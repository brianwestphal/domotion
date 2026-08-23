# Mixed-script bidi logical geometry

DM-2524 closes a logical paragraph-itemization mismatch exposed by the
pointed-Hebrew + Arabic + digit residual. It does not fit glyphs to a screenshot
and does not alter any visual threshold.

## Earliest source owner

The pinned Chromium revision is
`7d859f271cbda744098ac69f44978d4edfa62be3`; HarfBuzz is
`4de187dd0a915d13c976fa8bd474c084229f3aab` and Chromium's Skia pin is
`62efacd37737505732dbe3d8daa62abd679626a1`.

The upstream walk separates four decisions:

1. `InlineNode::SegmentBidiRuns` in
   `core/layout/inline/inline_node.cc` calls
   `BidiParagraph::SetParagraph` with the block's resolved `direction`.
   `unicode-bidi: plaintext` is the exception: Blink omits the explicit base so
   UAX #9 P2/P3 selects the first-strong paragraph level. It then copies ICU's
   exact logical levels to inline items and splits at logical-run boundaries.
2. `InlineItemsBuilder::EnterBlock` in
   `core/layout/inline/inline_items_builder.cc` makes `normal`, `embed`, and
   `isolate` redundant at block scope because the paragraph level already owns
   direction. `bidi-override` and `isolate-override` inject LRO/RLO plus PDF;
   those controls are then resolved inside the same paragraph base.
3. `HarfBuzzShaper::ShapeRange` and `ExtractShapeResults` in
   `platform/fonts/shaping/harfbuzz_shaper.cc` pass the resolved direction and
   script to HarfBuzz, then retain HarfBuzz's glyph IDs, cluster order,
   advances, and offsets. HarfBuzz does not rediscover the CSS paragraph base.
4. `TextFragmentPainter` in `core/paint/text_fragment_painter.cc` starts paint
   at the physical fragment box origin and baseline. `ShapeResult::ForEachGlyph`
   in `platform/fonts/shaping/shape_result.cc` adds the ordered HarfBuzz
   advances and per-glyph offsets from that one origin.

Domotion already preserved the downstream owners: captured UTF-16 cluster
origins feed `positionShapedClusters`, cursive Arabic retains native intra-run
advances, and each shaped group uses the minimum captured physical x as its
fragment origin. The earlier stage was wrong:
`src/render/script-segmentation.ts` always asked `bidi-js` for an LTR paragraph
unless CSS selected an override. That preserved direction parity for many
strong-script runs but lost exact levels and neutral ownership under an RTL
block, and it treated `plaintext` as LTR rather than first-strong auto.

The correction passes every captured element's `direction` and `unicode-bidi`
into the shaping/fallback funnel. `bidiLevelsFor` now uses:

- explicit LTR or RTL for ordinary block paragraphs;
- `auto` for `unicode-bidi: plaintext`; and
- Blink's LRO/RLO + PDF controls inside the same explicit paragraph base for
  override values.

The existing override-only native-direction reversal remains override-only.
Merely supplying an ordinary paragraph context cannot reverse source text.

## Exact hostile record

`npm run fonts:mixed-bidi-logical` opens real Chromium capture and records four
rows:

- forward source order under LTR and RTL paragraph bases; and
- reverse source order under LTR and RTL paragraph bases.

Every row contains pointed Hebrew, Arabic combining marks, European digits,
and strong Latin bookends. A nonzero captured letter spacing makes cluster
ownership observable without changing the algorithm being tested. The report
persists, without rounding:

- one UAX #9 level per source UTF-16 unit;
- each Blink-style item span, resolved script, direction, and source priority;
- every selected source face/file/face index/axis digest;
- glyph ID, HarfBuzz cluster, source UTF-16 span, x/y advance, x/y offset;
- captured physical fragment and cluster origins;
- emitted glyph origin and snapped baseline; and
- the pinned source revisions and host fingerprint.

Browser APIs do not expose Chromium's internal glyph IDs. The record therefore
keeps the ownership boundary honest: Chromium supplies paragraph style,
fragment geometry, UTF-16 origins, and ascent; Domotion's selected source file
supplies the exact HarfBuzz stream that its source-outline emitter consumes.

Three hostile mutations are mandatory and fail the command if inert:

- **wrong level:** resolve every row with the opposite paragraph base;
- **wrong cluster:** collapse a multi-cluster pointed-Hebrew stream onto its
  first HarfBuzz cluster, which discards captured post-spacing anchors; and
- **wrong origin:** substitute the logical first character's x for the minimum
  physical RTL fragment x, shifting the emitted run.

`src/render/mixed-bidi-logical.test.ts` separately pins the complete expected
level arrays and item tuples for all four rows. It also pins the `plaintext`
first-strong discriminator (`"אב L"`: ordinary LTR levels `1,1,0,0`, plaintext
levels `1,1,1,2`). This prevents the live oracle from grading a level algorithm
against itself.

## Native gate

`.github/workflows/mixed-bidi-logical-conformance.yml` runs the exact unit
records and live logical oracle on `macos-14`, `ubuntu-24.04`, and
`windows-2025`, retaining one JSON report per native OS. Selected face and gid
records are expected to be platform-specific; item levels, spans, scripts,
directions, mutation activation, and ownership invariants are platform-neutral.

This workflow is deliberately a logical gate. Existing feature-image baselines,
region limits, diff percentages, antialiasing envelopes, and every other visual
tolerance are unchanged.
