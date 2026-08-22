/**
 * Blink-owned HTML CSS-mask geometry (DM-2472).
 *
 * `BackgroundImageGeometry::AdjustPositioningArea` contracts the normal
 * border-box positioning area with `FillLayer::Origin()` independently from
 * the destination/painting area selected by `EffectiveClip()`.  Keeping the
 * two rectangles separate is essential: mask-size and mask-position resolve
 * against the former, while emitted pixels are intersected with the latter.
 */

import { splitTopLevelCommas } from "./css-tokens.js";
import type { MaskImageRect } from "./mask-position.js";

export interface MaskPhysicalEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MaskOriginClipContext {
  /** Computed, comma-separated `mask-origin` layer list. */
  originCss: string;
  /** Computed, comma-separated `mask-clip` layer list. */
  clipCss: string;
  /** Physical border widths, after effective CSS zoom. */
  border: MaskPhysicalEdges;
  /** Physical padding widths, after effective CSS zoom. */
  padding: MaskPhysicalEdges;
  /**
   * A safe output-space superset of Blink's visual-overflow painting area.
   * The masked SVG group cannot contribute ink outside its own visual
   * overflow, so using the capture viewport is pixel-equivalent while keeping
   * `mask-clip:no-clip` free from an artificial border-box intersection.
   */
  noClipPaintingArea?: MaskImageRect;
}

export interface ResolvedMaskLayerGeometry {
  positioningArea: MaskImageRect;
  /** `null` means Blink's `mask-clip:no-clip` route: do not add a clip. */
  paintingArea: MaskImageRect | null;
  origin: string;
  clip: string;
}

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

export function insetMaskRect(
  rect: MaskImageRect,
  edges: MaskPhysicalEdges,
): MaskImageRect {
  const top = finiteNonNegative(edges.top);
  const right = finiteNonNegative(edges.right);
  const bottom = finiteNonNegative(edges.bottom);
  const left = finiteNonNegative(edges.left);
  return {
    x: rect.x + left,
    y: rect.y + top,
    width: Math.max(0, rect.width - left - right),
    height: Math.max(0, rect.height - top - bottom),
  };
}

function addEdges(a: MaskPhysicalEdges, b: MaskPhysicalEdges): MaskPhysicalEdges {
  return {
    top: finiteNonNegative(a.top) + finiteNonNegative(b.top),
    right: finiteNonNegative(a.right) + finiteNonNegative(b.right),
    bottom: finiteNonNegative(a.bottom) + finiteNonNegative(b.bottom),
    left: finiteNonNegative(a.left) + finiteNonNegative(b.left),
  };
}

/**
 * Map the HTML used geometry-box aliases exactly as Blink does for associated
 * CSS layout boxes: fill-box -> content-box; stroke/view-box -> border-box.
 */
export function normalizeHtmlMaskBox(value: string, allowNoClip: boolean): string {
  const keyword = value.trim().toLowerCase();
  if (allowNoClip && keyword === "no-clip") return "no-clip";
  if (keyword === "padding-box") return "padding-box";
  if (keyword === "content-box" || keyword === "fill-box") return "content-box";
  if (keyword === "border-box" || keyword === "stroke-box" || keyword === "view-box") return "border-box";
  // `no-clip` is not a valid mask-origin and unsupported/empty computed
  // values use the property's HTML initial value.
  return "border-box";
}

export function resolveHtmlMaskReferenceBox(
  borderBox: MaskImageRect,
  value: string,
  border: MaskPhysicalEdges,
  padding: MaskPhysicalEdges,
): MaskImageRect {
  const box = normalizeHtmlMaskBox(value, false);
  if (box === "padding-box") return insetMaskRect(borderBox, border);
  if (box === "content-box") return insetMaskRect(borderBox, addEdges(border, padding));
  return { ...borderBox };
}

function cyclic(values: string[], index: number, fallback: string): string {
  return values.length > 0 ? values[index % values.length] : fallback;
}

/** Resolve one layer without collapsing origin into clip. */
export function resolveMaskOriginClipLayer(
  borderBox: MaskImageRect,
  layerIndex: number,
  context: MaskOriginClipContext,
): ResolvedMaskLayerGeometry {
  const origins = splitTopLevelCommas(context.originCss);
  const clips = splitTopLevelCommas(context.clipCss);
  const origin = normalizeHtmlMaskBox(cyclic(origins, layerIndex, "border-box"), false);
  const clip = normalizeHtmlMaskBox(cyclic(clips, layerIndex, "border-box"), true);
  const positioningArea = resolveHtmlMaskReferenceBox(
    borderBox,
    origin,
    context.border,
    context.padding,
  );
  const paintingArea = clip === "no-clip"
    ? null
    : resolveHtmlMaskReferenceBox(borderBox, clip, context.border, context.padding);
  return { positioningArea, paintingArea, origin, clip };
}
