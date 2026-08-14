# 124 — Embedded-font build diagnostics

Status: **Shipped**.

## Requirement

Every visual-test result records how each embedded font entry was built. The
diagnostic belongs to the same synchronous render generation as the emitted SVG,
so it can distinguish a hinted-subset propagation gap from a remaining
native-font versus webfont rasterization difference without reproducing the CI
host.

Each `embeddedFontBuilds` entry in `results.json` contains:

- the generated CSS family plus source `path`, TTC `faceIndex`, and resolved
  variation-axis location;
- the selected builder (`hb-subset` or `svg2ttf`);
- all exact hinted-source disqualification reasons: synthetic outline, missing
  source, missing physical face index, source/axis disagreement, CFF or subset
  failure, or the explicit `DOMOTION_HINTED_SUBSET=0` control;
- the emitted font's sorted sfnt table tags, including retained hint tables when
  applicable; and
- unique glyph count, total glyph occurrences, and distinct shaped-run count.

Diagnostics are observational: they do not alter eligibility or fallback. A
failed guard/subset still falls back to svg2ttf so rendering remains functional.
The source and purity rules remain defined in
[99 — Hinting-preserving embedded-font subsets](99-hinted-embedded-subset.md).

## Source correspondence

HarfBuzz preserves hinting unless `HB_SUBSET_FLAGS_NO_HINTING` is requested;
Domotion deliberately omits that flag and records the resulting table directory.
The local HarfBuzz implementation is `external/harfbuzz/src/hb-subset-input.cc`
and the table-subsetting plan is in `external/harfbuzz/src/hb-subset-plan.cc`.
Chromium's Linux webfont consumer passes the sanitized subset through Blink's
font loading and Skia/FreeType raster path; the diagnostic proves the font bytes
and builder choice before any remaining load-flag or rasterizer comparison.

## Verification

Unit tests cover both a pure hinted entry (including retained `cvt `/`fpgm`/
`prep`) and a synthetic entry with the exact `synthetic` fallback reason. The
HTML/unicode visual harness serializes the diagnostic beside each fixture's
pixel metrics and Chromium face summary.
