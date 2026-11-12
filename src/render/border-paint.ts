import type { CapturedElement } from "../capture/types.js";
import { r } from "./format.js";
import { parseColor, colorStr, sameColor } from "./colors.js";
import {
  parseSide,
  parseCornerRadii,
  renderBorderImage,
  insetCornerRadii,
  roundedRectPath,
  roundedRectSvg,
  roundBorderSideClipPolygon,
  hyperellipseBorderSideClipPolygon,
  contouredRectIntersectionPaths,
  doubleBorderStripeGeometry,
  blinkCurvedDashPathLength,
  pixelSnappedBorderReferenceRect,
  uniformDoubleBorderStripeBoxes,
  type CornerRadii,
} from "./borders.js";
import { paintThinDottedLine } from "./outline-paint.js";
import { closedDashArray, openDashArray, isThinDotted, DOUBLE_MIN_WIDTH } from "./stroke-style.js";
import type { PaintCtx } from "./element-tree-to-svg.js";

type BevelSide = "top" | "right" | "bottom" | "left";
type BevelColor = { r: number; g: number; b: number; a: number };

// Color::QuantizeTo8Bit (platform/graphics/color.cc:156, chromium 6b5a1b80):
// truncates against nextafter(256, 0) rather than rounding.
const quantizeTo8Bit = (unit: number): number => Math.floor(unit * 255.99998);

/** Color::Dark (color.cc:1165): scale every channel by (v - 0.33) / v, where v
 * is the largest sRGB channel; white is hardcoded to 171. */
function blinkDark(color: BevelColor): BevelColor {
  if (color.r === 255 && color.g === 255 && color.b === 255 && color.a === 1) return { r: 171, g: 171, b: 171, a: 1 };
  const v = Math.max(color.r, color.g, color.b) / 255;
  const multiplier = v === 0 ? 0 : Math.max(0, (v - 0.33) / v);
  const scale = (channel: number) => quantizeTo8Bit((channel / 255) * multiplier);
  return { r: scale(color.r), g: scale(color.g), b: scale(color.b), a: color.a };
}

/** Color::Light (color.cc:1138): scale by min(1, v + 0.33) / v; black becomes 84,84,84. */
function blinkLight(color: BevelColor): BevelColor {
  const v = Math.max(color.r, color.g, color.b) / 255;
  if (v === 0) return { r: 84, g: 84, b: 84, a: color.a };
  const multiplier = Math.min(1, v + 0.33) / v;
  const scale = (channel: number) => quantizeTo8Bit((channel / 255) * multiplier);
  return { r: scale(color.r), g: scale(color.g), b: scale(color.b), a: color.a };
}

// ui/gfx/color_utils.cc Linearize / GetRelativeLuminance4f / GetContrastRatio.
const linearize = (unit: number): number => (unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4);
const relativeLuminance = (color: BevelColor): number =>
  0.2126 * linearize(color.r / 255) + 0.7152 * linearize(color.g / 255) + 0.0722 * linearize(color.b / 255);
function contrastRatio(a: BevelColor, b: BevelColor): number {
  const la = relativeLuminance(a) + 0.05;
  const lb = relativeLuminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

/** CalculateInsetOutsetColor (core/paint/box_border_painter.cc:616, chromium
 * 6b5a1b80): the dark edge is Color::Dark(); the light edge is the color
 * itself unless it contrasts with that dark edge by less than 1.75, in which
 * case it is Color::Light(). */
export function bevelShades(color: BevelColor, style: string, side: BevelSide): { outer: string; inner: string } {
  const darkColor = blinkDark(color);
  const lightColor =
    color.r >= 150 || color.g >= 92 || contrastRatio(color, darkColor) >= 1.75 ? color : blinkLight(color);
  const dark = colorStr(darkColor);
  const light = colorStr(lightColor);
  const topLeft = side === "top" || side === "left";
  const outerLight = (style === "ridge" || style === "outset") === topLeft;
  return { outer: outerLight ? light : dark, inner: outerLight ? dark : light };
}

/** BoxBorderPainter's paint order for one opacity group of equal-priority
 * 3D sides: kSidePriority sorts top, bottom, right, left (chromium 6b5a1b80). */
export const BEVEL_PAINT_ORDER = ["top", "bottom", "right", "left"] as const;

/** Bevel side geometry in Blink's paint model (box_border_painter.cc at
 * 6b5a1b80). Top and bottom paint first; their adjacent sides will still
 * overdraw the corners (WillOverdraw), so they take no miter and fill
 * full-width bands. Right and left paint last with anti-aliased miters over
 * those bands, so each corner join is opaque with the two colors mixed
 * instead of leaving a seam between two anti-aliased polygons.
 * DrawRidgeOrGrooveBoxSide splits each side at (y1 + y2 + 1) / 2, so the half
 * nearer the top/left edge of the side's own band is ceil(w / 2): the outer
 * half of top/left and the inner half of bottom/right. */
export function bevelSidePolygons(
  el: CapturedElement,
  w: number,
): Record<BevelSide, { full: string; outer: string; inner: string }> {
  const x0 = el.x,
    y0 = el.y,
    x1 = el.x + el.width,
    y1 = el.y + el.height;
  const big = Math.ceil(w / 2);
  const small = w - big;
  const band = (top: number, bottom: number) =>
    `${r(x0)},${r(top)} ${r(x1)},${r(top)} ${r(x1)},${r(bottom)} ${r(x0)},${r(bottom)}`;
  return {
    top: {
      full: band(y0, y0 + w),
      outer: band(y0, y0 + big),
      inner: band(y0 + big, y0 + w),
    },
    right: {
      full: `${r(x1)},${r(y0)} ${r(x1)},${r(y1)} ${r(x1 - w)},${r(y1 - w)} ${r(x1 - w)},${r(y0 + w)}`,
      outer: `${r(x1)},${r(y0)} ${r(x1)},${r(y1)} ${r(x1 - small)},${r(y1 - small)} ${r(x1 - small)},${r(y0 + small)}`,
      inner: `${r(x1 - small)},${r(y0 + small)} ${r(x1 - small)},${r(y1 - small)} ${r(x1 - w)},${r(y1 - w)} ${r(x1 - w)},${r(y0 + w)}`,
    },
    bottom: {
      full: band(y1 - w, y1),
      outer: band(y1 - small, y1),
      inner: band(y1 - w, y1 - small),
    },
    left: {
      full: `${r(x0)},${r(y0)} ${r(x0)},${r(y1)} ${r(x0 + w)},${r(y1 - w)} ${r(x0 + w)},${r(y0 + w)}`,
      outer: `${r(x0)},${r(y0)} ${r(x0)},${r(y1)} ${r(x0 + big)},${r(y1 - big)} ${r(x0 + big)},${r(y0 + big)}`,
      inner: `${r(x0 + big)},${r(y0 + big)} ${r(x0 + big)},${r(y1 - big)} ${r(x0 + w)},${r(y1 - w)} ${r(x0 + w)},${r(y0 + w)}`,
    },
  };
}

export function paintBevelBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  bt: NonNullable<ReturnType<typeof parseSide>>,
): void {
  paintMixedBevelBorder(ctx, el, indent, bt.w, bt.color, {
    top: bt.style,
    right: bt.style,
    bottom: bt.style,
    left: bt.style,
  });
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
  const polygons = bevelSidePolygons(el, w);
  for (const side of BEVEL_PAINT_ORDER) {
    const style = styles[side];
    const shades = bevelShades(color, style, side);
    const shape = polygons[side];
    if (style === "inset" || style === "outset") {
      ctx.svgParts.push(`${indent}<polygon points="${shape.full}" fill="${shades.outer}" />`);
    } else {
      ctx.svgParts.push(`${indent}<polygon points="${shape.outer}" fill="${shades.outer}" />`);
      ctx.svgParts.push(`${indent}<polygon points="${shape.inner}" fill="${shades.inner}" />`);
    }
  }
}

// Uniform `double` border: two parallel strokes each 1/3 of border width with a
// 1/3 gap, using the collapse mode resolved by paintBorder.
function paintUniformDoubleBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  bt: NonNullable<ReturnType<typeof parseSide>>,
  collapse: boolean,
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
  collapse: boolean,
): void {
  const style = bt.style;
  const thinDotted = style === "dotted" && isThinDotted(bt.w);
  // Dashed/dotted uniform borders need per-side dash spacing — Chrome
  // adjusts the dash cycle so dashes start and end exactly at corners.
  // SVG `stroke-dasharray` on a single rect would use ONE pattern across
  // all 4 sides, but the top/bottom and left/right have different
  // lengths, so the pattern would mis-align at every corner. Emit 4
  // lines instead so each side gets its own adjusted pattern.
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
  //     that is necessary for `openDashArray` (which assumes a
  //     post-move sideLength) to compute Chrome-equivalent dot
  //     centers. The adjacent sides' first dots overlap at the
  //     corner, producing one visible corner dot. (DM-805.)
  //   • Dashed thick (≥ 8 px): legacy corner-overlap prevention so
  //     butt-cap dashes don't double-paint the corner pixel as a
  //     darker square (DM-402, visible on the 10 px dashed border
  //     in `17-bg-color-image`). Thin dashed borders use 0 trim
  //     so the dashes meet flush at the corner, matching Chrome
  //     for the common 1-3 px cases.
  const cornerTrim = style === "dotted" && !thinDotted ? bt.w / 2 : bt.w >= 8 ? inset : 0;
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
    const dash = openDashArray(style, bt.w, len);
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
    // Thick dotted sides are the exception: Blink's DrawLineWithStyle moves
    // the endpoints in itself and strokes from the moved start with dash
    // phase 0 (box_border_painter.cc:529-538, styled_stroke_data.cc:156,
    // chromium 7d859f27), so the first dot sits exactly at the inset start.
    const phaseOffset = style === "dotted" ? 0 : cornerTrim;
    const dashAttrs =
      dash !== ""
        ? ` stroke-dasharray="${dash}"${phaseOffset !== 0 ? ` stroke-dashoffset="${r(phaseOffset)}"` : ""}`
        : "";
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
  constraints.forEach((path, index) =>
    ctx.defsParts.push(`<clipPath id="${clipIds[index]}"><path d="${path}"/></clipPath>`),
  );
  const nestedOpen = clipIds.map((id) => `<g clip-path="url(#${id})">`).join("");
  const nestedClose = "</g>".repeat(clipIds.length);
  const maskId = ctx.nextClipId("crm");
  const pad = Math.max(width, height, 1) * 4 + 1;
  ctx.defsParts.push(
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" mask-type="luminance" x="${r(x - pad)}" y="${r(y - pad)}" width="${r(width + pad * 2)}" height="${r(height + pad * 2)}"><path d="${outerPath}" fill="white"/>${nestedOpen}<rect x="${r(x)}" y="${r(y)}" width="${r(width)}" height="${r(height)}" fill="black"/>${nestedClose}</mask>`,
  );
  return maskId;
}

// Uniform solid border, also used for dashed/dotted rounded contours: a single
// inset, device-pixel-rounded rounded-rect stroke.
function paintUniformSolidBorder(
  ctx: PaintCtx,
  el: CapturedElement,
  indent: string,
  corners: ReturnType<typeof parseCornerRadii>,
  bt: NonNullable<ReturnType<typeof parseSide>>,
  collapse: boolean,
): void {
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
  const half = collapse ? 0 : bt.w / 2;
  const strokeCorners = insetCornerRadii(corners, half, half, half, half);
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
  const dash = closedDashArray(
    bt.style,
    bt.w,
    blinkCurvedDashPathLength(
      Math.max(0, boxRight - boxLeft - half * 2),
      Math.max(0, boxBottom - boxTop - half * 2),
      strokeCorners,
    ),
  );
  const dashAttr = dash !== "" ? ` stroke-dasharray="${dash}"` : "";
  const linecap = bt.style === "dotted" && !isThinDotted(bt.w) ? ` stroke-linecap="round"` : "";
  const hasNonRoundContour = corners.curvature != null && Object.values(corners.curvature).some((value) => value !== 2);
  // Blink paints non-round borders as the area between its outer and aligned
  // inner ContouredRects. An SVG centerline stroke cannot represent a concave
  // contour (it protrudes on the wrong side of a scoop/notch), so preserve the
  // same two vector boundaries and fill the annulus with even-odd winding.
  if (hasNonRoundContour && !collapse && bt.style === "solid") {
    const outer = roundedRectPath(boxLeft, boxTop, boxRight - boxLeft, boxBottom - boxTop, corners);
    const innerCorners = insetCornerRadii(corners, bt.w, bt.w, bt.w, bt.w);
    const innerX = boxLeft + bt.w,
      innerY = boxTop + bt.w;
    const innerW = Math.max(0, boxRight - boxLeft - bt.w * 2),
      innerH = Math.max(0, boxBottom - boxTop - bt.w * 2);
    const maskId = createContouredRingMask(ctx, outer, innerX, innerY, innerW, innerH, innerCorners);
    if (maskId != null) {
      ctx.svgParts.push(`${indent}<path d="${outer}" fill="${colorStr(bt.color)}" mask="url(#${maskId})"/>`);
    } else {
      const inner = roundedRectPath(innerX, innerY, innerW, innerH, innerCorners);
      ctx.svgParts.push(`${indent}<path d="${outer} ${inner}" fill="${colorStr(bt.color)}" fill-rule="evenodd"/>`);
    }
    return;
  }
  const hasRadius = [corners.tl, corners.tr, corners.br, corners.bl].some((c) => c.h > 0 && c.v > 0);
  if ((bt.style === "dashed" || bt.style === "dotted") && !collapse && hasRadius && !hasNonRoundContour) {
    paintBlinkCurvedDashedDottedBorder(ctx, indent, corners, bt, boxLeft, boxTop, boxRight, boxBottom);
    return;
  }
  ctx.svgParts.push(
    `${indent}${roundedRectSvg(boxLeft + half, boxTop + half, Math.max(0, boxRight - boxLeft - half * 2), Math.max(0, boxBottom - boxTop - half * 2), strokeCorners, `fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(bt.w)}"${dashAttr}${linecap}`)}`,
  );
}

/** Blink's `DrawCurvedDashedDottedBoxSide` geometry for a round-cornered uniform
 * border (box_border_painter.cc:1827-1860, 2477-2483, chromium 7d859f27). The
 * stroked "centerline" is the snapped border rect inset by
 * `PhysicalBoxStrut::FromInts(width * 0.5)`, which truncates, so a 1px border
 * strokes its outer edge and a 3px border an inset of 1, with radii shrunk to
 * match. The dash gap is fitted to the truncated Skia length of that contour.
 * Dashes and thin dots are stroked at 2.2 × width and clipped to the border
 * ring; thick round dots keep the border width. */
export function paintBlinkCurvedDashedDottedBorder(
  ctx: PaintCtx,
  indent: string,
  corners: CornerRadii,
  bt: NonNullable<ReturnType<typeof parseSide>>,
  boxLeft: number,
  boxTop: number,
  boxRight: number,
  boxBottom: number,
): void {
  const w = bt.w;
  const k = Math.floor(Math.round(w) / 2);
  const centerCorners = insetCornerRadii(corners, k, k, k, k);
  const centerW = Math.max(0, boxRight - boxLeft - 2 * k);
  const centerH = Math.max(0, boxBottom - boxTop - 2 * k);
  const dash = closedDashArray(bt.style, w, blinkCurvedDashPathLength(centerW, centerH, centerCorners));
  const roundDots = bt.style === "dotted" && !isThinDotted(w);
  const strokeWidth = roundDots ? w : w * BLINK_CURVED_BORDER_CLIP_OVERDRAW;
  const outer = roundedRectPath(boxLeft, boxTop, boxRight - boxLeft, boxBottom - boxTop, corners);
  const inner = roundedRectPath(
    boxLeft + w,
    boxTop + w,
    Math.max(0, boxRight - boxLeft - 2 * w),
    Math.max(0, boxBottom - boxTop - 2 * w),
    insetCornerRadii(corners, w, w, w, w),
  );
  const maskId = ctx.nextClipId("bm");
  ctx.defsParts.push(`<mask id="${maskId}"><path d="${outer} ${inner}" fill="white" fill-rule="evenodd"/></mask>`);
  const dashAttr = dash !== "" ? ` stroke-dasharray="${dash}"` : "";
  const linecap = roundDots ? ` stroke-linecap="round"` : "";
  ctx.svgParts.push(
    `${indent}<path d="${roundedRectPath(boxLeft + k, boxTop + k, centerW, centerH, centerCorners)}" fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(strokeWidth)}"${dashAttr}${linecap} mask="url(#${maskId})" />`,
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
      ctx.svgParts.push(
        `${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}" fill="${fill}" />`,
      );
      continue;
    }
    if (rect.style === "double" && thickness >= DOUBLE_MIN_WIDTH) {
      // TableSectionPainter paints each collapsed edge through
      // BoxBorderPainter::DrawBoxSide → DrawDoubleBoxSide with no adjacent
      // widths, on the pixel-snapped edge rect. Its stripe is the integer
      // `(thickness + 1) / 3` (box_border_painter.cc:678, chromium 7d859f27),
      // so a 4px edge paints 1px / 2px gap / 1px rather than three 4/3px bands.
      const { stripe } = doubleBorderStripeGeometry(thickness);
      if (horizontal) {
        ctx.svgParts.push(
          `${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(stripe)}" fill="${fill}" />`,
        );
        ctx.svgParts.push(
          `${indent}<rect x="${r(rect.x)}" y="${r(rect.y + thickness - stripe)}" width="${r(rect.width)}" height="${r(stripe)}" fill="${fill}" />`,
        );
      } else {
        ctx.svgParts.push(
          `${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(stripe)}" height="${r(rect.height)}" fill="${fill}" />`,
        );
        ctx.svgParts.push(
          `${indent}<rect x="${r(rect.x + thickness - stripe)}" y="${r(rect.y)}" width="${r(stripe)}" height="${r(rect.height)}" fill="${fill}" />`,
        );
      }
      continue;
    }
    if (rect.style === "dotted" && isThinDotted(thickness)) {
      // Thin dots take DrawLineWithStyle's EnforceDotsAtEndpoints branch on the
      // full snapped edge and its centerline (box_border_painter.cc:521-527,
      // chromium 7d859f27), the same rule paintThinDottedLine mirrors for
      // uniform borders.
      const mid = thickness / 2;
      ctx.svgParts.push(
        ...(horizontal
          ? paintThinDottedLine(rect.x, rect.y + mid, rect.x + rect.width, rect.y + mid, thickness, fill, indent)
          : paintThinDottedLine(rect.x + mid, rect.y, rect.x + mid, rect.y + rect.height, thickness, fill, indent)),
      );
      continue;
    }
    if (rect.style === "dashed" || rect.style === "dotted") {
      const clipId = ctx.nextClipId("cb");
      ctx.defsParts.push(
        `<clipPath id="${clipId}"><rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}"/></clipPath>`,
      );
      const array = openDashArray(rect.style, thickness, length);
      const dash = array !== "" ? ` stroke-dasharray="${array}"` : "";
      const roundDots = rect.style === "dotted" && !isThinDotted(thickness);
      const cap = roundDots ? ` stroke-linecap="round"` : "";
      // Blink's DrawLineWithStyle sizes the dash intervals from the full edge
      // `length` above, then moves thick-dotted endpoints in by width/2 so the
      // round caps stay inside the edge, and strokes with dash phase 0 from the
      // moved start (box_border_painter.cc:515-538, styled_stroke_data.cc:156,
      // chromium 7d859f27).
      const capInset = roundDots ? thickness / 2 : 0;
      const x1 = horizontal ? rect.x + capInset : rect.x + thickness / 2;
      const y1 = horizontal ? rect.y + thickness / 2 : rect.y + capInset;
      const x2 = horizontal ? rect.x + rect.width - capInset : x1;
      const y2 = horizontal ? y1 : rect.y + rect.height - capInset;
      ctx.svgParts.push(
        `${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${fill}" stroke-width="${r(thickness)}"${dash}${cap} clip-path="url(#${clipId})" />`,
      );
      continue;
    }
    if (isBevelStyle(rect.style)) {
      const shades = bevelShades(color, rect.style, "top");
      const first = shades.outer;
      const second = rect.style === "groove" || rect.style === "ridge" ? shades.inner : first;
      if (rect.style === "inset" || rect.style === "outset") {
        ctx.svgParts.push(
          `${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(rect.height)}" fill="${first}" />`,
        );
      } else if (horizontal) {
        ctx.svgParts.push(
          `${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.width)}" height="${r(thickness / 2)}" fill="${first}" />`,
        );
        ctx.svgParts.push(
          `${indent}<rect x="${r(rect.x)}" y="${r(rect.y + thickness / 2)}" width="${r(rect.width)}" height="${r(thickness / 2)}" fill="${second}" />`,
        );
      } else {
        ctx.svgParts.push(
          `${indent}<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(thickness / 2)}" height="${r(rect.height)}" fill="${first}" />`,
        );
        ctx.svgParts.push(
          `${indent}<rect x="${r(rect.x + thickness / 2)}" y="${r(rect.y)}" width="${r(thickness / 2)}" height="${r(rect.height)}" fill="${second}" />`,
        );
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
  const borderCollapseMode = el.styles.borderCollapse === "collapse" && !offGridCollapsedCells.has(el);
  if (borderImagePainted) ctx.svgParts.push(borderImageMarkup.svg);

  // Border — uniform or per-side. Skipped when a border-image painted above.
  const bt = parseSide(el.styles.borderTopWidth, el.styles.borderTopStyle, el.styles.borderTopColor);
  const br = parseSide(el.styles.borderRightWidth, el.styles.borderRightStyle, el.styles.borderRightColor);
  const bb = parseSide(el.styles.borderBottomWidth, el.styles.borderBottomStyle, el.styles.borderBottomColor);
  const bl = parseSide(el.styles.borderLeftWidth, el.styles.borderLeftStyle, el.styles.borderLeftColor);
  const uniform =
    bt != null &&
    br != null &&
    bb != null &&
    bl != null &&
    bt.w === br.w &&
    br.w === bb.w &&
    bb.w === bl.w &&
    bt.style === br.style &&
    br.style === bb.style &&
    bb.style === bl.style &&
    sameColor(bt.color, br.color) &&
    sameColor(br.color, bb.color) &&
    sameColor(bb.color, bl.color);

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
    if (style === "double" && bt.w >= DOUBLE_MIN_WIDTH) {
      paintUniformDoubleBorder(ctx, el, indent, corners, bt, borderCollapseMode);
    } else if ((style === "groove" || style === "ridge" || style === "inset" || style === "outset") && bt.w >= 1) {
      paintBevelBorder(ctx, el, indent, bt);
    } else if ((style === "dashed" || style === "dotted") && corners.uniform && corners.tl.h === 0) {
      paintUniformDashedDottedBorder(ctx, el, indent, bt, borderCollapseMode);
    } else {
      paintUniformSolidBorder(ctx, el, indent, corners, bt, borderCollapseMode);
    }
  } else if (!uniform) {
    // Mixed per-side 3D bevel (e.g. ridge top/bottom + groove left/right): same
    // width + color, all four styles 3D-bevel. paintBevelBorder's uniform-STYLE
    // guard above skips it, so without this it falls through to a flat solid
    // per-side border with no bevel (DM-1275). Requires square corners (the
    // bevel trapezoid geometry assumes no radius).
    const allBevel =
      bt != null &&
      br != null &&
      bb != null &&
      bl != null &&
      bt.w > 0 &&
      bt.w === br.w &&
      br.w === bb.w &&
      bb.w === bl.w &&
      sameColor(bt.color, br.color) &&
      sameColor(br.color, bb.color) &&
      sameColor(bb.color, bl.color) &&
      isBevelStyle(bt.style) &&
      isBevelStyle(br.style) &&
      isBevelStyle(bb.style) &&
      isBevelStyle(bl.style) &&
      corners.uniform &&
      corners.tl.h === 0;
    if (allBevel && bt != null && br != null && bb != null && bl != null) {
      paintMixedBevelBorder(ctx, el, indent, bt.w, bt.color, {
        top: bt.style,
        right: br.style,
        bottom: bb.style,
        left: bl.style,
      });
    } else {
      paintPerSideBorder(ctx, el, indent, corners, bt, br, bb, bl, borderCollapseMode);
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
// many per-side clip ids via ctx.
interface SideGeometry {
  side: ReturnType<typeof parseSide>;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
  polygon: string;
  doubleNormals: readonly [number, number, number, number];
}

/** `kThicknessMultiplier` in DrawCurvedDashedDottedBoxSide (2 × 1.1): Blink's
 * curved dash/thin-dot stroke is doubled because its truncated centerline can
 * sit on the ring's outer edge, plus 10% so the ring clip owns the edge. The
 * SVG keeps the same width and the same ring clip (doc 127). */
export const BLINK_CURVED_BORDER_CLIP_OVERDRAW = 2.2;

/**
 * Emit one per-side border. Solid sides without a rounded
 * corner paint as a mitered trapezoid <polygon>; `double` sides paint two
 * parallel inset/outset <line> strokes; dashed / dotted / solid-collapsed sides
 * paint a single <line> with the right dash + linecap. Sides with a rounded
 * outer corner are skipped here because the caller already emitted annular wedges.
 */
function emitBorderSide(
  ctx: PaintCtx,
  indent: string,
  geometry: SideGeometry,
  collapse: boolean,
  hasOuterRadius: boolean,
  curvedStyledSide: boolean,
  sideClipForStyle: (geometry: SideGeometry) => string,
): void {
  const { side, x1, y1, x2, y2, length: len } = geometry;
  if (side == null || side.w <= 0 || side.color.a < 0.01) return;
  if (side.style === "none" || side.style === "hidden") return;
  if (curvedStyledSide && (side.style === "dashed" || side.style === "dotted")) return;
  if (!collapse && side.style === "solid") {
    // DM-773: solid sides with rounded corners already emitted as
    // annular wedges above (geometry-correct for any radius). Skip
    // the legacy trapezoid emit so we don't double-paint.
    if (hasOuterRadius) return;
    // Emit as a polygon trapezoid that tapers correctly at corners.
    ctx.svgParts.push(`${indent}<polygon points="${geometry.polygon}" fill="${colorStr(side.color)}" />`);
    return;
  }
  if (side.style === "double" && side.w >= DOUBLE_MIN_WIDTH) {
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
    const [oxN, oyN, ixN, iyN] = geometry.doubleNormals;
    const ox = oxN * offset_,
      oy = oyN * offset_;
    const ix = ixN * offset_,
      iy = iyN * offset_;
    const clipAttr = sideClipForStyle(geometry);
    ctx.svgParts.push(
      `${indent}<line x1="${r(x1 + ox)}" y1="${r(y1 + oy)}" x2="${r(x2 + ox)}" y2="${r(y2 + oy)}" stroke="${colorStr(side.color)}" stroke-width="${r(strokeW)}"${clipAttr} />`,
    );
    ctx.svgParts.push(
      `${indent}<line x1="${r(x1 + ix)}" y1="${r(y1 + iy)}" x2="${r(x2 + ix)}" y2="${r(y2 + iy)}" stroke="${colorStr(side.color)}" stroke-width="${r(strokeW)}"${clipAttr} />`,
    );
    return;
  }
  const thinDotted = side.style === "dotted" && isThinDotted(side.w);
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
  const dash = openDashArray(side.style, side.w, len);
  // Dotted uses `0.01 period` dasharray that needs round linecaps to
  // render as circles (DM-399). Chromium's BoxBorderPainter draws
  // dotted as "0 length dash strokes and round endcaps, producing
  // circles" (verified via Chromium source). Dashed keeps default
  // butt caps so the dash:gap ratio paints flat-ended rectangles.
  const linecap = side.style === "dotted" && !isThinDotted(side.w) ? ` stroke-linecap="round"` : "";
  const clipAttr = sideClipForStyle(geometry);
  if (thinDotted) {
    ctx.svgParts.push(
      ...paintThinDottedLine(x1, y1, x2, y2, side.w, colorStr(side.color), indent).map((markup) =>
        markup.replace(" />", `${clipAttr} />`),
      ),
    );
    return;
  }
  const dashAttrs = dash !== "" ? ` stroke-dasharray="${dash}"` : "";
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
  collapse: boolean,
): void {
  const collapsedSegments = el.styles.collapsedBorderSegments;
  if (collapsedSegments != null) {
    for (const seg of collapsedSegments) {
      const side = parseSide(`${seg.width}px`, seg.style, seg.color);
      if (side == null || side.w <= 0 || side.style === "none" || side.style === "hidden") continue;
      const horizontal = seg.side === "top" || seg.side === "bottom";
      const x1 = horizontal ? el.x + el.width * seg.start : seg.side === "left" ? el.x : el.x + el.width;
      const y1 = horizontal ? (seg.side === "top" ? el.y : el.y + el.height) : el.y + el.height * seg.start;
      const x2 = horizontal ? el.x + el.width * seg.end : x1;
      const y2 = horizontal ? y1 : el.y + el.height * seg.end;
      const len = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1);
      const array = openDashArray(side.style, side.w, len);
      const dash = array !== "" ? ` stroke-dasharray="${array}"` : "";
      const cap = side.style === "dotted" && !isThinDotted(side.w) ? ` stroke-linecap="round"` : "";
      ctx.svgParts.push(
        `${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(side.color)}" stroke-width="${r(side.w)}"${dash}${cap} />`,
      );
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
  const inset = (w: number) => (collapse ? 0 : w / 2);
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
  // One record per side keeps its centerline, miter clip, and double-stroke
  // normals together. The clockwise order also owns rounded wedge indexing.
  const sides: SideGeometry[] = [
    {
      side: bt,
      x1: bxL,
      y1: bxT + inset(tw),
      x2: bxR,
      y2: bxT + inset(tw),
      length: Math.max(0, bxR - bxL),
      polygon: `${r(bxL)},${r(bxT)} ${r(bxR)},${r(bxT)} ${r(bxR - rw)},${r(bxT + tw)} ${r(bxL + lw)},${r(bxT + tw)}`,
      doubleNormals: [0, -1, 0, 1],
    },
    {
      side: br,
      x1: bxR - inset(rw),
      y1: bxT,
      x2: bxR - inset(rw),
      y2: bxB,
      length: Math.max(0, bxB - bxT),
      polygon: `${r(bxR)},${r(bxT)} ${r(bxR)},${r(bxB)} ${r(bxR - rw)},${r(bxB - bw)} ${r(bxR - rw)},${r(bxT + tw)}`,
      doubleNormals: [-1, 0, 1, 0],
    },
    {
      side: bb,
      x1: bxL,
      y1: bxB - inset(bw),
      x2: bxR,
      y2: bxB - inset(bw),
      length: Math.max(0, bxR - bxL),
      polygon: `${r(bxR)},${r(bxB)} ${r(bxL)},${r(bxB)} ${r(bxL + lw)},${r(bxB - bw)} ${r(bxR - rw)},${r(bxB - bw)}`,
      doubleNormals: [0, 1, 0, -1],
    },
    {
      side: bl,
      x1: bxL + inset(lw),
      y1: bxT,
      x2: bxL + inset(lw),
      y2: bxB,
      length: Math.max(0, bxB - bxT),
      polygon: `${r(bxL)},${r(bxB)} ${r(bxL)},${r(bxT)} ${r(bxL + lw)},${r(bxT + tw)} ${r(bxL + lw)},${r(bxB - bw)}`,
      doubleNormals: [1, 0, -1, 0],
    },
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
  const sideClipForStyle = (geometry: SideGeometry) => {
    if (collapse || geometry.side == null || geometry.side.w <= 0) return "";
    const cid = ctx.nextClipId("bs");
    ctx.defsParts.push(`<clipPath id="${cid}"><polygon points="${geometry.polygon}"/></clipPath>`);
    return ` clip-path="url(#${cid})"`;
  };
  // DM-686: border-radius + per-side borders. The trapezoids and lines
  // above hit the sharp outer-rect corners. When the element has a
  // non-zero border-radius, wrap the per-side emit in a clip-path that
  // is the rounded outer border-box, so each side's polygon / line is
  // trimmed to follow the radius arc instead of squaring off. Matches
  // Blink, which paints sides into the rounded border outline clip.
  const hasOuterRadius =
    !collapse &&
    (corners.tl.h > 0 ||
      corners.tl.v > 0 ||
      corners.tr.h > 0 ||
      corners.tr.v > 0 ||
      corners.br.h > 0 ||
      corners.br.v > 0 ||
      corners.bl.h > 0 ||
      corners.bl.v > 0);
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
  const outerRoundedPath = hasOuterRadius ? roundedRectPath(bxL, bxT, bxR - bxL, bxB - bxT, corners) : "";
  const innerCornersForAnnular = hasOuterRadius ? insetCornerRadii(corners, tw, rw, bw, lw) : corners;
  const innerRoundedPath = hasOuterRadius
    ? roundedRectPath(
        bxL + lw,
        bxT + tw,
        Math.max(0, bxR - bxL - lw - rw),
        Math.max(0, bxB - bxT - tw - bw),
        innerCornersForAnnular,
      )
    : "";
  const annularPath = hasOuterRadius ? `${outerRoundedPath} ${innerRoundedPath}` : "";
  const hasNonRoundContour = corners.curvature != null && Object.values(corners.curvature).some((value) => value !== 2);
  const contouredRingMaskId =
    hasOuterRadius && hasNonRoundContour
      ? createContouredRingMask(
          ctx,
          outerRoundedPath,
          bxL + lw,
          bxT + tw,
          Math.max(0, bxR - bxL - lw - rw),
          Math.max(0, bxB - bxT - tw - bw),
          innerCornersForAnnular,
        )
      : null;
  // Hyperellipses use Blink's general miter/bevel-hull quad. Round and
  // concave contours use the close-edge miter/opposite-bound branch; the
  // non-renderable concave path-intersection prerequisite is DM-2317.
  const hyperellipse = corners.curvature != null && Object.values(corners.curvature).every((value) => value >= 2);
  const annularWedges: string[] = !hasOuterRadius
    ? []
    : hyperellipse
      ? [
          hyperellipseBorderSideClipPolygon("top", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
          hyperellipseBorderSideClipPolygon("right", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
          hyperellipseBorderSideClipPolygon("bottom", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
          hyperellipseBorderSideClipPolygon("left", bxL, bxT, bxR, bxB, corners, tw, rw, bw, lw),
        ]
      : [
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
    // Blink's CenterOutsets() truncates each half width (FromInts), so the
    // stroked "centerline" sits floor(width / 2) inside each edge
    // (box_border_painter.cc:2477-2483, chromium 7d859f27).
    const half = (width: number) => Math.floor(Math.round(width) / 2);
    const centerCorners = insetCornerRadii(corners, half(tw), half(rw), half(bw), half(lw));
    const centerX = bxL + half(lw);
    const centerY = bxT + half(tw);
    const centerW = Math.max(0, bxR - bxL - half(lw) - half(rw));
    const centerH = Math.max(0, bxB - bxT - half(tw) - half(bw));
    const centerPath = roundedRectPath(centerX, centerY, centerW, centerH, centerCorners);
    const centerLength = blinkCurvedDashPathLength(centerW, centerH, centerCorners);
    const ringMaskId = ctx.nextClipId("bm");
    ctx.defsParts.push(`<mask id="${ringMaskId}"><path d="${annularPath}" fill="white" fill-rule="evenodd"/></mask>`);
    for (let i = 0; i < sides.length; i++) {
      const side = sides[i].side;
      if (side == null || side.w <= 0 || side.color.a < 0.01) continue;
      if (side.style !== "dashed" && side.style !== "dotted") continue;
      const thinDotted = side.style === "dotted" && isThinDotted(side.w);
      // PaintOneBorderSide passes the max of this side and its two adjacent
      // widths; DrawCurvedDashedDottedBoxSide strokes dashes and thin dots at
      // 2.2 times that (the centerline may sit on the ring's outer edge) and
      // round dots at the side's own width. The ring mask and side wedge clip.
      const adjacentMax = Math.max(side.w, sides[(i + 1) % 4].side?.w ?? 0, sides[(i + 3) % 4].side?.w ?? 0);
      const strokeWidth =
        side.style === "dotted" && !thinDotted ? side.w : adjacentMax * BLINK_CURVED_BORDER_CLIP_OVERDRAW;
      const dash = closedDashArray(side.style, side.w, centerLength, thinDotted);
      const cid = ctx.nextClipId("bc");
      ctx.defsParts.push(`<clipPath id="${cid}"><polygon points="${annularWedges[i]}"/></clipPath>`);
      const linecap = side.style === "dotted" && !thinDotted ? ` stroke-linecap="round"` : "";
      const dashAttr = dash === "" ? "" : ` stroke-dasharray="${dash}"`;
      ctx.svgParts.push(
        `${indent}<path d="${centerPath}" fill="none" stroke="${colorStr(side.color)}" stroke-width="${r(strokeWidth)}"${dashAttr}${linecap} clip-path="url(#${cid})" mask="url(#${ringMaskId})" />`,
      );
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
      const side = sides[i].side;
      if (side == null || side.w <= 0 || side.color.a < 0.01) continue;
      if (side.style !== "solid") continue;
      const wid = ctx.nextClipId("bw");
      ctx.defsParts.push(`<clipPath id="${wid}"><polygon points="${annularWedges[i]}"/></clipPath>`);
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
  for (const geometry of sides) {
    emitBorderSide(ctx, indent, geometry, collapse, hasOuterRadius, curvedStyledSide, sideClipForStyle);
  }
  if (roundedSideGroupOpen) ctx.svgParts.push(`${indent}</g>`);
}

function quarterEllipseLength(rx: number, ry: number): number {
  if (rx <= 0 || ry <= 0) return Math.max(rx, ry);
  // Fixed Simpson integration is deterministic and sub-millipixel accurate for
  // the CSS corner aspect ratios used here; Blink asks Path::length() for this
  // same centerline before selecting a closed-path dash gap.
  const steps = 64;
  const h = Math.PI / 2 / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i * h;
    const speed = Math.hypot(rx * Math.sin(t), ry * Math.cos(t));
    sum += speed * (i === 0 || i === steps ? 1 : i % 2 === 0 ? 2 : 4);
  }
  return (sum * h) / 3;
}

export function roundedRectPerimeter(width: number, height: number, corners: CornerRadii): number {
  const horizontal =
    Math.max(0, width - corners.tl.h - corners.tr.h) + Math.max(0, width - corners.bl.h - corners.br.h);
  const vertical =
    Math.max(0, height - corners.tl.v - corners.bl.v) + Math.max(0, height - corners.tr.v - corners.br.v);
  return (
    horizontal +
    vertical +
    quarterEllipseLength(corners.tl.h, corners.tl.v) +
    quarterEllipseLength(corners.tr.h, corners.tr.v) +
    quarterEllipseLength(corners.br.h, corners.br.v) +
    quarterEllipseLength(corners.bl.h, corners.bl.v)
  );
}
