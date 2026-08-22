/**
 * Pure lowering of Blink's captured background-attachment ownership inputs.
 * Tile sizing/repeat/phase intentionally remain owned by image-pattern.ts
 * (DM-2478); this module only selects positioning and painting rectangles.
 */

import type {
  CapturedBackgroundAttachmentGeometry,
  CapturedBackgroundRect,
} from "../capture/types.js";

export type EffectiveBackgroundAttachment = "scroll" | "fixed" | "local";

export interface ResolvedBackgroundAttachment {
  attachment: EffectiveBackgroundAttachment;
  positioningBox: CapturedBackgroundRect;
  paintingBox: CapturedBackgroundRect;
  /** True when the local overflow clip, rather than background-clip, owns the visible edge. */
  localOverflowClipped: boolean;
}

const finiteRect = (rect: CapturedBackgroundRect): boolean =>
  Number.isFinite(rect.x) && Number.isFinite(rect.y)
  && Number.isFinite(rect.width) && Number.isFinite(rect.height)
  && rect.width >= 0 && rect.height >= 0;

/** Reapply reference-box insets from one border box to another. */
function rebaseReferenceBox(
  reference: CapturedBackgroundRect,
  fromBorder: CapturedBackgroundRect,
  toBorder: CapturedBackgroundRect,
): CapturedBackgroundRect {
  const left = reference.x - fromBorder.x;
  const top = reference.y - fromBorder.y;
  const right = fromBorder.x + fromBorder.width - reference.x - reference.width;
  const bottom = fromBorder.y + fromBorder.height - reference.y - reference.height;
  return {
    x: toBorder.x + left,
    y: toBorder.y + top,
    width: Math.max(0, toBorder.width - left - right),
    height: Math.max(0, toBorder.height - top - bottom),
  };
}

export function intersectBackgroundRects(
  left: CapturedBackgroundRect,
  right: CapturedBackgroundRect,
): CapturedBackgroundRect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const farX = Math.min(left.x + left.width, right.x + right.width);
  const farY = Math.min(left.y + left.height, right.y + right.height);
  return { x, y, width: Math.max(0, farX - x), height: Math.max(0, farY - y) };
}

export function resolveBackgroundAttachment(
  computedAttachment: string,
  borderBox: CapturedBackgroundRect,
  originBox: CapturedBackgroundRect,
  clipBox: CapturedBackgroundRect,
  geometry: CapturedBackgroundAttachmentGeometry | undefined,
  captureViewport: { w: number; h: number },
): ResolvedBackgroundAttachment {
  const token = computedAttachment.trim().toLowerCase();
  const compatible = geometry?.source === "blink-box-background-paint-context-v1"
    && finiteRect(geometry.layoutViewport);
  const canvas = compatible ? geometry.canvas : undefined;
  const canvasPaint = { x: 0, y: 0, width: captureViewport.w, height: captureViewport.h };

  if (token === "fixed" && compatible && geometry.fixedToViewport) {
    return {
      attachment: "fixed",
      positioningBox: geometry.layoutViewport,
      paintingBox: canvas == null ? clipBox : canvasPaint,
      localOverflowClipped: false,
    };
  }

  if (token === "local" && compatible && geometry.local?.active === true) {
    const scrolledBorder = {
      x: borderBox.x - geometry.local.scrollOffsetX,
      y: borderBox.y - geometry.local.scrollOffsetY,
      width: geometry.local.borderPaintWidth,
      height: geometry.local.borderPaintHeight,
    };
    const positioningBox = rebaseReferenceBox(originBox, borderBox, scrolledBorder);
    const scrolledClip = rebaseReferenceBox(clipBox, borderBox, scrolledBorder);
    return {
      attachment: "local",
      positioningBox,
      paintingBox: intersectBackgroundRects(scrolledClip, geometry.local.overflowClip),
      localOverflowClipped: true,
    };
  }

  // A transformed/will-change non-root fixed layer deliberately lands here:
  // Blink treats it exactly as scroll. Canvas backgrounds keep the root box's
  // stitched positioning size even though their destination covers the view.
  if (canvas != null && finiteRect(canvas.positioningRect)) {
    return {
      attachment: "scroll",
      positioningBox: rebaseReferenceBox(originBox, borderBox, canvas.positioningRect),
      paintingBox: canvasPaint,
      localOverflowClipped: false,
    };
  }
  return {
    attachment: "scroll",
    positioningBox: originBox,
    paintingBox: clipBox,
    localOverflowClipped: false,
  };
}
