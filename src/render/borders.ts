/**
 * Border-side parsing, per-corner radius resolution + clamping, rounded-rect
 * path emission, stroke dash patterns, and the CSS `border-image` 9-slice
 * emitter (`renderBorderImage`).
 */

import { r, esc } from "./format.js";
import { parseColor, type RGBA } from "./colors.js";
import type { CapturedElement } from "../capture/types.js";
import { embedResizedDataUri } from "../capture/embed.js";
import { parseGradient, buildLinearGradientDef, buildRadialGradientDef } from "./gradients.js";

/** `border-image-repeat` per-axis keyword. */
type BorderImageRepeat = "stretch" | "repeat" | "round" | "space";
const BORDER_IMAGE_REPEATS = new Set<string>(["stretch", "repeat", "round", "space"]);

function normalizeBorderImageRepeat(raw: string | undefined): BorderImageRepeat {
  if (raw != null && BORDER_IMAGE_REPEATS.has(raw)) return raw as BorderImageRepeat;
  return "stretch";
}

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

/** Grow each corner radius outward by `spread` for an OUTSET box-shadow shape.
 *  Per CSS Backgrounds 3 §6.4 and Chromium's `FloatRoundedRect::Outset`, a
 *  corner whose source radius is zero STAYS sharp through any spread — only
 *  pre-curved corners grow. A naive `corner + spread` produces visibly
 *  rounded shadow corners on a sharp-cornered box (e.g. concentric outlines
 *  built from `box-shadow: 0 0 0 Npx`). Use this for outset shadow shapes;
 *  the dual inset case is already covered by `insetCornerRadii` shrinking to
 *  zero when the border eats past the radius. */
export function outsetCornerRadiiForShadow(c: CornerRadii, spread: number): CornerRadii {
  const grow = (p: CornerRadiusPair): CornerRadiusPair => ({
    h: p.h > 0 ? Math.max(0, p.h + spread) : 0,
    v: p.v > 0 ? Math.max(0, p.v + spread) : 0,
  });
  const tl = grow(c.tl);
  const tr = grow(c.tr);
  const br = grow(c.br);
  const bl = grow(c.bl);
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

/**
 * Polygon (as `"x1,y1 x2,y2 …"`) that clips the annular border RING down to
 * the wedge belonging to one side of a rounded-corner box with mixed widths.
 *
 * For each side we compute that side's own apex (the meeting point of its
 * two adjacent corners' miter lines) and the perpendicular pair's apices.
 *
 * - top apex: NW-miter (lw, tw) ∩ NE-miter (-rw, tw) →
 *   `(bxL + lw·W/(lw+rw), bxT + tw·W/(lw+rw))`
 * - left apex: NW-miter (lw, tw) ∩ SW-miter (lw, -bw) →
 *   `(bxL + lw·H/(tw+bw), bxT + tw·H/(tw+bw))`
 * - and the bottom / right apexes mirror those.
 *
 * If the side's own apex falls INSIDE the box, the wedge is a triangle from
 * the two outer corners to that apex (DM-803). If the apex falls OUTSIDE the
 * box — which happens for wide-or-tall boxes whenever the box aspect ratio
 * doesn't match the adjacent widths' ratio — the triangle would extend
 * across to the OPPOSITE edge, and after intersection with the annular ring
 * the side bleeds its colour into the opposite side's strip. (Visible as
 * "circle, mixed sides" painting the whole ellipse one colour, or as a
 * solid bottom border's red dash showing through the gaps of a dashed
 * top border — DM-917 / DM-918.)
 *
 * In that case we build a quadrilateral using the PERPENDICULAR pair of
 * apex points (clamped to box bounds) as the wedge's inner corners — those
 * points cap the wedge where it meets the adjacent side wedges instead of
 * letting it run across the box.
 *
 * The `useSameSideApex` flags are per-side because each apex is checked
 * against the box independently; the caller passes whether each apex lies
 * within the box bounds (since the same caller has all the geometry already).
 */
export interface WedgeApexes {
  apexTopX: number; apexTopY: number;
  apexRightX: number; apexRightY: number;
  apexBottomX: number; apexBottomY: number;
  apexLeftX: number; apexLeftY: number;
}
export function wedgePolygonPoints(
  side: "top" | "right" | "bottom" | "left",
  bxL: number, bxT: number, bxR: number, bxB: number,
  a: WedgeApexes,
): string {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // A side's own apex is INSIDE the box rect when both coordinates lie
  // within the box; we already know one coord stays inside by construction
  // (top apex always has y ≥ bxT, etc.), so the check is the other coord
  // + the cross axis (apex could shift outside horizontally when widths
  // and box aspect both skew).
  const insideTop = a.apexTopY <= bxB && a.apexTopX >= bxL && a.apexTopX <= bxR;
  const insideRight = a.apexRightX >= bxL && a.apexRightY >= bxT && a.apexRightY <= bxB;
  const insideBottom = a.apexBottomY >= bxT && a.apexBottomX >= bxL && a.apexBottomX <= bxR;
  const insideLeft = a.apexLeftX <= bxR && a.apexLeftY >= bxT && a.apexLeftY <= bxB;
  const clLX = clamp(a.apexLeftX, bxL, bxR), clLY = clamp(a.apexLeftY, bxT, bxB);
  const clRX = clamp(a.apexRightX, bxL, bxR), clRY = clamp(a.apexRightY, bxT, bxB);
  const clTX = clamp(a.apexTopX, bxL, bxR), clTY = clamp(a.apexTopY, bxT, bxB);
  const clBX = clamp(a.apexBottomX, bxL, bxR), clBY = clamp(a.apexBottomY, bxT, bxB);
  switch (side) {
    case "top":
      return insideTop
        ? `${r(bxL)},${r(bxT)} ${r(bxR)},${r(bxT)} ${r(a.apexTopX)},${r(a.apexTopY)}`
        : `${r(bxL)},${r(bxT)} ${r(bxR)},${r(bxT)} ${r(clRX)},${r(clRY)} ${r(clLX)},${r(clLY)}`;
    case "right":
      return insideRight
        ? `${r(bxR)},${r(bxT)} ${r(bxR)},${r(bxB)} ${r(a.apexRightX)},${r(a.apexRightY)}`
        : `${r(bxR)},${r(bxT)} ${r(bxR)},${r(bxB)} ${r(clBX)},${r(clBY)} ${r(clTX)},${r(clTY)}`;
    case "bottom":
      return insideBottom
        ? `${r(bxR)},${r(bxB)} ${r(bxL)},${r(bxB)} ${r(a.apexBottomX)},${r(a.apexBottomY)}`
        : `${r(bxR)},${r(bxB)} ${r(bxL)},${r(bxB)} ${r(clLX)},${r(clLY)} ${r(clRX)},${r(clRY)}`;
    case "left":
      return insideLeft
        ? `${r(bxL)},${r(bxB)} ${r(bxL)},${r(bxT)} ${r(a.apexLeftX)},${r(a.apexLeftY)}`
        : `${r(bxL)},${r(bxB)} ${r(bxL)},${r(bxT)} ${r(clTX)},${r(clTY)} ${r(clBX)},${r(clBY)}`;
  }
}

/**
 * Same-side apex coordinates for the four side wedges of a rounded-corner
 * box with widths `tw / rw / bw / lw`. Each apex is the meeting point of
 * the two miter lines on that side's two corners. See `wedgePolygonPoints`
 * for how these feed into the wedge clip polygons.
 */
export function computeWedgeApexes(
  bxL: number, bxT: number, bxR: number, bxB: number,
  tw: number, rw: number, bw: number, lw: number,
): WedgeApexes {
  const W = bxR - bxL, H = bxB - bxT;
  const horizSum = lw + rw, vertSum = tw + bw;
  const cxBox = (bxL + bxR) / 2, cyBox = (bxT + bxB) / 2;
  return {
    apexTopX:    horizSum > 0 ? bxL + lw * W / horizSum : cxBox,
    apexTopY:    horizSum > 0 ? bxT + tw * W / horizSum : cyBox,
    apexRightX:  vertSum > 0 ? bxR - rw * H / vertSum : cxBox,
    apexRightY:  vertSum > 0 ? bxT + tw * H / vertSum : cyBox,
    apexBottomX: horizSum > 0 ? bxL + lw * W / horizSum : cxBox,
    apexBottomY: horizSum > 0 ? bxB - bw * W / horizSum : cyBox,
    apexLeftX:   vertSum > 0 ? bxL + lw * H / vertSum : cxBox,
    apexLeftY:   vertSum > 0 ? bxT + tw * H / vertSum : cyBox,
  };
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
/**
 * Force inline `<svg ...>` width/height to the captured layout size. Inline
 * icon SVGs in the wild fall into two cases that both need this:
 *   1. No width/height attrs — CSS sizes them on the page. Without injection
 *      the renderer falls back to the 300×150 default (giant black blob).
 *   2. Width/height attrs present but CSS overrides them (e.g. lucide icons
 *      ship `width="24" height="24"` and Tailwind shrinks via `size-3!`).
 *      Re-embedding the SVG creates a new viewport — author CSS no longer
 *      applies, so the icon paints at the original 24×24 instead of the
 *      12×12 Chrome painted (DM-480: Resend "Announcing" chevron).
 * Captured contentW/contentH are CSS-resolved layout dimensions, so forcing
 * them onto the nested `<svg>` is correct in both cases.
 */
export function injectSvgSize(svgHtml: string, w: number, h: number): string {
  if (w <= 0 || h <= 0) return svgHtml;
  const m = /^(<svg\b)([^>]*)(>)/i.exec(svgHtml);
  if (m == null) return svgHtml;
  let attrs = m[2];
  attrs = attrs.replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return `<svg${attrs} width="${r(w)}" height="${r(h)}">` + svgHtml.slice(m[0].length);
}


/**
 * Render a CSS border-image 9-slice around the element's border box.
 *
 * Supports:
 *   - border-image-source: url(...)         (gradient sources out of scope)
 *   - border-image-slice: t r b l            (percent + length, optional 'fill')
 *   - border-image-width: per-side (falls back to element border-width)
 *   - border-image-outset: per-side
 *   - border-image-repeat: stretch / repeat / round / space
 *
 * Returns { svg, usedIds }. usedIds indicates how many clipIdx values were
 * consumed so the caller can keep its own counter in sync.
 */
/**
 * Render a `border-image-source` that's a CSS gradient as a proper 9-slice.
 *
 * Per CSS Images 3, a gradient used as `border-image-source` has the size of
 * the border-image-area (= border-box ± `border-image-outset`). The 9-slice
 * algorithm then applies just like for a raster source: corners stretched,
 * edges tiled per `border-image-repeat`, optional fill center.
 *
 * Implementation: build a single `<linearGradient>` / `<radialGradient>` def
 * positioned in source space `(0, 0) - (natW, natH)` where natW = boxW,
 * natH = boxH. Each slot emits an inner `<svg x dx y dy width dw height dh
 * viewBox="sx sy sw sh" preserveAspectRatio="none">` containing a `<rect
 * width="natW" height="natH" fill="url(#g)" />`. The viewBox maps the source
 * slice rect onto the destination slot; the gradient comes along because its
 * `userSpaceOnUse` coordinates are interpreted in the viewBox space. Tiled
 * edges (`repeat` / `round` / `space`) wrap that inner `<svg>` in a
 * `<pattern>`. The single-def-per-element keeps SVG output small and matches
 * how the URL path reuses one source asset.
 */
function renderBorderImageGradient(
  el: CapturedElement,
  indent: string,
  idPrefix: string,
  defsParts: string[],
  clipIdx: number,
  src: string,
): { svg: string; usedIds: number } {
  const grad = parseGradient(src);
  if (grad == null) return { svg: "", usedIds: 0 };
  if (grad.kind !== "linear" && grad.kind !== "radial") return { svg: "", usedIds: 0 };

  const sliceRaw = el.styles.borderImageSlice ?? "100%";
  const fillCenter = /\bfill\b/i.test(sliceRaw);
  const bwTop = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
  const bwRight = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
  const bwBottom = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
  const bwLeft = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;

  // Outsets: default 0. Same parsing as URL path.
  const outsetTokens = (el.styles.borderImageOutset ?? "0").trim().split(/\s+/);
  const parseOutset = (tok: string | undefined, basis: number, borderW: number): number => {
    if (tok == null || tok === "") return 0;
    if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
    if (/(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(tok)) return parseFloat(tok) || 0;
    const n = parseFloat(tok);
    return Number.isFinite(n) ? n * borderW : 0;
  };
  const ot = parseOutset(outsetTokens[0], el.height, bwTop);
  const or_ = parseOutset(outsetTokens[1] ?? outsetTokens[0], el.width, bwRight);
  const ob = parseOutset(outsetTokens[2] ?? outsetTokens[0], el.height, bwBottom);
  const ol = parseOutset(outsetTokens[3] ?? outsetTokens[1] ?? outsetTokens[0], el.width, bwLeft);

  // Border-image-width per side; default = element's border-width. Same as URL path.
  const parseBorderImageLen = (tok: string | undefined, basis: number, borderW: number): number => {
    if (tok == null || tok === "" || tok === "auto") return borderW;
    if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
    if (/(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(tok)) return parseFloat(tok) || 0;
    const n = parseFloat(tok);
    return Number.isFinite(n) ? n * borderW : borderW;
  };
  const widthTokens = (el.styles.borderImageWidth ?? "").trim().split(/\s+/);
  const wt = parseBorderImageLen(widthTokens[0], el.height, bwTop);
  const wr = parseBorderImageLen(widthTokens[1] ?? widthTokens[0], el.width, bwRight);
  const wb = parseBorderImageLen(widthTokens[2] ?? widthTokens[0], el.height, bwBottom);
  const wl = parseBorderImageLen(widthTokens[3] ?? widthTokens[1] ?? widthTokens[0], el.width, bwLeft);

  const boxX = el.x - ol;
  const boxY = el.y - ot;
  const boxW = el.width + ol + or_;
  const boxH = el.height + ot + ob;
  if (boxW <= 0 || boxH <= 0) return { svg: "", usedIds: 0 };

  // Gradient sources have the size of the border-image-area.
  const natW = boxW;
  const natH = boxH;

  // Slice: numbers = source pixels, percentages = of source dims, optional `fill`.
  const sliceTokens = sliceRaw.replace(/\bfill\b/i, "").trim().split(/\s+/);
  const sliceNums = sliceTokens.map((t) => {
    if (/%$/.test(t)) return { pct: parseFloat(t) };
    return { px: parseFloat(t) };
  });
  const resolveSlice = (tok: { pct?: number; px?: number }, basis: number): number => {
    if (tok.pct != null) return (tok.pct / 100) * basis;
    return tok.px ?? 0;
  };
  const st = resolveSlice(sliceNums[0] ?? { px: 0 }, natH);
  const sr = resolveSlice(sliceNums[1] ?? sliceNums[0] ?? { px: 0 }, natW);
  const sb = resolveSlice(sliceNums[2] ?? sliceNums[0] ?? { px: 0 }, natH);
  const sl = resolveSlice(sliceNums[3] ?? sliceNums[1] ?? sliceNums[0] ?? { px: 0 }, natW);

  // Repeat policy per axis.
  const repeatTokens = (el.styles.borderImageRepeat ?? "stretch").trim().split(/\s+/);
  const rH = normalizeBorderImageRepeat((repeatTokens[0] ?? "stretch").toLowerCase());
  const rV = repeatTokens[1] != null && repeatTokens[1] !== "" ? normalizeBorderImageRepeat(repeatTokens[1].toLowerCase()) : rH;

  // Gradient def in source space (0, 0) - (natW, natH). Positioned at the
  // border-image-area's element-absolute origin (boxX, boxY) so the inner
  // <svg viewBox> remap below lands the gradient on the correct destination
  // coordinates. Each <rect> inside an inner <svg viewBox="sx sy sw sh">
  // paints the slice region by drawing the full natW × natH rect — the
  // viewBox + preserveAspectRatio="none" map source slice → destination slot.
  const gid = `${idPrefix}big${clipIdx}`;
  let usedIds = 1;
  const gradRect = { x: boxX, y: boxY, w: natW, h: natH };
  const def = grad.kind === "linear"
    ? buildLinearGradientDef(grad, gid, gradRect)
    : buildRadialGradientDef(grad, gid, gradRect);
  defsParts.push(def);

  // Slot geometry in element-absolute coords.
  const x0 = boxX, x1 = boxX + wl, x2 = boxX + boxW - wr, x3 = boxX + boxW;
  const y0 = boxY, y1 = boxY + wt, y2 = boxY + boxH - wb, y3 = boxY + boxH;
  // Source regions in source pixels (NB: corner rects + edge / center rects).
  const sxL = 0, sxR = natW - sr, sxC = sl, sxW_C = natW - sl - sr;
  const syT = 0, syB = natH - sb, syC = st, syH_C = natH - st - sb;

  const parts: string[] = [];

  // Inner <svg viewBox> that paints the source slice rect (sx, sy, sw, sh)
  // into the destination slot (dx, dy, dw, dh). The gradient is positioned
  // in source-space coords (boxX..boxX+natW, boxY..boxY+natH); to keep it
  // aligned through the viewBox mapping, the viewBox is offset to start at
  // (boxX + sx, boxY + sy) — so the gradient's userSpaceOnUse coordinates
  // line up with the source rect we're sampling. Then a single <rect>
  // covering (boxX, boxY) - (boxX+natW, boxY+natH) lets the gradient
  // evaluate across the full source space; the viewBox crops to the slice.
  const innerSvgForSlot = (
    dx: number, dy: number, dw: number, dh: number,
    sx: number, sy: number, sw: number, sh: number,
  ): string => {
    return `<svg x="${r(dx)}" y="${r(dy)}" width="${r(dw)}" height="${r(dh)}" viewBox="${r(boxX + sx)} ${r(boxY + sy)} ${r(sw)} ${r(sh)}" preserveAspectRatio="none"><rect x="${r(boxX)}" y="${r(boxY)}" width="${r(natW)}" height="${r(natH)}" fill="url(#${gid})" /></svg>`;
  };

  const emitStretchedSlot = (
    dx: number, dy: number, dw: number, dh: number,
    sx: number, sy: number, sw: number, sh: number,
  ): void => {
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
    parts.push(`${indent}${innerSvgForSlot(dx, dy, dw, dh, sx, sy, sw, sh)}`);
  };

  // Tiled edges: wrap the inner <svg> in a <pattern> sized to one tile, then
  // fill the destination rect with that pattern. round / space tile-count
  // logic mirrors the URL path's `emitTiledSliceEdge`. For `space`, the
  // pattern cell is the slot/N and the inner <svg> is centered inside the
  // cell so each end has a half-gap; transparent gap is automatic because
  // the inner <svg> is smaller than the pattern cell.
  const emitTiledEdgeSlot = (
    dx: number, dy: number, dw: number, dh: number,
    sx: number, sy: number, sw: number, sh: number,
    axis: "x" | "y", mode: "repeat" | "round" | "space",
  ): void => {
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
    let tileW: number, tileH: number;
    if (axis === "x") {
      tileH = dh;
      tileW = sw * (dh / sh);
      if (mode === "round") {
        const count = Math.max(1, Math.round(dw / tileW));
        tileW = dw / count;
      }
    } else {
      tileW = dw;
      tileH = sh * (dw / sw);
      if (mode === "round") {
        const count = Math.max(1, Math.round(dh / tileH));
        tileH = dh / count;
      }
    }
    let patternW = tileW, patternH = tileH;
    let tileOffX = 0, tileOffY = 0;
    if (mode === "space") {
      if (axis === "x") {
        const count = Math.floor(dw / tileW);
        if (count <= 0) return;
        patternW = dw / count;
        tileOffX = (patternW - tileW) / 2;
      } else {
        const count = Math.floor(dh / tileH);
        if (count <= 0) return;
        patternH = dh / count;
        tileOffY = (patternH - tileH) / 2;
      }
    }
    const patId = `${idPrefix}bip${clipIdx + usedIds}`;
    usedIds++;
    const inner = innerSvgForSlot(tileOffX, tileOffY, tileW, tileH, sx, sy, sw, sh);
    defsParts.push(`<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${r(dx)}" y="${r(dy)}" width="${r(patternW)}" height="${r(patternH)}">${inner}</pattern>`);
    parts.push(`${indent}<rect x="${r(dx)}" y="${r(dy)}" width="${r(dw)}" height="${r(dh)}" fill="url(#${patId})" />`);
  };

  // 4 corners — always stretched.
  emitStretchedSlot(x0, y0, wl, wt, sxL, syT, sl, st);   // NW
  emitStretchedSlot(x2, y0, wr, wt, sxR, syT, sr, st);   // NE
  emitStretchedSlot(x0, y2, wl, wb, sxL, syB, sl, sb);   // SW
  emitStretchedSlot(x2, y2, wr, wb, sxR, syB, sr, sb);   // SE
  // Top + Bottom edges.
  if (rH === "stretch") {
    emitStretchedSlot(x1, y0, x2 - x1, wt, sxC, syT, sxW_C, st);
    emitStretchedSlot(x1, y2, x2 - x1, wb, sxC, syB, sxW_C, sb);
  } else {
    emitTiledEdgeSlot(x1, y0, x2 - x1, wt, sxC, syT, sxW_C, st, "x", rH);
    emitTiledEdgeSlot(x1, y2, x2 - x1, wb, sxC, syB, sxW_C, sb, "x", rH);
  }
  // Left + Right edges.
  if (rV === "stretch") {
    emitStretchedSlot(x0, y1, wl, y2 - y1, sxL, syC, sl, syH_C);
    emitStretchedSlot(x2, y1, wr, y2 - y1, sxR, syC, sr, syH_C);
  } else {
    emitTiledEdgeSlot(x0, y1, wl, y2 - y1, sxL, syC, sl, syH_C, "y", rV);
    emitTiledEdgeSlot(x2, y1, wr, y2 - y1, sxR, syC, sr, syH_C, "y", rV);
  }
  // Center — only when `fill`.
  if (fillCenter) {
    emitStretchedSlot(x1, y1, x2 - x1, y2 - y1, sxC, syC, sxW_C, syH_C);
  }

  if (parts.length === 0) return { svg: "", usedIds: 0 };
  return { svg: parts.join("\n"), usedIds };
}

export function renderBorderImage(
  el: CapturedElement,
  indent: string,
  idPrefix: string,
  defsParts: string[],
  clipIdx: number,
): { svg: string; usedIds: number } {
  const src = el.styles.borderImageSource;
  if (src == null || src === "none" || src === "") return { svg: "", usedIds: 0 };

  // DM-722: CSS gradient as `border-image-source`. The 9-slice machinery
  // below is built around a fixed-size raster source. Per CSS Images 3, a
  // gradient used as `border-image-source` resolves to a concrete-size image
  // equal to the border-image-area (= border-box ± `border-image-outset`).
  // For the common `border-image: <grad> 1` case (slice 1, stretch — the
  // fixture's `.gradient-border` panel), emit a single "border ring" path
  // (outer rect minus inner rect via even-odd fill rule) filled with the
  // gradient scoped to the full border-image-area. This matches Chrome's
  // paint because slice 1 + stretch effectively maps a continuous gradient
  // along all four sides — exactly what painting the whole area with the
  // gradient and clipping to the border donut produces. Slice values other
  // than `1` or `1 fill` (with non-degenerate edge tiling) fall through
  // unsupported for gradient sources; the rasterise-during-capture path is
  // tracked separately for that.
  const urlMatch = /^url\((?:"|')?([^"')]+)(?:"|')?\)$/i.exec(src);
  if (urlMatch == null) {
    if (!/-gradient\(/i.test(src)) return { svg: "", usedIds: 0 };
    return renderBorderImageGradient(el, indent, idPrefix, defsParts, clipIdx, src);
  }
  const url = urlMatch[1];
  const natW = el.styles.borderImageIntrinsicWidth ?? 0;
  const natH = el.styles.borderImageIntrinsicHeight ?? 0;
  if (natW <= 0 || natH <= 0) return { svg: "", usedIds: 0 };

  // Slice values: numbers are pixels (intrinsic image pixels). Percentages
  // resolve against natW/natH. 'fill' keyword (anywhere) enables center.
  const sliceRaw = el.styles.borderImageSlice ?? "100%";
  const fillCenter = /\bfill\b/i.test(sliceRaw);
  const sliceTokens = sliceRaw.replace(/\bfill\b/i, "").trim().split(/\s+/);
  const sliceNums = sliceTokens.map((t) => {
    if (/%$/.test(t)) {
      // First two tokens measure vertically (top/bottom from natH); next two horizontally (right/left from natW).
      // We'll resolve per-side below using index.
      return { pct: parseFloat(t) };
    }
    return { px: parseFloat(t) };
  });
  const resolveSlice = (tok: { pct?: number; px?: number }, basis: number): number => {
    if (tok.pct != null) return (tok.pct / 100) * basis;
    return tok.px ?? 0;
  };
  const st = resolveSlice(sliceNums[0] ?? { px: 0 }, natH);
  const sr = resolveSlice(sliceNums[1] ?? sliceNums[0] ?? { px: 0 }, natW);
  const sb = resolveSlice(sliceNums[2] ?? sliceNums[0] ?? { px: 0 }, natH);
  const sl = resolveSlice(sliceNums[3] ?? sliceNums[1] ?? sliceNums[0] ?? { px: 0 }, natW);

  // Widths and outsets: CSS allows px/%/unitless. Unitless = multiplier of the
  // element's border-width on that side. 'auto' = element's border-width.
  const bwTop = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
  const bwRight = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
  const bwBottom = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
  const bwLeft = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
  const parseBorderImageLen = (tok: string | undefined, basis: number, borderW: number): number => {
    if (tok == null || tok === "" || tok === "auto") return borderW;
    if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
    if (/(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(tok)) return parseFloat(tok) || 0;
    // Unitless number -> multiplier of border-width.
    const n = parseFloat(tok);
    return Number.isFinite(n) ? n * borderW : borderW;
  };
  const widthTokens = (el.styles.borderImageWidth ?? "").trim().split(/\s+/);
  const wt = parseBorderImageLen(widthTokens[0], el.height, bwTop);
  const wr = parseBorderImageLen(widthTokens[1] ?? widthTokens[0], el.width, bwRight);
  const wb = parseBorderImageLen(widthTokens[2] ?? widthTokens[0], el.height, bwBottom);
  const wl = parseBorderImageLen(widthTokens[3] ?? widthTokens[1] ?? widthTokens[0], el.width, bwLeft);

  // Outsets: same parsing; default 0.
  const outsetTokens = (el.styles.borderImageOutset ?? "0").trim().split(/\s+/);
  const parseOutset = (tok: string | undefined, basis: number, borderW: number): number => {
    if (tok == null || tok === "") return 0;
    if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
    if (/(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(tok)) return parseFloat(tok) || 0;
    const n = parseFloat(tok);
    return Number.isFinite(n) ? n * borderW : 0;
  };
  const ot = parseOutset(outsetTokens[0], el.height, bwTop);
  const or_ = parseOutset(outsetTokens[1] ?? outsetTokens[0], el.width, bwRight);
  const ob = parseOutset(outsetTokens[2] ?? outsetTokens[0], el.height, bwBottom);
  const ol = parseOutset(outsetTokens[3] ?? outsetTokens[1] ?? outsetTokens[0], el.width, bwLeft);

  const boxX = el.x - ol;
  const boxY = el.y - ot;
  const boxW = el.width + ol + or_;
  const boxH = el.height + ot + ob;

  // Repeat policy per axis (tokens order: H V; fallback: single token applies to both).
  const repeatTokens = (el.styles.borderImageRepeat ?? "stretch").trim().split(/\s+/);
  const rH = normalizeBorderImageRepeat((repeatTokens[0] ?? "stretch").toLowerCase());
  const rV = repeatTokens[1] != null && repeatTokens[1] !== "" ? normalizeBorderImageRepeat(repeatTokens[1].toLowerCase()) : rH;

  // Slot geometry (in element-absolute coords).
  const x0 = boxX, x1 = boxX + wl, x2 = boxX + boxW - wr, x3 = boxX + boxW;
  const y0 = boxY, y1 = boxY + wt, y2 = boxY + boxH - wb, y3 = boxY + boxH;

  // Corresponding source regions (in intrinsic image pixels).
  // Full image 9-slice mapping:
  //   NW = (0,0)-(sl,st); N = (sl,0)-(natW-sr,st); NE = (natW-sr,0)-(natW,st)
  //   W  = (0,st)-(sl,natH-sb); C = (sl,st)-(natW-sr,natH-sb); E = (natW-sr,st)-(natW,natH-sb)
  //   SW = (0,natH-sb)-(sl,natH); S = (sl,natH-sb)-(natW-sr,natH); SE = ...
  const sxL = 0, sxR = natW - sr, sxC = sl, sxW_C = natW - sl - sr;
  const syT = 0, syB = natH - sb, syC = st, syH_C = natH - st - sb;

  const parts: string[] = [];
  let usedIds = 0;

  // Each slot is either:
  //   - a <pattern> backed by a clipped <svg><image/></svg> tile (for repeat variants)
  //   - or a simple <image href preserveAspectRatio='none'> scaled to the slot (stretch, corners)
  // For slots drawn by <image>, we use an SVG <clipPath> + translate to show just the
  // right slice of the source. Since href is an absolute URL, loading is shared.

  const emitStretchedSlice = (
    dxSlot: number,
    dySlot: number,
    dwSlot: number,
    dhSlot: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): void => {
    if (dwSlot <= 0 || dhSlot <= 0 || sw <= 0 || sh <= 0) return;
    const clipId = `${idPrefix}bi${clipIdx + usedIds}`;
    usedIds++;
    // Clip to the slot, draw the whole image scaled so the source region (sx,sy,sw,sh) maps to (dxSlot,dySlot,dwSlot,dhSlot).
    defsParts.push(`<clipPath id="${clipId}"><rect x="${r(dxSlot)}" y="${r(dySlot)}" width="${r(dwSlot)}" height="${r(dhSlot)}" /></clipPath>`);
    const scaleX = dwSlot / sw;
    const scaleY = dhSlot / sh;
    const imgX = dxSlot - sx * scaleX;
    const imgY = dySlot - sy * scaleY;
    const imgW = natW * scaleX;
    const imgH = natH * scaleY;
    parts.push(`${indent}<image href="${esc(embedResizedDataUri(url, imgW, imgH))}" x="${r(imgX)}" y="${r(imgY)}" width="${r(imgW)}" height="${r(imgH)}" preserveAspectRatio="none" clip-path="url(#${clipId})" />`);
  };

  // For edge slots with repeat/round/space, we tile along one axis. Simplest
  // repeating impl: use a <pattern>. Round rescales tile count to be integer.
  const emitTiledSliceEdge = (
    dxSlot: number,
    dySlot: number,
    dwSlot: number,
    dhSlot: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    axis: "x" | "y",
    mode: "repeat" | "round" | "space",
  ): void => {
    if (dwSlot <= 0 || dhSlot <= 0 || sw <= 0 || sh <= 0) return;
    // Natural tile size = source region scaled to match the slot's non-tiling dimension.
    let tileW: number, tileH: number;
    if (axis === "x") {
      // Top / bottom edges: tile horizontally; non-tiling dim is height.
      tileH = dhSlot;
      tileW = sw * (dhSlot / sh);
      if (mode === "round") {
        const count = Math.max(1, Math.round(dwSlot / tileW));
        tileW = dwSlot / count;
      }
    } else {
      tileW = dwSlot;
      tileH = sh * (dwSlot / sw);
      if (mode === "round") {
        const count = Math.max(1, Math.round(dhSlot / tileH));
        tileH = dhSlot / count;
      }
    }
    // DM-795: `space` tiles the source N whole times with equal gaps between
    // tiles AND half-gaps at each end (CSS Images 3 §6.1.3). Compute N =
    // floor(slot / tile); if N === 0 the tile is too big for the slot and
    // the spec says no border is drawn for that side, so bail. Otherwise set
    // `patternW = dwSlot / N` so cells span the slot evenly, and offset the
    // pattern start by half a gap. The `<image>` inside the cell needs a
    // `<clipPath>` clipped to the slice region (0, 0, tileW, tileH) —
    // otherwise the image extends past the slice into the gap, painting
    // source pixels beyond the slice region instead of transparent gap.
    let patternW = tileW, patternH = tileH;
    let patternX = dxSlot, patternY = dySlot;
    if (mode === "space") {
      if (axis === "x") {
        const count = Math.floor(dwSlot / tileW);
        if (count <= 0) return;
        patternW = dwSlot / count;
        // Per spec, half-gap at each end: shift pattern start by `(patternW − tileW) / 2`.
        patternX = dxSlot + (patternW - tileW) / 2;
      } else {
        const count = Math.floor(dhSlot / tileH);
        if (count <= 0) return;
        patternH = dhSlot / count;
        patternY = dySlot + (patternH - tileH) / 2;
      }
    }
    const patId = `${idPrefix}bip${clipIdx + usedIds}`;
    usedIds++;
    // Pattern: single <image> showing just the slice, scaled to patternW x patternH.
    const imgScaleX = tileW / sw;
    const imgScaleY = tileH / sh;
    const inImgX = -sx * imgScaleX;
    const inImgY = -sy * imgScaleY;
    const inImgW = natW * imgScaleX;
    const inImgH = natH * imgScaleY;
    // DM-795: clip the image to the slice region so `space` mode shows
    // transparent gaps between tiles instead of bleeding adjacent source
    // pixels into the gap. The clipPath is scoped to the pattern cell at
    // (0, 0) - (tileW, tileH) and references the image inside the pattern.
    const clipBgId = `${idPrefix}bic${clipIdx + usedIds}`;
    usedIds++;
    const clipDef = mode === "space"
      ? `<clipPath id="${clipBgId}"><rect x="0" y="0" width="${r(tileW)}" height="${r(tileH)}" /></clipPath>`
      : "";
    const imgClip = mode === "space" ? ` clip-path="url(#${clipBgId})"` : "";
    defsParts.push(`<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${r(patternX)}" y="${r(patternY)}" width="${r(patternW)}" height="${r(patternH)}">${clipDef}<image href="${esc(embedResizedDataUri(url, inImgW, inImgH))}" x="${r(inImgX)}" y="${r(inImgY)}" width="${r(inImgW)}" height="${r(inImgH)}" preserveAspectRatio="none"${imgClip} /></pattern>`);
    parts.push(`${indent}<rect x="${r(dxSlot)}" y="${r(dySlot)}" width="${r(dwSlot)}" height="${r(dhSlot)}" fill="url(#${patId})" />`);
  };

  // Corners: always stretched (CSS spec).
  emitStretchedSlice(x0, y0, wl, wt, sxL, syT, sl, st);                             // NW
  emitStretchedSlice(x2, y0, wr, wt, sxR, syT, sr, st);                             // NE
  emitStretchedSlice(x0, y2, wl, wb, sxL, syB, sl, sb);                             // SW
  emitStretchedSlice(x2, y2, wr, wb, sxR, syB, sr, sb);                             // SE

  // Top + Bottom edges (horizontal axis).
  if (rH === "stretch") {
    emitStretchedSlice(x1, y0, x2 - x1, wt, sxC, syT, sxW_C, st);
    emitStretchedSlice(x1, y2, x2 - x1, wb, sxC, syB, sxW_C, sb);
  } else {
    emitTiledSliceEdge(x1, y0, x2 - x1, wt, sxC, syT, sxW_C, st, "x", rH);
    emitTiledSliceEdge(x1, y2, x2 - x1, wb, sxC, syB, sxW_C, sb, "x", rH);
  }
  // Left + Right edges (vertical axis).
  if (rV === "stretch") {
    emitStretchedSlice(x0, y1, wl, y2 - y1, sxL, syC, sl, syH_C);
    emitStretchedSlice(x2, y1, wr, y2 - y1, sxR, syC, sr, syH_C);
  } else {
    emitTiledSliceEdge(x0, y1, wl, y2 - y1, sxL, syC, sl, syH_C, "y", rV);
    emitTiledSliceEdge(x2, y1, wr, y2 - y1, sxR, syC, sr, syH_C, "y", rV);
  }
  // Center (only if `fill`). Per CSS Backgrounds 3 §6.1.3 the middle slice
  // is tiled in both directions when `border-image-repeat` is non-stretch,
  // using the SAME tile sizing as the corresponding edge — horizontal axis
  // matches the top edge derivation (tileW_natural = sxW_C × wt / st),
  // vertical matches the left edge derivation (tileH_natural = syH_C × wl / sl).
  // Single stretched <image> for stretch×stretch; otherwise a 2D <pattern>.
  if (fillCenter) {
    const dwCenter = x2 - x1;
    const dhCenter = y2 - y1;
    if (rH === "stretch" && rV === "stretch") {
      emitStretchedSlice(x1, y1, dwCenter, dhCenter, sxC, syC, sxW_C, syH_C);
    } else if (dwCenter > 0 && dhCenter > 0 && sxW_C > 0 && syH_C > 0 && st > 0 && sl > 0) {
      // Per-axis tile size.
      const tileWNatural = sxW_C * (wt / st);
      const tileHNatural = syH_C * (wl / sl);
      let tileW: number, tileH: number;
      let patternW: number, patternH: number;
      let tileOffX = 0, tileOffY = 0;
      // Horizontal.
      if (rH === "stretch") {
        tileW = dwCenter;
        patternW = dwCenter;
      } else if (rH === "round") {
        const count = Math.max(1, Math.round(dwCenter / tileWNatural));
        tileW = dwCenter / count;
        patternW = tileW;
      } else if (rH === "space") {
        const count = Math.floor(dwCenter / tileWNatural);
        if (count <= 0) { tileW = 0; patternW = 0; } else {
          tileW = tileWNatural;
          patternW = dwCenter / count;
          tileOffX = (patternW - tileW) / 2;
        }
      } else { // "repeat"
        tileW = tileWNatural;
        patternW = tileWNatural;
      }
      // Vertical.
      if (rV === "stretch") {
        tileH = dhCenter;
        patternH = dhCenter;
      } else if (rV === "round") {
        const count = Math.max(1, Math.round(dhCenter / tileHNatural));
        tileH = dhCenter / count;
        patternH = tileH;
      } else if (rV === "space") {
        const count = Math.floor(dhCenter / tileHNatural);
        if (count <= 0) { tileH = 0; patternH = 0; } else {
          tileH = tileHNatural;
          patternH = dhCenter / count;
          tileOffY = (patternH - tileH) / 2;
        }
      } else {
        tileH = tileHNatural;
        patternH = tileHNatural;
      }
      if (tileW > 0 && tileH > 0 && patternW > 0 && patternH > 0) {
        const imgScaleX = tileW / sxW_C;
        const imgScaleY = tileH / syH_C;
        const inImgX = -sxC * imgScaleX + tileOffX;
        const inImgY = -syC * imgScaleY + tileOffY;
        const inImgW = natW * imgScaleX;
        const inImgH = natH * imgScaleY;
        const patId = `${idPrefix}bipc${clipIdx + usedIds}`;
        usedIds++;
        // For `space` mode, clip the image to the visible tile region so
        // gaps stay transparent (mirrors the edge-tile fix from DM-795).
        const needsClip = rH === "space" || rV === "space";
        let clipDef = "";
        let imgClip = "";
        if (needsClip) {
          const clipBgId = `${idPrefix}bicc${clipIdx + usedIds}`;
          usedIds++;
          clipDef = `<clipPath id="${clipBgId}"><rect x="${r(tileOffX)}" y="${r(tileOffY)}" width="${r(tileW)}" height="${r(tileH)}" /></clipPath>`;
          imgClip = ` clip-path="url(#${clipBgId})"`;
        }
        defsParts.push(`<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${r(x1)}" y="${r(y1)}" width="${r(patternW)}" height="${r(patternH)}">${clipDef}<image href="${esc(embedResizedDataUri(url, inImgW, inImgH))}" x="${r(inImgX)}" y="${r(inImgY)}" width="${r(inImgW)}" height="${r(inImgH)}" preserveAspectRatio="none"${imgClip} /></pattern>`);
        parts.push(`${indent}<rect x="${r(x1)}" y="${r(y1)}" width="${r(dwCenter)}" height="${r(dhCenter)}" fill="url(#${patId})" />`);
      }
    }
  }

  return { svg: parts.join("\n"), usedIds };
}
