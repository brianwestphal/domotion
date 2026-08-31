---
id: "requirements/embedded-font-build-diagnostics"
title: "124 — Embedded-font build diagnostics"
kind: "contract"
status: "current"
owners: ["text-fonts"]
platforms: ["macos","linux"]
tickets: [2625]
code: ["src/review/linux-unicode-evidence.ts","src/review/stage-evidence.ts","tests/review-server.tsx"]
aliases: ["docs/124-embedded-font-build-diagnostics.md","doc-124"]
---

# 124 — Embedded-font build diagnostics

Status: **Shipped**.

## Requirement

Every visual-test result records how each embedded font entry was built. The
diagnostic belongs to the same synchronous render generation as the emitted SVG,
so it can distinguish a hinted-subset propagation gap from a remaining
native-font versus webfont rasterization difference without reproducing the CI
host.

Each `embeddedFontBuilds` entry in `results.json` contains:

- the exact renderer instance key and generated CSS family;
- the generated CSS family plus source `path`, TTC `faceIndex`, and resolved
  variation-axis location, plus the builder's input UPEM;
- the selected builder (`hb-subset` or `svg2ttf`);
- all exact hinted-source disqualification reasons: synthetic outline, missing
  source, missing physical face index, source/axis disagreement, CFF or subset
  failure, or the explicit `DOMOTION_HINTED_SUBSET=0` control;
- the emitted font's sorted sfnt table tags, including retained hint tables when
  applicable, plus a dedicated retained-hint-table list; and
- the final TTF byte length and SHA-256 identity; and
- unique glyph count, total glyph occurrences, and distinct shaped-run count.

For an attempted HarfBuzz build, `subsetAttempt` records the immutable source
SHA/size/table inventory, physical face and axes, sorted gid list/hash, session
id and build ordinal, every returned WASM pointer, memory size before/after,
the last stage reached, and the original error. Successful attempts add the raw
subset output SHA/size/tables. The enclosing builder record adds the exact PUA
mapping hash and sorted gid/PUA/advance rows, while its final representation
describes the post-cmap emitted font. Allocation and object-creation return
values are checked before use, and partial allocations are released in one
stage-independent `finally` path.

The WASM module remains cached for the normal fast path. If an operational
allocation/object/subset/output call fails, the identical tuple is retried once
on a pristine WASM instance before the builder is allowed to latch svg2ttf.
Both attempts remain in `subsetAttempts`, with distinct instance ids and a
shared process session/monotonic ordinal. Deterministic input rejections
(invalid axis pins and unsupported outline formats) are not retried. The
repeatability oracle compares one exact variable-font tuple cold, after 96
mixed cached builds, immediately repeated, and after an explicit fresh-instance
reset; all four outputs must have one SHA-256 identity.

The HTML/unicode harness resets the complete generation state before every
fixture. Diagnostics are therefore fixture-scoped; `workerSeq` subtraction is
neither required nor valid. For the pinned 24-row Linux Unicode raster-floor
corpus and its separately adjudicated structural Vedic Extensions row,
`textRunEvidence` additionally persists the fixture on every production run,
UTF-16 and code-point spans, selected physical face, glyph id/cluster,
advance/offset, source-outline digest, and final representation.

The targeted PingFang Extension-B diagnostic row goes further because a hosted
CoreText handle cannot be reconstructed after its runner image expires. Its
run evidence retains the source file SHA-256/size/mtime and the live descriptor
axis dictionary; the result also carries per-codepoint source `Range` geometry,
per-leaf CDP platform-font records, and the emitted SVG SHA/byte length/text
transforms. This fixture bypasses the expected cache so every browser record is
from the run that produced the artifact. The complete SVG remains the geometry
payload; the compact transform list makes placement comparisons possible even
when artifact pruning removes `.svg` files.

`src/review/linux-unicode-evidence.ts` owns the closed acceptance list and the
two-arm adjudicator. Disabling the fontconfig-backed resolver must move selected
face rows. Disabling hinted subset construction must move builder/table/raster
records while leaving the complete logical signature exact. A logical change
always produces `logical-mismatch`; image similarity cannot override it.

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
Selection authority is Chromium `7d859f27`'s `FontFallbackIterator`,
`font_cache_linux.cc`, and `ui/gfx/font_fallback_linux.cc`; shaping authority is
HarfBuzz `4de187d`; native raster ownership is Chromium-pinned Skia `62efacd3`
`SkFontHost_FreeType.cpp` (load flags and `generateImage`).

## Verification

Unit tests cover both a pure hinted entry (including retained `cvt `/`fpgm`/
`prep`) and a synthetic entry with the exact `synthetic` fallback reason. The
HTML/unicode visual harness serializes the diagnostic beside each fixture's
pixel metrics and Chromium face summary.
