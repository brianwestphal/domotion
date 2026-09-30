import { selectBestDashGap } from "./borders.js";
import { r } from "./format.js";

/** Blink `DashLengthRatio`, `DashGapRatio`, and `DashEffectFromStrokeStyle` in
 * `third_party/blink/renderer/platform/graphics/styled_stroke_data.cc`.
 * Open sides and closed contours differ only in gap fitting and the short
 * two-dash case; all CSS border/outline callers use these rules. */
export const DASH_LENGTH_FACTOR = { thin: 3, regular: 2 } as const;
export const DOT_EPSILON = 0.01;
export const THIN_DOTTED_MAX_WIDTH = 3;
export const DOUBLE_MIN_WIDTH = 3;

export function isThinDotted(width: number): boolean {
  return Math.round(width) <= THIN_DOTTED_MAX_WIDTH;
}

function dashArray(style: string, width: number, pathLength: number, closed: boolean, thinDotted: boolean): string {
  if (pathLength <= 0 || width <= 0) return "";
  if (style === "dashed" || (style === "dotted" && thinDotted)) {
    const dashed = style === "dashed";
    const thin = width < 3;
    const dashLength = dashed
      ? width * (thin ? DASH_LENGTH_FACTOR.thin : DASH_LENGTH_FACTOR.regular)
      : Math.round(width);
    const gapTarget = dashed ? width * (thin ? 2 : 1) : Math.round(width);
    if (pathLength <= dashLength * 2) return "";
    const twoDashesLength = 2 * dashLength + gapTarget * (closed ? 2 : 1);
    if (pathLength <= twoDashesLength) {
      const scale = pathLength / twoDashesLength;
      return `${r(dashLength * scale)} ${r(gapTarget * scale)}`;
    }
    const gap = dashed ? selectBestDashGap(pathLength, dashLength, gapTarget, closed) : gapTarget;
    return gap > 0 ? `${r(dashLength)} ${r(gap)}` : "";
  }
  if (style === "dotted") {
    if (pathLength < width * 2) return `${DOT_EPSILON} ${r(width * 2 - DOT_EPSILON)}`;
    const gap = selectBestDashGap(pathLength, width, width, closed);
    return gap > 0 ? `${DOT_EPSILON} ${r(gap + width - DOT_EPSILON)}` : "";
  }
  return "";
}

export function openDashArray(
  style: string,
  width: number,
  sideLength: number,
  thinDotted = isThinDotted(width),
): string {
  return dashArray(style, width, sideLength, false, thinDotted);
}

export function closedDashArray(
  style: string,
  width: number,
  pathLength: number,
  thinDotted = isThinDotted(width),
): string {
  return dashArray(style, width, pathLength, true, thinDotted);
}
