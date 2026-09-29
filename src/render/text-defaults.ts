/**
 * Fallbacks the renderer applies when a captured element lacks a measurement.
 *
 * The capture always records `font-size`, `fontAscent` and the text metrics, so these are
 * only reached for hand-built trees, partial captures and older captured-tree files. They are
 * defaults, not measurements of Chrome, and are collected here so there is one answer to
 * "what does the renderer assume when it was not told".
 */

/**
 * The `font-size` assumed when a captured style is missing or unparseable: CSS `medium`, 16 px
 * (Blink's default standard font size, `FontSize::kMediumSize` semantics in `font_size.cc`).
 */
export const DEFAULT_FONT_SIZE_PX = 16;

/**
 * Ascent as a fraction of font size when no `fontAscent` was captured. CAPTURE-COMPAT, NO
 * UPSTREAM RULE: real ascent is a font metric (Blink's `SimpleFontData::FloatAscent`); this
 * is the generic Latin-face approximation used only until a capture supplies the measurement.
 */
export const FALLBACK_ASCENT_RATIO = 0.8;

/** Parse a captured CSS pixel size, falling back to {@link DEFAULT_FONT_SIZE_PX}. */
export function fontSizeOrDefault(css: string | undefined): number {
  return parseFloat(css ?? "") || DEFAULT_FONT_SIZE_PX;
}

/**
 * The vertical-text ascent fraction kept for legacy captures with neither a run nor an element
 * `fontAscent` (pre-DM-1024 trees). Pinned by a test; deliberately not folded into
 * {@link FALLBACK_ASCENT_RATIO}, whose 0.8 would move those trees.
 */
export const LEGACY_VERTICAL_ASCENT_RATIO = 0.85;

/** The list-marker ascent fraction kept for pre-DM-2192 trees that lack `markerFontAscent`. */
export const LEGACY_MARKER_ASCENT_RATIO = 0.77;
