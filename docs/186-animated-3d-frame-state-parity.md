---
id: "requirements/animated-3d-frame-state-parity"
title: "186 — Animated CSS 3D frame-state parity"
kind: "evidence"
status: "partial"
owners: ["animation","platform-release"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2356","DM-2359","DM-2492","DM-2531","DM-2553","DM-2554"]
code: [".github/workflows/animated-projective-frame-parity.yml","src/capture/animation-frame.ts"]
aliases: ["docs/186-animated-3d-frame-state-parity.md","doc-186"]
---

# 186 — Animated CSS 3D frame-state parity

**Status:** exact document-timeline CSS/WAAPI and SMIL frame synchronization,
quads, residuals, and atomic paint shipped; the macOS/Linux/Windows DPR 1/2
owner-minimality expectation is known partial (DM-2356).

DM-2359 closes the gap between the static projective boundary in
[doc 162](162-inline-svg-3d-transform-audit.md) and an animation that changes
that boundary over time. Capture no longer asks several independently
advancing layout/CDP/raster passes what the current 3D state is. A caller may
pass `animationTimeMs` to `captureElementTree*`; every participating document
is paused at that exact time, Chromium commits two paint frames, and only then
do the existing prepasses begin.

## Source verdict

The pinned Chromium checkout is
`7d859f271cbda744098ac69f44978d4edfa62be3`; Chromium's DEPS pins Skia
`62efacd37737505732dbe3d8daa62abd679626a1`.

- `core/animation/css_transform_interpolation_type.cc:176-182` deliberately
  sends every pair of transform lists to `InterpolableTransformList` without
  pre-classifying it; that layer owns discrete fallback.
- `platform/transforms/transform_operations.cc:142-211` blends a matching
  function prefix component-wise, merges a mismatched suffix through
  matrix/matrix3d interpolation, and falls back discretely at 50% when a
  matrix is singular. The captured result must therefore be Chromium's
  composed frame, not a Domotion interpolation or a selected 2D submatrix.
- `core/animation/animation.cc:3544-3573` sets the requested current time,
  pauses an active compositor animation at that same time, writes the hold
  time immediately, and explicitly avoids waiting for ready because that would
  allow drift. `src/capture/animation-frame.ts` mirrors the public WAAPI/SMIL
  boundary and verifies the committed result.
- `core/style/computed_style.h:2210-2267` makes opacity, filter, clip-path,
  mask, isolation, blending, backdrop filtering, and non-visible overflow
  grouping properties that force the *used* 3D style flat. The computed
  `preserve-3d` token remains independently relevant to stacking and fixed
  containment.
- `core/paint/paint_property_tree_builder.cc:1458-1466,1634-1651` assigns a
  rendering-context ID only through direct parents whose *used* style preserves
  3D. Perspective contributes a projection node but does not establish that
  context (`paint_property_tree_builder_test.cc:3495-3523`). DM-2492 replaces
  the invalid outer-host expectation with that exact used-context rule.
- `core/paint/paint_property_tree_builder.cc` owns transform/perspective
  composition and flattening. Pinned `SkMatrix::mapPointPerspective` performs
  homogeneous division, so a non-affine fourth corner cannot be fitted to an
  SVG six-value matrix.

## Stable frame protocol

`seekAnimationsToFrame(page, timeMs)` performs one transaction across the top
document and every attached frame:

1. Let a fresh document render twice so CSS animations have joined its
   timeline. The marker remains on `documentElement`, so navigation resets it.
2. Pause every `document.getAnimations()` result and assign the exact requested
   millisecond; pause and seek every SMIL SVG timeline.
3. Wait two more animation frames for style/layout/compositor paint to commit.
4. Re-enumerate and verify the count, numeric current time within 0.02ms, and
   paused/finished play state.

Strict capture rejects a refused seek, an animation that appears during
settling, a non-document `currentTime`, drift, or a frame that cannot be
evaluated. The video exporter reuses the same helper in its historical
best-effort mode. `animationTimeMs` is applied before external-reference,
font, image, pseudo, text, scrollbar, projective, and raster prepasses, so none
can straddle compositor frames.

## Captured frame record

Every 3D-influenced `CapturedElement` in an explicitly seeked capture may carry
`projectiveFrameState`:

- protocol source and exact sample time;
- total paused animation count;
- HTML/SVG paint role;
- CDP content and border quads in capture CSS coordinates;
- held-out fourth-corner residual and non-affine activation bit;
- selected `ownsRasterBoundary` result (currently conservative rather than
  proven minimal across nested context breaks);
- the same-frame computed `transform`, independent translate/rotate/scale,
  transform origin/style, perspective/origin, and overflow axes.

An inactive identity `matrix3d` sample omits this 3D record. A `translate3d`
under perspective may retain the record yet stay vector-owned when its four
corners remain an affine parallelogram. A non-affine record always crosses one
materialized Chromium `transformSubtreeRaster`; the renderer returns after the
atomic `<image>` and never emits `matrix3d()` or fits the apparent 2D entries.

## Oracle matrix

`npm run transform:animated-3d-frame-gate` runs one fixture at 0, 250, 500,
and 750ms for DPR 1 and 2:

| Family | Required discriminator |
| --- | --- |
| `rotate3d` | non-affine residual and child-owned atomic surface |
| `translate3d` | perspective-composed uniform scale remains affine/vector |
| `matrix3d` | identity starts inactive; interpolated projective frames activate |
| `perspective` | animated distance/origin change the child plane, but perspective alone does not make the host a rendering-context owner |
| `transform-origin` | same 3D matrix with moving pivot changes the exact quad |
| `preserve-3d` | discrete preserve→flat transition ends direct context propagation and starts a child/self boundary |
| grouping flatten | `overflow:visible→hidden` retains computed fixed-CB ownership while used paint starts a fresh inner context |
| animation composition | two additive transform animations survive as Chromium's complete composed matrix |

For each row the tool first pauses the source and reads a fresh independent CDP
quad/computed record. Production capture then seeks the same time itself. The
adjudicator requires at most 0.02 CSS px quad/residual delta, exact computed
composition and timestamp, one expected owner, a materialized raster when
required, and no projective 2D approximation in final SVG markup.

Five destructive mutations must fail: stale timestamp, one-pixel quad shift,
dropped owner/raster, apparent-2D fitting, and collapsed animation
composition. The local macOS arm64 calibration was **64/64 rows and 5/5
mutations** at DPR 1/2 against the corrected source-derived expectations.
`.github/workflows/animated-projective-frame-parity.yml` runs the same matrix on
native macOS, Linux, and Windows and uploads the fingerprinted JSON even when
the gate fails. `expectedOwnerId()` now assigns perspective-only paint to the
plane and assigns the overflow-grouped half of the grouping animation to the
independently measured preserving intermediary. Production consumes the same
paused-frame used-preserve facts.

## Explicit boundary

Deterministic document-timeline CSS/WAAPI and SMIL animation is supported.
Scroll/view timelines do not have a numeric document `currentTime`, so strict
capture reports and rejects those visible to each queried document TreeScope.
Open/closed-shadow progress animations are currently missed. rAF motion is a
separate unsupported gap: it is outside WAAPI enumeration, is not reported by
strict capture, and can advance during the helper's settle callbacks. Even a
pre-navigation Playwright clock exposes native rAF to page script and does not
instrument worker rAF. This is not a pixel tolerance or platform envelope.
DM-2531 independently traces that boundary in
[doc 221](221-scroll-view-raf-timeline-ownership.md): a resolved scroll/view
effect can be held only at its source-owned CSS percentage while its
post-layout/compositor source remains independently mutable. DM-2553 and
DM-2554 own the two exact production protocols; neither is approximated here.
