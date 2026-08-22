# 167 — Source-frame-coherent native-control rasters

DM-2456 makes `nativeControlRaster` a strict Chromium paint boundary. Native
form chrome is not reconstructed from sampled macOS geometry when a screenshot
is late, contaminated, invalid, or unavailable. A present raster record is an
ownership decision: it contains either a materialized PNG, an authoritative
`empty` result, or a named `native-control-raster` warning and no paint.

## Source ownership

Pinned Chromium revision `7d859f271cbda744098ac69f44978d4edfa62be3`
establishes the boundary:

- `third_party/blink/renderer/core/paint/theme_painter.cc` switches on
  `ComputedStyle::EffectiveAppearance()` and dispatches checkbox, radio,
  button, menulist, progress, slider, and text-field parts to the theme
  painter. The normal CSS background/border path is not an interchangeable
  fallback for the appearances whose painter returns `false`.
- `theme_painter_default.cc` passes checked/indeterminate state, effective
  zoom, used color scheme, forced-colors mode, accent color, progress
  determination/value geometry, and `WebThemeState` to
  `WebThemeEngine::Paint`. Those inputs and the selected platform engine own
  the pixels.
- `headless/lib/browser/headless_web_contents_impl.cc` fulfills a screenshot
  from the completed compositor surface through `CopyFromSurface`. Separate
  screenshot calls are separate readbacks; they are not evidence of one
  animation frame.

Consequently the old loop in `rasterizeBitmapGlyphs` was invalid for native
controls: every control received a later independent screenshot, and a failed
call silently reopened the sampled `form-controls.ts` route. Indeterminate
progress made the timing error measurable—the expected and emitted native
segments had the same shape at different inline positions.

## Capture contract

`src/capture/native-control-raster.ts` consumes at most two page-wide images,
never one screenshot per control:

1. The caller's `rasterizeFromImagePath` is the authoritative compositor frame
   when its decoded dimensions prove it covers the same capture coordinate
   space. Without one, a single unmodified live-page screenshot supplies the
   equivalent atomic frame.
2. One additional screenshot is taken after every non-native owner is hidden,
   every native owner is revived at its original used visibility, and the
   propagated html/body canvas background is made transparent. All mutations
   are restored in reverse order. Live nodes are correlated through the
   private pre-existing DOM-object registry, not marker attributes that could
   activate author selectors.
3. For static controls, the isolated frame owns alpha. A source-frame RGB pixel
   is copied only when both source and isolation alpha equal 255, which proves
   that no backdrop can contribute to that pixel. Transparent and antialiased
   checkbox/radio edges remain isolation-owned. An intersecting painted sibling
   makes the whole static target isolation-owned; overlapping native owners
   cannot be separated by a single atlas and therefore fail closed.
4. A time-dependent owner such as indeterminate progress cannot mix a source
   frame with alpha from the later isolation readback. When no painted sibling
   intersects, its complete clipped source crop is the atomic stamp, including
   alpha and the already-identical backdrop underneath it. With an intersection
   it fails closed: flattening the sibling would steal paint ownership, while
   the isolated readback would depict a different animation frame.

The capture script retains the existing paint rectangle exactly: the host box
plus active outline width/offset and one additional CSS pixel on every edge.
The Node pass snaps that rectangle outward once, intersects it with all four
capture-viewport edges, maps the result through the decoded frame's actual DPR,
and stamps the PNG at the same clipped CSS rectangle. It rejects non-finite or
zero rectangles, empty intersections, non-uniform source scaling, out-of-range
pixel crops, malformed RGBA, and incoherent source/isolation dimensions. A
successful all-transparent crop is recorded as `empty`, because Chromium has
proved that clipping/state produced no visible native pixels.

## Failure behavior

Any required surface that cannot be materialized appends:

```text
feature: native-control-raster
detail: required Chromium native-control surface unavailable (...);
        sampled SVG chrome is suppressed (DM-2456)
```

The private live-node index, selector, and frame-sensitive bit are removed from
the returned tree on every path. In `element-tree-to-svg.ts`, the presence of
`nativeControlRaster` always terminates control painting. `dataUri` emits one
atomic `<image>`; `empty` and warned failures emit nothing. Neither case may
fall through to `renderFormControl`.

## Gates

`src/capture/native-control-raster.test.ts` independently gates outward
snapping/viewport clipping, DPR mapping, aspect mismatch rejection, crop bounds,
alpha classification, source/isolated composition, and the source-selection
mutation.

`tests/native-control-source-frame.e2e.test.ts` runs in the Chromium E2E lane on
macOS, Linux, and Windows and covers:

- determinate and indeterminate progress plus meter, with a deliberately
  delayed isolation readback and a zero-tolerance, all-channel comparison of
  the complete indeterminate source crop;
- exactly one isolation screenshot for three controls (the retired
  per-control implementation would take three);
- rest, hover, and active native states;
- transparent checkbox/radio pixels over an authored page background and a
  later positioned overlap, proving neither color enters the control PNG, plus
  an overlapped indeterminate progress control that must fail closed;
- outline/one-pixel overflow, top/left/right/bottom viewport clipping, live
  scroll, fractional coordinates, CSS zoom, and DPR 2 dimensions; and
- forced screenshot failure, requiring a named warning, cleaned private facts,
  and SVG with no bitmap or sampled control geometry.

The existing activation and pixel-content controls remain in
`npm run raster:boundary-oracle`, `npm run replaced:geometry-oracle`, and
`tests/raster-fallback-content.e2e.test.ts`. `appearance:none` and author-owned
button paint remain vector negatives; effective-appearance classification and
subcontrol splitting are owned by their separate follow-ups.
