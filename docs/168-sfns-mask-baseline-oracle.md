# SFNS CoreText mask and baseline oracle

DM-2452 is a diagnostic follow-up to the three font-size-space work. It does
not change renderer geometry or accept a visual tolerance. The focused macOS
runner is `tools/sfns-mask-baseline-oracle.ts`; its native companion is
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

The `font-optical-sizing:none` row is the negative control: because explicit
`opsz=17` already owns the coordinate, it is byte-identical to `zoom:2`.

## Measured result

The retained artifact was collected on Chromium `147.0.7727.15`, arm64 macOS,
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

## Boundary and follow-up

The result authorizes no renderer or tolerance change. Direct
`CTFontDrawGlyphs` composition intentionally isolates the native API but does
not reproduce every later Skia A8/LCD gamma, preblend, and compositor decision.
If a production change is still desired, the remaining focused follow-up is a
source-owned capture of Skia's post-conversion glyph mask plus the
pre-compositor raster scale/phase in the cancellation row. That evidence must
move independently before changing production.

Run the diagnostic on macOS with:

```bash
npm run fonts:sfns-mask-baseline -- --out tests/output/sfns-mask-baseline-dm2452
```

The JSON report and PNG/SVG arms are written beneath that output directory;
they are diagnostic artifacts, not checked-in baselines.
