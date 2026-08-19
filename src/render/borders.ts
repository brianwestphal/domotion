/**
 * Border-side parsing, per-corner radius resolution + clamping, rounded-rect
 * path emission, stroke dash patterns, and the CSS `border-image` 9-slice
 * emitter (`renderBorderImage`).
 */

import { r, esc } from "./format.js";
import { parseColor, type RGBA } from "./colors.js";
import type { CapturedElement } from "../capture/types.js";
import { embedOriginalDataUri } from "../capture/embed.js";
import { parseGradient, buildLinearGradientDef, buildRadialGradientDef } from "./gradients.js";

/** Blink DrawDoubleBoxSide uses `(thickness + 1) / 3` integer division. */
export function doubleBorderStripeGeometry(width: number): { stripe: number; offset: number } {
  const snapped = Math.max(1, Math.round(width));
  const stripe = Math.floor((snapped + 1) / 3);
  return { stripe, offset: (snapped - stripe) / 2 };
}

/** Port of Skia/Blink SelectBestDashGap for open or closed strokes. */
export function selectBestDashGap(strokeLength: number, dashLength: number, gapLength: number, closedPath: boolean): number {
  const available = strokeLength + (closedPath ? 0 : gapLength);
  const minDashes = Math.max(1, Math.floor(available / (dashLength + gapLength)));
  const gapFor = (n: number) => (strokeLength - n * dashLength) / Math.max(1, closedPath ? n : n - 1);
  const a = gapFor(minDashes), b = gapFor(minDashes + 1);
  if (b <= 0) return a;
  return Math.abs(a - gapLength) < Math.abs(b - gapLength) ? a : b;
}

/** Minimal rect for collapsed-cell grid analysis. */
export interface CollapseCellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * DM-1151: detect `border-collapse: collapse` cells that are laid out OFF the
 * shared table grid, so the renderer can paint their borders INSIDE their own
 * border-box (like a non-collapsed cell) instead of centered on the grid line.
 *
 * Normally collapsed cells paint each border centered on the shared grid edge
 * so adjacent cells overlap into a single line. But a cell whose border is
 * thicker than its neighbors can be laid out with a SMALLER box than its
 * row/column slot, leaving its rect edges ~1px inside the grid line. Chrome
 * paints such a cell's borders flush to its own rect on every side (verified
 * against painted pixels for the 6px-red interior cell in
 * `18-deep-borders-mixed-sides`).
 *
 * Detection uses a consensus vote: an edge is "offset" when ≥2 OTHER cells
 * share a same-orientation edge coordinate that sits >0.5px (but ≤2px) away —
 * those agreeing cells define the real grid line and this cell is the minority.
 * A cell with any offset edge is off-grid. Grid-aligned cells (every edge
 * coincides with the consensus) return false, so the calibrated collapsed-
 * border fixtures keep their centered painting unchanged.
 *
 * Returns a boolean per input cell (aligned by index): true ⇒ off-grid.
 */
export function findOffGridCollapsedCells(cells: CollapseCellRect[]): boolean[] {
  const result = new Array<boolean>(cells.length).fill(false);
  if (cells.length <= 1) return result;
  // All vertical edges (left/right x) and horizontal edges (top/bottom y).
  const vEdges: number[] = [];
  const hEdges: number[] = [];
  for (const c of cells) {
    vEdges.push(c.x, c.x + c.width);
    hEdges.push(c.y, c.y + c.height);
  }
  // True when ≥2 of `others` agree (within 0.5px of each other) on a coordinate
  // that is >0.5px (but ≤2px) away from `coord` — i.e. a nearby grid line that
  // this edge is offset from.
  const hasShiftedConsensus = (coord: number, others: number[]): boolean => {
    for (const a of others) {
      const d = Math.abs(a - coord);
      if (d <= 0.5 || d > 2) continue;
      let agree = 0;
      for (const b of others) if (Math.abs(b - a) <= 0.5) agree++;
      if (agree >= 2) return true;
    }
    return false;
  };
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    result[i] = hasShiftedConsensus(c.x, vEdges)
      || hasShiftedConsensus(c.x + c.width, vEdges)
      || hasShiftedConsensus(c.y, hEdges)
      || hasShiftedConsensus(c.y + c.height, hEdges);
  }
  return result;
}

/** `border-image-repeat` per-axis keyword. */
type BorderImageRepeat = "stretch" | "repeat" | "round" | "space";
const BORDER_IMAGE_REPEATS = new Set<string>(["stretch", "repeat", "round", "space"]);

function normalizeBorderImageRepeat(raw: string | undefined): BorderImageRepeat {
  if (raw != null && BORDER_IMAGE_REPEATS.has(raw)) return raw as BorderImageRepeat;
  return "stretch";
}

export interface NinePieceDestinationGrid {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Mirror Blink's ToPixelSnappedRect + NinePieceImageGrid::SnapEdgeWidths. */
export function snapNinePieceDestinationGrid(
  x: number,
  y: number,
  width: number,
  height: number,
  left: number,
  right: number,
  top: number,
  bottom: number,
): NinePieceDestinationGrid {
  const snappedX = Math.round(x);
  const snappedY = Math.round(y);
  // SnapSizeToPixel snaps the far edge relative to the snapped origin.
  const snappedWidth = Math.round(x + width) - snappedX;
  const snappedHeight = Math.round(y + height) - snappedY;
  const snapEdges = (start: number, end: number, extent: number): [number, number] =>
    extent - start - end <= 1 / 64
      ? [Math.round(start), extent - Math.round(start)]
      : [Math.floor(start), Math.floor(end)];
  const [snappedLeft, snappedRight] = snapEdges(left, right, snappedWidth);
  const [snappedTop, snappedBottom] = snapEdges(top, bottom, snappedHeight);
  return {
    x: snappedX,
    y: snappedY,
    width: snappedWidth,
    height: snappedHeight,
    left: snappedLeft,
    right: snappedRight,
    top: snappedTop,
    bottom: snappedBottom,
  };
}

export function borderImageSpaceTiling(destination: number, tile: number): { spacing: number; period: number } | null {
  const count = Math.floor(destination / tile);
  if (count <= 0) return null;
  const spacing = (destination - tile * count) / (count + 1);
  return { spacing, period: tile + spacing };
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
  /** Blink `ContouredRect::CornerCurvature`: the superellipse exponent. */
  curvature?: { tl: number; tr: number; br: number; bl: number };
  /** Original border contour and accumulated inset used by Blink's
   * `Corner::AlignedToOrigin` constant-thickness construction. */
  originRadii?: { tl: CornerRadiusPair; tr: CornerRadiusPair; br: CornerRadiusPair; bl: CornerRadiusPair };
  contourInsets?: { top: number; right: number; bottom: number; left: number };
};

const ROUND_CURVATURE = 2;
const STRAIGHT_CURVATURE = 1000;
const NOTCH_CURVATURE = 1 / STRAIGHT_CURVATURE;

/** Blink `Superellipse::Exponent()` (`2^parameter`, clamped to ±16). */
export function parseCornerShapeCurvature(value: string | undefined): number {
  const keyword: Record<string, number> = {
    notch: NOTCH_CURVATURE,
    scoop: 0.5,
    bevel: 1,
    round: ROUND_CURVATURE,
    squircle: 4,
    square: STRAIGHT_CURVATURE,
  };
  const normalized = (value ?? "round").trim().toLowerCase();
  if (keyword[normalized] != null) return keyword[normalized];
  const match = /^superellipse\(\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*\)$/i.exec(normalized);
  if (match == null) return ROUND_CURVATURE;
  return Math.pow(2, Math.max(-16, Math.min(16, Number(match[1]))));
}

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
  styles: { borderTopLeftRadius?: string; borderTopRightRadius?: string; borderBottomRightRadius?: string; borderBottomLeftRadius?: string; borderRadius?: string; cornerTopLeftShape?: string; cornerTopRightShape?: string; cornerBottomRightShape?: string; cornerBottomLeftShape?: string },
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
  const curvature = {
    tl: tl.h === 0 || tl.v === 0 ? ROUND_CURVATURE : parseCornerShapeCurvature(styles.cornerTopLeftShape),
    tr: tr.h === 0 || tr.v === 0 ? ROUND_CURVATURE : parseCornerShapeCurvature(styles.cornerTopRightShape),
    br: br.h === 0 || br.v === 0 ? ROUND_CURVATURE : parseCornerShapeCurvature(styles.cornerBottomRightShape),
    bl: bl.h === 0 || bl.v === 0 ? ROUND_CURVATURE : parseCornerShapeCurvature(styles.cornerBottomLeftShape),
  };
  if (curvature.tl < 1 || curvature.tr < 1 || curvature.br < 1 || curvature.bl < 1) {
    const factor = concaveRadiiConstraintFactor(width, height, { tl, tr, br, bl }, curvature);
    if (factor < 1) {
      const scale = (pair: CornerRadiusPair) => ({ h: pair.h * factor, v: pair.v * factor });
      tl = scale(tl); tr = scale(tr); br = scale(br); bl = scale(bl);
    }
  }
  const uniform = curvature.tl === ROUND_CURVATURE && curvature.tr === ROUND_CURVATURE
    && curvature.br === ROUND_CURVATURE && curvature.bl === ROUND_CURVATURE
    && tl.h === tl.v && tl.h === tr.h && tl.h === tr.v
    && tl.h === br.h && tl.h === br.v && tl.h === bl.h && tl.h === bl.v;
  return { tl, tr, br, bl, uniform, curvature };
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
  const nonRound = c.curvature != null && Object.values(c.curvature).some(value => value !== ROUND_CURVATURE);
  const previous = c.contourInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    tl, tr, br, bl,
    uniform: uniform && (c.curvature?.tl ?? ROUND_CURVATURE) === ROUND_CURVATURE,
    curvature: c.curvature,
    ...(nonRound ? {
      originRadii: c.originRadii ?? { tl: c.tl, tr: c.tr, br: c.br, bl: c.bl },
      contourInsets: { top: previous.top + top, right: previous.right + right, bottom: previous.bottom + bottom, left: previous.left + left },
    } : {}),
  };
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
  return { tl, tr, br, bl, uniform: uniform && (c.curvature?.tl ?? ROUND_CURVATURE) === ROUND_CURVATURE, curvature: c.curvature };
}

/** Blink FloatRoundedRect::Radii::OutsetWithCornerCorrection. Margin-box
 * corners use the CSS corner-shaping correction independently per axis so a
 * small radius approaches a sharp corner continuously instead of simply
 * adding the whole margin outset. */
export function outsetCornerRadiiWithCorrection(c: CornerRadii, top: number, right: number, bottom: number, left: number): CornerRadii {
  const adjusted = (radius: number, outset: number): number => {
    if (radius === 0 || outset === 0) return radius;
    const magnitude = Math.abs(outset);
    const factor = radius < magnitude ? 1 + (radius / magnitude - 1) ** 3 : 1;
    return Math.max(0, radius + factor * outset);
  };
  const corner = (value: CornerRadiusPair, horizontal: number, vertical: number): CornerRadiusPair => ({ h: adjusted(value.h, horizontal), v: adjusted(value.v, vertical) });
  const tl = corner(c.tl, left, top), tr = corner(c.tr, right, top), br = corner(c.br, right, bottom), bl = corner(c.bl, left, bottom);
  const uniform = tl.h === tl.v && tl.h === tr.h && tl.h === tr.v && tl.h === br.h && tl.h === br.v && tl.h === bl.h && tl.h === bl.v;
  return { tl, tr, br, bl, uniform: uniform && (c.curvature?.tl ?? ROUND_CURVATURE) === ROUND_CURVATURE, curvature: c.curvature };
}

type Point = { x: number; y: number };
type CornerGeometry = { start: Point; outer: Point; end: Point; center: Point; curvature: number };

function mapCornerPoint(corner: CornerGeometry, normalized: Point): Point {
  return {
    x: corner.center.x + (corner.outer.x - corner.start.x) * normalized.x + (corner.start.x - corner.center.x) * normalized.y,
    y: corner.center.y + (corner.outer.y - corner.start.y) * normalized.x + (corner.start.y - corner.center.y) * normalized.y,
  };
}

function lineIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const abx = b.x - a.x, aby = b.y - a.y, cdx = d.x - c.x, cdy = d.y - c.y;
  const denominator = abx * cdy - aby * cdx;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((c.x - a.x) * cdy - (c.y - a.y) * cdx) / denominator;
  return { x: a.x + t * abx, y: a.y + t * aby };
}

function hullQuad(corner: CornerGeometry): Point[] {
  const halfValue = Math.pow(0.5, 1 / Math.max(NOTCH_CURVATURE, Math.min(STRAIGHT_CURVATURE, corner.curvature)));
  const half = mapCornerPoint(corner, { x: halfValue, y: halfValue });
  const radial = { x: half.x - corner.outer.x, y: half.y - corner.outer.y };
  const tangentEnd = { x: half.x - radial.y, y: half.y + radial.x };
  return [
    corner.start,
    lineIntersection(half, tangentEnd, corner.start, corner.center) ?? corner.center,
    lineIntersection(half, tangentEnd, corner.end, corner.center) ?? corner.center,
    corner.end,
  ];
}

function quadsIntersect(a: Point[], b: Point[]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i++) {
      const edge = { x: polygon[(i + 1) % polygon.length].x - polygon[i].x, y: polygon[(i + 1) % polygon.length].y - polygon[i].y };
      const axis = { x: -edge.y, y: edge.x };
      const project = (points: Point[]) => points.reduce((range, point) => {
        const value = point.x * axis.x + point.y * axis.y;
        return { min: Math.min(range.min, value), max: Math.max(range.max, value) };
      }, { min: Infinity, max: -Infinity });
      const pa = project(a), pb = project(b);
      if (pa.max <= pb.min || pb.max <= pa.min) return false;
    }
  }
  return true;
}

function scaledQuad(quad: Point[], origin: Point, scale: number): Point[] {
  return quad.map(point => ({ x: origin.x + (point.x - origin.x) * scale, y: origin.y + (point.y - origin.y) * scale }));
}

function opposingHullScale(a: CornerGeometry, b: CornerGeometry): number {
  const boxesOverlap = Math.max(a.start.x, a.end.x) > Math.min(b.start.x, b.end.x)
    && Math.max(b.start.x, b.end.x) > Math.min(a.start.x, a.end.x)
    && Math.max(a.start.y, a.end.y) > Math.min(b.start.y, b.end.y)
    && Math.max(b.start.y, b.end.y) > Math.min(a.start.y, a.end.y);
  if (!boxesOverlap) return 1;
  const ah = hullQuad(a), bh = hullQuad(b);
  if (!quadsIntersect(ah, bh)) return 1;
  let min = 0, max = 1;
  while (max - min > 0.05) {
    const check = (min + max) / 2;
    if (quadsIntersect(scaledQuad(ah, a.outer, check), scaledQuad(bh, b.outer, check))) max = check;
    else min = check;
  }
  return min;
}

/** Blink `RadiiConstraintFactorForOppositeCorners` for non-convex contours. */
function concaveRadiiConstraintFactor(
  width: number,
  height: number,
  radii: Pick<CornerRadii, "tl" | "tr" | "br" | "bl">,
  curvature: NonNullable<CornerRadii["curvature"]>,
): number {
  const tl: CornerGeometry = { start: { x: 0, y: radii.tl.v }, outer: { x: 0, y: 0 }, end: { x: radii.tl.h, y: 0 }, center: { x: radii.tl.h, y: radii.tl.v }, curvature: curvature.tl };
  const tr: CornerGeometry = { start: { x: width - radii.tr.h, y: 0 }, outer: { x: width, y: 0 }, end: { x: width, y: radii.tr.v }, center: { x: width - radii.tr.h, y: radii.tr.v }, curvature: curvature.tr };
  const br: CornerGeometry = { start: { x: width, y: height - radii.br.v }, outer: { x: width, y: height }, end: { x: width - radii.br.h, y: height }, center: { x: width - radii.br.h, y: height - radii.br.v }, curvature: curvature.br };
  const bl: CornerGeometry = { start: { x: radii.bl.h, y: height }, outer: { x: 0, y: height }, end: { x: 0, y: height - radii.bl.v }, center: { x: radii.bl.h, y: height - radii.bl.v }, curvature: curvature.bl };
  return Math.min(1, opposingHullScale(tl, br), opposingHullScale(bl, tr));
}

/** Chromium `ApproximateSuperellipseHalfCornerAsBezierCurve`. */
function superellipseControls(curvature: number): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  const p = [1.2430920942724248, 2.010479023614843, 0.32922901179443753, 0.2823023142212073, 1.3473704261055421, 2.9149468637949814, 0.9106507102917086];
  const s = Math.log2(curvature);
  const slope = p[0] + (p[6] - p[0]) * 0.5 * (1 + Math.tanh(p[5] * (s - p[1])));
  const base = 1 / (1 + Math.exp(-slope * (0 - p[1])));
  const logistic = 1 / (1 + Math.exp(-slope * (s - p[1])));
  const a = (logistic - base) / (1 - base);
  const b = p[2] * Math.exp(-p[3] * Math.pow(s, p[4]));
  const half = Math.pow(0.5, 1 / Math.max(NOTCH_CURVATURE, Math.min(STRAIGHT_CURVATURE, curvature)));
  return [{ x: a, y: 1 }, { x: half - b, y: half + b }, { x: half, y: half }];
}

function cornerCommands(start: Point, outer: Point, end: Point, center: Point, rawCurvature: number): string[] {
  let curvature = Math.max(NOTCH_CURVATURE, Math.min(STRAIGHT_CURVATURE, rawCurvature));
  const concave = curvature < 1;
  if (concave) {
    curvature = 1 / curvature;
    [outer, center] = [center, outer];
  }
  const map = (v: Point): Point => mapCornerPoint({ start, outer, end, center, curvature }, v);
  const point = (v: Point) => `${r(v.x)},${r(v.y)}`;
  if (curvature >= STRAIGHT_CURVATURE) return [`L${point(start)}`, `L${point(outer)}`, `L${point(end)}`];
  if (curvature === 1) return [`L${point(start)}`, `L${point(end)}`];
  if (curvature === ROUND_CURVATURE) {
    const radiusX = Math.abs(start.x - end.x), radiusY = Math.abs(start.y - end.y);
    return [`L${point(start)}`, `A${r(radiusX)},${r(radiusY)} 0 0 ${concave ? 0 : 1} ${point(end)}`];
  }
  const [p1, p2, p3] = superellipseControls(curvature);
  const q1 = map(p1), q2 = map(p2), q3 = map(p3);
  const q4 = map({ x: p2.y, y: p2.x }), q5 = map({ x: p1.y, y: p1.x });
  return [`L${point(start)}`, `C${point(q1)} ${point(q2)} ${point(q3)}`, `C${point(q4)} ${point(q5)} ${point(end)}`];
}

function normalized(vector: Point): Point {
  const length = Math.hypot(vector.x, vector.y);
  return length === 0 ? { x: 0, y: 0 } : { x: vector.x / length, y: vector.y / length };
}

/** Chromium `ContouredRect::Corner::AlignedToOrigin`. */
function alignedCorner(target: CornerGeometry, origin: CornerGeometry, thicknessStart: number, thicknessEnd: number): CornerGeometry {
  if ((origin.start.x === origin.end.x && origin.start.y === origin.end.y)
    || (target.start.x === origin.start.x && target.start.y === origin.start.y
      && target.outer.x === origin.outer.x && target.outer.y === origin.outer.y
      && target.end.x === origin.end.x && target.end.y === origin.end.y)) return target;
  const half = Math.pow(0.5, 1 / Math.max(0.5, Math.min(2, origin.curvature)));
  const hull = normalized({ x: 2 * half - 0.5, y: 1.5 - 2 * half });
  const adjusted = { x: hull.x, y: -hull.y };
  const offset = (from: Point, to: Point, amount: number): Point => {
    const unit = normalized({ x: to.x - from.x, y: to.y - from.y });
    return { x: unit.x * amount, y: unit.y * amount };
  };
  const v1 = offset(origin.start, origin.outer, thicknessStart * adjusted.y);
  const v2 = offset(origin.outer, origin.end, thicknessStart * adjusted.x);
  const v3 = offset(origin.end, origin.center, thicknessEnd * adjusted.x);
  const v4 = offset(origin.center, origin.start, thicknessEnd * adjusted.y);
  const add = (point: Point, a: Point, b: Point): Point => ({ x: point.x + a.x + b.x, y: point.y + a.y + b.y });
  return {
    start: add(origin.start, v1, v2), outer: add(origin.outer, v2, v3),
    end: add(origin.end, v3, v4), center: add(origin.center, v4, v1), curvature: origin.curvature,
  };
}

function contouredCornerGeometries(x: number, y: number, w: number, h: number, c: CornerRadii): { tl: CornerGeometry; tr: CornerGeometry; br: CornerGeometry; bl: CornerGeometry } {
  const tl = { h: Math.min(c.tl.h, w), v: Math.min(c.tl.v, h) };
  const tr = { h: Math.min(c.tr.h, w), v: Math.min(c.tr.v, h) };
  const br = { h: Math.min(c.br.h, w), v: Math.min(c.br.v, h) };
  const bl = { h: Math.min(c.bl.h, w), v: Math.min(c.bl.v, h) };
  const curvature = c.curvature ?? { tl: 2, tr: 2, br: 2, bl: 2 };
  let tlCorner: CornerGeometry = { start: { x, y: y + tl.v }, outer: { x, y }, end: { x: x + tl.h, y }, center: { x: x + tl.h, y: y + tl.v }, curvature: curvature.tl };
  let trCorner: CornerGeometry = { start: { x: x + w - tr.h, y }, outer: { x: x + w, y }, end: { x: x + w, y: y + tr.v }, center: { x: x + w - tr.h, y: y + tr.v }, curvature: curvature.tr };
  let brCorner: CornerGeometry = { start: { x: x + w, y: y + h - br.v }, outer: { x: x + w, y: y + h }, end: { x: x + w - br.h, y: y + h }, center: { x: x + w - br.h, y: y + h - br.v }, curvature: curvature.br };
  let blCorner: CornerGeometry = { start: { x: x + bl.h, y: y + h }, outer: { x, y: y + h }, end: { x, y: y + h - bl.v }, center: { x: x + bl.h, y: y + h - bl.v }, curvature: curvature.bl };
  if (c.originRadii != null && c.contourInsets != null) {
    const inset = c.contourInsets, origin = c.originRadii;
    const ox = x - inset.left, oy = y - inset.top, ow = w + inset.left + inset.right, oh = h + inset.top + inset.bottom;
    const originTl: CornerGeometry = { start: { x: ox, y: oy + origin.tl.v }, outer: { x: ox, y: oy }, end: { x: ox + origin.tl.h, y: oy }, center: { x: ox + origin.tl.h, y: oy + origin.tl.v }, curvature: curvature.tl };
    const originTr: CornerGeometry = { start: { x: ox + ow - origin.tr.h, y: oy }, outer: { x: ox + ow, y: oy }, end: { x: ox + ow, y: oy + origin.tr.v }, center: { x: ox + ow - origin.tr.h, y: oy + origin.tr.v }, curvature: curvature.tr };
    const originBr: CornerGeometry = { start: { x: ox + ow, y: oy + oh - origin.br.v }, outer: { x: ox + ow, y: oy + oh }, end: { x: ox + ow - origin.br.h, y: oy + oh }, center: { x: ox + ow - origin.br.h, y: oy + oh - origin.br.v }, curvature: curvature.br };
    const originBl: CornerGeometry = { start: { x: ox + origin.bl.h, y: oy + oh }, outer: { x: ox, y: oy + oh }, end: { x: ox, y: oy + oh - origin.bl.v }, center: { x: ox + origin.bl.h, y: oy + oh - origin.bl.v }, curvature: curvature.bl };
    trCorner = alignedCorner(trCorner, originTr, inset.top, inset.right);
    brCorner = alignedCorner(brCorner, originBr, inset.right, inset.bottom);
    blCorner = alignedCorner(blCorner, originBl, inset.bottom, inset.left);
    tlCorner = alignedCorner(tlCorner, originTl, inset.left, inset.top);
  }
  return { tl: tlCorner, tr: trCorner, br: brCorner, bl: blCorner };
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
  const curvature = c.curvature ?? { tl: 2, tr: 2, br: 2, bl: 2 };
  if (curvature.tl !== 2 || curvature.tr !== 2 || curvature.br !== 2 || curvature.bl !== 2) {
    const { tl: tlCorner, tr: trCorner, br: brCorner, bl: blCorner } = contouredCornerGeometries(x, y, w, h, c);
    const commands = [`M${r(trCorner.start.x)},${r(trCorner.start.y)}`];
    commands.push(...cornerCommands(trCorner.start, trCorner.outer, trCorner.end, trCorner.center, curvature.tr));
    commands.push(`L${r(brCorner.start.x)},${r(brCorner.start.y)}`);
    commands.push(...cornerCommands(brCorner.start, brCorner.outer, brCorner.end, brCorner.center, curvature.br));
    commands.push(`L${r(blCorner.start.x)},${r(blCorner.start.y)}`);
    commands.push(...cornerCommands(blCorner.start, blCorner.outer, blCorner.end, blCorner.center, curvature.bl));
    commands.push(`L${r(tlCorner.start.x)},${r(tlCorner.start.y)}`);
    commands.push(...cornerCommands(tlCorner.start, tlCorner.outer, tlCorner.end, tlCorner.center, curvature.tl));
    commands.push("Z");
    return commands.join(" ");
  }
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

/**
 * SVG polygon equivalent of Blink's ordinary-round
 * `ClipBorderSidePolygonCloseToEdges` side partition.
 *
 * Each side is bounded by its two outer-corner → unadjusted-inner-edge miter
 * lines. When their apex lies beyond the visible side, Blink first clips out
 * `UnionInnerCornersAndEdge()` for the opposite side; for a round corner that
 * boundary is the near edge of the opposite inner-corner bounding boxes.
 * Intersecting the two miter lines with that source-derived boundary yields the
 * finite polygon below. No codepoint, fixture, radius bucket, or pixel
 * threshold participates in the decision.
 */
export function roundBorderSideClipPolygon(
  side: "top" | "right" | "bottom" | "left",
  bxL: number, bxT: number, bxR: number, bxB: number,
  corners: CornerRadii,
  tw: number, rw: number, bw: number, lw: number,
): string {
  const inner = insetCornerRadii(corners, tw, rw, bw, lw);
  const innerL = bxL + lw, innerT = bxT + tw;
  const innerR = bxR - rw, innerB = bxB - bw;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const point = (x: number, y: number) => `${r(x)},${r(y)}`;
  const fullBox = `${point(bxL, bxT)} ${point(bxR, bxT)} ${point(bxR, bxB)} ${point(bxL, bxB)}`;
  if ((side === "top" && tw <= 0) || (side === "right" && rw <= 0)
    || (side === "bottom" && bw <= 0) || (side === "left" && lw <= 0)) return fullBox;
  const apexes = computeWedgeApexes(bxL, bxT, bxR, bxB, tw, rw, bw, lw);

  if (side === "top") {
    if (lw === 0 && rw === 0) return `${point(bxL, bxT)} ${point(bxR, bxT)} ${point(bxR, bxB)} ${point(bxL, bxB)}`;
    const cut = clamp(innerB - Math.max(inner.bl.v, inner.br.v), bxT, bxB);
    if (apexes.apexTopY <= cut) return `${point(bxL, bxT)} ${point(bxR, bxT)} ${point(apexes.apexTopX, apexes.apexTopY)}`;
    const dy = cut - bxT;
    return `${point(bxL, bxT)} ${point(bxR, bxT)} ${point(clamp(bxR - rw * dy / tw, bxL, bxR), cut)} ${point(clamp(bxL + lw * dy / tw, bxL, bxR), cut)}`;
  }
  if (side === "bottom") {
    if (lw === 0 && rw === 0) return `${point(bxR, bxB)} ${point(bxL, bxB)} ${point(bxL, bxT)} ${point(bxR, bxT)}`;
    const cut = clamp(innerT + Math.max(inner.tl.v, inner.tr.v), bxT, bxB);
    if (apexes.apexBottomY >= cut) return `${point(bxR, bxB)} ${point(bxL, bxB)} ${point(apexes.apexBottomX, apexes.apexBottomY)}`;
    const dy = bxB - cut;
    return `${point(bxR, bxB)} ${point(bxL, bxB)} ${point(clamp(bxL + lw * dy / bw, bxL, bxR), cut)} ${point(clamp(bxR - rw * dy / bw, bxL, bxR), cut)}`;
  }
  if (side === "right") {
    if (tw === 0 && bw === 0) return `${point(bxR, bxT)} ${point(bxR, bxB)} ${point(bxL, bxB)} ${point(bxL, bxT)}`;
    const cut = clamp(innerL + Math.max(inner.tl.h, inner.bl.h), bxL, bxR);
    if (apexes.apexRightX >= cut) return `${point(bxR, bxT)} ${point(bxR, bxB)} ${point(apexes.apexRightX, apexes.apexRightY)}`;
    const dx = bxR - cut;
    return `${point(bxR, bxT)} ${point(bxR, bxB)} ${point(cut, clamp(bxB - bw * dx / rw, bxT, bxB))} ${point(cut, clamp(bxT + tw * dx / rw, bxT, bxB))}`;
  }
  if (tw === 0 && bw === 0) return `${point(bxL, bxB)} ${point(bxL, bxT)} ${point(bxR, bxT)} ${point(bxR, bxB)}`;
  const cut = clamp(innerR - Math.max(inner.tr.h, inner.br.h), bxL, bxR);
  if (apexes.apexLeftX <= cut) return `${point(bxL, bxB)} ${point(bxL, bxT)} ${point(apexes.apexLeftX, apexes.apexLeftY)}`;
  const dx = cut - bxL;
  return `${point(bxL, bxB)} ${point(bxL, bxT)} ${point(cut, clamp(bxT + tw * dx / lw, bxT, bxB))} ${point(cut, clamp(bxB - bw * dx / lw, bxT, bxB))}`;
}

/**
 * Blink `BoxBorderPainter::ClipBorderSidePolygon` hyperellipse branch.
 *
 * The source builds a four-point side clip from the two outer corners and
 * the corresponding inner-rect corners, then moves each inner point to the
 * intersection of its miter with the inner corner's bevel hull. Normalize all
 * four physical sides into top-side coordinates so the transcription has one
 * decision path; `fromCanonical` only rotates/refects the resulting points.
 */
export function hyperellipseBorderSideClipPolygon(
  side: "top" | "right" | "bottom" | "left",
  bxL: number, bxT: number, bxR: number, bxB: number,
  corners: CornerRadii,
  tw: number, rw: number, bw: number, lw: number,
): string {
  const width = bxR - bxL, height = bxB - bxT;
  const inner = insetCornerRadii(corners, tw, rw, bw, lw);
  let length: number, firstAlong: number, secondAlong: number, inward: number;
  let firstRadius: CornerRadiusPair, secondRadius: CornerRadiusPair;
  let fromCanonical: (point: Point) => Point;
  if (side === "top") {
    length = width; firstAlong = lw; secondAlong = rw; inward = tw;
    firstRadius = inner.tl; secondRadius = inner.tr;
    fromCanonical = p => ({ x: bxL + p.x, y: bxT + p.y });
  } else if (side === "right") {
    length = height; firstAlong = tw; secondAlong = bw; inward = rw;
    firstRadius = { h: inner.tr.v, v: inner.tr.h }; secondRadius = { h: inner.br.v, v: inner.br.h };
    fromCanonical = p => ({ x: bxR - p.y, y: bxT + p.x });
  } else if (side === "bottom") {
    length = width; firstAlong = rw; secondAlong = lw; inward = bw;
    firstRadius = inner.br; secondRadius = inner.bl;
    fromCanonical = p => ({ x: bxR - p.x, y: bxB - p.y });
  } else {
    length = height; firstAlong = bw; secondAlong = tw; inward = lw;
    firstRadius = { h: inner.bl.v, v: inner.bl.h }; secondRadius = { h: inner.tl.v, v: inner.tl.h };
    fromCanonical = p => ({ x: bxL + p.y, y: bxB - p.x });
  }
  const outerStart = { x: 0, y: 0 }, outerEnd = { x: length, y: 0 };
  let innerStart = { x: firstAlong, y: inward };
  let innerEnd = { x: length - secondAlong, y: inward };
  if (firstRadius.h !== 0 && firstRadius.v !== 0) {
    innerStart = lineIntersection(
      outerStart, innerStart,
      { x: innerStart.x + firstRadius.h, y: innerStart.y },
      { x: innerStart.x, y: innerStart.y + firstRadius.v },
    ) ?? innerStart;
  }
  if (secondRadius.h !== 0 && secondRadius.v !== 0) {
    innerEnd = lineIntersection(
      outerEnd, innerEnd,
      { x: innerEnd.x - secondRadius.h, y: innerEnd.y },
      { x: innerEnd.x, y: innerEnd.y + secondRadius.v },
    ) ?? innerEnd;
  }
  return [outerStart, innerStart, innerEnd, outerEnd]
    .map(fromCanonical)
    .map(point => `${r(point.x)},${r(point.y)}`)
    .join(" ");
}
export function wedgePolygonPoints(
  side: "top" | "right" | "bottom" | "left",
  bxL: number, bxT: number, bxR: number, bxB: number,
  a: WedgeApexes,
  /** DM-1150: the four border widths. When a side's BOTH adjacent sides have
   *  zero width, Chrome's BoxBorderPainter computes NO miter (`ComputeMiter`
   *  returns `kNoMiter` when `!adjacent_edge.UsedWidth()`) — the bordered side
   *  paints its FULL rounded corner arc rather than tapering at a diagonal
   *  miter line. The same-side apex degenerates to the box centre in that case
   *  (`computeWedgeApexes` divides by a zero adjacent-sum), which would cut the
   *  corner with a centre-converging triangle. Passing the widths lets the wedge
   *  span the full box edge (the perpendicular-apex quad) so both corners are
   *  covered, matching Chrome. Omit (undefined) to keep the legacy triangle. */
  widths?: { tw: number; rw: number; bw: number; lw: number },
): string {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // DM-1150: force the box-spanning quad when a side's two adjacent sides are
  // both zero-width (no miter → full corner arc, per Blink's box_border_painter).
  const horizZero = widths != null && widths.lw === 0 && widths.rw === 0;
  const vertZero = widths != null && widths.tw === 0 && widths.bw === 0;
  // A side's own apex is INSIDE the box rect when both coordinates lie
  // within the box; we already know one coord stays inside by construction
  // (top apex always has y ≥ bxT, etc.), so the check is the other coord
  // + the cross axis (apex could shift outside horizontally when widths
  // and box aspect both skew).
  const insideTop = !horizZero && a.apexTopY <= bxB && a.apexTopX >= bxL && a.apexTopX <= bxR;
  const insideRight = !vertZero && a.apexRightX >= bxL && a.apexRightY >= bxT && a.apexRightY <= bxB;
  const insideBottom = !horizZero && a.apexBottomY >= bxT && a.apexBottomX >= bxL && a.apexBottomX <= bxR;
  const insideLeft = !vertZero && a.apexLeftX <= bxR && a.apexLeftY >= bxT && a.apexLeftY <= bxB;
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
// ── border-image token parsers (shared by the gradient + URL 9-slice paths) ──
// All three are pure functions of their args; lifted to module scope (DM-1370)
// from the identical closures that renderBorderImageGradient and
// renderBorderImage each defined inline.

/** A `border-image-outset` token → px. `%` is of `basis`, a length unit is
 *  absolute px, a bare number multiplies the side's border-width; empty → 0. */
function parseOutset(tok: string | undefined, basis: number, borderW: number): number {
  if (tok == null || tok === "") return 0;
  if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
  if (/(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(tok)) return parseFloat(tok) || 0;
  const n = parseFloat(tok);
  return Number.isFinite(n) ? n * borderW : 0;
}

/** A `border-image-width` token → px. Like {@link parseOutset} but `auto` /
 *  empty / a non-finite bare number default to the side's border-width. */
function parseBorderImageLen(tok: string | undefined, basis: number, borderW: number): number {
  if (tok == null || tok === "" || tok === "auto") return borderW;
  if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
  if (/(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(tok)) return parseFloat(tok) || 0;
  // Unitless number -> multiplier of border-width.
  const n = parseFloat(tok);
  return Number.isFinite(n) ? n * borderW : borderW;
}

/** A parsed `border-image-slice` token (`{ pct }` of `basis`, or `{ px }`) → px. */
function resolveSlice(tok: { pct?: number; px?: number }, basis: number): number {
  if (tok.pct != null) return (tok.pct / 100) * basis;
  return tok.px ?? 0;
}

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
  const ot = parseOutset(outsetTokens[0], el.height, bwTop);
  const or_ = parseOutset(outsetTokens[1] ?? outsetTokens[0], el.width, bwRight);
  const ob = parseOutset(outsetTokens[2] ?? outsetTokens[0], el.height, bwBottom);
  const ol = parseOutset(outsetTokens[3] ?? outsetTokens[1] ?? outsetTokens[0], el.width, bwLeft);

  // Border-image-width per side; default = element's border-width. Same as URL path.
  const widthTokens = (el.styles.borderImageWidth ?? "").trim().split(/\s+/);
  let wt = parseBorderImageLen(widthTokens[0], el.height, bwTop);
  let wr = parseBorderImageLen(widthTokens[1] ?? widthTokens[0], el.width, bwRight);
  let wb = parseBorderImageLen(widthTokens[2] ?? widthTokens[0], el.height, bwBottom);
  let wl = parseBorderImageLen(widthTokens[3] ?? widthTokens[1] ?? widthTokens[0], el.width, bwLeft);

  // Blink constructs NinePieceImageGrid from ToPixelSnappedRect(area), then
  // SnapEdgeWidths floors non-abutting edge widths (or symmetrically assigns
  // the final pixel when opposing edges abut). Build the same integer grid
  // before deriving any of the nine destination rectangles.
  const grid = snapNinePieceDestinationGrid(
    el.x - ol, el.y - ot, el.width + ol + or_, el.height + ot + ob,
    wl, wr, wt, wb,
  );
  const { x: boxX, y: boxY, width: boxW, height: boxH } = grid;
  ({ left: wl, right: wr, top: wt, bottom: wb } = grid);
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
  // fill the destination rect with that pattern. Tile phase and spacing
  // mirror NinePieceImagePainter::ComputeTileParameters.
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
    if (mode === "repeat") {
      if (axis === "x") tileOffX = (dw - tileW) / 2;
      else tileOffY = (dh - tileH) / 2;
    }
    if (mode === "space") {
      if (axis === "x") {
        const tiling = borderImageSpaceTiling(dw, tileW);
        if (tiling == null) return;
        patternW = tiling.period;
        tileOffX = tiling.spacing;
      } else {
        const tiling = borderImageSpaceTiling(dh, tileH);
        if (tiling == null) return;
        patternH = tiling.period;
        tileOffY = tiling.spacing;
      }
    }
    const patId = `${idPrefix}bip${clipIdx + usedIds}`;
    usedIds++;
    defsParts.push(`<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${r(dx + tileOffX)}" y="${r(dy + tileOffY)}" width="${r(patternW)}" height="${r(patternH)}">${innerSvgForSlot(0, 0, tileW, tileH, sx, sy, sw, sh)}</pattern>`);
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
  // DM-2242: every slice must sample the same source texture. A border image
  // uses multiple scale transforms by design; asking the resize cache for each
  // transform first creates multiple resampled full images whose bilinear edge
  // pixels disagree at the shared slice coordinate.
  const sourceHref = embedOriginalDataUri(url);
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
  const widthTokens = (el.styles.borderImageWidth ?? "").trim().split(/\s+/);
  let wt = parseBorderImageLen(widthTokens[0], el.height, bwTop);
  let wr = parseBorderImageLen(widthTokens[1] ?? widthTokens[0], el.width, bwRight);
  let wb = parseBorderImageLen(widthTokens[2] ?? widthTokens[0], el.height, bwBottom);
  let wl = parseBorderImageLen(widthTokens[3] ?? widthTokens[1] ?? widthTokens[0], el.width, bwLeft);

  // Outsets: same parsing; default 0.
  const outsetTokens = (el.styles.borderImageOutset ?? "0").trim().split(/\s+/);
  const ot = parseOutset(outsetTokens[0], el.height, bwTop);
  const or_ = parseOutset(outsetTokens[1] ?? outsetTokens[0], el.width, bwRight);
  const ob = parseOutset(outsetTokens[2] ?? outsetTokens[0], el.height, bwBottom);
  const ol = parseOutset(outsetTokens[3] ?? outsetTokens[1] ?? outsetTokens[0], el.width, bwLeft);

  const grid = snapNinePieceDestinationGrid(
    el.x - ol, el.y - ot, el.width + ol + or_, el.height + ot + ob,
    wl, wr, wt, wb,
  );
  const { x: boxX, y: boxY, width: boxW, height: boxH } = grid;
  ({ left: wl, right: wr, top: wt, bottom: wb } = grid);

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
    const clipId = `${idPrefix}bi${clipIdx + usedIds++}`;
    defsParts.push(`<clipPath id="${clipId}"><rect x="${r(dxSlot)}" y="${r(dySlot)}" width="${r(dwSlot)}" height="${r(dhSlot)}" /></clipPath>`);
    const scaleX = dwSlot / sw, scaleY = dhSlot / sh;
    parts.push(`${indent}<image href="${esc(sourceHref)}" x="${r(dxSlot - sx * scaleX)}" y="${r(dySlot - sy * scaleY)}" width="${r(natW * scaleX)}" height="${r(natH * scaleY)}" preserveAspectRatio="none" clip-path="url(#${clipId})" />`);
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
    // Blink's CalculateSpaceNeeded distributes the remainder across N + 1
    // gaps: one full gap at each end and one between each pair of tiles. If
    // N === 0 no border is drawn for that side. The `<image>` inside the cell needs a
    // `<clipPath>` clipped to the slice region (0, 0, tileW, tileH) —
    // otherwise the image extends past the slice into the gap, painting
    // source pixels beyond the slice region instead of transparent gap.
    let patternW = tileW, patternH = tileH;
    let patternX = dxSlot, patternY = dySlot;
    if (mode === "repeat") {
      if (axis === "x") patternX += (dwSlot - tileW) / 2;
      else patternY += (dhSlot - tileH) / 2;
    }
    if (mode === "space") {
      if (axis === "x") {
        const tiling = borderImageSpaceTiling(dwSlot, tileW);
        if (tiling == null) return;
        patternW = tiling.period;
        patternX = dxSlot + tiling.spacing;
      } else {
        const tiling = borderImageSpaceTiling(dhSlot, tileH);
        if (tiling == null) return;
        patternH = tiling.period;
        patternY = dySlot + tiling.spacing;
      }
    }
    const patId = `${idPrefix}bip${clipIdx + usedIds}`;
    usedIds++;
    const scaleX = tileW / sw, scaleY = tileH / sh;
    const tileClip = `${idPrefix}bic${clipIdx + usedIds++}`;
    defsParts.push(`<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${r(patternX)}" y="${r(patternY)}" width="${r(patternW)}" height="${r(patternH)}"><clipPath id="${tileClip}"><rect x="0" y="0" width="${r(tileW)}" height="${r(tileH)}" /></clipPath><image href="${esc(sourceHref)}" x="${r(-sx * scaleX)}" y="${r(-sy * scaleY)}" width="${r(natW * scaleX)}" height="${r(natH * scaleY)}" preserveAspectRatio="none" clip-path="url(#${tileClip})" /></pattern>`);
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
        const tiling = borderImageSpaceTiling(dwCenter, tileWNatural);
        if (tiling == null) { tileW = 0; patternW = 0; } else {
          tileW = tileWNatural;
          patternW = tiling.period;
          tileOffX = tiling.spacing;
        }
      } else { // "repeat"
        tileW = tileWNatural;
        patternW = tileWNatural;
        tileOffX = (dwCenter - tileW) / 2;
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
        const tiling = borderImageSpaceTiling(dhCenter, tileHNatural);
        if (tiling == null) { tileH = 0; patternH = 0; } else {
          tileH = tileHNatural;
          patternH = tiling.period;
          tileOffY = tiling.spacing;
        }
      } else {
        tileH = tileHNatural;
        patternH = tileHNatural;
        tileOffY = (dhCenter - tileH) / 2;
      }
      if (tileW > 0 && tileH > 0 && patternW > 0 && patternH > 0) {
        const patId = `${idPrefix}bipc${clipIdx + usedIds}`;
        usedIds++;
        const scaleX = tileW / sxW_C, scaleY = tileH / syH_C;
        const needsClip = rH === "space" || rV === "space";
        let clipDef = "", imageClip = "";
        if (needsClip) {
          const clipId = `${idPrefix}bicc${clipIdx + usedIds++}`;
          clipDef = `<clipPath id="${clipId}"><rect x="${r(tileOffX)}" y="${r(tileOffY)}" width="${r(tileW)}" height="${r(tileH)}" /></clipPath>`;
          imageClip = ` clip-path="url(#${clipId})"`;
        }
        defsParts.push(`<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${r(x1)}" y="${r(y1)}" width="${r(patternW)}" height="${r(patternH)}">${clipDef}<image href="${esc(sourceHref)}" x="${r(-sxC * scaleX + tileOffX)}" y="${r(-syC * scaleY + tileOffY)}" width="${r(natW * scaleX)}" height="${r(natH * scaleY)}" preserveAspectRatio="none"${imageClip} /></pattern>`);
        parts.push(`${indent}<rect x="${r(x1)}" y="${r(y1)}" width="${r(dwCenter)}" height="${r(dhCenter)}" fill="url(#${patId})" />`);
      }
    }
  }

  return { svg: parts.join("\n"), usedIds };
}
