import type { CapturedElement } from "../capture/types.js";
import { r } from "./format.js";
import { parseColor, colorStr, sameColor } from "./colors.js";
import {
  parseSide,
  parseCornerRadii,
  dashArrayForStyle,
  renderBorderImage,
  insetCornerRadii,
  roundedRectPath,
  roundedRectSvg,
  roundBorderSideClipPolygon,
  hyperellipseBorderSideClipPolygon,
  contouredRectIntersectionPaths,
  doubleBorderStripeGeometry,
  pixelSnappedBorderReferenceRect,
  uniformDoubleBorderStripeBoxes,
  selectBestDashGap,
  type BorderSide,
  type CornerRadii,
} from "./borders.js";
import { adjustedDashAttrs, paintThinDottedLine } from "./outline-paint.js";
import type { PaintCtx } from "./element-tree-to-svg.js";

// 3D bevel border (DM-280): groove / ridge / inset / outset. Each side is a
// trapezoid polygon so the shade pairs miter cleanly at corners; groove/ridge
// split each trapezoid into outer/inner halves with inverted shades. Extracted
// from paintBorder's uniform branch (DM-1342) — pure code move, byte-identical.
export function paintBevelBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  bt: NonNullable<ReturnType<typeof parseSide>>,
): void {
  const style = bt.style;
  const w = bt.w;
  const x0 = el.x, y0 = el.y;
  const x1 = el.x + el.width, y1 = el.y + el.height;
  // Match Chromium's BoxBorderPainter: darker = base × 2/3 per channel,
  // lighter = the base color itself (no actual lightening). The
  // earlier symmetric ±22% lightness shift in HSL space produced too
  // much contrast vs Chromium's painted output (DM-293).
  const darker = colorStr({ r: Math.round(bt.color.r * 2 / 3), g: Math.round(bt.color.g * 2 / 3), b: Math.round(bt.color.b * 2 / 3), a: bt.color.a });
  const lighter = colorStr(bt.color);
  // tl = top + left (sharing one shade); br = bottom + right (other shade).
  const tlIsLighter = style === "outset" || style === "ridge";
  const tlColor = tlIsLighter ? lighter : darker;
  const brColor = tlIsLighter ? darker : lighter;
  // Trapezoid polygons for each side. Outer corners are the captured
  // border-box corners; inner corners are inset by w on each axis.
  const topPoly = `${r(x0)},${r(y0)} ${r(x1)},${r(y0)} ${r(x1 - w)},${r(y0 + w)} ${r(x0 + w)},${r(y0 + w)}`;
  const rightPoly = `${r(x1)},${r(y0)} ${r(x1)},${r(y1)} ${r(x1 - w)},${r(y1 - w)} ${r(x1 - w)},${r(y0 + w)}`;
  const bottomPoly = `${r(x0)},${r(y1)} ${r(x1)},${r(y1)} ${r(x1 - w)},${r(y1 - w)} ${r(x0 + w)},${r(y1 - w)}`;
  const leftPoly = `${r(x0)},${r(y0)} ${r(x0)},${r(y1)} ${r(x0 + w)},${r(y1 - w)} ${r(x0 + w)},${r(y0 + w)}`;
  if (style === "inset" || style === "outset") {
    ctx.svgParts.push(`${indent}<polygon points="${topPoly}" fill="${tlColor}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${leftPoly}" fill="${tlColor}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${rightPoly}" fill="${brColor}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${bottomPoly}" fill="${brColor}" />`);
  } else {
    // Groove / ridge: split each trapezoid horizontally in half so the
    // outer half and inner half can carry inverse shades. The mid-line
    // for the top trapezoid runs from (x0+w/2, y0+w/2) to
    // (x1-w/2, y0+w/2) — i.e., w/2 inset on every axis.
    const halfW = w / 2;
    const xa = x0, xb = x1, ya = y0, yb = y1;
    // Outer halves: top, right, bottom, left — each is a 4-pt polygon.
    const topOuter = `${r(xa)},${r(ya)} ${r(xb)},${r(ya)} ${r(xb - halfW)},${r(ya + halfW)} ${r(xa + halfW)},${r(ya + halfW)}`;
    const rightOuter = `${r(xb)},${r(ya)} ${r(xb)},${r(yb)} ${r(xb - halfW)},${r(yb - halfW)} ${r(xb - halfW)},${r(ya + halfW)}`;
    const bottomOuter = `${r(xa)},${r(yb)} ${r(xb)},${r(yb)} ${r(xb - halfW)},${r(yb - halfW)} ${r(xa + halfW)},${r(yb - halfW)}`;
    const leftOuter = `${r(xa)},${r(ya)} ${r(xa)},${r(yb)} ${r(xa + halfW)},${r(yb - halfW)} ${r(xa + halfW)},${r(ya + halfW)}`;
    // Inner halves: top, right, bottom, left.
    const topInner = `${r(xa + halfW)},${r(ya + halfW)} ${r(xb - halfW)},${r(ya + halfW)} ${r(xb - w)},${r(ya + w)} ${r(xa + w)},${r(ya + w)}`;
    const rightInner = `${r(xb - halfW)},${r(ya + halfW)} ${r(xb - halfW)},${r(yb - halfW)} ${r(xb - w)},${r(yb - w)} ${r(xb - w)},${r(ya + w)}`;
    const bottomInner = `${r(xa + halfW)},${r(yb - halfW)} ${r(xb - halfW)},${r(yb - halfW)} ${r(xb - w)},${r(yb - w)} ${r(xa + w)},${r(yb - w)}`;
    const leftInner = `${r(xa + halfW)},${r(ya + halfW)} ${r(xa + halfW)},${r(yb - halfW)} ${r(xa + w)},${r(yb - w)} ${r(xa + w)},${r(ya + w)}`;
    // groove: outer is darker on top+left, lighter on bottom+right
    // (carved-in look); inner is the inverse so the inside of the
    // groove brightens on top+left.
    // ridge:  outer is lighter on top+left, darker on bottom+right
    // (raised look); inner is the inverse.
    const outerTL = style === "ridge" ? lighter : darker;
    const outerBR = style === "ridge" ? darker : lighter;
    const innerTL = outerBR;
    const innerBR = outerTL;
    ctx.svgParts.push(`${indent}<polygon points="${topOuter}" fill="${outerTL}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${leftOuter}" fill="${outerTL}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${rightOuter}" fill="${outerBR}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${bottomOuter}" fill="${outerBR}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${topInner}" fill="${innerTL}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${leftInner}" fill="${innerTL}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${rightInner}" fill="${innerBR}" />`);
    ctx.svgParts.push(`${indent}<polygon points="${bottomInner}" fill="${innerBR}" />`);
  }
}

// The four CSS border styles that paint a light/dark 3D bevel.
function isBevelStyle(style: string): boolean {
  return style === "groove" || style === "ridge" || style === "inset" || style === "outset";
}

// Per-side 3D bevel border (DM-1275): the SAME Chrome-calibrated shading as
// paintBevelBorder (darker = base × 2/3, lighter = base — DM-293) and identical
// trapezoid geometry, but each side renders its OWN 3D style. This covers the
// mixed case paintBevelBorder's uniform-STYLE guard skips — e.g. `ridge` top/
// bottom + `groove` left/right ("3D pair flip") — which otherwise fell through to
// paintPerSideBorder and painted as a flat solid border with no bevel at all.
// The caller gates on uniform width + color + square corners (the single base
// color + trapezoid geometry assume that); anything else falls back.
function paintMixedBevelBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  w: number,
  color: { r: number; g: number; b: number; a: number },
  styles: { top: string; right: string; bottom: string; left: string },
): void {
  const x0 = el.x, y0 = el.y, x1 = el.x + el.width, y1 = el.y + el.height;
  const darker = colorStr({ r: Math.round(color.r * 2 / 3), g: Math.round(color.g * 2 / 3), b: Math.round(color.b * 2 / 3), a: color.a });
  const lighter = colorStr(color);
  const halfW = w / 2;
  // Full trapezoids (inset/outset) + outer/inner halves (groove/ridge) — same
  // geometry as paintBevelBorder, keyed per side.
  const full = {
    top: `${r(x0)},${r(y0)} ${r(x1)},${r(y0)} ${r(x1 - w)},${r(y0 + w)} ${r(x0 + w)},${r(y0 + w)}`,
    right: `${r(x1)},${r(y0)} ${r(x1)},${r(y1)} ${r(x1 - w)},${r(y1 - w)} ${r(x1 - w)},${r(y0 + w)}`,
    bottom: `${r(x0)},${r(y1)} ${r(x1)},${r(y1)} ${r(x1 - w)},${r(y1 - w)} ${r(x0 + w)},${r(y1 - w)}`,
    left: `${r(x0)},${r(y0)} ${r(x0)},${r(y1)} ${r(x0 + w)},${r(y1 - w)} ${r(x0 + w)},${r(y0 + w)}`,
  };
  const outer = {
    top: `${r(x0)},${r(y0)} ${r(x1)},${r(y0)} ${r(x1 - halfW)},${r(y0 + halfW)} ${r(x0 + halfW)},${r(y0 + halfW)}`,
    right: `${r(x1)},${r(y0)} ${r(x1)},${r(y1)} ${r(x1 - halfW)},${r(y1 - halfW)} ${r(x1 - halfW)},${r(y0 + halfW)}`,
    bottom: `${r(x0)},${r(y1)} ${r(x1)},${r(y1)} ${r(x1 - halfW)},${r(y1 - halfW)} ${r(x0 + halfW)},${r(y1 - halfW)}`,
    left: `${r(x0)},${r(y0)} ${r(x0)},${r(y1)} ${r(x0 + halfW)},${r(y1 - halfW)} ${r(x0 + halfW)},${r(y0 + halfW)}`,
  };
  const inner = {
    top: `${r(x0 + halfW)},${r(y0 + halfW)} ${r(x1 - halfW)},${r(y0 + halfW)} ${r(x1 - w)},${r(y0 + w)} ${r(x0 + w)},${r(y0 + w)}`,
    right: `${r(x1 - halfW)},${r(y0 + halfW)} ${r(x1 - halfW)},${r(y1 - halfW)} ${r(x1 - w)},${r(y1 - w)} ${r(x1 - w)},${r(y0 + w)}`,
    bottom: `${r(x0 + halfW)},${r(y1 - halfW)} ${r(x1 - halfW)},${r(y1 - halfW)} ${r(x1 - w)},${r(y1 - w)} ${r(x0 + w)},${r(y1 - w)}`,
    left: `${r(x0 + halfW)},${r(y0 + halfW)} ${r(x0 + halfW)},${r(y1 - halfW)} ${r(x0 + w)},${r(y1 - w)} ${r(x0 + w)},${r(y0 + w)}`,
  };
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const style = styles[side];
    const isTL = side === "top" || side === "left";
    if (style === "inset" || style === "outset") {
      const fill = style === "outset" ? (isTL ? lighter : darker) : (isTL ? darker : lighter);
      ctx.svgParts.push(`${indent}<polygon points="${full[side]}" fill="${fill}" />`);
    } else {
      // groove / ridge: outer + inner halves carry inverse shades (matches the
      // uniform path's TL/BR grouping, applied per-side).
      const outerFill = style === "ridge" ? (isTL ? lighter : darker) : (isTL ? darker : lighter);
      const innerFill = style === "ridge" ? (isTL ? darker : lighter) : (isTL ? lighter : darker);
      ctx.svgParts.push(`${indent}<polygon points="${outer[side]}" fill="${outerFill}" />`);
      ctx.svgParts.push(`${indent}<polygon points="${inner[side]}" fill="${innerFill}" />`);
    }
  }
}

// Uniform `double` border: two parallel strokes each 1/3 of border-width with a
// 1/3 gap, collapse-aware. Extracted from paintBorder (DM-1342) — byte-identical.
function paintUniformDoubleBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  bt: NonNullable<ReturnType<typeof parseSide>>,
  offGridCollapsedCells: Set<CapturedElement>,
): void {
  // CSS double border: two parallel strokes each 1/3 of border-width,
  // separated by 1/3 gap. Our captured rect is the border box (outer
  // edge), so strokes need their centerlines at 1/6*w (outer) and
  // 5/6*w (inner) inside the border box.
  //
  // DM-689: In `border-collapse: collapse` mode Chrome paints the
  // border CENTERED on the cell's grid edge instead of inside the
  // cell box — half the border width sits outside the cell, half
  // inside. Match that by shifting the outer/inner offsets outward
  // by bt.w/2 in collapse mode (Blink's
  // `CollapsedBorderPainter::PaintCollapsedBorders` centers the
  // collapsed-border rect on the grid line).
  const collapse = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
  const collapseShift = collapse ? bt.w / 2 : 0;
  // BoxBorderPainter initializes one pixel-snapped outer contour, then derives
  // both uniform-double stripe contours from integer outsets of that reference.
  // Collapsed borders have separate table-grid ownership and intentionally keep
  // the already shared, unsnapped grid edge.
  const reference = collapse
    ? { x: el.x, y: el.y, width: el.width, height: el.height }
    : pixelSnappedBorderReferenceRect(el.x, el.y, el.width, el.height);
  const {
    strokeWidth: strokeW,
    outerInset,
    innerInset,
    outer,
    inner,
  } = uniformDoubleBorderStripeBoxes(reference, bt.w, collapseShift);
  const outerCorners = insetCornerRadii(corners, outerInset, outerInset, outerInset, outerInset);
  const innerCorners = insetCornerRadii(corners, innerInset, innerInset, innerInset, innerInset);
  ctx.svgParts.push(
    `${indent}${roundedRectSvg(outer.x, outer.y, outer.width, outer.height, outerCorners, `fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(strokeW)}"`)}`,
  );
  ctx.svgParts.push(
    `${indent}${roundedRectSvg(inner.x, inner.y, inner.width, inner.height, innerCorners, `fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(strokeW)}"`)}`,
  );
}

// Uniform `dashed` / `dotted` border with square (non-rounded) corners: 4 lines,
// each with its own corner-adjusted dash cycle. Extracted from paintBorder
// (DM-1342) — byte-identical.
function paintUniformDashedDottedBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  bt: NonNullable<ReturnType<typeof parseSide>>,
  offGridCollapsedCells: Set<CapturedElement>,
): void {
  const style = bt.style;
  const thinDotted = style === "dotted" && Math.round(bt.w) <= 3;
  // Dashed/dotted uniform borders need per-side dash spacing — Chrome
  // adjusts the dash cycle so dashes start and end exactly at corners.
  // SVG `stroke-dasharray` on a single rect would use ONE pattern across
  // all 4 sides, but the top/bottom and left/right have different
  // lengths, so the pattern would mis-align at every corner. Emit 4
  // lines instead so each side gets its own adjusted pattern.
  const collapse = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
  const inset = collapse ? 0 : bt.w / 2;
  // Chromium has two dotted branches: widths 1--3 use square {w,w}
  // intervals plus explicit endpoint dots; thicker strokes use zero-length
  // dashes with round caps. `paintThinDottedLine` owns the former branch.
  const linecap = style === "dotted" && !thinDotted ? ` stroke-linecap="round"` : "";
  // Round box edges to integer device pixels so the stroke center
  // lands on an integer (for even widths) and paints 2 solid rows
  // instead of 3 antialiased rows. Skip when border-collapse:collapse
  // because shared edges between adjacent cells must use the same
  // (un-rounded) coords to overlap exactly. DM-403/405.
  const bL = collapse ? el.x : Math.round(el.x);
  const bT = collapse ? el.y : Math.round(el.y);
  const bR = collapse ? el.x + el.width : Math.round(el.x + el.width);
  const bB = collapse ? el.y + el.height : Math.round(el.y + el.height);
  // Corner trim along the side's axis. Two reasons it applies:
  //   • Thick dotted: Chromium's `DrawLineWithStyle` moves the
  //     line endpoints IN by width/2 before stroking round-dotted
  //     lines so the round endcap fits inside the line. Matching
  //     that is necessary for `adjustedDashAttrs` (which assumes a
  //     post-move sideLength) to compute Chrome-equivalent dot
  //     centers. The adjacent sides' first dots overlap at the
  //     corner, producing one visible corner dot. (DM-805.)
  //   • Dashed thick (≥ 8 px): legacy corner-overlap prevention so
  //     butt-cap dashes don't double-paint the corner pixel as a
  //     darker square (DM-402, visible on the 10 px dashed border
  //     in `17-bg-color-image`). Thin dashed borders use 0 trim
  //     so the dashes meet flush at the corner, matching Chrome
  //     for the common 1-3 px cases.
  const cornerTrim = style === "dotted" && !thinDotted ? bt.w / 2 : (bt.w >= 8 ? inset : 0);
  // Each entry: [x1, y1, x2, y2, naturalLen]. naturalLen is the
  // PRE-cornerTrim side length — Chromium's `DrawLineWithStyle`
  // computes the dash pattern from the original `info.path_length`
  // BEFORE moving thick-dotted endpoints inward by width/2 (the move
  // shifts the painted line but the dash math sees the original).
  // For thin dashed/dotted borders cornerTrim = 0, so naturalLen == drawn
  // length; for thick dotted (cornerTrim = width/2) and thick dashed
  // (cornerTrim = width/2) the two differ.
  const sides: Array<[number, number, number, number, number]> = [
    [bL + cornerTrim, bT + inset, bR - cornerTrim, bT + inset, bR - bL],
    [bR - inset, bT + cornerTrim, bR - inset, bB - cornerTrim, bB - bT],
    [bL + cornerTrim, bB - inset, bR - cornerTrim, bB - inset, bR - bL],
    [bL + inset, bT + cornerTrim, bL + inset, bB - cornerTrim, bB - bT],
  ];
  for (const [x1, y1, x2, y2, len] of sides) {
    if (thinDotted) {
      ctx.svgParts.push(...paintThinDottedLine(x1, y1, x2, y2, bt.w, colorStr(bt.color), indent));
      continue;
    }
    const { array: dash, offset } = adjustedDashAttrs(style, bt.w, len);
    // DM-912: the dash math computes pattern positions from `len` (the
    // OUTER corner-to-corner length, e.g. 300 for a 10 px border on a
    // 300 px box), but the SVG `<line>` is drawn from the INNER
    // cornerTrim'd endpoints (length len - 2·cornerTrim). SVG's
    // `stroke-dasharray` phases from the line START, so without a
    // shift the visible dashes land cornerTrim px ahead of where
    // Chrome's `BoxBorderPainter` paints them. Adding a
    // `stroke-dashoffset` equal to `cornerTrim` rewinds the pattern
    // so the visible portion aligns with Chrome's per-edge dash
    // positions.
    const phaseOffset = cornerTrim > 0 ? offset + cornerTrim : offset;
    const dashAttrs = dash !== "" ? ` stroke-dasharray="${dash}"${phaseOffset !== 0 ? ` stroke-dashoffset="${r(phaseOffset)}"` : ""}` : "";
    ctx.svgParts.push(
      `${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(bt.color)}" stroke-width="${r(bt.w)}"${dashAttrs}${linecap} />`,
    );
  }
}

function createContouredRingMask(
  ctx: PaintCtx,
  outerPath: string,
  x: number,
  y: number,
  width: number,
  height: number,
  innerCorners: CornerRadii,
): string | null {
  const constraints = contouredRectIntersectionPaths(x, y, width, height, innerCorners);
  if (constraints == null) return null;
  const clipIds = constraints.map(() => ctx.nextClipId("cci"));
  constraints.forEach((path, index) => ctx.defsParts.push(`<clipPath id="${clipIds[index]}"><path d="${path}"/></clipPath>`));
  const nestedOpen = clipIds.map(id => `<g clip-path="url(#${id})">`).join("");
  const nestedClose = "</g>".repeat(clipIds.length);
  const maskId = ctx.nextClipId("crm");
  const pad = Math.max(width, height, 1) * 4 + 1;
  ctx.defsParts.push(
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" mask-type="luminance" x="${r(x - pad)}" y="${r(y - pad)}" width="${r(width + pad * 2)}" height="${r(height + pad * 2)}"><path d="${outerPath}" fill="white"/>${nestedOpen}<rect x="${r(x)}" y="${r(y)}" width="${r(width)}" height="${r(height)}" fill="black"/>${nestedClose}</mask>`,
  );
  return maskId;
}

// Uniform solid border (also the fallback for dashed/dotted with rounded corners
// or non-uniform radii): a single inset, device-pixel-rounded rounded-rect stroke.
// Extracted from paintBorder (DM-1342) — byte-identical.
function paintUniformSolidBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  bt: NonNullable<ReturnType<typeof parseSide>>,
  offGridCollapsedCells: Set<CapturedElement>,
): void {
  const dash = dashArrayForStyle(bt.style, bt.w);
  const linecap = "";
  // CSS paints borders INSIDE the border-box. SVG strokes are centered on
  // the path, so half would spill outside. Inset the rect by half the
  // stroke width so the stroke sits entirely inside the element box.
  // Exception: with border-collapse:collapse on the parent table, Chrome
  // collapses adjacent cell borders into a single shared line painted ON
  // the shared edge (not inset). If we kept the inset, two adjacent
  // cells' borders would land ~1px apart and read as a doubled 2px line.
  // Centered painting (no inset) lets the two cells' borders overlap
  // exactly, producing a single 1px line — matching Chrome's collapsed
  // table grid.
  const collapse = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
  const half = collapse ? 0 : bt.w / 2;
  const strokeCorners = insetCornerRadii(corners, half, half, half, half);
  const dashAttr = dash !== "" ? ` stroke-dasharray="${dash}"` : "";
  // Chrome paints borders aligned to device pixels: it rounds the box
  // edges to integers before stroking. Our captured `el.x / el.y` are
  // fractional from `getBoundingClientRect()`, so emitting the stroke
  // at `el.x + half` puts the stroke center at a fractional y, which
  // the SVG renderer then antialiases across 3 pixel rows instead of
  // 2 — producing a visibly thicker / blurrier border. Round the box
  // edges to integers (matching Chrome's per-edge `round`), then add
  // the half-stroke offset. Skip when collapse=true so shared cell
  // edges still overlap exactly. DM-403/405/406/407/410.
  const boxLeft = collapse ? el.x : Math.round(el.x);
  const boxTop = collapse ? el.y : Math.round(el.y);
  const boxRight = collapse ? el.x + el.width : Math.round(el.x + el.width);
  const boxBottom = collapse ? el.y + el.height : Math.round(el.y + el.height);
  const hasNonRoundContour = corners.curvature != null
    && Object.values(corners.curvature).some(value => value !== 2);
  // Blink paints non-round borders as the area between its outer and aligned
  // inner ContouredRects. An SVG centerline stroke cannot represent a concave
  // contour (it protrudes on the wrong side of a scoop/notch), so preserve the
  // same two vector boundaries and fill the annulus with even-odd winding.
  if (hasNonRoundContour && !collapse && bt.style === "solid") {
    const outer = roundedRectPath(boxLeft, boxTop, boxRight - boxLeft, boxBottom - boxTop, corners);
    const innerCorners = insetCornerRadii(corners, bt.w, bt.w, bt.w, bt.w);
    const innerX = boxLeft + bt.w, innerY = boxTop + bt.w;
    const innerW = Math.max(0, boxRight - boxLeft - bt.w * 2), innerH = Math.max(0, boxBottom - boxTop - bt.w * 2);
    const maskId = createContouredRingMask(ctx, outer, innerX, innerY, innerW, innerH, innerCorners);
    if (maskId != null) {
      ctx.svgParts.push(`${indent}<path d="${outer}" fill="${colorStr(bt.color)}" mask="url(#${maskId})"/>`);
    } else {
      const inner = roundedRectPath(innerX, innerY, innerW, innerH, innerCorners);
      ctx.svgParts.push(`${indent}<path d="${outer} ${inner}" fill="${colorStr(bt.color)}" fill-rule="evenodd"/>`);
    }
    return;
  }
  ctx.svgParts.push(
    `${indent}${roundedRectSvg(boxLeft + half, boxTop + half, Math.max(0, boxRight - boxLeft - half * 2), Math.max(0, boxBottom - boxTop - half * 2), strokeCorners, `fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(bt.w)}"${dashAttr}${linecap}`)}`,
  );
}

// Border paint phase — border-image 9-slice composition plus the plain per-side
// border — extracted from renderElement (DM-1306, DM-1316). Handles uniform and
// per-side borders: solid annular wedges for rounded corners, trapezoid tapers,
// double strokes, 3D bevel (groove/ridge/inset/outset) polygons, and dashed /
// dotted per-side line emission, plus the <fieldset>+<legend> notch clip. Highest-
// coupling phase: it mints many per-side clip ids (and the border-image pass mints
// its own), so clipIdx is threaded in and the advanced value returned, keeping the
// positional id sequence byte-identical. Returns { svg, defs, clipIdx }.
export function paintCollapsedBorderRects(ctx: PaintCtx, el: CapturedElement, indent: string): boolean {
  const rects = el.styles.collapsedBorderRects;
  if (rects == null) return false;
  for (const rect of rects) {
    const color = parseColor(rect.color);
    if (color == null || color.a < 0.01 || rect.width <= 0 || rect.height <= 0) continue;
    const fill = colorStr(color);
    const horizontal = rect.width >= rect.height;
    const thickness = horizontal ? rect.height : rect.width;
    const length = horizontal ? rect.width : rect.height;
    if (rect.style === "solid" || thickness < 1) {
      ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}" fill="${fill}" />`);
      continue;
    }
    if (rect.style === "double" && thickness >= 3) {
      const stripe = thickness / 3;
      if (horizontal) {
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(stripe)}" fill="${fill}" />`);
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y + thickness - stripe)}" width="${r(rect.width)}" height="${r(stripe)}" fill="${fill}" />`);
      } else {
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(stripe)}" height="${r(rect.height)}" fill="${fill}" />`);
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x + thickness - stripe)}" y="${r(rect.y)}" width="${r(stripe)}" height="${r(rect.height)}" fill="${fill}" />`);
      }
      continue;
    }
    if (rect.style === "dashed" || rect.style === "dotted") {
      const clipId = ctx.nextClipId("cb");
      ctx.defsParts.push(`<clipPath id="${clipId}"><rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}"/></clipPath>`);
      const { array, offset } = adjustedDashAttrs(rect.style, thickness, length);
      const dash = array !== "" ? ` stroke-dasharray="${array}"${offset !== 0 ? ` stroke-dashoffset="${r(offset)}"` : ""}` : "";
      const cap = rect.style === "dotted" ? ` stroke-linecap="round"` : "";
      const x1 = horizontal ? rect.x : rect.x + thickness / 2;
      const y1 = horizontal ? rect.y + thickness / 2 : rect.y;
      const x2 = horizontal ? rect.x + rect.width : x1;
      const y2 = horizontal ? y1 : rect.y + rect.height;
      ctx.svgParts.push(`${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${fill}" stroke-width="${r(thickness)}"${dash}${cap} clip-path="url(#${clipId})" />`);
      continue;
    }
    if (isBevelStyle(rect.style)) {
      const dark = colorStr({ r: Math.round(color.r * 2 / 3), g: Math.round(color.g * 2 / 3), b: Math.round(color.b * 2 / 3), a: color.a });
      const first = rect.style === "outset" || rect.style === "ridge" ? fill : dark;
      const second = rect.style === "groove" || rect.style === "ridge" ? (first === fill ? dark : fill) : first;
      if (rect.style === "inset" || rect.style === "outset") {
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}" fill="${first}" />`);
      } else if (horizontal) {
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(thickness / 2)}" fill="${first}" />`);
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y + thickness / 2)}" width="${r(rect.width)}" height="${r(thickness / 2)}" fill="${second}" />`);
      } else {
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(thickness / 2)}" height="${r(rect.height)}" fill="${first}" />`);
        ctx.svgParts.push(`${indent}<rect x="${r(rect.x + thickness / 2)}" y="${r(rect.y)}" width="${r(thickness / 2)}" height="${r(rect.height)}" fill="${second}" />`);
      }
    }
  }
  return true;
}

export function paintBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  width: number,
  height: number,
  borderWidth: number,
  borderColor: ReturnType<typeof parseColor>,
  suppressEmptyCell: boolean,
  useInlineFragments: boolean,
  offGridCollapsedCells: Set<CapturedElement>,
): void {
  // Border-image: if a URL source with intrinsic dimensions is present,
  // emit a 9-slice composition and SKIP the plain-border fallback below.
  // Gradient sources are not supported in this pass (tracked as follow-up).
  const borderImageMarkup = useInlineFragments
    ? { svg: "", usedIds: 0 }
    : renderBorderImage(el, indent, ctx.idPrefix, ctx.defsParts, ctx.peekClipIdx());
  if (borderImageMarkup.usedIds > 0) ctx.advanceClipIdx(borderImageMarkup.usedIds);
  const borderImagePainted = borderImageMarkup.svg !== "";
  if (borderImagePainted) ctx.svgParts.push(borderImageMarkup.svg);

  // Border — uniform or per-side. Skipped when a border-image painted above.
  const bt = parseSide(el.styles.borderTopWidth, el.styles.borderTopStyle, el.styles.borderTopColor);
  const br = parseSide(el.styles.borderRightWidth, el.styles.borderRightStyle, el.styles.borderRightColor);
  const bb = parseSide(el.styles.borderBottomWidth, el.styles.borderBottomStyle, el.styles.borderBottomColor);
  const bl = parseSide(el.styles.borderLeftWidth, el.styles.borderLeftStyle, el.styles.borderLeftColor);
  const uniform = bt != null && br != null && bb != null && bl != null
    && bt.w === br.w && br.w === bb.w && bb.w === bl.w
    && bt.style === br.style && br.style === bb.style && bb.style === bl.style
    && sameColor(bt.color, br.color) && sameColor(br.color, bb.color) && sameColor(bb.color, bl.color);

  // <fieldset>+<legend> notch: clip the border drawing to exclude the
  // legend's bbox so the top border breaks behind the legend, matching
  // Chrome's UA fieldset paint. DM-342/DM-343.
  let notchedBorderOpen = false;
  if (el.fieldsetLegendNotch != null) {
    const ln = el.fieldsetLegendNotch;
    const notchId = ctx.nextClipId("fln");
    ctx.defsParts.push(
      `<clipPath id="${notchId}" clip-rule="evenodd"><path d="M 0 0 L ${r(width)} 0 L ${r(width)} ${r(height)} L 0 ${r(height)} Z M ${r(ln.x)} ${r(ln.y)} L ${r(ln.x + ln.w)} ${r(ln.y)} L ${r(ln.x + ln.w)} ${r(ln.y + ln.h)} L ${r(ln.x)} ${r(ln.y + ln.h)} Z" clip-rule="evenodd"/></clipPath>`,
    );
    ctx.svgParts.push(`${indent}<g clip-path="url(#${notchId})">`);
    notchedBorderOpen = true;
  }

  // Collapsed table borders belong to TablePainter, after all table-part
  // backgrounds. The post-child inline phase emits their table-owned rects;
  // suppress the ordinary per-box border here without painting them early.
  if (!borderImagePainted && el.styles.collapsedBorderRects != null) {
    if (notchedBorderOpen) ctx.svgParts.push(`${indent}</g>`);
    return;
  }

  if (suppressEmptyCell) {
    // empty-cells: hide — suppress the border too.
  } else if (useInlineFragments) {
    // Border painted per-fragment in renderInlineFragments above.
  } else if (borderImagePainted) {
    // Border visual came from border-image. Skip the plain-border emission.
  } else if (uniform && bt != null && bt.w > 0) {
    const style = bt.style;
    if (style === "double" && bt.w >= 3) {
      paintUniformDoubleBorder(ctx, el, indent, corners, bt, offGridCollapsedCells);
    } else if ((style === "groove" || style === "ridge" || style === "inset" || style === "outset") && bt.w >= 1) {
      paintBevelBorder(ctx, el, indent, bt);
    } else if ((style === "dashed" || style === "dotted") && corners.uniform && corners.tl.h === 0) {
      paintUniformDashedDottedBorder(ctx, el, indent, bt, offGridCollapsedCells);
    } else {
      paintUniformSolidBorder(ctx, el, indent, corners, bt, offGridCollapsedCells);
    }
  } else if (!uniform) {
    // Mixed per-side 3D bevel (e.g. ridge top/bottom + groove left/right): same
    // width + color, all four styles 3D-bevel. paintBevelBorder's uniform-STYLE
    // guard above skips it, so without this it falls through to a flat solid
    // per-side border with no bevel (DM-1275). Requires square corners (the
    // bevel trapezoid geometry assumes no radius).
    const allBevel = bt != null && br != null && bb != null && bl != null
      && bt.w > 0 && bt.w === br.w && br.w === bb.w && bb.w === bl.w
      && sameColor(bt.color, br.color) && sameColor(br.color, bb.color) && sameColor(bb.color, bl.color)
      && isBevelStyle(bt.style) && isBevelStyle(br.style) && isBevelStyle(bb.style) && isBevelStyle(bl.style)
      && corners.uniform && corners.tl.h === 0;
    if (allBevel && bt != null && br != null && bb != null && bl != null) {
      paintMixedBevelBorder(ctx, el, indent, bt.w, bt.color, { top: bt.style, right: br.style, bottom: bb.style, left: bl.style });
    } else {
      paintPerSideBorder(ctx, el, indent, corners, bt, br, bb, bl, offGridCollapsedCells);
    }
  } else if (borderWidth > 0 && borderColor != null && borderColor.a > 0.01) {
    // Legacy path for elements whose per-side captures weren't parsed cleanly.
    ctx.svgParts.push(
      `${indent}${roundedRectSvg(el.x, el.y, el.width, el.height, corners, `fill="none" stroke="${colorStr(borderColor)}" stroke-width="${r(borderWidth)}"`)}`,
    );
  }
  if (notchedBorderOpen) ctx.svgParts.push(`${indent}</g>`);
  return;
}

// Per-side border (mixed widths / styles / colors): the highest-coupling border
// strategy. Solid sides become mitered trapezoids (or annular wedges when the box
// has rounded corners); double/dashed/dotted sides become clipped <line>s. Mints
// many per-side clip ids via ctx. Extracted verbatim from paintBorder (DM-1342) —
// byte-identical (only `'\''` comment-escape artifacts cleaned to `'`).
/**
 * Emit ONE per-side border (extracted from `paintPerSideBorder`'s main emit
 * loop, DM-1458; called once per side index). Solid sides without a rounded
 * corner paint as a mitered trapezoid <polygon>; `double` sides paint two
 * parallel inset/outset <line> strokes; dashed / dotted / solid-collapsed sides
 * paint a single <line> with the right dash + linecap. Sides with a rounded
 * outer corner are skipped here — they were already emitted as annular wedges
 * by the caller. Body unchanged (the loop's `continue` becomes an early
 * `return`), so output is byte-identical.
 */
function emitBorderSide(
  ctx: PaintCtx,
  indent: string,
  i: number,
  sides: Array<[ReturnType<typeof parseSide>, number, number, number, number, number]>,
  trapezoids: Array<[ReturnType<typeof parseSide>, string]>,
  doubleSides: Array<[number, number, number, number]>,
  useTrapezoid: (side: ReturnType<typeof parseSide>) => boolean,
  hasOuterRadius: boolean,
  curvedStyledSide: boolean,
  sideClipForStyle: (i: number, side: ReturnType<typeof parseSide>) => string,
): void {
  const [side, x1, y1, x2, y2, len] = sides[i];
  if (side == null || side.w <= 0 || side.color.a < 0.01) return;
  if (side.style === "none" || side.style === "hidden") return;
  if (curvedStyledSide && (side.style === "dashed" || side.style === "dotted")) return;
  if (useTrapezoid(side)) {
    // DM-773: solid sides with rounded corners already emitted as
    // annular wedges above (geometry-correct for any radius). Skip
    // the legacy trapezoid emit so we don't double-paint.
    if (hasOuterRadius) return;
    // Emit as a polygon trapezoid that tapers correctly at corners.
    ctx.svgParts.push(
      `${indent}<polygon points="${trapezoids[i][1]}" fill="${colorStr(side.color)}" />`,
    );
    return;
  }
  if (side.style === "double" && side.w >= 3) {
    // Two parallel strokes, each w/3 wide, separated by a w/3 gap.
    // Outer stroke center sits at (sideCenter + outerNormal * w/3),
    // inner at (sideCenter + innerNormal * w/3). Each stroke = w/3 thick.
    // DM-689: works in both collapse and non-collapse modes — the
    // `(x1, y1) → (x2, y2)` side endpoints are already collapse-aware
    // upstream (inset=0 puts the side centerline ON the cell's grid
    // edge in collapse mode), so adding the ±w/3 perpendicular
    // offsets lands the outer stroke 1/3 of the way past the edge
    // and the inner stroke 1/3 of the way inside — matching Blink's
    // `CollapsedBorderPainter::PaintCollapsedDoubleBorder`.
    const { stripe: strokeW, offset: offset_ } = doubleBorderStripeGeometry(side.w);
    const [oxN, oyN, ixN, iyN] = doubleSides[i];
    const ox = oxN * offset_, oy = oyN * offset_;
    const ix = ixN * offset_, iy = iyN * offset_;
    const clipAttr = sideClipForStyle(i, side);
    ctx.svgParts.push(
      `${indent}<line x1="${r(x1 + ox)}" y1="${r(y1 + oy)}" x2="${r(x2 + ox)}" y2="${r(y2 + oy)}" stroke="${colorStr(side.color)}" stroke-width="${r(strokeW)}"${clipAttr} />`,
    );
    ctx.svgParts.push(
      `${indent}<line x1="${r(x1 + ix)}" y1="${r(y1 + iy)}" x2="${r(x2 + ix)}" y2="${r(y2 + iy)}" stroke="${colorStr(side.color)}" stroke-width="${r(strokeW)}"${clipAttr} />`,
    );
    return;
  }
  const thinDotted = side.style === "dotted" && Math.round(side.w) <= 3;
  const thickDotted = side.style === "dotted" && !thinDotted;
  const vertical = x1 === x2;
  // Blink computes the dash effect from the full side length. Only after that
  // does DrawLineWithStyle move thick-dotted endpoints inward by width / 2 so
  // the round endpoint dots remain inside the side path. The miter clip, not a
  // shortened centerline, owns mixed-side corner partitioning.
  const endpointInset = thickDotted ? side.w / 2 : 0;
  const drawX1 = vertical ? x1 : x1 + endpointInset;
  const drawY1 = vertical ? y1 + endpointInset : y1;
  const drawX2 = vertical ? x2 : x2 - endpointInset;
  const drawY2 = vertical ? y2 - endpointInset : y2;
  const { array: dash, offset } = adjustedDashAttrs(side.style, side.w, len);
  // Dotted uses `0.01 period` dasharray that needs round linecaps to
  // render as circles (DM-399). Chromium's BoxBorderPainter draws
  // dotted as "0 length dash strokes and round endcaps, producing
  // circles" (verified via Chromium source). Dashed keeps default
  // butt caps so the dash:gap ratio paints flat-ended rectangles.
  const linecap = side.style === "dotted" ? ` stroke-linecap="round"` : "";
  const clipAttr = sideClipForStyle(i, side);
  if (thinDotted) {
    ctx.svgParts.push(...paintThinDottedLine(x1, y1, x2, y2, side.w, colorStr(side.color), indent)
      .map(markup => markup.replace(" />", `${clipAttr} />`)));
    return;
  }
  // The gap is selected from the full side, but Skia starts the dash phase at
  // DrawLineWithStyle's already-inset endpoint. Rewinding by `endpointInset`
  // invents a corner-centered dot and shifts every interior dot left/up; the
  // mixed 6px bottom border visibly demonstrates that error. Keep only an
  // explicit style-owned phase (currently zero for this branch).
  const phaseOffset = offset;
  const dashAttrs = dash !== "" ? ` stroke-dasharray="${dash}"${phaseOffset !== 0 ? ` stroke-dashoffset="${r(phaseOffset)}"` : ""}` : "";
  ctx.svgParts.push(
    `${indent}<line x1="${r(drawX1)}" y1="${r(drawY1)}" x2="${r(drawX2)}" y2="${r(drawY2)}" stroke="${colorStr(side.color)}" stroke-width="${r(side.w)}"${dashAttrs}${linecap}${clipAttr} />`,
  );
}

export function paintPerSideBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  bt: ReturnType<typeof parseSide>,
  br: ReturnType<typeof parseSide>,
  bb: ReturnType<typeof parseSide>,
  bl: ReturnType<typeof parseSide>,
  offGridCollapsedCells: Set<CapturedElement>,
): void {
    const collapsedSegments = el.styles.collapsedBorderSegments;
    if (collapsedSegments != null) {
      for (const seg of collapsedSegments) {
        const side = parseSide(`${seg.width}px`, seg.style, seg.color);
        if (side == null || side.w <= 0 || side.style === "none" || side.style === "hidden") continue;
        const horizontal = seg.side === "top" || seg.side === "bottom";
        const x1 = horizontal ? el.x + el.width * seg.start : (seg.side === "left" ? el.x : el.x + el.width);
        const y1 = horizontal ? (seg.side === "top" ? el.y : el.y + el.height) : el.y + el.height * seg.start;
        const x2 = horizontal ? el.x + el.width * seg.end : x1;
        const y2 = horizontal ? y1 : el.y + el.height * seg.end;
        const len = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1);
        const { array, offset } = adjustedDashAttrs(side.style, side.w, len);
        const dash = array !== "" ? ` stroke-dasharray="${array}"${offset !== 0 ? ` stroke-dashoffset="${r(offset)}"` : ""}` : "";
        const cap = side.style === "dotted" ? ` stroke-linecap="round"` : "";
        ctx.svgParts.push(`${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(side.color)}" stroke-width="${r(side.w)}"${dash}${cap} />`);
      }
      return;
    }
    // Per-side border: emit 4 separate lines along the element edges. Lines
    // are drawn at the centerline of each border so stroke spills equally
    // inward/outward — visually close enough for typical 1-10px borders.
    // Blink constructs every straight side path across the full outer side
    // rectangle, then assigns corner ownership with the miter clip polygon.
    // Do not shorten a side because an adjacent width is larger: that retired
    // approximation changes the path length (and therefore dash phase) before
    // clipping, which is especially visible on mixed dashed/dotted joints.
    // border-collapse:collapse → paint each side ON the cell edge (not
    // inset by half-width), so two adjacent cells' shared sides overlap
    // exactly and produce a single line instead of a doubled one.
    const collapse = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
    const inset = (w: number) => collapse ? 0 : w / 2;
    const tw = bt?.w ?? 0;
    const rw = br?.w ?? 0;
    const bw = bb?.w ?? 0;
    const lw = bl?.w ?? 0;
    // Round box edges to integer device pixels so each per-side stroke
    // lands on Chrome's pixel grid. Only when border-collapse !== collapse:
    // collapsed table cells share their borders with neighbors and rounding
    // would split the shared edge between two integer rows. DM-403/405/407.
    const roundEdges = !collapse;
    const bxL = roundEdges ? Math.round(el.x) : el.x;
    const bxT = roundEdges ? Math.round(el.y) : el.y;
    const bxR = roundEdges ? Math.round(el.x + el.width) : el.x + el.width;
    const bxB = roundEdges ? Math.round(el.y + el.height) : el.y + el.height;
    const sides: Array<[typeof bt, number, number, number, number, number]> = [
      [bt, bxL, bxT + inset(tw), bxR, bxT + inset(tw), Math.max(0, bxR - bxL)],
      [br, bxR - inset(rw), bxT, bxR - inset(rw), bxB, Math.max(0, bxB - bxT)],
      [bb, bxL, bxB - inset(bw), bxR, bxB - inset(bw), Math.max(0, bxR - bxL)],
      [bl, bxL + inset(lw), bxT, bxL + inset(lw), bxB, Math.max(0, bxB - bxT)],
    ];
    // For SOLID sides (and only when not collapsed), emit each side as a
    // `<polygon>` trapezoid that meets adjacent sides at a miter — this
    // produces Chrome's BoxBorderPainter taper exactly without needing
    // the trimAdj winner-takes-corner heuristic. The trapezoid's outer
    // edge sits flush with the box outer rect, and the inner edge is
    // inset by the side's width, with the corner points meeting the
    // adjacent sides' inner edges. Dashed / dotted / double / etc. sides
    // continue to use `<line>` because they'd need a clip-path to
    // reproduce the trapezoid taper, which would clip the dashes
    // mid-pattern. DM-421.
    const useTrapezoid = (side: typeof bt) => !collapse && side != null && side.style === "solid" && side.w > 0;
    const trapezoids: Array<[typeof bt, string]> = [
      // top: outer L,T  outer R,T  inner R-rw,T+tw  inner L+lw,T+tw
      [bt, `${r(bxL)},${r(bxT)} ${r(bxR)},${r(bxT)} ${r(bxR - rw)},${r(bxT + tw)} ${r(bxL + lw)},${r(bxT + tw)}`],
      // right: outer R,T  outer R,B  inner R-rw,B-bw  inner R-rw,T+tw
      [br, `${r(bxR)},${r(bxT)} ${r(bxR)},${r(bxB)} ${r(bxR - rw)},${r(bxB - bw)} ${r(bxR - rw)},${r(bxT + tw)}`],
      // bottom: outer R,B  outer L,B  inner L+lw,B-bw  inner R-rw,B-bw
      [bb, `${r(bxR)},${r(bxB)} ${r(bxL)},${r(bxB)} ${r(bxL + lw)},${r(bxB - bw)} ${r(bxR - rw)},${r(bxB - bw)}`],
      // left: outer L,B  outer L,T  inner L+lw,T+tw  inner L+lw,B-bw
      [bl, `${r(bxL)},${r(bxB)} ${r(bxL)},${r(bxT)} ${r(bxL + lw)},${r(bxT + tw)} ${r(bxL + lw)},${r(bxB - bw)}`],
    ];
    // Per-side `double` style — emit two parallel strokes each w/3 wide
    // separated by a w/3 gap (CSS spec). DM-436. Each side has its own
    // perpendicular axis, so we offset along the inward normal.
    const doubleSides: Array<[number, number, number, number]> = [
      // For each side, the [outerOffsetX, outerOffsetY, innerOffsetX, innerOffsetY]
      // expressed as multipliers of the side's own width applied to its centerline.
      // Top: inward normal is +y. Outer stroke at center - w/3, inner at center + w/3.
      [0, -1, 0, 1], // top: outer up (toward outer edge), inner down
      [-1, 0, 1, 0], // right: outer right (outer edge), inner left
      [0, 1, 0, -1], // bottom: outer down, inner up
      [1, 0, -1, 0], // left: outer left, inner right
    ];
    // DM-697: non-solid sides (double / dashed / dotted) need the same
    // diagonal-miter clip at corners that solid sides get from the
    // trapezoid emit. Per Blink's `BoxBorderPainter::PaintOneBorderSide`,
    // each side paints into a 4-point clip region whose corners run from
    // the border-box outer rect to the inner rect — i.e., the same
    // trapezoid shape we use for solid sides. Without it our `<line>`
    // strokes spill into adjacent sides' wedges and produce square
    // corners instead of the diagonal cut Chrome paints. Build a
    // clipPath per non-solid side and wrap its emission in it.
    const sideClipForStyle = (i: number, side: typeof bt) => {
      if (collapse || side == null || side.w <= 0) return "";
      const cid = ctx.nextClipId("bs");
      ctx.defsParts.push(
        `<clipPath id="${cid}"><polygon points="${trapezoids[i][1]}"/></clipPath>`,
      );
      return ` clip-path="url(#${cid})"`;
    };
    // DM-686: border-radius + per-side borders. The trapezoids and lines
    // above hit the sharp outer-rect corners. When the element has a
    // non-zero border-radius, wrap the per-side emit in a clip-path that
    // is the rounded outer border-box, so each side's polygon / line is
    // trimmed to follow the radius arc instead of squaring off. Matches
    // Blink, which paints sides into the rounded border outline clip.
    const hasOuterRadius = !collapse && (corners.tl.h > 0 || corners.tl.v > 0
      || corners.tr.h > 0 || corners.tr.v > 0
      || corners.br.h > 0 || corners.br.v > 0
      || corners.bl.h > 0 || corners.bl.v > 0);
    // DM-773: when the box has rounded corners AND per-side mixed widths,
    // the legacy trapezoid + outer-outline-clip approach paints each side
    // as a straight rectangular strip clipped to the rounded outline. For
    // large radii (`border-radius: 50%` / circle case, or any corner whose
    // radius dominates the side's width) the rectangular strip sits
    // entirely OUTSIDE the rounded outline at most y values — the clip
    // erases the side, leaving only a thin sliver near the side's
    // midpoint. Chrome's `BoxBorderPainter` paints each side as a wedge
    // of the BORDER RING (outer outline minus inner outline) cut to the
    // side's diagonal-to-center quadrant; that approach is geometry-
    // correct for any radius. For solid sides we switch to that approach
    // here when there's a rounded corner; the non-solid branches keep
    // their existing line / double-stroke emit with the outer-outline
    // clip wrapping.
    const outerRoundedPath = hasOuterRadius
      ? roundedRectPath(bxL, bxT, bxR - bxL, bxB - bxT, corners)
      : "";
    const innerCornersForAnnular = hasOuterRadius
      ? insetCornerRadii(corners, tw, rw, bw, lw)
      : corners;
    const innerRoundedPath = hasOuterRadius
      ? roundedRectPath(
          bxL + lw, bxT + tw,
          Math.max(0, bxR - bxL - lw - rw), Math.max(0, bxB - bxT - tw - bw),
          innerCornersForAnnular,
        )
      : "";
    const annularPath = hasOuterRadius
      ? `${outerRoundedPath} ${innerRoundedPath}`
      : "";
    const hasNonRoundContour = corners.curvature != null
      && Object.values(corners.curvature).some(value => value !== 2);
    const contouredRingMaskId = hasOuterRadius && hasNonRoundContour
      ? createContouredRingMask(
          ctx, outerRoundedPath,
          bxL + lw, bxT + tw,
          Math.max(0, bxR - bxL - lw - rw), Math.max(0, bxB - bxT - tw - bw),
          innerCornersForAnnular,
        )
      : null;
    // Hyperellipses use Blink's general miter/bevel-hull quad. Round and
    // concave contours use the close-edge miter/opposite-bound branch; the
    // non-renderable concave path-intersection prerequisite is DM-2317.
    const hyperellipse = corners.curvature != null
      && Object.values(corners.curvature).every(value => value >= 2);
    const annularWedges: string[] = !hasOuterRadius ? [] : hyperellipse ? [
      hyperellipseBorderSideClipPolygon("top", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      hyperellipseBorderSideClipPolygon("right", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      hyperellipseBorderSideClipPolygon("bottom", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      hyperellipseBorderSideClipPolygon("left", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
    ] : [
      roundBorderSideClipPolygon("top", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      roundBorderSideClipPolygon("right", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      roundBorderSideClipPolygon("bottom", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
      roundBorderSideClipPolygon("left", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
    ];
    const curvedStyledSide = hasOuterRadius && !hasNonRoundContour;
    if (curvedStyledSide) {
      // Blink's curved dashed/dotted branch does not stroke four independent
      // straight sides. It strokes the complete closed border centerline for
      // every side, then clips that stroke to the side's rounded miter wedge.
      // This preserves dash continuity through the corner arc and lets the
      // side clip, rather than a line endpoint, own each mixed-color joint.
      const centerCorners = insetCornerRadii(corners, tw / 2, rw / 2, bw / 2, lw / 2);
      const centerX = bxL + lw / 2;
      const centerY = bxT + tw / 2;
      const centerW = Math.max(0, bxR - bxL - (lw + rw) / 2);
      const centerH = Math.max(0, bxB - bxT - (tw + bw) / 2);
      const centerPath = roundedRectPath(centerX, centerY, centerW, centerH, centerCorners);
      const centerLength = roundedRectPerimeter(centerW, centerH, centerCorners);
      const ringMaskId = ctx.nextClipId("bm");
      ctx.defsParts.push(`<mask id="${ringMaskId}"><path d="${annularPath}" fill="white" fill-rule="evenodd"/></mask>`);
      for (let i = 0; i < sides.length; i++) {
        const side = sides[i][0];
        if (side == null || side.w <= 0 || side.color.a < 0.01) continue;
        if (side.style !== "dashed" && side.style !== "dotted") continue;
        const thinDotted = side.style === "dotted" && Math.round(side.w) <= 3;
        // Blink expands this stroke to 2.2 * max-adjacent-width solely so its
        // raster clip can antialias the border-ring edges. SVG clips/masks are
        // vector-antialiased themselves, so preserve the resulting logical
        // ink thickness here rather than copying that Skia overdraw width.
        const strokeWidth = side.w;
        const dash = adjustedClosedDashArray(side.style, side.w, centerLength, thinDotted);
        const cid = ctx.nextClipId("bc");
        ctx.defsParts.push(`<clipPath id="${cid}"><polygon points="${annularWedges[i]}"/></clipPath>`);
        const linecap = side.style === "dotted" && !thinDotted ? ` stroke-linecap="round"` : "";
        const dashAttr = dash === "" ? "" : ` stroke-dasharray="${dash}"`;
        ctx.svgParts.push(`${indent}<path d="${centerPath}" fill="none" stroke="${colorStr(side.color)}" stroke-width="${r(strokeWidth)}"${dashAttr}${linecap} clip-path="url(#${cid})" mask="url(#${ringMaskId})" />`);
      }
    }
    // The outer-outline group still wraps the remaining non-solid branches
    // (notably double) so their straight strokes get trimmed to the rounded
    // outline. Dashed/dotted sides were emitted as closed curved paths above.
    // Solid sides emit their own annular wedge BEFORE the group
    // opens (and use their own per-side wedge clip), so they fall outside
    // this wrapping — the wedge clip is tighter than the outer outline
    // anyway.
    let roundedSideGroupOpen = false;
    if (hasOuterRadius) {
      // Emit solid sides as annular wedges first.
      for (let i = 0; i < sides.length; i++) {
        const side = sides[i][0];
        if (side == null || side.w <= 0 || side.color.a < 0.01) continue;
        if (side.style !== "solid") continue;
        const wid = ctx.nextClipId("bw");
        ctx.defsParts.push(
          `<clipPath id="${wid}"><polygon points="${annularWedges[i]}"/></clipPath>`,
        );
        ctx.svgParts.push(
          `${indent}<path d="${contouredRingMaskId == null ? annularPath : outerRoundedPath}" fill="${colorStr(side.color)}"${contouredRingMaskId == null ? ' fill-rule="evenodd"' : ` mask="url(#${contouredRingMaskId})"`} clip-path="url(#${wid})"/>`,
        );
      }
      const rcid = ctx.nextClipId("br");
      ctx.defsParts.push(
        `<clipPath id="${rcid}"><path d="${roundedRectPath(el.x, el.y, el.width, el.height, corners)}"/></clipPath>`,
      );
      ctx.svgParts.push(`${indent}<g clip-path="url(#${rcid})">`);
      roundedSideGroupOpen = true;
    }
    for (let i = 0; i < sides.length; i++) {
      emitBorderSide(ctx, indent, i, sides, trapezoids, doubleSides, useTrapezoid, hasOuterRadius, curvedStyledSide, sideClipForStyle);
    }
    if (roundedSideGroupOpen) ctx.svgParts.push(`${indent}</g>`);
}

/**
 * Per-side adjusted dash array. Chrome'\''s dashed/dotted border rasterizer
 * (see Blink `BoxPainterBase::PaintBorderSides`) sizes each side'\''s dash
 * cycle so dashes start and end exactly at the corners — otherwise the last
 * dash before a corner is partial and the pattern looks ragged.
 *
 * Algorithm: ideal period (dash + gap) is `4 * width` for dashed, `2 * width`
 * for dotted. Compute cycle count `N = round(sideLength / period)` (clamped
 * to ≥1), then scale dash and gap by `sideLength / (N * period)` so
 * `N * (dash + gap) === sideLength` exactly.
 *
 * Returns "" when style isn'\''t dashed/dotted, or when the side is too short
 * to fit even one cycle (renderer falls back to solid).
 */
export function adjustedDashArray(style: string, width: number, sideLength: number): string {
  return adjustedDashAttrs(style, width, sideLength).array;
}

function quarterEllipseLength(rx: number, ry: number): number {
  if (rx <= 0 || ry <= 0) return Math.max(rx, ry);
  // Fixed Simpson integration is deterministic and sub-millipixel accurate for
  // the CSS corner aspect ratios used here; Blink asks Path::length() for this
  // same centerline before selecting a closed-path dash gap.
  const steps = 64;
  const h = (Math.PI / 2) / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i * h;
    const speed = Math.hypot(rx * Math.sin(t), ry * Math.cos(t));
    sum += speed * (i === 0 || i === steps ? 1 : i % 2 === 0 ? 2 : 4);
  }
  return sum * h / 3;
}

export function roundedRectPerimeter(width: number, height: number, corners: CornerRadii): number {
  const horizontal = Math.max(0, width - corners.tl.h - corners.tr.h)
    + Math.max(0, width - corners.bl.h - corners.br.h);
  const vertical = Math.max(0, height - corners.tl.v - corners.bl.v)
    + Math.max(0, height - corners.tr.v - corners.br.v);
  return horizontal + vertical
    + quarterEllipseLength(corners.tl.h, corners.tl.v)
    + quarterEllipseLength(corners.tr.h, corners.tr.v)
    + quarterEllipseLength(corners.br.h, corners.br.v)
    + quarterEllipseLength(corners.bl.h, corners.bl.v);
}

export function adjustedClosedDashArray(style: string, width: number, pathLength: number, thinDotted: boolean): string {
  if (pathLength <= 0 || width <= 0) return "";
  if (style === "dashed") {
    const dashLength = width * (width >= 3 ? 2 : 3);
    const targetGap = width * (width >= 3 ? 1 : 2);
    const gap = selectBestDashGap(pathLength, dashLength, targetGap, true);
    return gap > 0 ? `${r(dashLength)} ${r(gap)}` : "";
  }
  if (style === "dotted") {
    if (thinDotted) return `${r(Math.round(width))} ${r(Math.round(width))}`;
    const gap = selectBestDashGap(pathLength, width, width, true);
    return gap > 0 ? `0.01 ${r(gap + width - 0.01)}` : "";
  }
  return "";
}

/**
 * Returns the `stroke-dasharray` value AND the matching `stroke-dashoffset`
 * needed to center the dash pattern within the side so it visually matches
 * Chromium's BoxBorderPainter (DM-318).
 *
 * For dotted: Chromium centers each dot in its half-period slot — i.e. dots
 *   are inset from each corner by half a period rather than starting flush.
 *   In SVG terms, the dasharray is `0.01 period` with linecap=round (so each
 *   "dash" renders as a single dot), and stroke-dashoffset is set to half a
 *   period so the line starts mid-gap and the first dot appears at period/2.
 *
 * For dashed: Chromium also tends to center the dash pattern — the first
 *   dash starts at gap/2 from the corner so each side has equal margin. The
 *   prior implementation started the cycle with a full dash flush at the
 *   corner, which left a visible phase offset vs Chrome's painted output.
 *
 * Returns offset as a number (0 if no shift needed), the caller emits a
 * `stroke-dashoffset` attribute when offset !== 0.
 */
