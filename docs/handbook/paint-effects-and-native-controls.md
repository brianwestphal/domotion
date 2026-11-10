---
id: "handbook/paint-effects-and-native-controls"
title: "Paint, effects, and native controls handbook"
kind: "contract"
status: "current"
owners: ["paint-effects", "text-fonts"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2596", "DM-2615", "DM-2628", "DM-2634", "DM-TPJX3H", "DM-J2WVF3", "DM-H5DDDE", "DM-09GQAV"]
code:
  [
    "src/render/element-tree-to-svg.ts",
    "src/render/paint-order.ts",
    "src/render/box-shadow-paint.ts",
    "src/capture/script/walker/document-prepass.ts",
    "tests/capture-selected-shadow-root.e2e.test.ts",
    "tests/box-shadow-border-knockout.e2e.test.ts",
    "tests/box-shadow-native-contour-authority.e2e.test.ts",
    "src/capture/input-value-geometry.ts",
    "src/capture/native-control-raster.ts",
    "src/capture/pseudo-style-cdp.test.ts",
    "src/capture/pseudo-style-cdp.ts",
    "src/capture/script/walker/form-controls.ts",
    "src/capture/script/walker/input-value.ts",
    "src/render/form-controls.test.ts",
    "src/render/form-controls.ts",
    "tests/feature-coverage.ts",
  ]
aliases: ["docs/handbook/paint-effects-and-native-controls.md"]
---

# Paint, effects, and native controls handbook

## Contract

1. Paint follows Chromium's background, border, content, decoration, outline,
   stacking, blend, filter, mask, and backdrop order. Geometry is derived from
   captured boxes and source-cited decision procedures, not screenshot tuning.
2. SVG-native gradients, masks, clips, filters, borders, and shadows remain
   vector when semantics are representable. URL resources preserve reference
   identity, units, geometry boxes, and transitive dependencies.
3. Effects needing an isolated source surface or browser-only paint operation
   use an authenticated, bounded raster owned by the corresponding element or
   effect. Transparent or unavailable evidence fails closed.
4. Native controls use Chromium-owned source pixels only when the activation,
   state, geometry, and compositor frame are authenticated. Hand-sampled
   platform palettes and approximate chrome are not fallback behavior.
5. Structural controls retain vector ownership, but their browser-owned layout
   inputs are captured rather than inferred. A single-line input may consume
   Chromium's closed-UA-shadow value-text FragmentItem top only after strict
   quad and same-frame host-size validation. A `base-select` disclosure icon is
   vector structural paint using the captured resolved `::picker-icon` color;
   it is never substituted for a native menulist arrow.
6. A render-side degradation is never silent. Wherever the renderer paints
   something other than Chromium did (an unsupported `clip-path` shape left
   unclipped, a `mask-image` whose resource graph cannot be rewritten, an
   approximated gradient, text replaced by a boundary marker) it calls
   `renderWarn(feature, detail)` (`src/render/render-warn.ts`): one `[domotion]`
   line on stderr plus a `CaptureWarning` on the active render's warning sink.
   `elementTreeToSvg(..., { warnings })` and `composeScrollSvg({ warnings })`
   open a synchronous `withRenderWarningSink` scope so a tree's render warnings
   stay with the caller's array; outside any scope the warning falls back to the
   process-global last-capture buffer that `getLastCaptureWarnings()` and the
   CLI's `--warnings` report. Without that scope, rendering an earlier capture's
   tree after a later capture attributed the warnings to the later one.
   `DemoRecorder` scopes each render (and passes the same array to its async
   remote-image and conic-tile pre-passes) and exposes the result as
   `recorder.getLastCaptureWarnings()`; the CLI pipelines keep the global
   fallback (see doc 01). Renderer
   fallbacks for missing measurements (default font size, fallback ascent) are
   named in `src/render/text-defaults.ts`.

## Verified implementation map

| Area                           | Requirements                                                                                                                                                                                                                                                                                        | Code and tests                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gradients/masks/clips          | [Gradient fills](../07-gradient-fills.md), [mask emission](../20-css-mask-emission.md), [generated combinations](../188-generated-svg-effect-combinations.md)                                                                                                                                       | render paint builders and paint geometry oracles                                                                                                                         |
| Paint order and filters        | [Paint order](../132-paint-order-oracle.md), [blend/filter stage](../185-blend-filter-pixel-stage-oracle.md), [backdrop ownership](../195-strict-ordinary-backdrop-ownership.md)                                                                                                                    | paint-order/filter modules and strict browser oracles                                                                                                                    |
| Borders and scrollbars         | [Border phase](../127-border-outline-phase-oracle.md), [cross-platform envelopes](../191-cross-platform-border-phase-envelopes.md), [scrollbars](../165-native-scrollbar-layout-paint-ownership-audit.md)                                                                                           | border/scrollbar oracles and native workflows                                                                                                                            |
| Native and structural controls | [Source-frame rasters](../167-native-control-source-frame-rasters.md), [effective appearance](../170-blink-effective-appearance-routing.md), [closed-shadow geometry/decorations](../171-closed-shadow-control-decorations.md), [fallback retirement](../182-native-control-fallback-retirement.md) | native-control capture/routes plus `input-value-geometry.ts`, the input/form-control walkers, `form-controls.ts`, focused unit tests, and cross-platform E2E/visual jobs |

Every new specialized paint route needs a source decision, an activation
record, a hostile movement control, and platform integration evidence.

## Selected shadow-only roots (DM-TPJX3H)

Root selection must reach an element's existing paint producer even when that
ordinary element has no background, border, direct text, or real children.
An empty 20×20 selected div with `box-shadow:inset 0 0 0 20px red` previously
returned no captured roots, while selecting its transparent container or body
reached the same div and matched Chromium. Root admission now retains source
computed all-inset shadow lists, using the existing shadow parser so comma
separated colors and mixed inset/outset lists are distinguished correctly.
The ordinary no-shadow container flattening and capture's visibility/geometry
pruning remain in force; no source styles or geometry are changed.

Actual Chromium 147 revision `6b5a1b80` `BoxPainterBase` invokes inset shadow
paint independently of an opaque background or painted border. Native full-RGBA
controls cover the original solid inset, inset frame, multiple inset layers,
direct/container/body selection, and retained visibility/geometry pruning.
This is a platform-neutral computed-style admission rule; native macOS was
verified locally, without claiming a Linux/Windows execution that was not run.

DM-J2WVF3 repairs the independently demonstrated existing outset producer:
a transparent box's normal shadow must knock out the original border-box
interior. `BoxPainterBase::ClipToBorderEdge` excludes the border contour before
normal-shadow paint when the source background is nonopaque. The renderer now
retains that exclusion after filtering, with an inverse rounded-rectangle mask
for circular coverage and an even-odd clip for sharp corners. Known opaque or
unknown background facts keep their existing producer path; styled control and
resize/scrollbar callers supply their own source background rather than an
unrelated host color. `display:contents` owns no layout box: its selector keeps
flattening to the real child, and the general producer skips its own shadow.

New outset/mixed shadow-only roots remain unadmitted (DM-09GQAV). The existing
container/body producer has exact native integer-origin controls covering
transparent/semitransparent/opaque backgrounds, one-axis/two-axis source
offsets, positive/negative spread, uniform circular corners, group/shadow
opacity, multiple/inset layering and non-box flattening. Those passing controls
do not authenticate fractional paint-space coverage for new selected roots.
Other independently painted roots still reach their existing producer. Source
positions, radii and shadow offsets remain unchanged.

New blurred outset/mixed roots stay unadmitted pending DM-RRWR8E: an unchanged
producer blur control differs at843 pixels, including400 wrong interior pixels
and443 outer sampling pixels. Border knockout fixes the400 interior pixels;
the outer443 remain byte-identical to the old output (max alpha difference7).
That is not full blur parity or a universal raster floor. Elliptical/unequal or
other unauthenticated corner contours remain unadmitted under DM-H5DDDE; strict
probe assertions are retained outside ordinary test discovery. Source-only
fragmented clone/slice shadow ownership remains an investigation (DM-4RGP8Y),
not a native defect inferred from the ordinary-box controls.

DM-H49Z50 and DM-HZPAYY own
separate proved outline-only and pseudo-only root admission defects. These
boundaries are explicit follow-ups, not evidence that all own-paint roots are
already supported.

### Contour authority investigation (DM-H5DDDE)

The native 147 contour investigation preserves the exact source geometry and
full RGBA assertions. Its 20×20 transparent box at (20,20), with a red hard
shadow offset (4,4), distinguishes these residuals:

| Contour         |            Before J2 | After J2 | Attribution                                                                                      |
| --------------- | -------------------: | -------: | ------------------------------------------------------------------------------------------------ |
| `8px / 4px`     | 251 differing pixels |        4 | Three outer pixels are byte-identical to the old producer; one inner inverse-mask pixel remains. |
| `8px 0 3px 5px` |                  251 |        1 | The outer pixel is byte-identical to the old producer.                                           |

For the ellipse, the native outer pixels (42,26), (25,41), (42,41) have red
alpha255; both producers have alpha248. The inner (38,37) is transparent in
Chromium, alpha255 before J2, and alpha7 afterward. The unequal contour's
outer (26,42) is native alpha255 versus producer alpha252. These measurements
do not establish a generic raster floor or justify moving a radius/position.

The native paint log records a soft difference `clipRRect` on the source box,
then `drawRRect` with the shadow looper. Plain CSS and SVG ellipses at the
translated shadow location are byte-identical, while the CSS shadow differs
from that plain contour at the three outer pixels. A CSS background in SVG
`foreignObject` also matches the plain CSS contour. Canvas2D `roundRect`, with
or without a zero-blur native canvas shadow, does not recover those native CSS
shadow pixels. Therefore replacing an SVG path with a rounded-rect primitive,
or independently rasterizing only the contour, is not an established repair.
The coupled CSS clip/shadow paint remains the authority; the precise downstream
coverage mechanism has not been attributed. DM-ZNQ7PH owns the demonstrated old
outer contour coverage repair; DM-H5DDDE closes only the investigation scope.

A separate coincident-contour control (`box-shadow:0 0 0 red`) exposed
DM-09GQAV: Chromium paints zero RGBA bytes for sharp, circular, elliptical and
unequal contours, whereas the initial J2 inverse mask left34 circular pixels
(max alpha64, alpha sum1211), and40 elliptical pixels (max alpha62).
DM-09GQAV skips the all-zero normal shadow before generating its shape/mask:
the shadow-minus-source-border set is empty. Native full RGBA controls include
sharp/circular/elliptical/unequal corners, fractional source placement and
opaque/semitransparent backgrounds. Genuine integer offsets and nonzero spread
retain their existing exact controls. No general contour, geometry or tolerance
change is part of that repair.

Bounded adversaries also prove why new outset/mixed admission stays held.
At integer source origin, circular subpixel offsets `(0.5,0)` and `(0,0.5)`
retain3/4 differing pixels (maximum alpha4/10). An inverse clipPath replacement
regresses the exact integer-offset controls and is rejected. Separately,
DM-WYY3ZZ owns source paint geometry: for a box at DOM `(20.5,20.5)`, native CDP
records normal-shadow `clipRRect` and `drawRRect` at `(21,21)`, matching Blink's
`PixelSnappedContouredBorder`; capture correctly retains the DOM rectangle,
but the current shadow producer lacks that distinct paint rectangle. The
fractional circular horizontal control differs87 pixels (max alpha167), and
the sharp one differs80 (max191). Blanket rounding captured coordinates would
not establish local-paint/transform authority.

The independent positive-inset control at margin20.5, `inset 0 0 0 3px red`,
also differs for selected-root and container capture:136 pixels/max alpha192
for sharp corners and148/max181 for radius5. Blink's inset entry points use
`PixelSnappedContouredInnerBorder` or
`PixelSnappedContouredBorderWithOutsets`. DM-7P69DC owns the selected-root guard;
DM-8N1VB2 owns the producer repair. Empty-inset controls do not authenticate
positive-inset fractional coverage. DM-09GQAV changes no inset production code.

DM-TFN8RD tracks a 20×20 box at (20,20), radius 5px and
`box-shadow:0 0 0 -.125px red`: native alpha sum 933 versus SVG 1095,
24 differing RGBA pixels/max alpha difference 25. Sharp corners are exact.
The nontransparent circular native result excludes extending the all-zero skip;
the cause remains unresolved.

Linux/Windows native workflows select knockout, contour-authority, selected-root,
range-shadow and resize-handle suites with 54 passing assertions and zero skips.

Native contracts live in `tests/box-shadow-native-contour-authority.e2e.test.ts`. Strict producer
probes remain unchanged outside ordinary discovery at
`tests/investigations/dm-h5ddde-strict-contours.probe.txt`; to execute them, copy
that file to `tests/dm-h5ddde-strict-contours.e2e.test.ts`, run it with
`vitest.e2e.config.ts`, and remove the temporary copy. Its ellipse and unequal
full-pixel assertions intentionally fail until an authenticated repair exists.
No failing probe is in the required browser profile and no tolerance was added.

```sh
node node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts tests/box-shadow-native-contour-authority.e2e.test.ts
```

Source provenance is Chromium147 revision
`6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050`, whose DEPS pins Skia
`fd139e79fd4553ba16556c1bca6c0f4dd9bc6fa5`, rather than the older materialized
external Skia snapshot. See
[BoxPainterBase](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/paint/box_painter_base.cc),
[GraphicsContext](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/platform/graphics/graphics_context.cc),
[SVGShapePainter](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/paint/svg_shape_painter.cc),
[DrawLooper](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/cc/paint/draw_looper.cc)
and [SkCanvas](https://skia.googlesource.com/skia/+/fd139e79fd4553ba16556c1bca6c0f4dd9bc6fa5/src/core/SkCanvas.cpp).
The source clip precedes normal-shadow drawing; the zero-blur looper has no
blur mask filter. Neither fact alone identifies backend coverage arithmetic.
All measurements above are native macOS evidence, not a Linux/Windows result.

## Structural form-control failure boundaries

- Input value geometry is retained only for one non-empty closed-shadow text
  candidate and one finite, positive-area, axis-aligned host/text quad pair.
  The live DOM walk consumes its host-relative top only when the recorded and
  current host dimensions agree within 0.05 CSS px. Compound controls,
  ambiguous candidates, rotation/skew, invalid geometry, or a changed scale do
  not acquire this authority; old captures and rejected records keep the
  documented metric-based compatibility path.
- Closed single-selects capture the resolved `::picker-icon` color. The renderer
  emits the structural disclosure path at the logical inline end only when the
  control has no native-decoration raster reservation. Missing icon and host
  colors omit the vector. Native `auto`/`menulist-button` arrows remain narrow
  Chromium-owned raster overlays and can never fall through to this path.
- Both decisions are platform-neutral Blink/CDP procedures and contain no
  macOS, Linux, or Windows font, palette, or glyph table. The capture contract
  applies on all three platforms; DM-2628's exact visual ratification was the
  Linux `06-deep-field-sizing` fixture that exposed the half-pixel estimate.
