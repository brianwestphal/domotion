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
