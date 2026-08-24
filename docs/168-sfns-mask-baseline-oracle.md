# SFNS CoreText mask and baseline oracle

DM-2452 is the diagnostic follow-up to the three font-size-space work. DM-2567
closes the bounded variable-outline ownership gap that diagnostic exposed.
DM-2568 pins the remaining terminal-mask source path, resolves the
zoom/transform cancellation row to a 13px scaler as an implementation
prediction, and defines the private-Skia plus instrumented-Chromium evidence
needed to turn that prediction into an exact gate. The private pinned-Skia
proposal collector now retains actual scaler records, matrix factorization,
gamma/preblend state, and mask bytes. DM-2575 adds the independent test-only
pinned-Chromium validation arm, with exact browser-constructed records and
post-conversion buffers from 26 separately launched, explicitly headless
processes. DM-2576 adds the exact cross-arm adjudicator and an optional
manual-only CI gate. The retained arms authenticate individually and agree on
the decisive `[13,13]` cancellation scaler, but the adjudicator correctly
withholds terminal-mask readiness because their exact shaped advances,
placement/phases, selected typeface identity, records, and mask bytes are not
equal. Validation v2 now retains the formerly absent direct shaped offsets and
full gamma/preblend buffers, so missing evidence no longer explains that
verdict.
No visual tolerance is accepted: the terminal mask comparison remains
diagnostic, while the CoreText design-command seam is already an exact logical
proposal/validation gate. The focused macOS runner is
`tools/sfns-mask-baseline-oracle.ts`; its native companion is
`tools/sfns-mask-baseline.swift`.

## Question and fixed inputs

The oracle asks where the remaining SFNS zoom/transform residual first becomes
observable after glyph placement is held constant. Every row uses the physical
bytes at `/System/Library/Fonts/SFNS.ttf` (SHA-256
`2bfd40dc72e6759e248f82a52a40d551338979fffc9b5c070e685b4b7ad19e66`),
the text `zoom2!`, and the same gids at the same captured Skia quarter-pixel x
keys. The base axis dictionary is complete:

```text
wdth=100, opsz=17, GRAD=400, wght=700
```

Chromium receives those exact bytes through an isolated `@font-face` route.
CDP must report a custom face and the report records the routed source digest.
For the Domotion arm, only the captured family lookup is returned to the
production `system-ui` route; that route must prove the same SFNS path and
digest through text-run provenance. All captured origins, font metrics, style,
axis requests, and transforms are otherwise retained. CoreText re-maps the
text independently and must return the supplied gid list
`[969, 815, 815, 795, 1310, 1377]`.

Each row crosses four representations:

1. Chromium's macOS glyph paint;
2. a direct `CTFontDrawGlyphs` mask from the exact bytes;
3. `CTFontCreatePathForGlyph` geometry using pinned Skia's subpixel path rule,
   rasterized by Chromium as SVG; and
4. production Domotion path emission, also rasterized by Chromium as SVG.

The native mask and both vector arms receive one shared emitted baseline and
the same quarter-pixel x list. Browser layout baseline, captured ascent/descent,
Domotion's emitted baseline, CoreText typographic metrics, coverage centroids,
fixed-position coverage, and the best integer y fit are separate fields. A
baseline move therefore cannot silently become a mask verdict.

## Pinned source ownership

Chromium revision `7d859f271cbda744098ac69f44978d4edfa62be3` pins Skia revision
`62efacd37737505732dbe3d8daa62abd679626a1` in `external/chromium/DEPS`.
The implementation follows these exact source seams:

- Blink's ordinary macOS `SkFont` starts with antialiasing, subpixel
  positioning, and `kSubpixelAntiAlias` edging enabled. It disables smoothing
  for `-webkit-font-smoothing:antialiased`, and uses no hinting for that mode or
  `text-rendering:geometricPrecision`
  (`font_platform_data_mac.mm:211-271`).
- Blink's custom-font path applies explicit variation settings, including an
  explicit `opsz`, before cloning the SkTypeface
  (`font_custom_platform_data.cc:102-239`).
- Blink hands direct HarfBuzz advance, offset, and accumulated-advance facts to
  paint through `ShapeResult::ForEachGlyphImpl` or the paint-owned
  `ShapeResultView::ForEachGlyphImpl`; the validation hook records those values
  before bloberization instead of reconstructing them from adjacent origins.
- macOS Skia constructs data-backed typefaces through
  `SkTypeface_Mac::MakeFromStream`, keeping the CoreText backend
  (`SkFontMgr_mac_ct.cpp:485-507`).
- Skia builds a complete, clamped CoreText variation dictionary and applies it
  with `CTFontCreateCopyWithAttributes`
  (`SkTypeface_mac_ct.cpp:1075-1174,1213-1217`).
- Skia disables CoreGraphics font quantization, enables subpixel positioning,
  calls `CTFontDrawGlyphs`, then performs its mask conversion
  (`SkScalerContext_mac_ct.cpp:229-290,464-515`).
- For an axis-aligned horizontal baseline, Skia's path arm asks CoreText for a
  4x-x path and scales x back by 1/4, retaining y hinting
  (`SkScalerContext_mac_ct.cpp:621-675`). The Swift helper mirrors this rather
  than treating the ordinary point-size path as Skia's path.
- Native ascent, descent, leading, and bounding-box facts come from the
  separate Skia/CoreText metrics seam (`SkScalerContext_mac_ct.cpp:680-690`).
- The two-bit subpixel key and axis-aligned rounding rules come from
  `SkGlyph.cpp:696-734`; scaler matrix factorization is in
  `SkScalerContext.cpp:874-984`.
- Chromium initializes the process-wide LCD order, contrast, and gamma from
  `gfx::GetFontRenderParams` (`content/browser/browser_main_loop.cc:985-994`).
  macOS defaults to antialiasing, RGB subpixel rendering, subpixel positioning,
  and medium hinting (`ui/gfx/font_render_params_mac.cc:15-36`); the pinned Skia
  defaults are sRGB transfer and contrast `0.5` (`include/core/SkTypes.h:84-93`).
- Skia's mask strike is built from the font size and the live device matrix,
  surface pixel geometry, subpixel/hinting/edging flags, luminance, gamma, and
  contrast (`SkScalerContext.cpp:1053-1219`). Unknown pixel geometry or an LCD
  mask that is too large converts the request to A8 and marks it as generated
  from LCD.
- `SkGlyphRunPainter` adds the draw origin to the current draw matrix, gives
  that same matrix to `SkStrikeSpec::MakeMask`, and packs the mapped position's
  two-bit x/y phases (`SkGlyphRunPainter.cpp:120-163,242-335` and
  `SkStrikeSpec.cpp:133-146`). Thus the transform participating in the SkCanvas
  draw also participates in the scaler record; it is not an unrecorded
  post-strike author transform on this route.

Apple's public `CTFont.h` contract independently fixes what can be observed at
the proprietary boundary: `CTFontCreateCopyWithAttributes` creates the varied
copy; the metrics and advance APIs expose the selected font's numeric facts;
`CTFontCreatePathForGlyph` applies point size, font matrix, and caller
transform in order; and `CTFontDrawGlyphs` draws caller-supplied shaped gids at
caller-supplied positions. The API does not specify glyph-mask bytes, smoothing
gamma, or cache behavior. Those pixels cannot be reconstructed from the public
path contract alone.

## Source adjudication

### Identity, origins, and lifecycle

The artifact authenticates one physical source by path and SHA-256, not by a
possibly size-dependent CoreText display name. Chromium and Domotion report
the same digest and the native arm opens that exact path. All arms agree on the
complete axis dictionary, cmap mapping, and supplied gid stream; browser and
native metrics remain separate facts:

| Row family | Native CT size / ascent / descent / leading | Browser ascent / descent | Captured / emitted baseline |
| --- | --- | --- | --- |
| zoom, optical-none, opsz mutation | 26 / 25.13671875 / 5.484375 / 0 | 25 / 5 | 43.25 / 43 |
| transform scale 2 | 26 / 25.13671875 / 5.484375 / 0 | 26 / 6 | 45.25 / 45.25 |
| zoom/transform cancellation | 13 / 12.568359375 / 2.7421875 / 0 | 12.5 / 2.5 | 30.75 / 30.75 |

The six-glyph corpus exercises x phases `0`, `.25`, `.5`, and `.75`; emitted y
phases are `0`, `.25`, and `.75`. Every phase is supplied identically to the
native and Domotion arms. Two independent cold observations and two warm
observations are byte-stable at every stage. Every best integer y correction
is zero. Thus neither a different face, gid, axis instance, metric/baseline
handoff, quarter-origin phase, nor warm-cache transition explains the
dominant residual.

### Uniform matrix factorization

The requested rows contain only uniform matrices. Pinned Skia factors the total
scaler matrix `A` into a uniform vertical scale `s` used for the `CTFont` point
size and a residual `sA`. For uniform positive `A`, `sA` is exactly identity
(`SkScalerContext.cpp:941-966`):

| Row | CSS-computed size | Uniform paint transform | Candidate total `A` | If carried by the scaler: CT size / residual |
| --- | ---: | ---: | ---: | --- |
| `zoom-2` | 26 | 1 | 26 | 26 / identity |
| `transform-scale-2` | 13 | 2 | 26 | 26 / identity |
| `zoom-2-transform-half` | 26 | .5 | 13 | 13 / identity |
| `optical-sizing-none` | 26 | 1 | 26 | 26 / identity |
| `opsz-26-mutation` | 26 | 1 | 26 | 26 / identity |

This rules out an omitted residual skew or anisotropic matrix in the current
oracle arms. DM-2568's pinned source trace further establishes that the live
draw matrix participates in strike construction, selecting a 13px scaler for
the cancellation row. The retained pinned-Skia proposal captures that actual
record and reports scale `[13,13]`; DM-2575's independent pinned-browser trace
authenticates the same `[13,13]` factorization at Chromium's live
record-construction boundary.

### Hinting, antialiasing, and mask conversion

Pinned Skia's macOS route is more than a direct CoreText RGBA draw:

1. `SkTypeface_Mac::onFilterRec` maps every non-none hinting request to normal
   hinting and classifies the runtime CoreGraphics smoothing behavior as none,
   grayscale, or subpixel. A requested LCD mask may become A8 while preserving
   CoreGraphics hinting (`SkTypeface_mac_ct.cpp:887-986`).
2. Skia's runtime discriminator paints smooth and unsmoothed glyphs, compares
   their bitmaps, and caches the classification because CoreText exposes no API
   for this fact (`SkCTFont.cpp:213-275` at the pinned Skia revision).
3. The scaler draws black-on-white into an alpha-less DeviceRGB bitmap with
   font quantization disabled, subpixel positioning enabled, explicit
   antialias/smoothing flags, and the residual text matrix
   (`SkScalerContext_mac_ct.cpp:177-294`).
4. Skia then linearizes CoreGraphics' smooth output, converts RGB to A8 or
   LCD16, and may apply luminance preblend
   (`SkScalerContext_mac_ct.cpp:366-519`). Scaler-record construction also
   carries device pixel geometry, gamma, contrast, subpixel, baseline, and
   mask-format decisions (`SkScalerContext.cpp:1053-1219`). Chromium seeds the
   global pixel geometry, text contrast, and gamma in
   `content/browser/browser_main_loop.cc:985-994`.

The Swift arm deliberately draws white-on-black into premultiplied RGBA. It is
a useful native-raster discriminator, but it is not byte-equivalent to Skia's
post-conversion A8/LCD mask. Its proximity to Chromium therefore cannot define
a tolerance or prove a Domotion route change.

### DM-2568 terminal-mask investigation

The remaining bytes are observable without an Apple-private API, but not by
the existing public-CoreText draw. A hermetic executable built inside pinned
Skia can use `SkScalerContext::MakeRecAndEffects`, descriptor construction, and
the selected typeface's scaler creation (`SkScalerContext.h:291-382`,
`SkTypeface.h:323-348`). It can then pack the exact gid/phase, materialize the
glyph, and read the final image and mask metadata (`SkGlyph.h:44-120,422-477`).
`SkMaskGamma.h:191-227` also exposes the computed preblend tables to that
in-tree harness. This is the proposal-side API boundary: it exercises Skia's
actual private implementation rather than attempting to reconstruct the bytes
from `CTFontDrawGlyphs`.

### Pinned-Skia proposal collector

`tools/sfns-pinned-skia-collector/sfns_post_conversion_collector.cpp` is copied
temporarily into the authenticated checkout of Skia revision
`62efacd37737505732dbe3d8daa62abd679626a1` and built by
`tools/build-sfns-pinned-skia-collector.mjs`. It is a private-API evidence
binary, not a production dependency. The build manifest pins its source, GN,
Ninja, compiler, shared scenario manifest, schema, collector, and output-binary
digests. The build driver uses the existing authenticated Chromium build
assets; it neither fetches tools nor leaves its temporary source overlay in the
checkout.

DM-2586 adds an independent Chromium-exact OTS step before the proposal arm.
`tools/build-sfns-pinned-ots-sanitizer.mjs` builds the evidence-only wrapper in
`tools/sfns-pinned-ots-sanitizer/` against OTS revision
`46bea9879127d0ff1c6601b078e2ce98e83fcd33`. Its table actions and 128 MiB
output envelope match pinned Blink's `WebFontDecoder`. Starting from the
authenticated 7,909,644-byte `/System/Library/Fonts/SFNS.ttf`, the independent
run produces a 7,806,016-byte SFNT with SHA-256
`48eedcecfc1b0338a2b0deaac43b017df55b3023cff2c5e8ecc87570b4eacff4`.
The proposal does not copy or read the validation arm's decoded font or mask
bytes.

The native process authenticates both the original and independently decoded
SFNS bytes, constructs its CoreText-backed typeface from the decoded stream at
collection index zero with the complete four-axis tuple, builds the raw rec with
`SkScalerContext::MakeRecAndEffects`, obtains the scaler's actual filtered rec,
calls `computeMatrices(kVertical)`, and materializes each retained glyph through
`makeGlyph` plus `setImage`. It embeds every final mask byte in the JSON beside
its exact dimensions, row bytes, format, and SHA-256. It also retains the full
gamma table and all three 256-byte preblend tables, not only their digests.

Both arms consume `tools/sfns-terminal-mask-manifest.ts`. That source-owned
manifest declares only the authenticated corpus, gids, axis requests, exact
white paint/surface/scaler inputs, source start and baseline, full live device
matrix, and browser CSS request for five scenarios and six controls. It contains
no shaped advances or offsets, derived origins, phases, records, metrics, or
mask bytes. Each arm derives those outputs independently. Proposal observation
IDs are arm-qualified. The native collector records shaped advances/offsets
separately from strike advances/fixed subpixel offsets, the source and mapped
positions on both sides of Skia's rounding step, raw and normalized CoreText
metrics, both scaler records, all factored matrices, and every mask.

The retained proposal artifact is
`.pr-notes/artifacts/dm2577-sfns-pinned-skia-proposal.json` (artifact digest
`0b84c3eac49fc805566b32f81cd3f52fea8343d713c36ed186ed4db23c015b0c`,
file SHA-256
`3ffcdef85e8e24c2a84354c4d1715ad565b457d0496e2a7a4936358a06a45d30`).
It contains 26 separately launched native observations: two cold and two warm
processes for each of the five fixed scenarios, plus active phase,
anti-aliasing, hinting, device-matrix, optical-size, and
surface-geometry/mask-format controls. Warm observations prime and then reuse
the same scaler context; every retained observation still has its own process.
All four lifecycle observations in each scenario have one exact logical digest.
The collection launches no browser.

On the retained host, `SkCTFontGetSmoothBehavior()` returned `some`. The normal
rows record raw LCD16 recs and actual filtered A8 recs; all retained glyph
images are exact A8 buffers. Gamma contributes a 2,048-byte table and the
artifact retains the table bytes plus all three 256-byte preblend buffers. The base, transform,
optical-none, and optical-size rows factor to `[26,26]`; cancellation factors
to `[13,13]`. Every positive control moved its required exact evidence group,
with no threshold or fitted comparison. The fail-closed schema in
`tools/sfns-pinned-skia-mask-schema.ts` reopens all embedded base64 rec,
gamma/preblend, and mask bytes; recomputes their digests; authenticates the
record's process-local typeface ID against the decoded typeface; validates the
manifest, OTS metadata, axes, derived positions, two-bit phases, matrices,
CoreText normalization, arm-qualified IDs, and lifecycle equality; and seals
the whole artifact. These are proposal facts only; they do not establish
Chromium agreement by themselves.

The independent validation boundary is the browser that constructs the record.
DM-2575's test-only build at Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` can narrowly trace
`SkScalerContext::MakeRecAndEffects`, `SkTypeface_Mac::onFilterRec`, and
`SkScalerContext_Mac::generateImage` for only the authenticated SFNS digest and
an explicit scenario observation id. The trace must retain raw and filtered
records, total/factored matrices, packed phase, surface properties, runtime
smoothing result, gamma/preblend inputs, and the post-conversion buffer. The
hook is false by default, absent from ordinary builds, and must not ship in
production.

### Pinned-Chromium validation collector

`tools/chromium-sfns-validation/` retains the exact overlay for Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and Skia
`62efacd37737505732dbe3d8daa62abd679626a1`. Its private GN argument defaults
to false. When explicitly enabled for the isolated validator build, the hook
records six existing seams without changing their values: direct Blink shaping,
raw scaler-record construction, macOS record filtering, full filtered-record
gamma/preblend construction, direct-mask run/phase packing, and the
post-conversion macOS mask buffer. The hook writes only when the ABI,
observation envelope, exact 7,909,644-byte source-SFNS digest, deterministic
pinned-OTS decoded-stream digest, and target gid stream all match. The two font
identities are distinct because Blink's mandatory OTS pass constructs Skia's
typeface from sanitized bytes; the collector authenticates the source route
and the hook authenticates the exact derived stream. Its retained source,
patches, build inputs, and emitted binary are SHA-authenticated in the artifact.

`tools/sfns-pinned-chromium-validation-collector.ts` launches one fresh browser
process for each observation with both Playwright `headless: true` and
`--headless=new`; `--disable-gpu` fixes the CPU bitmap-mask route. Normal rows
also pass `--enable-lcd-text`, because Chromium's macOS headless source path
otherwise disables LCD text before Skia constructs the record. The independent
surface control passes `--disable-lcd-text` and proves the resulting
unknown-pixel-geometry/LCD-to-A8 transition. There are two cold and two
independently launched warm observations for each of the five scenarios, plus
one phase, antialiasing, hinting, device-matrix, optical-size, and
surface/mask-format control: 26 browser launches in total. Each event has a
monotonic process-local sequence and exact observation identity. The schema
rejects dropped, duplicate, reordered, stale, cross-process, or wrong-source
events; reopens every base64 scaler record, complete 2,048-byte gamma table,
three 256-byte preblend buffers, and mask; recomputes every digest; authenticates
the direct Blink shape-to-Skia-run coordinate seam and raw/normalized CoreText
metrics; requires exact lifecycle equality; and proves every control moved its
owned evidence groups. Comparisons are byte equality, never a fitted threshold.
Each 56-byte record remains embedded and SHA-authenticated, and its leading
`SkTypefaceID` must match the event's observed typeface. Only that four-byte
process-local ID is zeroed when computing cross-process logical digests; it is
identity plumbing, not a raster input, and proposal/validation processes cannot
share it. Every other record and mask byte remains exact.

The build uses Chromium's exact filtered GCS Node dependency bundle. A retained
macOS build profile prevents TypeScript's resolver from escaping the isolated
checkout into this repository's unrelated `node_modules`; that profile affects
only build-tool reads and has no runtime or rendering effect. The host's pinned
Xcode Metal component, GN, Ninja, Clang, Chromium/Skia revisions, GN arguments,
hook sources, test sources, binary, and SFNS bytes are all retained as build
facts. No production source, renderer route, or visual tolerance changes.

The retained Chromium `151.0.7918.0` result decides the cancellation question:
zoom 2 plus `transform:scale(.5)` carries a 26px `SkFont`, but its live .5
device matrix factors to a `[13,13]` scaler with an identity residual. It does
not rasterize a 26px mask for later resampling. The ordinary rows begin with
browser-constructed LCD16 records and macOS filtering produces the exact A8
records used by every retained post-conversion mask. Runtime smoothing is
`some`; all four fresh-process observations in each scenario have one identical
logical digest after removing only the authenticated process-local typeface id.
The six controls move every evidence group they own.

The retained validation-v2 artifact has sealed digest
`55197a4575ea78723de7e173a60e8e7ab991f055a4e4da204ad976c37e04bd8b`
and file SHA-256
`2403c4664983d8286aa7cde59ea5028bf32b0c1a69f819f5fc68d5e18473bf33`.
Its authenticated `headless_shell` SHA-256 is
`71f9ce3c463efc910151055e3f73f0416aa6a461552d103921e6a125f4cb2170`.

Two earlier bounded host observations support that design without pretending
to be the exact cross-arm gate. The new proposal artifact supersedes the first
one only on the private-Skia side:

- An independent reproduction of pinned Skia's embedded SpiderSymbol smooth
  discriminator (`SkCTFont.cpp:213-275`) classified this host's CoreGraphics as
  `some`: the smooth and unsmoothed images changed 126 pixels out of 136
  nonzero pixels, while zero pixels had unequal RGB channels. The exact
  embedded 1,984-byte font had SHA-256
  `e5f0e22cc84fb26b8ca9107bdd394f9fd511e592fa3ccb65ada870345becc324`.
  This proves a grayscale smoothing environment for that run, not the return
  value of an instrumented Skia call, and the runtime classification remains an
  authenticated artifact field.
- An explicitly headless Chrome `147.0.7727.15` command log at DPR 1, using the
  exact SFNS bytes and a CDP-confirmed six-glyph custom face, recorded 26px text
  with no concat for `zoom:2`, 13px text under `scale(2)` for the transform row,
  and 26px text under `scale(.5)` for the cancellation row. The pinned source
  path above folds that last canvas matrix into the strike, so it selects a
  13px total scaler matrix rather than a 26px mask resampled afterward. Because
  the observed binary is Chrome 147 while the source pin is Chromium 151, the
  command log is drifted corroboration only. The private-Skia proposal now
  records the predicted 13px result, and DM-2575's pinned validation hook now
  independently authenticates the browser-constructed `[13,13]` record.

The exact adjudicator requires distinct proposal/validation builds and
observation ids, two cold and two warm samples, and equality of source/font,
typeface/axes, gid/advance/offset, metrics/baseline, raw/filtered records,
matrices, two-bit phases, hinting/edging/mask format, surface properties,
smoothing, gamma/contrast/preblend digests, raster dimensions/row bytes,
pre-compositor scale, and every post-conversion byte. Phase, AA/hinting,
matrix, opsz, and surface-geometry/mask-format mutations must all be active;
dropped, duplicated, reordered, stale, or wrong-identity observations fail
closed. There is no pixel tolerance.

The proposal-side pinned-Skia collector and independent test-only
pinned-headless Chromium validator are implemented. DM-2576's adjudicator is
`tools/sfns-terminal-mask-adjudicator.ts`. The original DM-2576 report (file
SHA-256 `ba14ff03e75e5ace2b609f14cbd7e0c18ff35ca99cd9a73571056028ca5caf3c`,
sealed report digest
`e730e1cf8216e9d15c62fd6ee06b3bcd2763c9ae735dfab8a7c24ba32613d72c`)
is the historical result described immediately below. The proposal recollection
first replaced it with a v2 re-adjudication; the validation-v2 recollection now
replaces the same retained path,
`.pr-notes/artifacts/dm2576-sfns-terminal-mask-adjudication.json`, with the v3
re-adjudication described after the proposal history.
It re-runs both arm schemas, recomputes both artifact digests, requires distinct
authority/build/binary identities, pairs all 26 observations, and compares
every required field and embedded mask byte. Only the first four
`SkScalerContextRec` bytes—the separately authenticated, process-local
`SkTypefaceID`—are zeroed. The optional workflow is manual-only and stays red
until exact adjudication succeeds. None of this evidence infrastructure changes
production rendering or the existing source-backed outline gate.

### Original DM-2576 cross-arm result

Both retained inputs pass their independent fail-closed schemas. Their build
identities and binary digests are distinct, and all eight cancellation
observations—two cold and two warm in each arm—factor exactly to `[13,13]`.
This closes the 13px-versus-26px decision: Chromium does not rasterize a 26px
mask and resample it later. Cross-arm authentication separately records one
integrity failure because the ordinary scenario observation IDs overlap.

The terminal-mask gate is nevertheless **not ready**. Exact adjudication finds
721 field/byte mismatches across the 26 paired observations. The repeated
count is intentional: cold and warm equality inside an arm cannot excuse a
cross-arm disagreement. The governing incompatibilities are:

- the 20 ordinary scenario observations reuse the same IDs in both arms,
  violating independent observation identity;
- the proposal uses the original data-backed typeface (`.SFNS-Bold`), black
  paint, surface contrast `0.5`, and diagnostic absolute origins/baselines,
  while Chromium uses the OTS-sanitized stream, its rewritten PostScript name,
  white paint, surface contrast `0`, and live run-coordinate origins/baselines;
- those paint/surface facts change the raw and filtered record bytes beyond the
  permitted four-byte runtime ID. Pinned Skia source makes the dependency
  direct: `MakeRecAndEffects` stores luminance/gamma/contrast, `onFilterRec`
  halves the smoothing luminance and derives preblend, and `generateImage`
  applies the resulting tables to the final buffer;
- the validation v1 artifact retains strike subpixel offsets but not the
  required shaped glyph offsets, and retains preblend digests but not the full
  2,048-byte gamma-table digest/shape required for cross-arm equality;
- CoreText metric projections disagree on `xHeight`, transform/cancellation
  placement and two-bit phases do not share one coordinate envelope, and every
  paired post-conversion glyph mask differs byte-for-byte. Raster dimensions
  mostly agree, which cannot substitute for unequal bytes.

The report retains SHA-256 group identities rather than eliding these facts or
inventing a normalization. The next evidence collection must independently
produce the same OTS-decoded font stream, paint/surface inputs, run-coordinate
placement and phase, complete metrics/offset/gamma fields, and arm-qualified
observation IDs before the manual workflow can become an optional passing gate.

### DM-2586 proposal recollection

DM-2586 performs that correction on the proposal arm without consuming the
validation arm's result bytes. Its pinned OTS executable independently
reproduces and authenticates the sanitized SFNT. The new proposal collection
uses the shared input-only manifest, the sanitized stream at collection index
zero, Chromium's white paint and zero contrast/gamma surface envelope, the full
translated device matrices, and arm-qualified IDs. Position, rounding, phase,
record, metric, gamma, preblend, and mask outputs are derived inside the pinned
Skia process. No diagnostic origin array is passed into the native collector.
The exact data-backed identity is `.SFNS-Bold` at the named `opsz=17` instance;
the non-named `opsz=26` instance reports
`.SFNS-Regular_wdth_opsz1A0000_GRAD_wght2BC0000`. The schema pins that
source-observed distinction literally rather than normalizing either name.

The v2 adjudicator keeps the same sole record normalization: only the first
four process-local `SkTypefaceID` bytes may be zeroed. It compares the decoded
font identity, raw and normalized CoreText metrics, shaped advance/offset,
strike advance/fixed offset, full placement and phase, full gamma/preblend
buffers, and every mask byte as separate exact groups. The retained validation
v1 input remains fail-closed and **not ready** because it does not contain the
separate shaped offsets or full gamma/preblend buffers required by that v2
contract. DM-2587 must independently recollect the validation arm from the same
manifest before DM-2588 can ratify cross-arm equality. DM-2586 therefore makes
no terminal-mask readiness claim.

The retained v2 report has file SHA-256
`740f8886167675c5b4d0f3c4fccbd784ec8649cb65ec136e582f2d5d59ad517b`
and sealed report digest
`508ebc27b7f3d2385f05a5b104e9af5401438855fb094e76ed7dd3e6fb24bd24`.
Both inputs pass their own schemas; all 26 observations pair, all authorities,
builds, binaries, and observation IDs are independent, and there are zero
input-integrity errors. Cancellation remains exact at `[13,13]`. The result is
still **not ready**, with 784 exact mismatch records. Of those, 338 are required
facts absent from validation v1: 26 full-gamma groups, 156 shaped-advance
groups, and 156 shaped-offset groups. The remaining 446 retain literal legacy
v1 differences: 21 typeface groups; one font, raw-rec, and filtered-rec group;
123 mask groups; 47 glyph-metric groups; 122 phase groups; and 130 placement
groups. These are not excused or fitted. The shared-manifest validation v2
recollection in DM-2587 must resolve or retain them independently before
DM-2588 can make any equality claim.

The work is evidence-only: it changes no production rendering source, route,
or tolerance. Proposal recollection launches no browser. The validation
collector continues to request Playwright `headless: true` explicitly in
addition to Chromium's `--headless=new` argument.

### Validation v2 recollection

The validation-v2 recollection consumes the same source-owned manifest in a
separate authenticated Chromium execution. It retains arm-qualified IDs,
direct HarfBuzz shaped advances and offsets from the paint-owned
`ShapeResultView` seam, the linked Skia run positions and strike fixed offsets,
raw and normalized CoreText metrics, exact raw/filtered records, and complete
gamma-table, preblend, and post-conversion mask bytes. The shape hook
authenticates the same 7,806,016-byte OTS-decoded typeface used by the Skia
events. Selection requires one direct shape/run coordinate match and linked
record digests; it never derives a missing shaped offset from neighboring
origins.

All 26 observations use fresh Chromium processes with Playwright
`headless: true` and `--headless=new`. Two cold and two warm observations for
each scenario have one exact logical digest after zeroing only the separately
authenticated four-byte process-local `SkTypefaceID`. Six controls remain
active. The anti-alias control records Chromium's exact coupled behavior:
`-webkit-font-smoothing:antialiased` produces AA edging, no hinting, and Skia's
linear-gamma branch, whose gamma/preblend buffers are exactly empty rather than
silently filled from an ordinary row.

The retained validation artifact has file SHA-256
`2403c4664983d8286aa7cde59ea5028bf32b0c1a69f819f5fc68d5e18473bf33`
and sealed artifact digest
`55197a4575ea78723de7e173a60e8e7ab991f055a4e4da204ad976c37e04bd8b`.
The fail-closed hostile suite covers missing, duplicated, reordered, stale,
wrong-source, wrong-font/typeface/axis/gid, shaped-offset, phase,
anti-aliasing/hinting, matrix, optical-size, surface, full gamma/preblend, and
mask-byte mutations. Focused validation and adjudicator coverage contains 66
passing tests.

The v3 adjudicator reauthenticates both independent artifacts, pairs all 26
observations, retains exact `[13,13]` cancellation in both arms, and reports
zero input-integrity errors. Missing validation-v1 evidence is closed: shaped
offsets now agree in every glyph, full gamma agrees in 25 of 26 pairs, and
direct shaped advances are present rather than `null`. The gate remains
**not ready** because exact execution exposes 498 real mismatches: 21 typeface,
51 shaped-advance, 130 placement, 122 phase, 47 glyph-metric, 123 mask, and one
each in font, raw record, filtered record, and gamma. The one font/record/gamma
row is the anti-alias coupling above. No mismatch is normalized or fitted.

The retained v3 report has file SHA-256
`1d439f10fbd29b7acb8395f9c4ed59ac0583b17ee362c80bc9846575692748c8`
and sealed report digest
`ab9d17dc1570c8d87a11ca5be289dd373a2ef4ed2ef724518458a42d65a9d014`.
The next ratification must resolve or source-adjudicate these literal
cross-arm differences and reach zero exact mismatches before readiness can
change. This recollection changes no production renderer source, route, or
visual tolerance.

### Production outline route (closed by DM-2567)

The pre-DM-2567 route returned fontkit's non-empty SFNS outline before asking
CoreText. Its topology and command counts matched, but coordinates differed by
as much as 1.266 design units: gid 969 began at x `120` in fontkit and x `120.5`
in CoreText. That retained measurement is the activation proof for the fix,
not a tolerance.

Production now classifies one deliberately narrow route with
`coreTextDesignOutlineEligibility`: the host must be macOS, and the already
selected run must expose an authenticated file-backed variable source, known
physical member, and matched face name. Every outline-owning emitter passes
that exact `FontInstance` into `resolveGlyphCommands`; the helper reopens the
same path with the complete selected axis dictionary. Static sources and
unmatched/unknown collection members retain fontkit. Once a run is eligible,
helper absence or failure is an explicit degraded disposition and cannot fall
back to the known-different fontkit geometry.

Helper caches are keyed by path, PostScript name, member, sorted axis location,
and gid. The SVG glyph registry additionally hashes the actual command stream,
so an `opsz` or custom-axis mutation cannot reuse a warm definition for the
same CSS tuple and gid. Production provenance records the resolved command
identity and `outlineDisposition`, rather than describing the bypassed fontkit
outline as emitted evidence.

The independent Swift arm now exports the pinned-Skia 4x-x path both at paint
size and at unitsPerEm. Both independent streams are canonicalized onto the
helper protocol's declared 0.001-design-unit serialization lattice and then
compared by exact command topology, coordinates, counts, and SHA-256—there is
no epsilon. The authenticated helper path and bytes are part of each report.
Two separately launched macOS workflow jobs collect `proposal` and
`validation`; adjudication requires different observation IDs and one exact
logical digest.

## Integrity gates

A report is refused before classification unless all of these hold:

- Chromium computed CSS, CoreText's actual full variation state, and
  Domotion's selected-instance provenance equal the requested four axes;
- Chromium is using the routed exact-byte face and Domotion proves the exact
  source path and digest;
- native cmap gids, supplied native gids, and emitted Domotion gids agree;
- raw Range origins derive the recorded quarter keys, and native/Domotion both
  consume those keys;
- native mask/path, Chromium PNG, and Domotion SVG are identical across two
  cold and two warm observations; and
- the `opsz=26` mutation moves Chromium, native mask, CoreText path, and
  Domotion path digests.

The DM-2567 outline gate additionally requires the helper to be present and
SHA-authenticated, all 30 production gid observations to report
`helper-outline`, native/Domotion command counts and canonical command digests
to match, and every design-coordinate delta to be exactly zero. The mutation
must also move both design-command streams. Terminal raster classifications do
not participate in this equality decision.

The `font-optical-sizing:none` row is the negative control: because explicit
`opsz=17` already owns the coordinate, it is byte-identical to `zoom:2`.

## Retained pre-fix diagnostic result

The table below is the pre-DM-2567 activation artifact, collected on Chromium `147.0.7727.15`, arm64 macOS,
at DPR 1. Coverage numbers are normalized mean absolute white-coverage deltas
over the fixed 240x100 surface. All best integer baseline shifts were zero, so
fixed-position and baseline-fitted values are identical in this run.

| Row | logical / computed / paint px | Chromium↔CT mask | Chromium↔CT path | Chromium↔Domotion | CT path↔Domotion | Max path-coordinate delta | Closest representation |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `zoom-2` | 13 / 26 / 26 | 0.00161961 | 0.00560196 | 0.00562614 | 0.00030000 | 0.012696px | CT mask |
| `transform-scale-2` | 13 / 13 / 26 | 0.00391013 | 0.00736438 | 0.00742516 | 0.00029902 | 0.012696px | CT mask |
| `zoom-2-transform-half` | 13 / 26 / 13 | 0.00304510 | 0.00256438 | 0.00259575 | 0.00006797 | 0.006348px | CT path |
| `optical-sizing-none` | 13 / 26 / 26 | 0.00161961 | 0.00560196 | 0.00562614 | 0.00030000 | 0.012696px | CT mask |
| `opsz-26-mutation` | 13 / 26 / 26 | 0.00178807 | 0.00536716 | 0.00529706 | 0.00023480 | 0.016067px | CT mask |

The first exact representation divergence is the CoreText-path versus
Domotion-path boundary in all five rows. Topology and per-glyph command counts
are nevertheless identical (`[13, 32, 32, 37, 33, 15]`); the maximum measured
coordinate delta is 1.266 design units, or 0.016067 paint px. Domotion's
serialized scale (`0.0127` at 26px, `0.00635` at 13px) and CoreText's exact
2048-UPM scales (`0.0126953125`, `0.00634765625`) are recorded separately.
This proves the first numeric stage difference without showing that it causes
the dominant pixels.

## Post-fix exact outline result

Two independent, explicitly headless local arms exercise five scenarios and
six gids per scenario (30 observations per arm), including two cold and two
warm production renders. Every row reports `helper-outline`, exact command
counts `[13, 32, 32, 37, 33, 15]`, equal canonical design-command digests, and
`maxDesignUnitDelta = 0`. The `opsz=26` control changes both native and
production command digests. Proposal and validation produce the same logical
digest while retaining distinct observation IDs.

The raster classifications remain diagnostic and still show differences after
the exact outline seam, as expected: SVG number/transform serialization and
the terminal CoreText/Skia mask pipeline are different questions. No pixel
threshold, baseline fit, or tolerance changed with the logical closure.

At 26 paint px the native CoreText mask is materially closer to Chromium than
either vector raster: in `zoom-2`, for example, its mean delta is about 3.46x
smaller than the CoreText path's. The CoreText-path↔Domotion delta is only about
4.6% of the native-mask↔CoreText-path delta there. This isolates native mask
coverage as the larger residual for the ordinary zoom and transform rows, not
Domotion outline topology.

The cancellation row deliberately prevents that observation from becoming a
universal rule. With `zoom:2; transform:scale(.5)`, the CoreText path raster is
closest to Chromium, while direct final-size CoreText mask paint is worse. The
CoreText-path↔Domotion delta is only about 2.7% of the remaining
Chromium↔CoreText-path delta, so the row does not support blaming Domotion's
small coordinate delta. DM-2568's governing source path selects a 13px scaler,
and DM-2575's exact pinned-browser record authenticates that factorization and
the post-conversion buffer. Cross-arm byte adjudication remains separate.

## Baseline conclusion

No row selects a `-1` or `+1` integer y correction for the native mask,
CoreText path, or Domotion path. The ordinary zoom rows record Chromium's
captured layout baseline at 43.25px and Domotion/Skia's axis-aligned emitted
baseline at 43px; that fractional snap is visible as a baseline fact and is
not folded into the mask classification. Transform and cancellation rows keep
their fractional 45.25px and 30.75px emitted baselines. The focused evidence
therefore finds no remaining one-device-pixel baseline component.

## Adjudicated boundary and follow-up

The original diagnostic's dominant residual is owned by CoreText/Skia's terminal raster pipeline, not
by face selection, shaping, axes, metrics, baseline placement, quarter-origin
phase, or cache lifecycle. The proposal artifact byte-authenticates the private
pinned-Skia post-conversion mask and actual 13px cancellation record. The
independent validation artifact authenticates the record and mask emitted by
pinned Chromium. The area remains a partial platform boundary rather than an
exact cross-arm pixel gate: the adjudicator now exists and fails closed on the
retained non-equivalent inputs rather than producing a false shared digest.

The former fontkit-first variable-outline gap is closed by DM-2567's bounded
CoreText route and exact proposal/validation gate. DM-2568's terminal-mask
investigation, private-Skia proposal collector, and independent pinned-browser
validation artifact, and exact adjudicator are complete. Recollection on one
shared rendering envelope remains follow-up work. It cannot justify changing
this logical route or widening a visual tolerance.

Run the diagnostic on macOS with:

```bash
npm run fonts:sfns-mask-baseline -- --out tests/output/sfns-mask-baseline-dm2452
```

The JSON report and PNG/SVG arms are written beneath that output directory;
they are diagnostic artifacts, not checked-in baselines.

Run the exact independent outline arms and adjudicator with:

```bash
npm run fonts:sfns-mask-baseline -- --arm proposal --out tests/output/sfns-outline-proposal
npm run fonts:sfns-mask-baseline -- --arm validation --out tests/output/sfns-outline-validation
npm run fonts:sfns-outline:adjudicate -- --proposal tests/output/sfns-outline-proposal/report.json --validation tests/output/sfns-outline-validation/report.json
```

The collector always launches Chromium with `headless: true`.

Build, collect, and validate the private-Skia proposal on macOS with Xcode
command-line tools and the authenticated Chromium/Skia/OTS assets available:

```bash
npm run fonts:sfns-pinned-ots:build
npm run fonts:sfns-pinned-skia:build
npm run fonts:sfns-pinned-skia:collect
npm run fonts:sfns-pinned-skia:validate
```

The builds verify every pinned revision and tool digest, reuse the authenticated
GN/Ninja assets, remove their exact temporary source overlays, and refuse stale
overlays. Collection launches native evidence processes only; it does not
launch Chromium or any other browser.

Build, collect, and validate the independent pinned-Chromium arm with the exact
Chromium/Skia checkout and pinned Xcode Metal component available:

```bash
npm run fonts:sfns-pinned-chromium:build
npm run fonts:sfns-pinned-chromium:collect
npm run fonts:sfns-pinned-chromium:validate
```

The collector launches 26 separate browsers, all explicitly headless, and
retains `.pr-notes/artifacts/dm2575-sfns-pinned-chromium-validation.json`.
The normal rows pass `--enable-lcd-text`; the surface control alone passes
`--disable-lcd-text` to activate the source-owned pixel-geometry conversion.
The build hook defaults off and neither collection nor validation changes
production rendering or a visual tolerance.

Run the exact cross-arm adjudicator without launching a browser:

```bash
npm run fonts:sfns-terminal-mask:adjudicate -- \
  --proposal .pr-notes/artifacts/dm2577-sfns-pinned-skia-proposal.json \
  --validation .pr-notes/artifacts/dm2575-sfns-pinned-chromium-validation.json \
  --report sfns-terminal-mask-adjudication.json
```

The command exits nonzero while any logical field or byte differs. Pass
`--allow-not-ready` only when deliberately retaining the diagnostic report; the
manual CI gate never passes that flag.
