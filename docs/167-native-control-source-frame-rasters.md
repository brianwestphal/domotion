---
id: "requirements/native-control-source-frame-rasters"
title: "167 — Source-frame-coherent native-control rasters"
kind: "contract"
status: "current"
owners: ["images-media"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2456", "DM-2458", "DM-Q4J4JG"]
code:
  [
    "src/capture/native-control-raster.test.ts",
    "src/capture/native-control-raster.ts",
    "src/capture/snapshot-visibility-override.test.ts",
    "src/capture/snapshot-visibility-transitions.ts",
    "tests/native-control-source-frame.e2e.test.ts",
    "tests/native-control-style-restoration.e2e.test.ts",
    "tests/raster-fallback-content.e2e.test.ts",
  ]
aliases: ["docs/167-native-control-source-frame-rasters.md", "doc-167"]
---

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
   activate author selectors. Visibility on a custom element is owned by an
   effect rather than its `style` attribute; see
   [Custom-element visibility isolation](#custom-element-visibility-isolation).
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

## Custom-element visibility isolation

Isolation hides by visibility, and both native raster owners
(`native-control-raster.ts` and `native-control-decoration-raster.ts`) used to
write every isolation visibility as an inline `!important` declaration. An
autonomous custom element or customized built-in (`is=`) that observes `style`
runs `attributeChangedCallback` synchronously on that write and again on the
exact-literal restore. Restoring the attribute cannot undo what the callback
did. An inheriting custom element needs no write: its hidden ancestor already
hides it, and the restore path keeps absent and literal `style` attributes
exact. An element that declares `visibility: visible !important` itself still
needs an override.

No stylesheet can supply that override. In Blink's cascade, the inline-style
bit sorts above every layer and specificity
(`css/resolver/cascade_priority.h`, Chromium `7d859f27`), so an author inline
`!important` beats any author stylesheet `!important`. Only the transition
origin sorts above author importance (`css/resolver/cascade_origin.h`).

`SnapshotVisibilityState.override` (in `snapshot-visibility-transitions.ts`)
therefore applies a custom element's isolation visibility as a capture-owned
effect, in two tiers:

1. A paused native script `Animation` with `fill: both`. It sits in the
   animation origin, above every normal author declaration and composited
   after CSS animations. This is enough unless the author's declaration is
   `!important`.
2. Otherwise, a transition-priority effect.
   `KeyframeEffect::Create(source)` copies the source effect's priority
   (`animation/keyframe_effect.cc`). A CSS transition's effect keeps
   `kTransitionPriority` until it is cancelled or finished
   (`animation/css/css_animations.cc`). The owner starts a `visibility`
   transition on a private probe `<div>`, clones its effect, and then removes
   the probe in the same synchronous evaluation. Queued transition events
   dispatch to the detached probe. Each override is a clone of that template,
   retargeted and rebound through a private base `Animation`, in the same way
   as the active-transition paint owner. The tier-1 animation is cancelled
   first, because Blink drops transition-priority values for a property that a
   default-priority animation on the same element also animates
   (`CalculateTransitionActiveInterpolations`).

Every override is cancelled when the visibility owner is disposed. An override
that survives cancellation fails that restore and invalidates the crops.

If neither tier takes, `override` returns false and the caller keeps the
inline write, so no healthy control is refused. This happens when an author
CSS animation of `visibility` on the same element erases the transition tier,
or when the page has replaced the native animation APIs. These fallbacks still
cost the two callbacks.

Elements other than custom elements keep the exact inline path. Snapshot
transition owners keep their existing paint-owner path.

Known residual boundaries:

- Non-visibility host neutralization in the decoration owner (background,
  border, shadow, text fill) stays inline. Author-origin background and border
  flags select Blink's menulist painter, so a customized built-in control host
  still receives those callbacks.
- The snapshot transition owner still writes an inline `transition` list on
  any element that declares a visibility transition.
- The tier-2 probe is one child-list insertion and removal, which a
  `MutationObserver` on the document can see.

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
button paint remain vector negatives. Blink-exact effective-appearance
classification is now shipped in [doc 170](170-blink-effective-appearance-routing.md);
native/closed-shadow subcontrol splitting is shipped separately in
[doc 171](171-closed-shadow-control-decorations.md). Whole-host and partial
surfaces intentionally retain distinct paint phases and failure records.

DM-2458 subsequently made this failure contract irreversible in the renderer:
the sampled palettes, calibrated constants, and native-default geometry
branches were deleted, and a static/mutation gate now enumerates every
`renderFormControl` entry path. See
[doc 182](182-native-control-fallback-retirement.md).
