/**
 * Caret / cursor geometry shared by every simulated-typing surface (the `typing`
 * overlay, the `typeResample` re-capture caret, and — via its own block shape — the
 * terminal cursor). Centralized so all of them draw a caret the way a real browser
 * does, instead of ad-hoc `fontSize` / `fontSize×1.2` guesses.
 *
 * **Height (bar caret).** Researched against Blink (`third_party/blink/renderer/
 * core/editing/local_caret_rect.cc` + `caret_display_item_client.cc`): a bar caret's
 * height is the text fragment / line-box height, which for `line-height: normal` is
 * the font's **metrics height = ascent + descent** — NOT the cap height (too short)
 * and NOT a fixed em multiplier. When the exact font metrics are available (e.g.
 * `CanvasRenderingContext2D.measureText().fontBoundingBox{Ascent,Descent}` page-side,
 * or a fontkit face node-side) use them directly; {@link barCaretHeightPx} is the
 * font-agnostic fallback for callers that only have the CSS `font-size`.
 *
 * **Shape.** Blink models three caret shapes (`CaretShape`): `kBar` (a thin vertical
 * bar, the default text caret), `kBlock` (spans a whole character cell, drawn
 * semi-transparent over the glyph), and `kUnderscore`. Terminals conventionally use
 * a **block** cursor — the `term` renderer already draws one (full cell, ~0.7 alpha),
 * matching `kBlock`. Text fields use the **bar**.
 */

/**
 * The font's metrics height (ascent + descent) as a fraction of `font-size`. This is
 * the correct bar-caret height and the used value of `line-height: normal` for most
 * fonts (empirically ~1.125–1.17× across SF Mono / system fonts; 1.15 is a good
 * central estimate). Prefer the face's real ascent+descent when you have it.
 */
export const FONT_METRICS_HEIGHT_EM = 1.15;

/**
 * Bar-caret height in px. Pass the real `ascent`/`descent` (in px) when available —
 * that is exact (Blink's fragment height); otherwise it falls back to
 * `fontSize × {@link FONT_METRICS_HEIGHT_EM}`.
 */
export function barCaretHeightPx(fontSize: number, ascent?: number, descent?: number): number {
  if (ascent != null && descent != null && ascent + descent > 0) {
    return Math.round(ascent + descent);
  }
  return Math.round(fontSize * FONT_METRICS_HEIGHT_EM);
}

/**
 * The three CSS `caret-shape` values Blink models (`CaretShape`): a thin vertical
 * `bar` (the text default), a `block` spanning a whole character cell drawn
 * semi-transparent over the glyph, and an `underscore` — a thin horizontal bar at
 * the baseline (DM-1591).
 */
export type CaretShape = "bar" | "block" | "underscore";

/**
 * Block-caret alpha. Blink paints a block caret at 50% — `color_.SetAlpha(0.5)`
 * in `caret_display_item_client.cc` — so it reads as a translucent highlight over
 * the character cell rather than hiding the glyph. (Blink gates this on auto
 * caret-color; we apply it for every block caret so an explicit caret color still
 * shows the glyph beneath, matching the shape's intent.)
 */
export const BLOCK_CARET_ALPHA = 0.5;

/** Default bar-caret width in px. */
export const DEFAULT_CARET_WIDTH_PX = 2;

/**
 * Underscore-caret thickness (px) for a font size — a thin bar at the baseline,
 * ~1/12 em with a 1px floor, matching a typical underline weight.
 */
export function underscoreCaretThicknessPx(fontSize: number): number {
  return Math.max(1, Math.round(fontSize / 12));
}

export interface CaretRectInput {
  shape: CaretShape;
  /** Caret x (the insertion-point left edge), px. */
  x: number;
  /** Text baseline y, px. */
  baselineY: number;
  /** Font ascent / descent in px (exact metrics — see {@link barCaretHeightPx}). */
  ascentPx: number;
  descentPx: number;
  /** Advance of the insertion cell (the character at/after the caret, or a space
   *  at end-of-text), px — the width of a `block` / `underscore` caret. */
  cellWidthPx: number;
  fontSize: number;
  /** Bar-caret width override (default {@link DEFAULT_CARET_WIDTH_PX}). */
  barWidthPx?: number;
}

export interface CaretShapeRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fill opacity — 0.5 for `block` (translucent over the glyph), 1 otherwise. */
  opacity: number;
}

/**
 * Resolve a caret's on-screen rectangle for a given {@link CaretShape}, shared by
 * every simulated-typing surface so a bar / block / underscore caret is drawn the
 * same way Blink paints it. `bar` and `block` span the font box (`baselineY −
 * ascent … baselineY + descent`); `underscore` is a thin bar sitting on the
 * baseline. `block` / `underscore` are `cellWidthPx` wide; `bar` is `barWidthPx`.
 */
export function caretShapeRect(inp: CaretRectInput): CaretShapeRect {
  const boxTop = inp.baselineY - inp.ascentPx;
  const boxHeight = Math.round(inp.ascentPx + inp.descentPx);
  const cellW = Math.max(1, inp.cellWidthPx);
  switch (inp.shape) {
    case "block":
      return { x: inp.x, y: boxTop, width: cellW, height: boxHeight, opacity: BLOCK_CARET_ALPHA };
    case "underscore":
      return { x: inp.x, y: inp.baselineY, width: cellW, height: underscoreCaretThicknessPx(inp.fontSize), opacity: 1 };
    case "bar":
    default:
      return { x: inp.x, y: boxTop, width: inp.barWidthPx ?? DEFAULT_CARET_WIDTH_PX, height: boxHeight, opacity: 1 };
  }
}

/**
 * Raw page-side measurements from which {@link firstLineBaseline} derives an
 * element's first-line text baseline. Collected in page context (canvas
 * `measureText("Hg").fontBoundingBox{Ascent,Descent}` + computed style /
 * `getBoundingClientRect`), computed node-side so the math lives in ONE tested
 * place — shared by the `typeResample` caret and the typing overlay's
 * `anchor.baseline` resolution (DM-1750), which must agree.
 */
export interface LineBoxMeasurement {
  fontSize: number;
  /** Computed `line-height` in px; pass 0 when it is `normal` (the font box,
   *  then 1.2 em, stand in). */
  lineHeightPx: number;
  /** `fontBoundingBoxAscent` / `fontBoundingBoxDescent` from canvas
   *  `measureText("Hg")` with the element's computed font; pass 0 when the
   *  engine doesn't expose them (falls back to the 1.15-em split: 0.9 em
   *  ascent + 0.25 em descent). */
  fontAscentPx: number;
  fontDescentPx: number;
  /** Content-box top (page coords) and height (border + padding excluded). */
  contentTop: number;
  contentHeight: number;
  /** True for a single-line `<input>`, which centers its one line box in the
   *  content box; a `<textarea>` / block content lays line boxes from the top. */
  centerInContentBox: boolean;
}

/**
 * First-line text baseline (page coords) plus the effective ascent/descent, from
 * raw page measurements. Mirrors how Blink places the line: the line box sits at
 * the content-box top (or centered in it for a single-line input), and the text
 * box — the font's ascent + descent — is centered in the line box under CSS
 * half-leading, with the baseline `ascent` below the text-box top. This is the
 * math the `typeResample` caret measurement has always used; extracted so the
 * typing overlay's `anchor.baseline` resolution (DM-1750) shares it verbatim.
 */
export function firstLineBaseline(m: LineBoxMeasurement): { baselineY: number; ascentPx: number; descentPx: number } {
  const fontBox = m.fontAscentPx + m.fontDescentPx;
  const ascentPx = fontBox > 0 ? m.fontAscentPx : m.fontSize * 0.9;
  const descentPx = fontBox > 0 ? m.fontDescentPx : m.fontSize * 0.25;
  const textBoxHeight = Math.round(ascentPx + descentPx);
  const lineH = m.lineHeightPx || fontBox || m.fontSize * 1.2;
  const lineTop = m.centerInContentBox
    ? m.contentTop + Math.max(0, (m.contentHeight - lineH) / 2)
    : m.contentTop;
  const boxTop = lineTop + (lineH - textBoxHeight) / 2;
  return { baselineY: boxTop + ascentPx, ascentPx, descentPx };
}
