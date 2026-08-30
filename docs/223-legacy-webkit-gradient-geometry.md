---
id: "requirements/legacy-webkit-gradient-geometry"
title: "223 — Legacy -webkit-gradient() geometry ownership"
kind: "archive"
status: "superseded"
owners: ["paint-effects","layout"]
platforms: []
tickets: ["DM-2528"]
code: ["src/capture/script/walker/borders-backgrounds.test.ts","src/capture/script/walker/borders-backgrounds.ts","src/render/gradients.test.ts","src/render/gradients.ts","tests/legacy-webkit-gradient.e2e.test.ts","tools/paint-geometry-oracle.ts"]
aliases: ["docs/223-legacy-webkit-gradient-geometry.md","doc-223"]
---

# 223 — Legacy `-webkit-gradient()` geometry ownership

DM-2528 closes the logical gap between Blink's deprecated gradient grammar and
Domotion's SVG paint servers. This is a source-transcription change, not a
pixel-alignment exercise: no image was sampled to choose coordinates, no visual
threshold moved, and the paint-geometry oracle keeps its `0.00011` tolerance.

## Pinned source contract

The browser rule leg is Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`:

- `third_party/blink/renderer/core/css/properties/css_parsing_utils.cc:2767-2935`
  accepts exactly two physical-axis point components. Each component is an
  axis-appropriate keyword, a percentage, or a unitless number; CSS lengths
  such as `px` are invalid. The radial form adds two non-negative unitless
  radii. `from()` and `to()` own offsets 0 and 1, while `color-stop()` accepts
  negative and out-of-range numbers or percentages. Deprecated gradients are
  non-repeating.
- `third_party/blink/renderer/core/css/css_gradient_value.cc:839-919` resolves
  percentages against the physical image width/height and multiplies unitless
  coordinates by `CSSToLengthConversionData::Zoom()`. Writing mode does not
  exchange those axes.
- `css_gradient_value.cc:1371-1456` gives deprecated linear gradients their two
  resolved endpoints directly. The modern center-line/magic-corner branch is a
  different switch arm and is not an equivalent fallback.
- `css_gradient_value.cc:1825-1840,1924-2016` multiplies both deprecated radial
  radii by effective zoom and constructs one two-point conical gradient from
  the independent start and end circles.
- `css_gradient_value.cc:411-442,656-665` stable-sorts deprecated stops by
  source offset and bypasses modern stop fixup.
- `third_party/blink/renderer/platform/graphics/gradient.cc:84-94,126-213,295-345`
  forwards the sorted domain to a non-repeating, premultiplied, pad-mode Skia
  shader.

Chromium DEPS pins Skia
`62efacd37737505732dbe3d8daa62abd679626a1`. Its
`src/shaders/gradients/SkGradientBaseShader.cpp:213-265` inserts missing terminal
stops and monotonically pins supplied positions to `[previous, 1]`. Therefore
legacy negative/out-of-range stops are stable-sorted first and terminal-clamped
second. HarfBuzz and Unicode data do not participate in this paint decision.

## Production mapping

`src/capture/script/walker/borders-backgrounds.ts` crosses the CSSOM-to-paint
zoom boundary once. It scales only unitless point/radius slots inside
`-webkit-gradient()`; percentage points and numeric stop offsets remain
unchanged. The same helper now feeds ordinary backgrounds, masks,
border-images, generated pseudo boxes, and form-control pseudo backgrounds.

`src/render/gradients.ts` keeps the deprecated grammar distinct:

- linear gradients emit the two resolved physical endpoints directly;
- radial gradients emit the start circle as SVG `fx`/`fy`/`fr` and the end
  circle as `cx`/`cy`/`r`;
- zero, one, negative, duplicate, and out-of-range stop lists retain Blink's
  ordering, with only the pinned terminal clamp reflected in SVG offsets;
- degenerate endpoints remain degenerate instead of silently selecting the
  modern line;
- no deprecated form receives `spreadMethod="repeat"`.

The element-background, mask, border-image, and form-control routes consume the
same exact parsed representation. Modern linear/radial and every `repeating-*`
route remain on their existing builders.

## Evidence and mutation controls

`tools/paint-geometry-oracle.ts` adds eight structured rows, bringing the fixed
logical corpus to 118 exact rows. They cover asymmetric percentage endpoints,
unitless point/radius zoom, two-circle radial geometry, stable-sort-before-clamp,
and the non-repeating activation boundary. Three destructive rows must fail if
the implementation substitutes the modern center line, exchanges physical
width and height, or omits effective zoom.

`src/render/gradients.test.ts` covers the exact grammar and SVG records;
`src/capture/script/walker/borders-backgrounds.test.ts` proves zoom changes only
geometry-owned slots; and `tests/legacy-webkit-gradient.e2e.test.ts` joins live
Chromium computed serialization to captured values and final SVG across
asymmetric boxes, vertical writing, zoom, radial circles, hostile stop domains,
and unchanged modern/repeating controls.
