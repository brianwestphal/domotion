# Renderer-owned color-glyph boundary

DM-2392 removes Unicode block lists, named emoji exceptions, font-name checks,
and the canvas two-fill probe from the raster-glyph decision. Those mechanisms
answered what a codepoint or a second paint *usually* looks like; Chromium asks
which face and glyph the actual run selected.

## Chromium decision chain

The implementation follows Chromium revision `7d859f271c` and its pinned
emoji-segmenter, ICU, HarfBuzz, and Skia revisions:

1. Blink's emoji-segmenter grammar classifies whole sequences and assigns text
   or emoji fallback priority. The source selector wins over
   `font-variant-emoji`; regional indicators, keycaps, modifiers, tags, and ZWJ
   sequences are grammar tokens rather than per-codepoint exceptions.
2. The normal fallback iterator walks declared faces before its one priority
   face and then system fallback. A presentation selector does not bypass that
   ordering.
3. A face contradicts VS15/VS16 only when cmap14 has no exact sequence, the
   base glyph exists, and its physical table directory says color or
   monochrome. Blink's color predicate is exactly `sbix || (COLR && CPAL) ||
   (CBDT && CBLC)`; OpenType SVG is intentionally not part of this selector
   predicate. An unmatched sequence requeues, and exhaustion resets the entire
   iterator once while ignoring the selector.
4. After shaping, Domotion separately asks whether the selected glyph can be
   emitted as an outline. The answer is per glyph: an sbix image, COLR base
   glyph, bitmap glyph, or SVG-only glyph receives a screenshot overlay;
   an outline glyph in the same mixed face remains vector.

The capture script therefore records every non-whitespace grapheme as a
temporary candidate. `selectedGlyphRasterSpans()` repeats the renderer's real
family/fallback/shaping path with the captured weight, style, stretch,
variations, features, language, and `font-variant-emoji`, then prunes candidates
that selected outline glyphs. Exact UTF-16 spans are the sole input to path
suppression, so a whole flag/keycap/ZWJ cluster is suppressed once rather than
leaving component paths beneath the overlay.

## Pinned data and native faces

Renderer-side scanner categories come from the Chromium-pinned ICU companion.
The in-page scanner uses the captured Chromium process's own Unicode data. When
the ICU helper is absent the Node path remains non-fatal and uses host Unicode
properties as an explicitly approximate fallback.

The macOS, Linux, and Windows glyph helpers report the selected face's physical
`sbix`, `COLR`, `CPAL`, `CBDT`, `CBLC`, and `SVG ` tables in their meta response.
The HarfBuzz shaping proxy forwards this directory unchanged. No PostScript or
family-name substring is accepted as color capability evidence.

CSSOM Range rectangles describe line/advance geometry, not embedded bitmap
strike ink bounds. When the selected representation is CBDT/CBLC, the capture
therefore uses the containing line fragment as the raster boundary; clipping
the screenshot to the glyph Range loses real Noto Color Emoji pixels on Linux.
This boundary follows the selected table representation and does not inspect
the platform, font name, or Unicode value.

## Discriminating controls

The focused matrix covers lone/paired/trailing regional indicators, bare and
VS15/VS16 keycaps, modifier bases and modifiers, valid/broken tags and ZWJ
sequences, explicit-selector precedence over every `font-variant-emoji` mode,
complete and incomplete color-table pairs, sbix image presence, SVG-only
glyphs, and outline and COLR glyphs sharing one face. Browser tests prove that a
monochrome Alchemical Symbol remains vector while an adjacent selected color
emoji receives one populated overlay.
