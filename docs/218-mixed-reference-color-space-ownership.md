---
id: "requirements/mixed-reference-color-space-ownership"
title: "218 — Mixed reference-filter color-space ownership"
kind: "reference"
status: "current"
owners: ["paint-effects"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2535","DM-2548","DM-2549"]
code: ["tests/fixtures/html-test/38-mixed-reference-color-space-stage.html","tools/mixed-reference-color-space-oracle.ts"]
aliases: ["docs/218-mixed-reference-color-space-ownership.md","doc-218"]
---

# 218 — Mixed reference-filter color-space ownership

**Status:** Source-exact and promoted. DM-2548 landed the source-proven
localized filter-inside-blend wrapper order without changing a tolerance.
DM-2549 then promoted the matrix to an entirely strict native release gate;
retained run 32684579069 passed on macOS, Linux, and Windows.

**Source pins:** Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and the Skia revision recorded by
that checkout,
`62efacd37737505732dbe3d8daa62abd679626a1`.

## Decision

Domotion must preserve the computed CSS filter list and copied SVG reference
filter as one browser-owned native-vector terminal. It must **not** emulate an
extra `linearRGB -> sRGB` transition between a reference filter and a following
CSS shorthand function at these pins. Pinned Chromium explicitly omits that
transition in the compositor operation list and converts the remaining linear
result to sRGB only after the list. Replacing the native list with a locally
authored `<fe*>` graph would silently implement different behavior.

The investigation did find a separate, locally owned representation bug.
Reference-filter localization now places the CSS filter wrapper inside
the element's blend wrapper. That matches Blink's effect-tree order and lets
the blend sample its source backdrop while retaining local filter coordinates.
This was an ordering and isolation defect, not a color-transfer approximation.

HarfBuzz has no role in this effect-tree, color-transfer, or pixel-compositing
decision.

## Pinned Blink ownership

There are two related builders, and conflating them hides the seam:

1. `SVGFilterBuilder::BuildGraph()` resolves inherited
   `color-interpolation-filters` separately for every primitive and assigns
   `linearRGB` or sRGB to its `FilterEffect`
   (`core/svg/graphics/filters/svg_filter_builder.cc:135-192`).
   `paint_filter_builder::Build()` asks every input for the consumer's
   operating space and inserts a transform when the spaces differ
   (`platform/graphics/filters/paint_filter_builder.cc:61-88`). Chromium's own
   graph test spells out the device→linear and linear→device nodes around a
   linear blur, sRGB blend, and linear merge
   (`image_filter_builder_test.cc:40-135`).
2. `FilterEffectBuilder::BuildFilterEffect()` likewise connects each
   non-reference shorthand operation to the previous effect in author order,
   forces that operation to sRGB, and lets the recursive image-filter builder
   resolve edges (`core/paint/filter_effect_builder.cc:144-370`).
3. The compositor-list route is different at this pin.
   `BuildFilterOperations()` starts in sRGB, seeds a reference filter's
   `SourceGraphic` from the previous space, and then records the reference's
   final operating space (`filter_effect_builder.cc:373-405`). Shorthand
   operations are appended without updating that state. The source has an
   explicit TODO saying a conversion should be inserted when a linearRGB
   reference is followed by a filter function (`:496-498`). Only after the
   complete list does it append linearRGB→sRGB (`:500-505`).

For the pinned path, the observable chain is therefore:

```text
sRGB SourceGraphic
  -> unpremultiply, decode sRGB, premultiply
  -> linearRGB reference primitives
  -> shorthand arithmetic on the still-linear numeric values
  -> unpremultiply, encode sRGB, premultiply at the terminal
```

An explicit following sRGB reference filter is the decisive control: its
primitive requests sRGB, so the graph inserts the missing transition before
the shorthand list. Putting the shorthand list before the linearRGB reference
is a second, independent ordering control.

## Pinned Skia ownership

Blink maps both gamma directions to Skia color filters
(`platform/graphics/interpolation_space.cc:44-77`). At the pinned Skia commit:

- `SkColorSpaceXformColorFilter` constructs unpremultiplied→unpremultiplied
  transform steps, explicitly appends `unpremul`, applies the transfer, and
  appends `premul` for translucent shaders
  (`src/effects/colorfilters/SkColorSpaceXformColorFilter.cpp:27-46`). Its two
  singleton filters bind sRGB and linear-sRGB color spaces (`:82-91`).
- `SkColorSpaceXformSteps` derives `unpremul`/`premul` from the alpha types
  (`src/core/SkColorSpaceXformSteps.cpp:137-140`), preserves the pair only when
  a nonlinear transfer lies between them (`:202-210`), and executes
  unpremultiply → linearize/gamut/encode → premultiply in that exact order
  (`:213-274`).
- Reference `feColorMatrix` and shorthand matrix stages also unpremultiply,
  apply/clamp the 4×5 matrix, and premultiply
  (`src/effects/colorfilters/SkMatrixColorFilter.cpp:70-97`). Blink's byte-table
  component transfers are built at
  `platform/graphics/filters/fe_component_transfer.cc:43-95,134-166`; pinned
  Skia again brackets the table with unpremultiply/premultiply
  (`SkTableColorFilter.cpp:25-42`).

The oracle records straight and premultiplied RGBA for every transition. Its
principal partial-alpha trace is:

| Surface | Logical space | Straight RGBA | Premultiplied RGBA |
| --- | --- | --- | --- |
| SourceGraphic | sRGB | `(0.20392, 0.64314, 0.90588, 0.58)` | `(0.11827, 0.37302, 0.52541, 0.58)` |
| reference input | linearRGB | `(0.03434, 0.37124, 0.79910, 0.58)` | `(0.01992, 0.21532, 0.46348, 0.58)` |
| reference output | linearRGB | `(0.09816, 0.35244, 0.74718, 0.58)` | `(0.05693, 0.20442, 0.43337, 0.58)` |
| shorthand without transition | linear values, shorthand assumption | `(0.23504, 0.35170, 0.53281, 0.3886)` | `(0.09133, 0.13667, 0.20705, 0.3886)` |
| terminal | sRGB | `(0.52206, 0.62759, 0.75657, 0.3886)` | `(0.20287, 0.24388, 0.29400, 0.3886)` |

The explicit sRGB-reference boundary instead ends at straight
`(0.34878, 0.47821, 0.59345, 0.3886)`, a 44-code discriminator. The report also
records exact channel facts: sRGB `0.5` decodes to `0.2140411405`, while linear
`0.5` encodes to `0.7353569831`.

## Effect and blend order

Blink's ordinary effect node owns opacity, `mix-blend-mode`, and explicit
isolation (`paint_property_tree_builder.cc:1983-2041`). Its filter node owns the
computed filter operations (`:2447-2533`). The property-tree walk calls
`UpdateEffect()` before `UpdateFilter()` (`:4080-4082`), making the blend effect
the outer consumer and the filter its inner input. In operation notation:

```text
source content -> filter -> blend with the effect-node backdrop
```

Domotion's reference-box localization currently emits the reverse nesting at
`src/render/element-tree-to-svg.ts:5432-5437`:

```xml
<g style="filter:url(#linear-matrix) ...">
  <g style="mix-blend-mode:multiply">...</g>
</g>
```

The filter wrapper creates a group around the blend, so the blend no longer
sees the source backdrop. The exact symptom is that removing blend or source
isolation moves the Chromium source by 47–62 codes but moves the candidate by
at most one code.

## Oracle and mutations

`tools/mixed-reference-color-space-oracle.ts` consumes
`tests/fixtures/html-test/38-mixed-reference-color-space-stage.html` and emits:

- nine transparent, partial-alpha filter-stage probes: raw source, linear
  reference, ordinary shorthand, pinned mixed order, explicit sRGB reference,
  reversed order, and linear identity controls with/without the explicit
  boundary;
- three premultiplied blend/isolation surfaces: nonisolated document backdrop,
  isolated external backdrop, and an isolated local backplate;
- six positive native-vector ownership rows, including mixed reference lists
  with and without blend;
- exact computed filter lists, source/model/candidate pixels, straight and
  premultiplied intermediates, producer/source fingerprints, and artifacts;
- hostile logical controls for transfer-without-unpremultiply, early
  conversion, reversed order, and lost isolation; and
- live source and candidate mutations for reference space, missing reference,
  inserted/dropped explicit boundary, reversed list, blend, and isolation. A
  stable isolated no-blend mutation is the negative control.

Run:

```bash
npm run paint:mixed-color-space-stage -- \
  --dpr 1,2 \
  --json tests/output/blend-filter/mixed-color-space-report.json \
  --artifact-dir tests/output/blend-filter/mixed-color-space-artifacts
```

The four-channel-code named-pixel bound and eight-code positive-mutation floor
are imported unchanged from doc 185's stage oracle. There is no whole-image
metric or tolerance escape.

The existing three-platform blend/filter workflow runs this command on macOS,
Linux, and Windows. The bounded investigation classification has been removed:
every row must report `source-exact`; any source-model, ownership, structural,
pixel, or mutation failure is `unexpected-drift` and fails. Retained workflow
run 32684579069 passed all three platforms at DPR 1/2 with empty
`unexpectedFailures` arrays.

## Local DPR 1/2 result

The macOS arm64 Chromium 147.0.7727.15 run was identical at both DPRs:

| Evidence | DPR 1 | DPR 2 |
| --- | ---: | ---: |
| filter-stage source/model rows within four codes | 9/9 | 9/9 |
| filter-stage candidate/source rows exact | 9/9 | 9/9 |
| source/model maximum error | 1 code | 1 code |
| candidate/source maximum error, filter-only | 0 codes | 0 codes |
| native-vector ownership | 6/6 | same captured boundary |
| color-space/order mutations active | 5/5 | 5/5 |
| hostile logical controls active | 4/4 | same deterministic model |
| nonisolated blend residual | 62 codes | 62 codes |
| local-isolated blend residual | 48 codes | 48 codes |

The isolated external-backdrop row remains exact and its no-blend mutation is
stable, which rules out a bad blend formula. The source's no-blend/no-isolation
mutations remain strongly active while the candidate's are inert, which pins
the defect to wrapper ownership rather than pixel fitting.

## Completed follow-ups

- **DM-2548 — Preserve Blink filter-before-blend order for localized CSS URL
  filters.** Reorder only the source-owned wrappers while retaining reference
  localization, clip/mask semantics, stacking slot, and native CSS list. The
  two residual rows and all three inert mutations must become exact/active at
  DPR 1/2 without regressing the nine filter-only rows.
- **DM-2549 — Promote the mixed reference color-space matrix to a strict native
  release gate.** The bounded production-gap set is gone, the gate requires
  `source-exact` on macOS/Linux/Windows, run 32684579069 retains all three
  platform artifacts under unchanged bounds, and the Chromium-roll
  discriminator detects a future upstream resolution of the pinned TODO.

No production renderer, raster ownership, alpha serialization, pixel bound, or
mutation threshold changed in DM-2535.
