# Browser HarfBuzz substitution-stream ownership

DM-2532 closes the logical gap between the substitution-free native-raster
corpus in doc 197 and browser-shaped OpenType substitutions. The gate proves
portable `GSUB`/`GPOS`, required ligature, contextual-form, mark-attachment,
variation-axis, script, and language-system cases at exact
gid/UTF-16-cluster/source-span/advance/offset granularity. It does not compare
screenshots, fit pixels, widen a tolerance, or change production behavior.

`tools/browser-harfbuzz-substitution-oracle.ts` is the implementation and
`npm run fonts:browser-harfbuzz-substitutions` is its entry point. A local
record can say `exact-logical-agreement`; the cross-platform aggregate remains
`verdict-withheld` until it receives all six macOS/Linux/Windows ×
proposal/validation artifacts with one byte-identical corpus digest and one
byte-identical logical-stream digest. Rasterization remains explicitly
`not-started` at that aggregate boundary.

## Pinned source ownership

The source audit uses Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`, HarfBuzz
`4de187dd0a915d13c976fa8bd474c084229f3aab`, and Skia
`62efacd37737505732dbe3d8daa62abd679626a1`.

- Blink's `PooledHarfBuzzBuffer` creates a new buffer or calls
  `hb_buffer_reset` before reuse; it never sets buffer flags or a cluster level
  (`harfbuzz_shaper.cc:83-105`). HarfBuzz reset assigns
  `HB_BUFFER_FLAG_DEFAULT` and `HB_BUFFER_CLUSTER_LEVEL_DEFAULT`
  (`hb-buffer.cc:285-297`), and the pinned
  public definition makes that default exactly
  `MONOTONE_GRAPHEMES` (`hb-buffer.h:418-467`). This browser-focused gate must
  therefore use monotone graphemes. Doc 114's source-table control oracle uses
  monotone characters as its own explicit gate input; that is not a claim
  about Blink's default.
- Blink fills the buffer from UTF-16 (`case_mapping_harfbuzz_buffer_filler.cc:
  24-64`), then sets language, script, and direction and calls `hb_shape_full`
  with resolved plus authored feature ranges (`harfbuzz_shaper.cc:308-355`).
  There is no raster decision in this step.
- Blink creates the HarfBuzz face from the same `SkTypeface`, copies its exact
  variation design position into `hb_font_set_variations`
  (`harfbuzz_face.cc:550-584`), applies the scaled font, and sends the CSS-pixel
  specified size to `hb_font_set_ptem` (`harfbuzz_face.cc:631-650`).
- The pinned HarfBuzz OT plan activates common `locl`, `mark`, `mkmk`, and
  `rlig` features plus horizontal `calt`, `clig`, `curs`, `kern`, and `liga`,
  then overlays user feature values (`hb-ot-shape.cc:295-399`). It applies the
  substitution plan at lines 911-948, derives advances, executes GPOS/mark
  placement, finishes offsets, and reverses backward runs at lines 973-1105.
- Blink reads HarfBuzz glyph info and positions from the buffer, partitions
  fallback by exact clusters, and inserts the resulting buffer into
  `ShapeResultRun` (`harfbuzz_shaper.cc:509-528,627-785`). `ShapeResultRun` is
  consequently the browser owner of the exact logical stream. Skia is
  downstream and owns the later glyph-mask terminal, not substitution logic.

## Exact ownership join

Every case starts with one checked-in font byte sequence. The oracle verifies
its SHA-256 and required OpenType table directory before using it. Those same
bytes then travel through three legs:

1. A sole data-URL `@font-face` is loaded into Playwright's pinned Chromium.
   CDP `CSS.getPlatformFontsForNode` must report exactly one custom face and
   the exact shaped glyph count. Fixed faces require their exact PostScript
   name; the variable Open Sans face may expose an instance-specific
   PostScript name and is authenticated by its unique normalized internal
   family. Per-scalar DOM Ranges retain the browser-owned UTF-16 origins.
2. Chromium-configured vendored HarfBuzz shapes the authenticated bytes with
   Blink's direction, script, language, feature, CSS size/ptem, variation,
   default buffer flags, and monotone-grapheme inputs. The result retains every gid,
   cluster, derived UTF-16 source span, x/y advance, and x/y offset as exact
   integers.
3. The production renderer registers the same bytes and enables its opt-in
   text-run provenance. The gate requires the selected
   `webfont:<fixture-family>` key, source byte hash and length, HarfBuzz route,
   complete request, and complete emitted glyph stream to equal the oracle
   record field for field.

CDP deliberately does not expose glyph IDs, clusters, advances, or offsets.
The report says `not-exposed-by-cdp` instead of inventing those fields. Browser
ownership is joined source-first: sole exact custom bytes and browser glyph
count identify the face/run; Blink's pinned `ShapeResultRun` path establishes
the owner; the Chromium-configured HarfBuzz result and production provenance
over the identical bytes carry the unexposed logical fields. A browser face or
count disagreement withholds the verdict even when the two local HarfBuzz
records agree.

The aggregate reopens each artifact rather than trusting its booleans. It
recomputes corpus and logical digests, fixture identities and required tables,
each HarfBuzz-to-production field comparison, request/source identity, custom
face and glyph count, mutation coverage, source pins, installed Playwright
package/Chromium revision, and browser/Node versions.

## Portable corpus and exact records

| Case | Portable source | Required tables | Logical discriminator |
| --- | --- | --- | --- |
| `latin-liga-variable-axis` | existing Open Sans variable subset, SHA-256 `c8886233e48f9757d48028f9517bcbe97603e685c31a49eb3a596461621f4a5a` | `GSUB`, `GPOS`, `fvar` | `fi`, `liga=1`, `wght=800`, `wdth=100` becomes one ligature; omitting axes changes its advance |
| `arabic-required-ligature` | HarfBuzz in-house `a919b331…`, blob `d2f116ef…`, SHA-256 `9d9e6025284c0833926775248918ec1fa9b2417fde90abaa663cc9b625e3bdb1` | `GDEF`, `GSUB`, `GPOS` | Arabic `لله` becomes one required/contextual ligature; `-rlig` expands the stream |
| `arabic-contextual-mark-positioning` | HarfBuzz in-house mark-attachment probe `1af86850…`, blob `f450682f…`, SHA-256 `6aeee1f0d98fe4b6b5a7eb99324a2a27549133b2f0ee64a53357c391217767d9` | `GDEF`, `GSUB`, `GPOS` | Arabic `بَبَ` retains two grapheme clusters, distinct contextual base forms, zero-width marks, and a nonzero GPOS offset |
| `language-system-locl` | HarfBuzz in-house `6991b13c…`, blob `d9849668…`, SHA-256 `8440df3446a0724e2498ba62980d55ad0b0ad5e568cdc0ad4efd85c7f8d4b455` | `GSUB` | `J` under `Latn`/`zh-Hant-HK` selects gid 6; hostile `zh` selects a different language-system glyph |

The checked-in HarfBuzz fonts retain their upstream revision, path, Git blob,
and exact embedded-license status in every report. They are upstream in-house
test fixtures: the IranNastaliq and tiny ProbeMid mark-attachment files have no
embedded copyright/license string, and the LOCLTest file carries an Adobe
copyright but no license string. The evidence
does not relabel those font bytes with HarfBuzz's source-code license. The Open
Sans subset retains its existing repository provenance and SIL OFL 1.1
declaration.

The current exact logical streams are:

```text
latin-liga-variable-axis:
  gid907 cluster0 span[0,2] advance(1511,0) offset(0,0)

arabic-required-ligature:
  gid26 cluster0 span[0,3] advance(1503,0) offset(0,0)

arabic-contextual-mark-positioning:
  gid4 cluster2 span[2,4] advance(0,0)   offset(0,0)
  gid5 cluster2 span[2,4] advance(200,0) offset(0,0)
  gid4 cluster0 span[0,2] advance(0,0)   offset(10,100)
  gid1 cluster0 span[0,2] advance(200,0) offset(0,0)

language-system-locl:
  gid6 cluster0 span[0,1] advance(1000,0) offset(0,0)
```

For the checked-in corpus, the canonical corpus SHA-256 is
`e03e725648f3a4a648e0b62fc4f0bb63257fdf06dc7050c46dc20d863217a360`
and the canonical logical SHA-256 is
`94f7cf5b027853b255e0a22e1b0fd65168580ed294c2e6dd268d1165de8a97a2`.
Any fixture, input, or exact stream change necessarily creates a new evidence
identity and cannot inherit an earlier aggregate verdict.

## Hostile non-vacuity controls

Thirteen mandatory mutations must all move the exact record and be rejected:

- disable `liga`, omit variation axes, and disable `rlig`;
- substitute the wrong script, direction, browser cluster level, or language
  system;
- corrupt the source fingerprint, gid, cluster, UTF-16 source span, or advance;
- zero a real GPOS mark offset.

The current mutations discriminate glyph count, gid, cluster, span, advance,
and offset fields. In particular, changing the Arabic-mark case from Blink's
default monotone-grapheme level to monotone characters moves the cluster/span
record. A mutation that is inert, missing, duplicated, or marked rejected
without a changed exact field withholds aggregate ratification.

## Proposal/validation and raster ordering

`.github/workflows/browser-harfbuzz-substitution-streams.yml` runs a Cartesian
matrix of `macos-14`, `ubuntu-24.04`, and `windows-2025` with independent
`proposal` and `validation` browser processes. Each arm installs the lockfile's
pinned Playwright Chromium, proves the portable fixtures and mutations,
collects one browser/production logical report, and uploads it separately. The
Linux aggregate downloads all six artifacts and requires:

- exactly one proposal and one validation report for every declared OS;
- exact Chromium/HarfBuzz/Skia source pins, the installed Playwright
  package/Chromium revision, and single browser/Node versions;
- the same corpus and logical SHA-256 on all six arms;
- all four cases, all fixtures/tables, all browser/production joins, and all
  thirteen hostile mutations.

Only then can it emit `proposal-validation-agreement`. The workflow contains no
screenshot, PNG, pixel residual, tolerance, threshold, or envelope step. Doc
197's already-ratified substitution-free native-raster matrix remains unchanged.
If a future ticket adds substitutions to native raster grading, this six-arm
logical aggregate is a strict prerequisite and must remain a separate artifact.

## Local verification and retained-evidence status

On the implementation host:

- logic-only collection: 4/4 exact cases and 13/13 rejected mutations;
- unit and workflow proof: 8/8 tests;
- real Playwright browser ownership: 1/1 E2E test;
- TypeScript: `tsc --noEmit` clean.

The first retained native six-artifact aggregate can only be collected after
the workflow lands and runs on GitHub-hosted macOS, Linux, and Windows. Until
that artifact exists, the implementation is usable but the report correctly
withholds cross-platform ratification; it does not fall back to raster grading
or relax any existing visual cap. DM-2552 owns that bounded retained-evidence
run and documentation update; it does not own production or raster changes.
