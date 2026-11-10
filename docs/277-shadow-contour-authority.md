---
id: "requirements/shadow-contour-authority"
title: "Native shadow contour authority and unresolved producer boundaries"
kind: "investigation"
status: "current"
owners: ["paint-effects"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-H5DDDE", "DM-J2WVF3", "DM-09GQAV", "DM-7P69DC"]
code:
  [
    "src/render/box-shadow-paint.ts",
    "tests/box-shadow-native-contour-authority.e2e.test.ts",
    "tests/capture-selected-shadow-root.e2e.test.ts",
  ]
aliases: ["docs/277-shadow-contour-authority.md", "doc-277"]
---

# Native shadow contour authority and unresolved producer boundaries

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
range-shadow, resize-handle and source inset-context suites. Their strict gate
requires81 passing assertions and zero skips; actual platform execution is
recorded separately from the profile definition.

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
