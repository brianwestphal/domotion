---
id: "requirements/shadow-contour-authority"
title: "Native shadow contour authority and unresolved producer boundaries"
kind: "investigation"
status: "current"
owners: ["paint-effects"]
platforms: ["macos", "linux", "windows"]
tickets:
  [
    "DM-H5DDDE",
    "DM-J2WVF3",
    "DM-09GQAV",
    "DM-7P69DC",
    "DM-WYY3ZZ",
    "DM-8N1VB2",
    "DM-B73YF5",
    "DM-TFN8RD",
    "DM-S2EA2P",
    "DM-6A9J20",
    "DM-8PMQPX",
    "DM-4RGP8Y",
    "DM-GX7XNJ",
  ]
code:
  [
    "src/render/box-shadow-paint.ts",
    "src/capture/script/walker/border-paint-snap.ts",
    "tests/box-shadow-border-knockout.e2e.test.ts",
    "tests/background-paint-snap.e2e.test.ts",
    "tests/box-shadow-native-contour-authority.e2e.test.ts",
    "tests/capture-selected-shadow-root.e2e.test.ts",
    "src/render/background-inline-paint.ts",
    "src/capture/script/walker/fragmentation.ts",
    "tests/inline-fragment-box-shadow.e2e.test.ts",
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

## Pixel-snapped normal-shadow paint rectangle

`BoxPainterBase::PaintNormalBoxShadow` (`core/paint/box_painter_base.cc:294-338`,
Chromium `7d859f27`) derives both the shadow shape and the excluded border
contour from `ContouredBorderGeometry::PixelSnappedContouredBorder`
(`contoured_border_geometry.cc:178-185`): `ToPixelSnappedRect(paint_rect)`
(`physical_rect.h:228`) rounds the local origin and snaps each size with
`SnapSizeToPixel` (`layout_unit.h:805-813`, which keeps a nonzero size of more
than four LayoutUnits at one pixel), and the radii are resolved against the
unsnapped size, then constrained to the snapped rect (`:136-140`). A 20×20 box
at a 20.5px margin therefore paints its shadow and knockout at 21..41, not
20.5..40.5; before this change the producer differed from Chromium at 87 RGBA
pixels (sharp: 80).

That snap happens in local paint space, before any transform or scroll
translation, so the capture does not round viewport coordinates. For a box with
a `box-shadow`, a visible border or an outline,
`src/capture/script/walker/border-paint-snap.ts` records `borderPaintSnap` —
signed deltas from the captured border-box edges to the snapped edges, plus the
box size they describe (a derived box of another size ignores them), so a later
whole-tree translation keeps it valid — only when the local paint space is
authenticated:

- every element in the composed ancestor chain (self included) has an identity
  or pure 2D translation transform; subpixel accumulation survives those
  through `UpdateForPaintOffsetTranslation` /
  `CanPropagateSubpixelAccumulation` (`paint_property_tree_builder.cc:652-779`),
  so the local rect is the viewport rect minus the summed translations;
- every ancestor scroller and the document scroller have integral offsets
  (`UpdateScrollTranslation` applies them after the snap, `:3556-3564`);
- the device pixel ratio and pinch zoom are 1.

CSS `zoom` is supported. Blink lays out and snaps in zoomed LayoutUnits, using
the same `ToPixelSnappedRect`. Under standardized zoom, `getBoundingClientRect`
divides only by the frame's layout zoom factor
(`AdjustForAbsoluteZoom::AdjustRectMaybeExcludingCSSZoom`,
`core/layout/adjust_for_absolute_zoom.h`), so the captured rect is already in
that zoomed space. Two inputs serialize in unzoomed CSS px, so the walk
multiplies them by the owning element's effective zoom before using them:

- computed `transform` and `translate` translations;
- `scrollLeft` / `scrollTop` (`AdjustForAbsoluteZoom::AdjustScroll`,
  `core/dom/element.cc:2757`).

Strict full-RGBA controls at zoom 0.8, 1.25 and nested zoom are in
`tests/frozen-transform-paint-offset.e2e.test.ts`.

Static planar transforms are frozen by the capture walk (the box is measured
untransformed and the renderer re-applies the transform as a wrapper), so they
add nothing to the translation sum, and a frozen pure-translation ancestor keeps
the subpixel accumulation. On an axis where a frozen transform drops it (a
scale, rotation, skew or general matrix, a `will-change` transform, or paint
isolation; `CanPropagateSubpixelAccumulation`), Blink paints that box at local 0
of its rounded paint-offset translation, and its descendants relative to its
box. The walk folds that rounding into the wrapper matrix (doc 06, "Rounded
paint-offset translation") and registers the box as the local origin on those
axes, so the record measures each box relative to the nearest such ancestor
(the box itself included), and the border, outline, focus-ring and shadow
painters read the snapped edges from it (`snappedBorderEdges`). A frozen
transform whose own paint offset cannot be authenticated folds nothing and its
descendants get no record.

Everything else fails closed — no record, and the renderer keeps the captured
geometry: live (animated) scale/rotate/skew/3D transforms, including a live
rotated capture root, motion paths, and — on a box that is not itself a frozen
transform — `will-change` transform-family
properties (`kPreventingSubpixelAccumulationReasons`), paint or style+layout
containment and `content-visibility` (`NeedsIsolationNodes`, `:570-589`), sticky
positioning, a captured box that differs from the live border box (a fieldset
legend notch), and table-grid or scrollbar/resizer substitutes. Captured DOM
geometry is never changed.

The record holds each local edge's `LayoutUnit::Round` delta. Because
`round(x) + SnapSizeToPixelAllowingZero(w, x)` is `round(x + w)`
(`layout_unit.h:815-818`) and border widths enter as integers
(`PhysicalBoxStrut::FromInts`), the same deltas give both snaps Blink takes:

- `paintBoxShadow` uses `shadowBorderContour`: the snapped outer rect, with
  `SnapSizeToPixel`'s rule that a nonzero size of more than four LayoutUnits
  keeps one pixel (`:805-813`).
- `paintInsetBoxShadow` uses `shadowInnerBorderContour`, Blink's
  `PixelSnappedContouredInnerBorder` (`contoured_border_geometry.cc:207-255`,
  from `PaintInsetBoxShadowWithBorderRect`, `box_painter_base.cc:388-405`):
  the snapped outer edges moved by the truncated border widths, a size of zero
  when the borders consume the box, and the snapped outer radii inset by the
  same widths (`FloatRoundedRect::Radii::Outset`).

Native full-RGBA controls in `tests/box-shadow-border-knockout.e2e.test.ts` are
byte-exact on macOS: normal shadows at fractional rounded and sharp origins,
fractional width, quarter-pixel origins and with spread (previously 87, 80
and 40 differing pixels), and inset shadows at fractional sharp and rounded
origins, fractional width, a quarter-pixel offset inset and a bordered inset
(previously 136, 148 and 70). That file also pins the record for own and
ancestor translations and for each fail-closed space. Known remaining gaps:

- Under a fractional device translation (a `translate(.5px)` on the box or an
  ancestor), the snapped geometry now matches Chromium (21.5..41.5), but Blink's
  sharp `ClipOut` and inset `Clip` are not antialiased (`graphics_context.h:385-394`)
  while the SVG clips are, so the clip edge still differs (57 pixels for a
  sharp normal shadow, 67 for a sharp inset).
- The radii are constrained against the captured size and then again against
  the snapped size, rather than once against the snapped size.

### Backgrounds from the same record

Backgrounds snap the same way. `PaintFillLayerBackground` fills
`ToPixelSnappedRect` of the paint rect, and the rounded fast path fills the
`PixelSnappedContouredBorder` (`box_painter_base.cc:1056-1058`, `1213-1214`,
`1265`). Image and gradient layers contract their destination and positioning
areas to the clip and origin boxes and then `ToPixelSnappedRect` each one
(`background_image_geometry.cc:391-401`).

The record is now also captured for boxes with a background color or image:

- `paintBackgroundColor` fills `shadowBorderContour`.
- The layer painter builds its border, padding and content boxes with
  `snappedInsetBox` (`src/render/borders.ts`). An edge `k` past a border edge
  whose rounding delta is `s` rounds by `round(k − s) − (k − s)`.

On macOS, `tests/background-paint-snap.e2e.test.ts` passes byte-exact against
native rendering for: fractional, rounded, quarter-pixel and translucent colors;
a color under a border; colors under a translate and an x-only scale; plain,
rounded, padding-box and content-box gradients; and positioned, repeated and
covering images. Before, a half-pixel color box differed at 80 pixels.

Over 42 html-test fixtures (translate/scale, lists, tables, links), 23 improve
and 1 worsens:

| Fixture                     | Before       | After        |
| --------------------------- | ------------ | ------------ |
| 11-deep-math-functions      | 5.23%        | 0.76%        |
| 32-real-world-pricing-table | 9.48%        | 3.44%        |
| 22-deep-filter-stacking     | 2.51%        | 0.90%        |
| 13-deep-anchor-positioning  | 2.78% (fail) | 1.87% (pass) |
| 31-deep-inert-hidden        | 5.096%       | 5.179%       |

The 31-deep-inert-hidden change is a worse diffPct even though the total absolute
error over its changed pixels fell from 52045 to 11824.

Not covered: tiled gradients (`background-size` smaller than the box) are off
even at integral positions; that is the separate repeat-tiling gap.

### Background color and the bottom layer's clip (DM-NXDNGQ)

The color belongs to the bottom FillLayer, so it fills that layer's clip box
(`PaintFillLayer`, `box_painter_base.cc:1456-1551`). Border widths enter as
integers (`ComputeSnappedBorders`, `:1339-1345`, `ToInt` truncation) and padding
as LayoutUnits. The renderer used to fill the border box whatever the clip, so a
padding-box color under a 3px translucent border differed at 276 pixels, even at
an integral position. `backgroundColorClipBox` in `element-tree-to-svg.ts`
handles the two cases Blink distinguishes:

- **Sharp fill** (`:1539-1550`): the paint rect contracted by the insets, then
  `ToPixelSnappedRect`, so each inset edge rounds in local paint space
  (`snappedInsetBox`).
- **Rounded fill** (`ContouredBorderRectForClip`, `:1201-1248`): the snapped
  border contour, then `PixelSnappedContouredInnerBorder` /
  `PixelSnappedContouredBorderWithOutsets` of that already-snapped rect. The
  insets therefore round on their own, and the radii shrink by the insets.

Snapped colors are written with three decimals, because inset radii such as
5.75px lost up to 0.05px in the one-decimal format.

Sharp padding-box and content-box cases are byte-exact native controls. The
rounded ones match geometrically and keep a small alpha residual (max 13 where
the inner rrect meets a translucent border's anti-aliased inner edge, 2 without
a border), the rounded-contour coverage residual tracked separately.

### Background bleed avoidance under an obscuring border (DM-GX7XNJ)

A rounded box whose border paints and whose every edge obscures the background
edge shrinks its border-box background contour by half of each used border
width, or a sixth when an edge is double, with the radii shrunk by the same
amounts. Sources at Chromium `7d859f27`:

- `BoxDecorationData::ComputeBleedAvoidance` picks
  `kBackgroundBleedShrinkBackground` (`box_decoration_data.cc:23-68`).
- An edge obscures the background when it is present, opaque, and neither
  hidden, dotted nor dashed (`BorderEdge::ObscuresBackgroundEdge`,
  `border_edge.cc:44-54`). An edge with style `none` has width 0 and still
  obscures.
- `ContouredBorderRectForClip` applies
  `BackgroundContouredRectAdjustedForBleedAvoidance` to border-box layers
  (`box_painter_base.cc:1165-1232`).
- Inline boxes paint with `kBackgroundBleedNone`
  (`inline_box_fragment_painter.cc:461-534`), and the document element never
  shrinks.

`backgroundBleedShrinkInsets` (`src/render/borders.ts`) mirrors this decision.
`backgroundColorClipBox` and the border-box image layers apply it. Without the
shrink, the background's anti-aliased rim composited through the border's
outer edge: rounded corners and fractional edges read lighter than Chromium's.
For example, a 1px `#d4d4d8` border corner read 168 where Chromium paints 87.

The renderer's synthetic overflow-clip wrapper is bounded by the union of the
fractional box and the snapped border contour. Blink's overflow clip is the
snapped padding box and never cuts the box's own decorations
(`ToSnappedClipRect`, `paint_property_tree_builder.cc:2536-2538, 3086-3099`).
The fractional bound cut 0.3px off the snapped left border of a fractional
`<input>`.

**Effect on the feature suite.** `comp-input-button`'s raw diffPct rose from
0.0658 to 0.0829 when background snapping landed, while its absolute error
fell. Snapping made the straight edges exact, so the corner residue (this
missing shrink) lost the shift exemption of `compare-pngs`. With the shrink
and the clip bound, the corners and edges of its bordered button match within
one level and diffPct is 0.0570. In `31-deep-inert-hidden` the same residue
was a 199-pixel band along a rounded card's bottom border; that band is now
exact (diffPct 0.0518 -> 0.0510).

Strict full-RGBA controls are byte-exact for solid, thick, double and gradient
cases; restoring the unshrunk contour makes each one differ. A square box with
an overflow clip is byte-exact. A rounded one keeps a corner residual of at
most 2 levels.

## Normal-shadow spread radii

The rounded branch of `PaintNormalBoxShadow` (`box_painter_base.cc:371-380`,
Chromium `7d859f27`) applies `ApplySpreadToShadowShape` (`:91-97`): nothing
for a zero spread, otherwise `ContouredRect::OutsetWithCornerCorrection(spread)`
and `ConstrainRadii()`. `ShadowContourFollowsBorder` is stable
(`runtime_enabled_features.json5:5616`), so that is
`FloatRoundedRect::Radii::OutsetWithCornerCorrectionUsingCoverageFactor`
against the border rect's size (`float_rounded_rect.cc:168-264`,
`contoured_rect.cc:93-97`): a radius at least the spread, or whose coverage of
the edge exceeds 1, grows linearly; a smaller one grows by
`spread · (1 − (1 − r/spread)³ · (1 − coverage³))`; a zero radius stays sharp;
a negative spread shrinks each radius and clamps at zero. The constraint is
against the spread rect. `normalShadowCorners` in `box-shadow-paint.ts`
implements this (the renderer used to grow every nonzero radius linearly and
never constrain), and the shadow shape is written with three decimals because
the one-decimal coordinate format alone moved a 3.646px radius to 3.6px.

On macOS, 20×20 boxes with `2px`/`4px`, `1px`/`8px` (offset 3,2), `3px`/`10px`
and unequal `2px 0 4px 8px`/`5px` radius/spread previously differed from
Chromium by a maximum alpha of 90, 255, 251 and 124; they now differ by at most
10, 1, 1 and 3. That remainder was the arc-coverage residual attributed in
"Rounded shadows under Blink's antialiased clip" below; with that fix all four
are byte-exact. Inset spread needs no change: a negative outset always
takes the linear branch, which `insetCornerRadii` already implements. Inline
fragment shadows (`background-inline-paint.ts`) still use the linear rule.

The three-decimal shape output also resolves the fractional-spread residual: a
20×20 radius-5 box with `0 0 0 -.125px` paints Chromium's 20.125..39.875 shape
with 4.875px radii, which the one-decimal format wrote as 20.1/19.8/4.9 (24
differing pixels, maximum alpha delta 25). Source geometry was already right
(`ApplySpreadToShadowShape` takes the linear branch for a negative spread);
fractional negative, positive and translucent-background spreads are now
byte-exact native controls. Negative spread still paints: Chromium's antialiased
`ClipOutContouredRect` leaves coverage at the corners, so the all-zero
coincident skip must not extend to it.

## Rounded shadows under Blink's antialiased clip (DM-5KSA83, DM-ZNQ7PH)

This attributes the remaining coverage residual on rounded zero-blur shadows:
subpixel offsets, elliptical and unequal contours, and corrected spread radii.
The geometry was already exact. What differed was the Skia raster route.
Headless Chromium here rasterizes on the CPU: CDP `SystemInfo` reports
`rasterization: disabled_software`.

- `PaintNormalBoxShadow` draws the shadow after `ClipToBorderEdge`. For a box
  with a border radius, that clip is `ClipOutContouredRect`, which is
  antialiased (`box_painter_base.cc:175-198`, Chromium `7d859f27`). On an
  opaque background the contour is first inset by 1px and skipped when empty.
- The cc `DrawLooper` adds a color filter and a translation
  (`cc/paint/draw_looper.cc:22-42`). `Draw::drawRRect` then falls back to
  `drawPath(SkPath::RRect)` (Skia `62efacd3`, `SkDraw.cpp:848-878`).
- When the raster clip is antialiased, `SkScan::AntiFillPath` passes `forceRLE`
  (`SkScan_AntiPath.cpp:145-153`). `AAAFillPath` therefore uses the run-based
  accumulator instead of the mask accumulator (`SkScan_AAAPath.cpp:1736-1739`),
  and that changes a few edge pixels by up to 10 alpha levels.
- The same holds for the clip's own coverage: `SkAAClip::setPath` builds it
  with `forceRLE`.

`paintBoxShadow` reproduces that route for zero-blur shadows on a box with a
border radius and a known background:

- **Shadow shape.** It is drawn under `aaRouteClip`, an antialiased clip whose
  1px-rounded edge sits 2px outside the shape. The clip removes nothing; it
  only keeps Skia off the BW-clip path. A clip containing the whole device would
  collapse to BW, which is why it hugs the shape.
- **Knockout contour.** The contour inside the luminance mask is drawn the same
  way. For an opaque background, the contour inset by 1px is now knocked out
  too, because it reaches visible pixels at a rounded corner.
- **Corner representation.** Four equal elliptical corners are written as
  `<rect rx ry>` (`skRRectSvg`), the same conic `SkRRect`. Path `A` commands are
  decomposed into cubics and do not match.

These are now byte-exact native controls in
`tests/box-shadow-border-knockout.e2e.test.ts`:

- half-pixel horizontal and vertical offsets on radius 5 (previously 3 and 4
  pixels off);
- `8px / 4px` elliptical and `8px 0 3px 5px` unequal contours (the cases
  DM-H5DDDE retained);
- elliptical corners with spread;
- the four spread-correction cases;
- opaque elliptical, half-pixel and blurred boxes.

Two gaps remain:

- **Unequal corners.** There is no SVG primitive for an `SkRRect` with unequal
  radii; the path's cubic arcs stay. A 12px spread over `2px 0 4px 8px` still
  differs by up to 54 alpha.
- **Blurred shadows.** These take the mask-filter route, which this change does
  not touch.

## Sharp shadows under Blink's non-antialiased clips (DM-8PMQPX)

For a box without a border radius both shadow clips are **non-antialiased**,
and Skia snaps them in device space:

- **Normal shadow.** `ClipToBorderEdge` calls `GraphicsContext::ClipOut(RectF)`,
  which is `ClipRect(rect, kNotAntiAliased, kDifference)`
  (`graphics_context.h:384-386`, `box_painter_base.cc:189-196`, Chromium
  `7d859f27`). On a BW raster clip `SkRasterClip::op` applies
  `devRect.round()` (`SkRasterClip.cpp:170-171`, Skia `62efacd3`), rounding
  each device edge half up.
- **Region pieces.** The shadow is a plain antialiased `drawRect`. Under a
  non-rectangular BW region, `SkScan::AntiFillRect` walks the region's
  rectangles (`SkRegion::Cliperator`) and fills `antifillrect` once per piece
  (`SkScan_Antihair.cpp:784-808`). A piece one scanline high takes
  `do_scanline(..., B - T - 1)` (`:664-666`), so a half-pixel row that starts a
  band paints alpha 127, not 128. This happens with no transform at all:
  `box-shadow:30.5px .5px 0 red` far from its box differed at 21 pixels.
- **Inset shadow.** A sharp padding box is `context.Clip(bounds.Rect())`, also
  non-antialiased (`box_painter_base.cc:560-564`). The shadow is
  `FillRectWithContouredHole(AreaCastingShadowInHole(bounds), hole)`
  (`:509-522`, `:571-576`): a rect only as large as the bounds, outset by blur
  and a negative spread and united with its offset copy.

Device space needs the translation from the renderer's user space to device
pixels. The capture records it as `borderPaintSnap.device`: the fractional
part of the sum of frozen pure-translation transforms the renderer re-applies
as wrappers around the box (live translations are already in the captured
viewport coordinates). The record is omitted when any re-applied transform on
the chain is not a pure translation or uses the live-rect model.

With the record, `paintBoxShadow` and `paintInsetBoxShadow` do this for sharp
boxes:

- **Zero-blur normal shadow on a known background.** The hole (the border box,
  or the box inset by 1px on an opaque background, skipped when empty) is
  rounded to device pixels. The shadow is emitted as the up-to-four region band
  pieces as separate `<rect>`s with no clip, the same rectangles Skia's
  `Cliperator` hands to `antifillrect`.
- **Blurred normal shadow on a transparent background.** The even-odd clip
  keeps its shape, but its hole sits on device pixels. An antialiased clip on
  whole device pixels has the same 0/1 coverage as the BW one, and a
  mask-filter blit is not split by the region.
- **Inset shadow.** The clip rect sits on whole device pixels; Skia reduces an
  antialiased rect clip there to the BW clip (`nearly_integral`,
  `SkRasterClip.cpp:161-167`). For zero blur, the donut's outer edge is
  `AreaCastingShadowInHole`. Its edge coverage is visible where the rounded clip
  edge falls outside the bounds. Keeping the path small also keeps it on Skia's
  mask accumulator rather than the run-based one, which differs by one alpha
  level at the hole edge.

Without the record the antialiased producer is kept. Native full-RGBA controls
in `tests/box-shadow-border-knockout.e2e.test.ts` are byte-exact on every
selected root. They cover own and ancestor half-pixel translations (sharp,
opaque, inset), quarter-pixel translations with spread and offsets, mixed and
translucent layers, and the band-split rows with and without a background. A
negative control strips `device` and requires the pixels to move. Capture tests
pin the record for own, ancestor, summed and fail-closed (scaled) transforms.

Remaining gaps:

- **Opaque blurred sharp shadows.** These keep the unclipped producer.
- **Blurred inset shadows.** These keep the padded donut.
- **Collapsed sharp insets.** When the hole is empty, Blink fills the bounds
  with no clip and no blur (`box_painter_base.cc:548-554`); ours still clips
  and blurs.
- **Negative-spread inset holes.** These get rounded corners that Blink's
  coverage-corrected outset keeps sharp.

## Fragmented box shadows (DM-4RGP8Y)

A box broken across line boxes (a wrapped inline) or columns (a multi-column
block) is painted **per fragment**, never as one joined shape.
`InlineBoxFragmentPainterBase::PaintBoxDecorationBackground`
(`inline_box_fragment_painter.cc:427-444`, Chromium `7d859f27`) paints each
fragment's normal shadow, then its fill layers, then its inset shadow. Each
shadow comes from that fragment's own rect, through the shared `BoxPainterBase`
producer, with the fragment's `SidesToInclude()`:

- **Clone** includes every side, so each fragment is a whole box: pixel-snapped
  rect, `ClipToBorderEdge` knockout, and the clips above.
- **Slice** drops the sides where the box continues. `ClipToSides` keeps the
  border rect outset by `ShadowData::RectOutsets()` on included sides only
  (`ceil(3σ) + spread ∓ offset`, `shadow_data.cc:32-43`), as a non-antialiased
  `Clip(RectF)`. `AdjustRectForSideClipping` stretches the fill rect, or the
  inset hole, past each excluded side by the offset and blur
  (`box_painter_base.cc:200-250`). An inset fragment also drops the border
  widths of its excluded sides (`PixelSnappedContouredInnerBorder(style, rect,
sides)`).

Measured on unchanged `main` (macOS, full RGBA, transparent text):

| case                                      | pixels off | cause                                                         |
| ----------------------------------------- | ---------- | ------------------------------------------------------------- |
| shadow-only wrapped inline, slice / clone | 672 / 588  | no fragments captured; one shadow drawn around the union bbox |
| slice with a background                   | 512        | slice shadows skipped                                         |
| clone with a translucent background       | 896        | no border knockout                                            |
| slice inset                               | 720        | inset never painted per fragment; bbox inset instead          |
| fractional fragment edges                 | 28         | fragment rect not pixel-snapped                               |

The capture now records fragments for a shadow-only inline too.
`paintInlineFragment` hands each fragment to `paintBoxShadow` and
`paintInsetBoxShadow` with a `ShadowFragment`, which carries the sides and the
element's device translation. The sides follow the borders' slice ownership,
with the inline-axis start on the right in a right-to-left inline. The
fragment's snap comes from the element's `borderPaintSnap`: a fragment edge at
viewport offset `d` from the element edge is at local `L + d`, so its delta is
`round(d - δ) - (d - δ)`.

`tests/inline-fragment-box-shadow.e2e.test.ts` holds byte-exact native
controls on integral-geometry fixtures. They cover slice and clone with
transparent, translucent and opaque backgrounds; a negative offset with spread;
right-to-left; inset; a half-pixel translate; and a multi-column block. A
negative control strips the fragments and requires the pixels to move.

Remaining gaps, outside the shadow producer unless noted:

- **Rounded fragments.** A 1-8 alpha residual remains at 1-3 corner pixels. The
  same rounded box outside an inline does not show it.
- **Background fragment edges.** Fractional fragment edges are not
  pixel-snapped, which costs 51 pixels with or without a shadow.
- **Translucent slice borders.** These double-paint their corners.
- **Right-to-left corners and borders.** Fragment corners and borders ignore
  `direction`.
- **Vertical writing modes.** The fragment sides assume a horizontal inline
  axis.

## Blurred shadows (DM-RRWR8E)

Blink's σ is exactly half the blur radius (`shadow_data.h:76-82`), as ours is.
The engines differ:

- A **sharp** blurred rect goes through `SkBlurMaskFilterImpl::filterRectMask`
  → `SkBlurMask::BlurRect` (`SkBlurMaskFilterImpl.cpp:124-130`,
  `SkBlurMask.cpp:405`). That is an analytic integral profile.
- `feGaussianBlur` uses the image-filter blur engine (`SkBlurImageFilter`,
  `SkBlurEngine`).

The measured residual matches that split. The ticket's `4px 4px 4px` sharp case
differs at 443 pixels (max alpha delta 7), while a radius-5 blurred shadow,
which Blink blurs through the rrect mask route, is byte-exact.
