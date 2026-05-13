/**
 * Border-side parsing, per-corner radius resolution + clamping, rounded-rect
 * path emission, stroke dash patterns, and the CSS `border-image` 9-slice
 * emitter (`renderBorderImage`).
 */

import { r, esc } from "./format.js";
import { parseColor, type RGBA } from "./colors.js";
import type { CapturedElement } from "../capture/types.js";
import { embedResizedDataUri } from "../capture/embed.js";

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
export function renderBorderImage(
  el: CapturedElement,
  indent: string,
  idPrefix: string,
  defsParts: string[],
  clipIdx: number,
): { svg: string; usedIds: number } {
  const src = el.styles.borderImageSource;
  if (src == null || src === "none" || src === "") return { svg: "", usedIds: 0 };

  const urlMatch = /^url\((?:"|')?([^"')]+)(?:"|')?\)$/i.exec(src);
  if (urlMatch == null) return { svg: "", usedIds: 0 };
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
  const rH = (repeatTokens[0] || "stretch").toLowerCase();
  const rV = (repeatTokens[1] || rH).toLowerCase();

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
    // space: pad between tiles. Approximated here as a constant gap; exact
    // placement depends on count math Chrome uses. Close-enough fallback.
    let patternW = tileW, patternH = tileH;
    if (mode === "space") {
      if (axis === "x") {
        const count = Math.max(1, Math.floor(dwSlot / tileW));
        patternW = dwSlot / count;
      } else {
        const count = Math.max(1, Math.floor(dhSlot / tileH));
        patternH = dhSlot / count;
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
    defsParts.push(`<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${r(dxSlot)}" y="${r(dySlot)}" width="${r(patternW)}" height="${r(patternH)}"><image href="${esc(embedResizedDataUri(url, inImgW, inImgH))}" x="${r(inImgX)}" y="${r(inImgY)}" width="${r(inImgW)}" height="${r(inImgH)}" preserveAspectRatio="none" /></pattern>`);
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
    emitTiledSliceEdge(x1, y0, x2 - x1, wt, sxC, syT, sxW_C, st, "x", rH as "repeat" | "round" | "space");
    emitTiledSliceEdge(x1, y2, x2 - x1, wb, sxC, syB, sxW_C, sb, "x", rH as "repeat" | "round" | "space");
  }
  // Left + Right edges (vertical axis).
  if (rV === "stretch") {
    emitStretchedSlice(x0, y1, wl, y2 - y1, sxL, syC, sl, syH_C);
    emitStretchedSlice(x2, y1, wr, y2 - y1, sxR, syC, sr, syH_C);
  } else {
    emitTiledSliceEdge(x0, y1, wl, y2 - y1, sxL, syC, sl, syH_C, "y", rV as "repeat" | "round" | "space");
    emitTiledSliceEdge(x2, y1, wr, y2 - y1, sxR, syC, sr, syH_C, "y", rV as "repeat" | "round" | "space");
  }
  // Center (only if 'fill').
  if (fillCenter) {
    if (rH === "stretch" && rV === "stretch") {
      emitStretchedSlice(x1, y1, x2 - x1, y2 - y1, sxC, syC, sxW_C, syH_C);
    } else {
      // Center repeat is uncommon; fall back to stretch for simplicity.
      emitStretchedSlice(x1, y1, x2 - x1, y2 - y1, sxC, syC, sxW_C, syH_C);
    }
  }

  return { svg: parts.join("\n"), usedIds };
}
