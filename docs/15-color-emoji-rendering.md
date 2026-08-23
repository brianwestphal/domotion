# Domotion: Color emoji rendering

Requirements for color emoji glyphs (✨😀🚀⛔🎉 …) in Domotion's SVG output. Origin: DM-278 / DM-334 / DM-335.

> **Cross-platform note**: presentation and raster ownership are shared across
> macOS, Linux, and Windows. The platform helpers expose the selected face's
> physical color tables; the Windows helper also reports the exact selected
> gid's DirectWrite paint representation. macOS can additionally extract a
> high-resolution sbix strike, while Linux/Windows use the exact page screenshot
> for the selected glyph paint.

## Why color emoji are special

Some selected glyphs are represented by bitmap or layered-paint tables (`sbix`
on macOS, commonly `CBDT/CBLC` on Linux, and COLR/CPAL on Windows) rather than a
single reusable outline. OpenType SVG glyphs have the same output boundary.
This is a property of the selected glyph, not of the Unicode codepoint: a mixed
font may contain both COLR and ordinary outline glyphs, and an arbitrary author
icon font can contain color glyphs outside Unicode emoji ranges.

## Capture pipeline

`src/capture/script/emoji-detect.ts` ports Chromium's pinned emoji-segmenter
grammar. It classifies whole regional-indicator, keycap, modifier, tag, and ZWJ
tokens and records every non-whitespace grapheme as a temporary candidate, so
non-emoji color fonts are discoverable too. Post-capture,
`selectedGlyphRasterSpans()` repeats the renderer's actual declared-family,
fallback-priority, system-fallback, and shaping path using the captured CSS
font inputs. Only a candidate whose selected glyph is concretely non-outline
survives into `rasterGlyphs`; entries carry `{ charIndex, charLength, rect,
dataUri? }`, where the UTF-16 length makes whole-cluster suppression exact.
On Windows, a helper glyph's `rasterRepresentation` wins over an available base
outline. This mirrors Skia's selected-gid COLR/SVG/PNG checks: a COLR base
outline is fallback geometry, not proof that Chromium painted monochrome.

Raster ownership suppresses paint, not shaping. A selected color glyph remains
in its original source sequence so its shaped advance positions the following
vector text; only its path or embedded-subset glyph is omitted. This mirrors
macOS Skia, which refuses a path for color faces but still obtains the glyph
advance from CoreText (`SkScalerContext_mac_ct.cpp:297-311`, revision
`ebf5052`). U+200B substitution is reserved for zero-area structural markers
and raw-`<text>` degradation, never for a paint-bearing emoji overlay.

## Bitmap source: Apple Color Emoji sbix table (DM-335)

`rasterizeBitmapGlyphs` in `src/capture/emoji.ts` walks the captured tree post-capture and fills in each `dataUri`. There are two sources:

1. **Apple Color Emoji's `sbix` table** (preferred on macOS). `extractEmojiBitmap(codepoint, paintedWidthPx)` opens `/System/Library/Fonts/Apple Color Emoji.ttc` once (lazy + cached), looks up the glyph via `font.glyphForCodePoint(cp)`, and calls fontkit's `glyph.getImageForSize(ppem)` which returns the embedded PNG bytes for that strike directly. The strike is picked adaptively as `max(64, paintedWidthPx × 3)` rounded up to the nearest available strike (20, 26, 32, 40, 48, 52, 64, 96, 160 ppem). For a typical 18-20px painted rect this lands on the 64-ppem strike (~6KB embedded) which gives ~3× supersampling — sharp through 1×-2× DPR rasterization without bloating file size. Going larger (160-ppem ~24KB) would supersample 8× but adds 18KB per emoji for diminishing visual gain.

2. **Page screenshot** (fallback, was previously the only source). For selected glyph representations that Domotion cannot emit directly, capture Chromium's paint. Outline-independent formats normally use the selected cluster rect. CBDT/CBLC is different: CSSOM exposes the character advance/line geometry, not FreeType's strike bitmap bounds, and Noto Color Emoji can paint outside that rect. A selected CBDT glyph therefore promotes the containing line fragment to the existing segment-level screenshot boundary. This preserves every painted pixel without a platform, family-name, or codepoint rule; the helper's selected representation is the discriminator. The screenshot is exact at capture DPR but visibly soft when enlarged.

The sbix path activates only when:

- `process.platform === "darwin"` and the .ttc file exists.
- `glyphForCodePoint(cp).id !== 0` (the font has a glyph for the codepoint).
- The captured rect is wider than `0.4 ×` its height (filters out zero-width ZWJ joiner chars whose rect is a thin slice — those need pair-aware shaping the bitmap-per-codepoint path can't provide).

## Bitmap sizing — the advance square (DM-1198)

After the sbix bitmap is resolved, `src/capture/emoji.ts::emojiSquareRect` snaps the captured per-char rect to the **square Chrome actually paints the emoji in**: side = the glyph **advance** (the captured `Range.getBoundingClientRect()` width, minus any letter-spacing Chrome appends to the right of the advance), anchored flush-left at `rect.x` and vertically centered in the rect's line box.

The advance — not the font size — is the correct side because Chrome enforces a **minimum emoji advance** that exceeds the font size at small sizes: at `font-size: 16px` the emoji advance is 20px (≈1.25×). Sizing the overlay to the font size (the earlier behavior) painted every inline emoji ~20% too small. The sbix PNG is a full square em bitmap, so drawing it into an `advance × advance` box reproduces both full-bleed emoji and ones with transparent margins (e.g. 📈) without distortion. Verified empirically against Chromium's painted output across `font-size` 16-48 (the square side tracks the advance to the pixel; the vertical center matches within ~1px). The screenshot fallback path (§2) keeps the literal captured rect — it is already a pixel copy of Chrome's paint.

## Render pipeline

`src/render/text.ts::rasterGlyphOverlays` emits one `<image href="data:image/png;base64,…" x=… y=… width=… height=… preserveAspectRatio="none" clip-path="url(#…)"/>` per `rasterGlyphs` entry. The image is positioned at the captured viewport-relative rect (already snapped to the advance square at capture time); its width/height matches the painted size so the bitmap stretches/squishes to fit if the strike's aspect ratio differs slightly from the painted rect.

## Per-strike artwork self-calibration

Apple hand-tunes the emoji artwork PER STRIKE: the same glyph can sit at a
different position inside the bitmap frame at different ppem (U+1F6F7 sled:
ink starts at 5/32 of the 32-ppem frame but 18/96 of the 96-ppem frame;
U+1F684 train: 10/32 vs 23/96), and a few glyphs are outright redrawn between
strikes (U+1F6CE bellhop bell, U+1FA7B x-ray's pixel-sharpened small
strikes). Chrome paints the strike matching the render size 1:1 over the
advance square, so stamping our high-res strike (kept for >1× sharpness) over
the same square landed strike-tuned artwork 1-3px off — the residual regions
in the seven emoji unicode-block fixtures.

`calibrateSbixOverlays` (in `rasterizeBitmapGlyphs`) therefore self-calibrates
every sbix stamp against Chrome's OWN paint: it screenshots the advance square
(transparent background, deduped per codepoint + rounded size), alpha-scans
both the screenshot and the embedded strike for their ink bboxes, and

- **re-solves the destination rect** when the mapped ink misses Chrome's
  measured ink by ≥ ~1px on any edge (position-tuned artwork — sled/train);
- **demotes to the screenshot pixels** when, even aligned, the mean RGBA
  difference over the inked union exceeds a threshold (redrawn-per-strike
  artwork — bell/x-ray): exact at 1× (the fidelity target), at the cost of
  >1× sharpness for that rare glyph;
- leaves strike-invariant artwork (the overwhelming majority) byte-identical
  via a sub-quarter-pixel guard.

No CoreText strike-selection model is involved — an earlier attempt to predict
"the strike Chrome paints" from `smallest strike ≥ size` mis-corrected other
cells; measuring the page is authoritative.

## Path-pipeline interaction (DM-334)

Both path and embedded-font emission consult the selected glyph representation.
They emit no vector outline for a glyph owned by sbix/COLR/CBDT/SVG, and
`text.ts` replaces exactly the captured overlay span with zero-width fillers.
Ordinary uncovered characters still paint the fallback iterator's first
candidate `.notdef`; no Unicode range suppresses tofu.

## File-size budget

The 20-font-family fixture has 3 emoji (😀 🚀 ✨). With the 64-ppem strike picked adaptively each costs 4-9KB embedded as base64 in the SVG. Sustained at ~10 emoji per fixture this adds 60-90KB which is acceptable for the rendering-fidelity gain. Consumers who need smaller files can post-process the SVG with svgo or a separate optimization pass that re-encodes the data URIs at the lowest acceptable strike.

## CSS `font-variant-emoji`

The property is a genuine glyph-lookup and fallback-priority input, not a
raster hint. Blink forces the corresponding variation-selector mode
(`ApplyFontVariantEmojiOnFallbackPriority`, `shaping/harfbuzz_shaper.cc:184-198`;
`HarfBuzzGetGlyph`, `shaping/harfbuzz_face.cc:127-206`, rev `7d859f27`), so:

- `emoji` requests VS16 for Unicode `Emoji` scalars; declared covering faces
  still precede the priority face.
- `text` requests VS15 and can select a monochrome face; when no face satisfies
  the selector, Blink resets the complete fallback iterator once and retries
  ignoring it.
- `unicode` behaves like `emoji` for emoji-default codepoints and like `normal` otherwise.
- An explicit VS15/VS16 in the text always wins over the property.

An exact cmap14 sequence wins before the face-wide presentation predicate. The
predicate is exactly `sbix || (COLR && CPAL) || (CBDT && CBLC)`; SVG is a
separate selected-glyph output capability. See
[145-renderer-owned-color-glyph-boundary.md](145-renderer-owned-color-glyph-boundary.md).

## Known shaping-item boundary gap (DM-2502)

The downstream selected-glyph predicate above is exact, but the current
cluster fallback itemizer does not yet carry Blink's source-owned
`SymbolsIterator` priority boundary. Native Linux arm64 run `32611751700`
exposed the consequence: after a text-priority miss selected FreeSans for
U+2717, the same iterator reused that covering outline face for the following
emoji-presentation U+2757. Chromium created a new emoji-priority item and
painted Noto Color Emoji. Reversing only the two symbols changes Domotion's
answer, while VS15, VS16, CSS-text, and declared-family controls distinguish
the itemization defect from Unicode classification or raster paint.

[Doc 201](201-emoji-presentation-item-ownership.md) records the pinned source,
artifact, and strict native discriminator. DM-2507 owns the production split;
DM-2508 will promote it into the arm64 aggregate. No raster tolerance is
involved.

## Known gaps

- **Non-sbix formats use screenshots.** COLR, OpenType SVG, custom color
  webfonts, and multi-codepoint clusters are captured from the selected paint.
  CBDT/CBLC promotes its line fragment because CSSOM does not expose strike
  ink bounds. These are exact at capture DPR but softer if enlarged.
- **Helper-absent mode is approximate.** The app remains non-fatal, but pinned
  ICU properties and native face-table evidence are official-helper features;
  host Unicode/fontkit provide best effort without them.

## Test coverage

- `tests/output/html-test/20-font-family.html` `.s12` row exercises the typical case (😀 🚀 ✨ — three single-codepoint emoji from different blocks). Visual regression at 16px shows actual closely matches expected with sharper details than Chrome's 1× paint due to 64-ppem supersampling.
- `src/render/text-to-path.test.ts` `Selected raster glyphs suppress vector emission` locks output ownership for U+2728 / U+1F600 / U+1F680 / mixed Smile 😀 runs.
- `src/capture/script/emoji-detect.test.ts` mutation-covers the pinned sequence
  grammar; `src/render/emoji-raster-kind.test.ts` covers mixed faces and every
  complete/incomplete color-table form plus the per-glyph marker movement
  control; `tests/win32-glyph-extractor.test.ts` proves selected Segoe UI Emoji
  gids carry COLR ownership while an ordinary glyph in the same face does not.
  The Alchemical Symbols and raster content browser tests prove negative and
  positive production activation.
