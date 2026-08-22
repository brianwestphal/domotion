# 185 — Blend-mode and filter-kernel pixel-stage oracle

**Status:** DM-2360 investigation. No production paint behavior changed.

**Source pins:** Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and the Skia revision named by
that checkout,
`62efacd37737505732dbe3d8daa62abd679626a1`.

## Decision boundary

Ordinary CSS shorthand filters, `mix-blend-mode`, and representable
`background-blend-mode` layers remain native-vector output. Their SVG groups
are evaluated by the same Chromium/Skia pixel stages as the source page. The
correct oracle is therefore not a hand-authored SVG filter graph and not a
whole-page similarity threshold. It is a set of source-derived arithmetic and
named device-pixel probes that proves the input surface, operation order,
premultiplication, and isolation boundary independently.

Two already-inventoried cases remain Chromium raster surfaces:

- `backdrop-filter`, because an image-rendered SVG cannot sample pixels already
  painted behind its own group; and
- an HTML CSS URL filter whose graph contains `feConvolveMatrix`, because the
  convolution consumes Chromium's rasterized HTML `SourceGraphic`, not a newly
  rasterized SVG reconstruction.

An ordinary shorthand filter, a blend group, an HTML URL graph containing only
representable color primitives, and a convolution already owned by native SVG
are negative controls: all stay vector. The live oracle checks the data-bearing
capture fields for all six cases rather than inferring ownership from a CSS
string.

## Chromium and Skia findings

### Shorthand filters

`FilterEffectBuilder::BuildFilterEffect` visits the computed list in author
order and makes each operation consume the previous effect
(`filter_effect_builder.cc:156-370`). Every non-reference shorthand operation
has primitive clipping disabled and its operating interpolation space forced to
sRGB (`:356-363`). The model in
`tools/blend-filter-pixel-stage-oracle.ts` transcribes:

- Blink's grayscale and sepia 4×5 matrices (`:72-124`), saturate and hue-rotate
  matrices (`fe_color_matrix.cc:50-112`), and invert/opacity/brightness/contrast
  transfer definitions (`filter_effect_builder.cc:221-282`);
- Skia's matrix route: unpremultiply, apply the 4×5 matrix, clamp, then
  premultiply again when the shader is not known opaque
  (`SkMatrixColorFilter.cpp:70-97` at the pinned Skia revision); and
- Blink's byte lookup-table construction for component transfer
  (`fe_component_transfer.cc:45-134`).

The compositor path keeps the same operation order. One upstream caveat is
explicit in Chromium: a reference filter ending in `linearRGB` does not yet
insert the missing conversion when the following item is a shorthand function
(`filter_effect_builder.cc:496-498`). That is a Chromium behavior to retain in
browser-owned pass-through, not a reason to invent a Domotion conversion.

### Blur and drop shadow

Blink supplies `SkTileMode::kDecal` for a CSS Gaussian blur
(`fe_gaussian_blur.cc:79-87`). Pinned Skia treats sigma at or below `0.03` as an
identity and uses `ceil(3 × sigma)` as the contribution radius
(`SkBlurEngine.h:62-72`). The mapped sigma is capped at 532, non-finite or
identity axes are zeroed, and decal input outside the source is transparent
(`SkBlurImageFilter.cpp:145-215`).

A drop shadow is not a box-shadow approximation. Pinned Skia builds
`blur(input) -> SrcIn(shadow color) -> fractional linear-sampled offset`, then
merges the unchanged foreground and applies an optional crop
(`SkDropShadowImageFilter.cpp:35-71`). Blink keeps fractional offsets in its
main filter graph (`filter_effect_builder.cc:293-304`); the compositor-facing
operation separately floors a scaled offset (`:472-480`). The fixture's named
blur-edge and fractional-shadow pixels make either an incorrect edge mode or a
removed kernel visible without averaging it into the page.

Blink's legacy clip ownership is also explicit: descendants paint into the
filter input without the accumulated clip, while the filter output receives
the element's current clip (`paint_property_tree_builder.cc:2468-2485`). This
is why a source-surface test has to name pixels on both sides of the effect
boundary.

### Blend arithmetic and background stacks

Blink maps every CSS blend keyword directly to the corresponding Skia mode
(`platform/graphics/blend_mode.cc:47-82`). Pinned Skia accepts premultiplied
source and destination colors (`SkBlendMode.cpp:97-160`); its raster stages
implement the separable formulas at `SkRasterPipeline_opts.h:2207-2276` and
the hue/saturation/color/luminosity stages at `:2279-2379`.

Background images are painted in reverse list order. Blink opens one temporary
layer when any fill-layer mode is non-associative, so the bottom background
color and all image layers share the same isolated stack
(`box_painter_base.cc:59-84`, `:590-617`, and `:1390-1400`). The composed
fixture therefore includes two opaque image layers with different modes over a
third color; checking only a one-layer swatch would not prove the source stack.

## Oracle contract

Run:

```bash
npm run paint:blend-filter-stage -- \
  --dpr 1,2 \
  --json tests/output/blend-filter/report.json \
  --artifact-dir tests/output/blend-filter \
  --accept-known-findings
```

The report fingerprints Chromium, OS, and architecture and contains:

- all 17 CSS blend modes, including partial-alpha and four non-separable modes;
- forward/reverse shorthand color lists, alpha transfer, and an
  invert-own-`SourceGraphic` discriminator;
- named blur-edge and fractional drop-shadow pixels;
- isolated/non-isolated blend surfaces, opacity-created isolation, and a
  two-image background stack;
- DPR 1 and 2; and
- six positive/negative vector/raster ownership rows.

Each flat source pixel must agree with the source transcription within four
8-bit channel codes. Each final SVG pixel is compared to the corresponding
source pixel at that same named coordinate. Every positive mutation must move
at least eight channel codes, while negative isolation/normal controls may move
at most four. Mutation distance is candidate-to-mutation, not
source-to-mutation, so a broken candidate cannot make an inert mutation look
active. No whole-image MAE participates in the verdict.

The macOS Chromium 147.0.7727.15 DPR-1/2 run produced these stable
discriminators across 56 named rows:

- source arithmetic: 0–1 maximum channel-code error for every modeled flat
  pixel;
- exact final SVG rows: opaque forward/reverse color matrices, own-source
  invert, blur edge, fractional drop shadow, and the two-layer background
  stack (0–1 codes); and
- all six raster-boundary classifications matched.

## Concrete defect: translucent color serialization

The run also found one Domotion defect before any tolerance decision. A source
fill computed as `rgba(38, 171, 224, 0.65)` is emitted as
`rgba(38,171,224,0.7)`. `src/render/colors.ts::colorStr()` sends alpha through
`src/render/format.ts::r()`, whose contract is one decimal place for geometry.
The named source/model pixel still agrees within one code; the final SVG moves
8–11 codes on alpha-sensitive normal/blend/filter rows. Opaque controls remain
exact, localizing the failure to representation rather than Skia arithmetic.

The oracle reports this as `known-source-drift` and lists every affected row.
`--accept-known-findings` permits CI to preserve and upload the investigation
evidence; it does not turn those rows into passes. Classification is
signature-bound: the emitted pixel must independently match the same operation
modeled with alpha `0.7` inside the unchanged four-code bound. Any arbitrary
drift on an affected row, different failing row, boundary, structural error,
inert mutation, or source-model disagreement is `unexpected-drift` and fails
even with that flag.

Follow-up **DM-2485** owns the production correction. It must introduce a
color-specific alpha formatter, keep coordinate formatting unchanged, and move
this report to `source-exact` without increasing the four-code named-pixel
bound.

## Recommended maintenance

- Keep `.github/workflows/blend-filter-pixel-stage.yml` on macOS, Linux, and
  Windows. Backend differences belong in separate fingerprinted artifacts,
  never in a widened shared tolerance.
- Add a named source and mutation pixel whenever a new blend/filter paint route
  lands. A visual fixture without a source-surface discriminator is not stage
  evidence.
- Keep backdrop and HTML convolution raster ownership synchronized with
  docs 126, 134, and 148. Moving either boundary requires both a positive and a
  representable negative control.
- Do not lower ordinary CSS shorthand filters to hand-authored `<fe*>` graphs:
  SVG primitive regions and default interpolation semantics are different, and
  the native pass-through is already exact on opaque kernel/color rows.
