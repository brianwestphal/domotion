/**
 * Blink's pixel snapping of a replaced image's paint rectangles, applied in the
 * image's authenticated local paint space.
 *
 * `ImagePainter::PaintIntoRect` (core/paint/image_painter.cc:205-239, Chromium
 * 7d859f27) draws the image into `ToPixelSnappedRect(dest_rect)` — the
 * object-fit rectangle plus the paint offset — and, when the content box does
 * not contain it, into the intersection of that with
 * `ToPixelSnappedRect(content_rect)`, mapping the source rectangle by the same
 * ratio. Drawing the whole image into the snapped destination clipped to that
 * intersection paints the same pixels, so the renderer emits the snapped
 * destination and a snapped content clip.
 *
 * The snap happens in local paint space, whose fractional origin can differ
 * from the captured viewport coordinates (frozen transforms, live
 * translations), and which paint isolation above the image displaces as a
 * whole (`NeedsIsolationNodes` rounds the isolating box's paint offset and
 * drops the subpixel accumulation beneath it, paint_property_tree_builder.cc
 * :570-589 / :744-749). The capture records both as `imagePaintBasis`; the DOM
 * geometry is never rewritten. Without a basis the captured geometry is kept —
 * a global rounding of captured coordinates would be wrong exactly where the
 * two spaces differ.
 */

import type { CapturedImagePaintBasis } from "../capture/types.js";

export interface PaintRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ImagePaintBasisCarrier {
  x: number;
  y: number;
  width: number;
  height: number;
  imagePaintBasis?: CapturedImagePaintBasis;
}

/** The basis, unless the box was derived with another size. */
export function authenticImagePaintBasis(el: ImagePaintBasisCarrier): CapturedImagePaintBasis | undefined {
  const basis = el.imagePaintBasis;
  return basis != null && basis.width === el.width && basis.height === el.height ? basis : undefined;
}

/** LayoutUnit precision: captured coordinates sit on the 1/64 grid. */
const quantize = (value: number) => Math.round(value * 64) / 64;

/** Blink's LayoutUnit scale-down comparison and percentage position for a
 * raster with authenticated density reversal (Chromium 7d859f27,
 * layout_replaced.cc:444-479, physical_size.cc and length_functions.cc). */
export function rasterScaleDownRect(
  x: number,
  y: number,
  width: number,
  height: number,
  reverted: { w: number; h: number },
  ratio: { w: number; h: number },
  position: string | undefined,
): PaintRect | null {
  const w = Math.round(width * 64);
  const h = Math.round(height * 64);
  if (
    ratio.w <= 0 ||
    ratio.h <= 0 ||
    reverted.w <= 0 ||
    reverted.h <= 0 ||
    !Number.isSafeInteger(w * ratio.h) ||
    !Number.isSafeInteger(h * ratio.w)
  ) {
    return null;
  }

  const constrainedHeight = Math.trunc((w * ratio.h) / ratio.w);
  const heightLimited = constrainedHeight > h;
  const containWidth = heightLimited ? Math.trunc((h * ratio.w) / ratio.h) : w;
  const containHeight = heightLimited ? h : constrainedHeight;
  const useReverted = containWidth > reverted.w * 64;
  const objectW = useReverted ? reverted.w : containWidth / 64;
  const objectH = useReverted ? reverted.h : containHeight / 64;
  return positionRasterObjectRect({ x, y, width: w / 64, height: h / 64 }, { w: objectW, h: objectH }, position);
}

/** Blink's MinimumValueForLength percentage position for a known LayoutUnit object size. */
export function positionRasterObjectRect(
  content: PaintRect,
  object: { w: number; h: number },
  position: string | undefined,
): PaintRect | null {
  const [horizontal, vertical, extra] = (position ?? "50% 50%").trim().split(/\s+/);
  if (!horizontal?.endsWith("%") || !vertical?.endsWith("%") || extra != null) return null;
  const percentX = Number(horizontal.slice(0, -1));
  const percentY = Number(vertical.slice(0, -1));
  if (!Number.isFinite(percentX) || !Number.isFinite(percentY)) return null;
  const float = Math.fround;
  const offset = (free: number, percent: number) =>
    Math.trunc(float(float(float(free) * float(percent)) / 100) * 64) / 64;
  return {
    x: content.x + offset(quantize(content.width) - object.w, percentX),
    y: content.y + offset(quantize(content.height) - object.h, percentY),
    width: object.w,
    height: object.h,
  };
}

/**
 * `ToPixelSnappedRect` (core/layout/geometry/physical_rect.h:228) of a rect
 * given in captured coordinates, returned in captured coordinates: the origin
 * is `LayoutUnit::Round`ed and each size is `SnapSizeToPixel(size, offset)`
 * (platform/geometry/layout_unit.h:805-813), which keeps a nonzero size of
 * more than four LayoutUnits at one pixel.
 */
export function snapImagePaintRect(
  el: { x: number; y: number },
  basis: CapturedImagePaintBasis,
  rect: PaintRect,
): PaintRect {
  const axis = (start: number, size: number, captured: number, origin: number, shift: number) => {
    const local = quantize(start - captured + origin);
    const snappedStart = Math.round(local);
    let snappedSize = Math.round(quantize(local + size)) - snappedStart;
    if (snappedSize === 0 && Math.abs(size) > 4 / 64) snappedSize = Math.sign(size);
    return { start: captured + shift + snappedStart - origin, size: snappedSize };
  };
  const x = axis(rect.x, rect.width, el.x, basis.origin.x, basis.shift.x);
  const y = axis(rect.y, rect.height, el.y, basis.origin.y, basis.shift.y);
  return { x: x.start, y: y.start, width: x.size, height: y.size };
}

/** True when `outer` contains `inner` (PhysicalRect::Contains). */
export function paintRectContains(outer: PaintRect, inner: PaintRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** The intersection of two rects, empty (zero size) when they do not overlap. */
export function intersectPaintRects(a: PaintRect, b: PaintRect): PaintRect {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width),
    bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * The snapped destination and `PaintIntoRect`'s own crop, in captured
 * coordinates. `crop` is the snapped content rect intersected with the snapped
 * destination when the content box does not contain the destination, and null
 * otherwise (Blink then draws the whole destination with no crop).
 */
export function imagePaintIntoRect(
  el: { x: number; y: number },
  basis: CapturedImagePaintBasis,
  dest: PaintRect,
  content: PaintRect,
): { dest: PaintRect; crop: PaintRect | null } {
  const snappedDest = snapImagePaintRect(el, basis, dest);
  if (paintRectContains(content, dest)) return { dest: snappedDest, crop: null };
  return { dest: snappedDest, crop: intersectPaintRects(snapImagePaintRect(el, basis, content), snappedDest) };
}
