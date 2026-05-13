/**
 * Border-side parsing, per-corner radius resolution + clamping, rounded-rect
 * path emission, and stroke dash patterns. Excludes `renderBorderImage` (the
 * 9-slice border-image emitter) because it imports the embed-data-uri helper
 * still living in `dom-to-svg.ts`; that move waits for a follow-up sub-ticket.
 */

import { r } from "./format.js";
import { parseColor, type RGBA } from "./colors.js";

/** Per-corner border-radius axis-pair (h = horizontal, v = vertical).
 *  An elliptical corner has h ≠ v; a circular corner has h = v. */
export type CornerRadiusPair = { h: number; v: number };

/** Resolved per-corner border-radius for the four corners of a rect, with
 *  CSS-spec corner-overlap scaling already applied. `uniform` is true when
 *  all four corners are circular AND share the same radius, which lets the
 *  renderer emit a single `<rect rx>` instead of a per-corner `<path>`. */
export type CornerRadii = {
  tl: CornerRadiusPair;
  tr: CornerRadiusPair;
  br: CornerRadiusPair;
  bl: CornerRadiusPair;
  uniform: boolean;
};

/** Parse a captured "h v" axis-pair (e.g. "30px 30px" or "50px 20px"). */
function _parsePair(v: string | undefined): CornerRadiusPair {
  if (!v) return { h: 0, v: 0 };
  const parts = v.split(/\s+/);
  return {
    h: parseFloat(parts[0]) || 0,
    v: parseFloat(parts[1] != null ? parts[1] : parts[0]) || 0,
  };
}

/** Resolve the four per-corner radii for a captured element, applying CSS's
 *  corner-overlap scale-down (https://www.w3.org/TR/css-backgrounds-3/#corner-overlap):
 *  if any edge's two corner radii would together exceed the edge length, all
 *  four corners are scaled down uniformly. This is what produces the pill
 *  shape for `border-radius:999px` on a short element — without the spec
 *  clamp, two adjacent 999-px corners would overlap visibly. Falls back to
 *  the legacy single `borderRadius` shorthand when the per-corner longhands
 *  weren't captured (older snapshots). */
export function parseCornerRadii(
  styles: { borderTopLeftRadius?: string; borderTopRightRadius?: string; borderBottomRightRadius?: string; borderBottomLeftRadius?: string; borderRadius?: string },
  width: number,
  height: number,
): CornerRadii {
  let tl = _parsePair(styles.borderTopLeftRadius);
  let tr = _parsePair(styles.borderTopRightRadius);
  let br = _parsePair(styles.borderBottomRightRadius);
  let bl = _parsePair(styles.borderBottomLeftRadius);
  // Legacy fallback: a capture without per-corner longhands gets the shorthand
  // applied to all four corners as circular radii.
  if (!styles.borderTopLeftRadius && styles.borderRadius) {
    const fallback = parseFloat(styles.borderRadius) || 0;
    tl = tr = br = bl = { h: fallback, v: fallback };
  }
  // CSS corner-overlap scale-down: if rTL.h + rTR.h > width, scale all by
  // width / (rTL.h + rTR.h) (and similarly for the other three edges). We
  // take the smallest f across the four edges and apply it once.
  const sums = [
    { s: tl.h + tr.h, lim: width },
    { s: tr.v + br.v, lim: height },
    { s: br.h + bl.h, lim: width },
    { s: bl.v + tl.v, lim: height },
  ];
  let f = 1;
  for (const { s, lim } of sums) {
    if (s > 0 && lim > 0) f = Math.min(f, lim / s);
  }
  if (f < 1) {
    tl = { h: tl.h * f, v: tl.v * f };
    tr = { h: tr.h * f, v: tr.v * f };
    br = { h: br.h * f, v: br.v * f };
    bl = { h: bl.h * f, v: bl.v * f };
  }
  const uniform = tl.h === tl.v && tl.h === tr.h && tl.h === tr.v
    && tl.h === br.h && tl.h === br.v && tl.h === bl.h && tl.h === bl.v;
  return { tl, tr, br, bl, uniform };
}

/** Inset each corner radius by the matching border-side widths, clamping to 0.
 *  Use this to derive the inner radii used by background clips (where the
 *  border has eaten into the corner) and inner border strokes. CSS specifies
 *  that the inner corner is the outer corner pulled in by the adjacent border
 *  widths (top + left for TL, top + right for TR, etc.). */
export function insetCornerRadii(c: CornerRadii, top: number, right: number, bottom: number, left: number): CornerRadii {
  const tl = { h: Math.max(0, c.tl.h - left), v: Math.max(0, c.tl.v - top) };
  const tr = { h: Math.max(0, c.tr.h - right), v: Math.max(0, c.tr.v - top) };
  const br = { h: Math.max(0, c.br.h - right), v: Math.max(0, c.br.v - bottom) };
  const bl = { h: Math.max(0, c.bl.h - left), v: Math.max(0, c.bl.v - bottom) };
  const uniform = tl.h === tl.v && tl.h === tr.h && tl.h === tr.v
    && tl.h === br.h && tl.h === br.v && tl.h === bl.h && tl.h === bl.v;
  return { tl, tr, br, bl, uniform };
}

/** Emit an SVG path `d` attribute for a rounded rectangle with per-corner radii.
 *  Path goes clockwise from the top-left, using elliptical arc commands at each
 *  corner. Zero-radius corners collapse to a sharp 90° join. */
export function roundedRectPath(x: number, y: number, w: number, h: number, c: CornerRadii): string {
  // Each corner is at most clamped to fit; the spec scale-down already handled
  // edge-overlap, but clamp per-axis to half-extent as a safety net.
  const tl = { h: Math.min(c.tl.h, w), v: Math.min(c.tl.v, h) };
  const tr = { h: Math.min(c.tr.h, w), v: Math.min(c.tr.v, h) };
  const br = { h: Math.min(c.br.h, w), v: Math.min(c.br.v, h) };
  const bl = { h: Math.min(c.bl.h, w), v: Math.min(c.bl.v, h) };
  return [
    `M${r(x + tl.h)},${r(y)}`,
    `L${r(x + w - tr.h)},${r(y)}`,
    tr.h > 0 || tr.v > 0 ? `A${r(tr.h)},${r(tr.v)} 0 0 1 ${r(x + w)},${r(y + tr.v)}` : "",
    `L${r(x + w)},${r(y + h - br.v)}`,
    br.h > 0 || br.v > 0 ? `A${r(br.h)},${r(br.v)} 0 0 1 ${r(x + w - br.h)},${r(y + h)}` : "",
    `L${r(x + bl.h)},${r(y + h)}`,
    bl.h > 0 || bl.v > 0 ? `A${r(bl.h)},${r(bl.v)} 0 0 1 ${r(x)},${r(y + h - bl.v)}` : "",
    `L${r(x)},${r(y + tl.v)}`,
    tl.h > 0 || tl.v > 0 ? `A${r(tl.h)},${r(tl.v)} 0 0 1 ${r(x + tl.h)},${r(y)}` : "",
    `Z`,
  ].filter(s => s !== "").join(" ");
}

/** Emit a rounded-rect SVG element. Uses `<rect rx>` when the corners are
 *  uniform (cheaper, less markup); falls back to `<path>` for asymmetric or
 *  elliptical corners. The `attrs` string is injected verbatim — pass in
 *  fill/stroke/etc. */
export function roundedRectSvg(x: number, y: number, w: number, h: number, c: CornerRadii, attrs: string): string {
  if (c.uniform) {
    const rx = Math.min(c.tl.h, w / 2, h / 2);
    return `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${r(rx)}" ${attrs} />`;
  }
  return `<path d="${roundedRectPath(x, y, w, h, c)}" ${attrs} />`;
}

export interface BorderSide { w: number; style: string; color: RGBA }

export function parseSide(widthCss: string | undefined, styleCss: string | undefined, colorCss: string | undefined): BorderSide | null {
  if (widthCss == null || styleCss == null || colorCss == null) return null;
  const w = parseFloat(widthCss) || 0;
  const color = parseColor(colorCss);
  if (color == null) return null;
  return { w, style: styleCss, color };
}

/** Stroke-dasharray pattern for CSS border-style (dashed / dotted). Solid
 *  styles return an empty pattern (caller should omit the attribute entirely).
 *
 *   - dashed: dash = 2 * width, gap = width (a 2:1 ratio). DM-267.
 *   - dotted: SQUARE dots of side = width, gap = width — NOT round dots.
 *     Skia's kDottedStroke uses [width, width] dash pattern with butt caps,
 *     so each dash is a w×w square. (DM-368.)
 *  Caller should NOT add `stroke-linecap="round"` for dotted — square caps
 *  (the SVG default `butt`) match Chrome's painted output. */
export function dashArrayForStyle(style: string, width: number): string {
  switch (style) {
    case "dashed": return `${r(width * 2)} ${r(width)}`;
    case "dotted": return `${r(width)} ${r(width)}`;
    default: return "";
  }
}
