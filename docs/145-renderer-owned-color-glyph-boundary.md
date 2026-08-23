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

On Windows that last decision follows Chromium's DEPS-pinned Skia revision
`62efacd37737505732dbe3d8daa62abd679626a1`, not the presence of a path.
`SkScalerContext_DW::generateMetrics()` tries the selected gid's COLRv1 paint
tree, COLRv0 translated color run, SVG image, and PNG image before ordinary
DirectWrite metrics. A successful color query sets `neverRequestPath`; this is
true even when `GetGlyphRunOutline()` can also return the COLR glyph's
monochrome base outline. The outline is therefore not negative color evidence.

The capture script therefore records every non-whitespace grapheme as a
temporary candidate. `selectedGlyphRasterSpans()` repeats the renderer's real
family/fallback/shaping path with the captured weight, style, stretch,
variations, features, language, and `font-variant-emoji`, then prunes candidates
that selected outline glyphs. Exact UTF-16 spans are the sole input to path
paint ownership, so a whole flag/keycap/ZWJ cluster receives one overlay rather
than leaving component paths beneath it. The source sequence itself stays in
the shaped run. Only the selected raster glyph's vector/subset emission is
omitted; its shaped advance and cluster position remain authoritative for every
following outline.

That metrics/paint split is Chromium behavior, not an overlay workaround. On
macOS Skia sets `neverRequestPath` for a color typeface, then independently asks
CoreText for the same glyph's advance with `CTFontGetAdvancesForGlyphs`
(`SkScalerContext_mac_ct.cpp:297-311`, revision `ebf5052`). Replacing a selected
emoji cluster with U+200B before shaping violates the split: the bitmap still
lands at its captured rectangle, but the following vector text loses the emoji
advance and slides underneath it. Domotion therefore reserves U+200B
replacement for zero-area structural markers such as the body copy of a
separately captured `::first-letter`; paint-bearing raster glyphs are shaped in
their original sequence in both paths and embedded-font modes.

## Pinned data and native faces

Renderer-side scanner categories come from the Chromium-pinned ICU companion.
The in-page scanner uses the captured Chromium process's own Unicode data. When
the ICU helper is absent the Node path remains non-fatal and uses host Unicode
properties as an explicitly approximate fallback.

The macOS, Linux, and Windows glyph helpers report the selected face's physical
`sbix`, `COLR`, `CPAL`, `CBDT`, `CBLC`, and `SVG ` tables in their meta response.
Those face-wide tables answer Blink's presentation fallback question and remain
a compatibility input for outline-less glyphs. The Windows helper additionally
returns `rasterRepresentation` on each `glyphs` result after asking the same
selected-gid DirectWrite APIs as pinned Skia. HarfBuzz still owns cmap14/GSUB/
GPOS selection; its selected gid is fetched back from the same native face, so
the per-glyph representation travels with that exact shaped glyph into
`selectedGlyphRasterSpans()`. No PostScript name, family-name substring,
codepoint, or Unicode block is accepted as color capability evidence.

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
emoji receives one populated overlay. The Windows helper test adds the native
mixed-face discriminator: Segoe UI Emoji's selected U+1F600 gid reports COLR,
the same face's ordinary `#` glyph does not, and querying the emoji again by gid
returns the same ownership. The pure activation control changes only that
selected-glyph marker and requires the raster decision to move.

On an exact-block Windows rerun, `tools/unicode-font-route-trace.ts` records the
ordered declared families, fallback mechanism, selected PostScript face/file/
face index, shaped gid and cluster, per-gid raster representation, and final
raster span together. That makes a face-selection or cmap14 retry mismatch
distinguishable from a paint-ownership mismatch in the uploaded trace.

`npm run fonts:renderer-route` also records the macOS whole sequence
`❤️ ⚡️ VS16 wins` under `font-variant-emoji:text`: Chromium faces and scalar
origins, Domotion source spans, selected concrete faces, shaped gids/clusters/
advances, and the two selected `sbix` spans appear in one artifact. Its paired
`DOMOTION_CLUSTER_FALLBACK=0` record must activate `cluster-disabled-legacy`
and change the raster-span result; that negative arm proves the passing default
record traversed the whole-sequence route rather than an unconditional common
path. The `text-font-variant-emoji` visual fixture is the final placement gate.

## Upstream itemization boundary closed by DM-2507

Renderer-owned raster classification begins only after face selection, so it
cannot repair an incorrectly shared fallback iterator. The retained native
arm64 `02-text-emoji` artifact exposed that historical upstream gap. DM-2507
now mirrors Blink: independent bidi/script and `SymbolsIterator` ranges are
intersected before fallback, so U+2717's text iterator cannot lend FreeSans to
emoji-presentation U+2757.

The six other color glyphs in the same artifact traverse this document's
selected-glyph raster boundary exactly. The resolved order pair `✗ ❗` / `❗ ✗`
and opposite-CSS VS15/VS16, CSS-text, and declared-FreeSans controls prove the
logical correction before `selectedGlyphRasterSpans()`. See
[doc 201](201-emoji-presentation-item-ownership.md). DM-2508 owns release-gate
promotion only; this fix does not alter this boundary or authorize a pixel
tolerance.
