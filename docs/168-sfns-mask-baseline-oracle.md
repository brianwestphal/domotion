# SFNS CoreText mask and baseline oracle

DM-2452 is the diagnostic follow-up to the three font-size-space work. DM-2567
closes the bounded variable-outline ownership gap that diagnostic exposed. It
does not accept a visual tolerance: the terminal mask comparison remains
diagnostic, while the CoreText design-command seam is now an exact logical
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
oracle arms. It does not claim that Blink/cc necessarily sends the author CSS
transform into the glyph scaler: whether the cancellation row rasterizes at
26px and is then resampled to 13px remains a separate pre-compositor fact that
the retained report does not capture.

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
small coordinate delta. It leaves the local-raster/compositor scale and phase
boundary explicit; this oracle does not guess whether Chromium rasterized at
the zoomed size before resampling.

## Baseline conclusion

No row selects a `-1` or `+1` integer y correction for the native mask,
CoreText path, or Domotion path. The ordinary zoom rows record Chromium's
captured layout baseline at 43.25px and Domotion/Skia's axis-aligned emitted
baseline at 43px; that fractional snap is visible as a baseline fact and is
not folded into the mask classification. Transform and cancellation rows keep
their fractional 45.25px and 30.75px emitted baselines. The focused evidence
therefore finds no remaining one-device-pixel baseline component.

## Adjudicated boundary and follow-up

The dominant residual is owned by CoreText/Skia's terminal raster pipeline, not
by face selection, shaping, axes, metrics, baseline placement, quarter-origin
phase, or cache lifecycle. The current evidence does not byte-authenticate the
post-conversion Skia mask, so it remains a source-adjudicated platform boundary
rather than an exact pixel gate. A bounded Skia harness or trace may capture
the scaler record, smoothing classification, post-conversion mask, and
pre-compositor scale/phase if exact terminal pixels become a requirement.

The former fontkit-first variable-outline gap is closed by DM-2567's bounded
CoreText route and exact proposal/validation gate. Exact terminal-mask and
pre-compositor evidence, if required, remains isolated in DM-2568; it cannot
justify changing this logical route or widening a visual tolerance.

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
