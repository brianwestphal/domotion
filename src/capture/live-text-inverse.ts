import type { CapturedTextPaintQuad } from "./types.js";

export interface LiveTextRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LiveTextInverse {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

const LAYOUT_UNIT = 1 / 64;
const SOURCE_FLOAT_TOLERANCE = 1 / 1024;

function layoutCoordinate(value: number): number | undefined {
  const snapped = Math.round(value / LAYOUT_UNIT) * LAYOUT_UNIT;
  return Number.isFinite(value) && Math.abs(snapped - value) <= SOURCE_FLOAT_TOLERANCE ? snapped || 0 : undefined;
}

/** Keep snapshot coordinates in CSS viewport space. Transform-origin carries
 * the already resolved offsets from the owner's border box. */
export function liveTextInverse(
  owner: LiveTextRect,
  transform: { a: number; b: number; c: number; d: number; e: number; f: number },
  origin: { x: number; y: number },
): LiveTextInverse | undefined {
  if (
    ![owner.x, owner.y, owner.width, owner.height, transform.e, transform.f, origin.x, origin.y].every(
      Number.isFinite,
    ) ||
    owner.width <= 0 ||
    owner.height <= 0 ||
    transform.b !== 0 ||
    transform.c !== 0 ||
    !Number.isFinite(transform.a) ||
    !Number.isFinite(transform.d) ||
    transform.a <= 0 ||
    transform.d <= 0 ||
    transform.a === 1 ||
    transform.d === 1
  ) {
    return;
  }
  const x = layoutCoordinate(owner.x - transform.e - (1 - transform.a) * origin.x);
  const y = layoutCoordinate(owner.y - transform.f - (1 - transform.d) * origin.y);
  const width = layoutCoordinate(owner.width / transform.a);
  const height = layoutCoordinate(owner.height / transform.d);
  if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0) return;
  const scaleX = 1 / transform.a;
  const scaleY = 1 / transform.d;
  return { scaleX, scaleY, offsetX: x - owner.x * scaleX, offsetY: y - owner.y * scaleY };
}

export function invertLiveTextRect(rect: LiveTextRect, inverse: LiveTextInverse): LiveTextRect | undefined {
  // Range's empty bounding box is a sentinel rather than a source location.
  if (rect.x === 0 && rect.y === 0 && rect.width === 0 && rect.height === 0) return rect;
  const x = layoutCoordinate(rect.x * inverse.scaleX + inverse.offsetX);
  const y = layoutCoordinate(rect.y * inverse.scaleY + inverse.offsetY);
  const right = layoutCoordinate((rect.x + rect.width) * inverse.scaleX + inverse.offsetX);
  const bottom = layoutCoordinate((rect.y + rect.height) * inverse.scaleY + inverse.offsetY);
  if (x == null || y == null || right == null || bottom == null || right < x || bottom < y) return;
  return { x, y, width: right - x, height: bottom - y };
}

/** CDP quads have already had the captured viewport's origin subtracted. Add
 * it back before applying the viewport-space inverse, then return capture
 * coordinates for the existing exact Range/CDP fragment join. */
export function invertLiveTextQuad(
  quad: CapturedTextPaintQuad,
  inverse: LiveTextInverse,
  viewport: { x: number; y: number },
): CapturedTextPaintQuad | undefined {
  const x = (point: number) => {
    const restored = layoutCoordinate((point + viewport.x) * inverse.scaleX + inverse.offsetX);
    return restored == null ? undefined : restored - viewport.x;
  };
  const y = (point: number) => {
    const restored = layoutCoordinate((point + viewport.y) * inverse.scaleY + inverse.offsetY);
    return restored == null ? undefined : restored - viewport.y;
  };
  const x0 = x(quad[0]);
  const y0 = y(quad[1]);
  const x1 = x(quad[2]);
  const y1 = y(quad[3]);
  const x2 = x(quad[4]);
  const y2 = y(quad[5]);
  const x3 = x(quad[6]);
  const y3 = y(quad[7]);
  if (x0 == null || y0 == null || x1 == null || y1 == null || x2 == null || y2 == null || x3 == null || y3 == null)
    return;
  return [x0, y0, x1, y1, x2, y2, x3, y3];
}
