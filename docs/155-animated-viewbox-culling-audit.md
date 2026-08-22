# Animated viewBox culling geometry audit

DM-2386 audited the optimization in
[`src/tree-ops/viewbox-culling.ts`](../src/tree-ops/viewbox-culling.ts) against
Chromium revision `7d859f271cbda744098ac69f44978d4edfa62be3` and that
checkout's pinned Skia revision
`62efacd37737505732dbe3d8daa62abd679626a1`. This was an investigation only:
it did not change the culler or its activation surface.

## Verdict

The continuously animated SVG must be culled from a **conservative swept
visual bound over global-time intervals**, not from a finite set of per-frame
quads. An exact quad at a requested frame is appropriate for a finite
PNG/video frame and for the browser oracle, but it cannot prove that content
never enters the viewBox between frames while CSS animation runs continuously.

The present implementation is not conservative for the transform cases it
classifies as supported. Fresh Chromium controls demonstrate visible paint that
Domotion marks hidden. The unsafe assumptions are independent:

- the captured HTML carrier border box substitutes for the emitted SVG
  wrapper's `fill-box`;
- only the nearest `animId` is evaluated, instead of composing animated
  ancestors on the global timeline;
- endpoint transform matrices are interpolated after composition, although
  matching CSS transform functions are interpolated before composition;
- 49 interior probes from a fixed 50-part grid are treated as proof of an
  empty continuous interval; and
- the static path tests the untransformed captured box even when capture has
  frozen a rotate/skew/3D transform for the renderer to reapply.

At audit time, rejection of an unmodelled transform track or an independently
timed fused track was in the safe direction: those branches retained the
element. It did not compensate for the supported-path failures above. DM-2461
now models own-timing fused tracks while preserving the same fail-closed rule
for genuinely unsupported paths.

## DM-2461 implementation update

The timeline/operation half of this verdict is now implemented in
`src/tree-ops/swept-transform-bounds.ts` and wired by
`src/tree-ops/viewbox-culling.ts`:

- the endpoint-affine lerp and fixed `N=50` proof path are deleted;
- matching translate/scale/2D-rotate functions interpolate before reverse-order
  composition, including negative scale, both list orders, and all per-corner
  rotation-arc extrema;
- a tree walk carries the complete root-to-leaf animation wrapper stack rather
  than replacing it at the nearest `animId`, and unions each ancestor's
  visibility window with the full descendant hull before attaching a class;
- primary and independently timed fused tracks map to the global scene clock,
  partitioning delay/active/fill, every finite/infinite iteration, alternate
  direction, and step discontinuity;
- cubic-bezier y extrema (including overshoot) are included over each continuous
  progress interval; and
- mismatched/decomposition-only lists, matrix/skew/3D/projective values,
  unsupported timing syntax, excessive/unbounded partitions, and non-finite
  results return unknown, which means retain paint.

The implementation deliberately expands each nested operation/wrapper in
sequence. Lost correlation can enlarge the result but cannot over-cull. Focused
production tests reproduce all three audit failures: the function-first
negative-scale entry, the 50.5% interval between old sample points, and the
outer/inner cancellation visible at 700 ms. Repeat/alternate, positive and
negative delay, holds, steps, easing overshoot, operation order, own-timing
fuses, and unsupported controls are independently covered.

This does **not** close the full doc-155 boundary. DM-2460 still owns the emitted
SVG reference/visual bounds (the present carrier-box origin proxy remains),
static frozen transforms/effects, and unknown visual ink. DM-2462 still owns the
independent live Chromium activation oracle. Those unknown geometry paths must
continue to retain content.

## Pre-DM-2461 implementation boundary (audit baseline)

| Stage | Current decision | Audit result |
| --- | --- | --- |
| Static element | Intersect `CapturedElement.{x,y,width,height}` directly | Unsafe when a frozen author transform is emitted later; insufficient for visual effects |
| Transform reference box | Resolve a declared origin against the animation carrier's captured border box | Not the SVG wrapper's used `fill-box`, `stroke-box`, or `view-box` |
| Transform list | Parse translate/scale endpoints, compose each endpoint, then linearly blend the four composed affine components | Wrong for non-commuting matching functions such as scale plus translate |
| Time | Test both endpoints and progress `i / 50`, `i=1..49` | Samples cannot prove exclusion over a continuous interval |
| Tree | Replace inherited animation context when a child carries an `animId` | Drops ancestor transforms instead of composing the nested `<g>` wrappers the renderer emits |
| Unknowns | Retain rotate/skew/matrix/3D/percent and fused own-timing tracks | Correct conservative fallback, but it needs a recorded reason and activation controls |

The renderer makes the composition requirement observable. A cull class is on
an outer group, each animation class is on a separate inner group, and child
animation groups remain nested. The culler therefore has to evaluate the same
wrapper stack rather than choose one context. Separately, transform capture
freezes rotation/skew/`matrix3d()` to obtain an untransformed layout box and
threads the transform to the renderer; the no-animation culling branch does not
apply that stored transform.

## Pinned source decisions

### Reference box and operation order

`ComputedStyle::UsedTransformBox` distinguishes SVG from layout boxes. For SVG,
`content-box` becomes `fill-box`, `border-box` becomes `stroke-box`, and a
non-scaling stroke changes the latter to `fill-box`. For layout boxes,
`fill-box` becomes `content-box`, while `stroke-box` and `view-box` become
`border-box`.

`TransformHelper::ComputeReferenceBox` then resolves an SVG `fill-box` from
`ObjectBoundingBox()`, a `stroke-box` from `StrokeBoundingBox()`, and a
`view-box` from the SVG viewport; it applies effective zoom to that reference
box. The layout-box helper instead derives the content or border rectangle from
the physical fragment. These are different geometries. A captured HTML border
box is not a source-backed proxy for the output `<g>`'s SVG object bounding box.

`ComputedStyle::ApplyTransform` resolves transform origin against that selected
reference box and applies, in order, independent translate, rotate, and scale;
motion path; the `transform` operation list; and the inverse origin
translation. Motion-path reference geometry comes from the containing block or
SVG viewport. Consequently, computed `transform` alone is not a complete
motion transform.

### Bounds and failure direction

Blink's SVG painter uses `VisualRectInLocalSVGCoordinates()` when culling is
allowed. More importantly, it disables the optimization across transforms,
transform-related descendants, and pixel-moving filters; the unsupported
branch receives an infinite cull rect. Chromium itself therefore establishes
the required failure direction: uncertainty keeps paint.

Chromium's transform-operation bounds implementation provides the model for a
tighter safe path. `TransformOperations::BlendedBoundsForBox` walks matching
operations in reverse application order, expands a conservative box over a
progress interval, and returns `false` if an operation cannot be bounded.
Transform interpolation first blends a matching function prefix. A mismatched
remainder is matrix-decomposed, and failed decomposition falls back to discrete
animation. This is materially different from blending already-composed
`sx/sy/tx/ty` endpoints.

For projective mapping, `gfx::Transform` maps a rectangle through its quad and
clamps projected points whose homogeneous `w` is non-positive. Pinned Skia's
`SkM44` rectangle mapping clips edges to
`SkPathPriv::kW0PlaneDistance`; an edge wholly below that plane can contribute
infinite bounds. A continuous interval that reaches or crosses this plane is
not safely bounded by its endpoint rectangles. Until Domotion transcribes that
behavior for its actual paint surface, it must retain the subtree.

## Fresh adversarial evidence

The “current production decision” column below records the DM-2386 audit
baseline before the DM-2461 implementation update above.

The audit ran a local Playwright probe at DPR 1 with an 800 by 600 viewport.
The fingerprint was Headless Chrome `147.0.7727.15`, macOS arm64, Node
`v22.23.2`; the user agent was
`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML,
like Gecko) HeadlessChrome/147.0.7727.15 Safari/537.36`. Each production result was
obtained by calling the exported `decideCull` or
`cullElementsOutsideViewBox`, while the compared rectangle came independently
from Chromium layout/paint state.

| Discriminator | Chromium observation | Current production decision | Consequence |
| --- | --- | --- | --- |
| SVG fill box vs border-box proxy | A `<g>` containing `x=300,y=100,w=20,h=20` reports that exact `getBBox()`. `scale(.5)` about `100% 100%` paints `x=310..320,y=110..120`. | With a synthetic carrier border box `0,0,400,200`, the model predicts `x=350..360,y=150..160` and emits `{visStartPct:0,visEndPct:50}` for a 330-wide viewBox. | The visible final state is hidden after 50%. |
| Nested independent timing | At global 700 ms, an outer 0-to-400 translate over 1000 ms is `+280`; an inner 0-to--400 translate over 200 ms after a 400 ms delay is `-400`. Their child paints `x=80..100`. | The child `animId` replaces the parent context and receives `cull-40_000-60_000`. | The child is suppressed at 70% while it intersects the viewBox. |
| Matching transform functions | `scale(-1) translateX(-100px)` to `scale(1) translateX(100px)` has computed `matrix(-0.1,0,0,-0.1,1,0)` at 45%; the rect paints `x=-1..1`. | Blending the two already-composed endpoint matrices returns `{alwaysHidden:true}` for a 50-wide viewBox. | A mid-animation entry is deleted. |
| Narrow interval between samples | `translateX(-101000px)` to `translateX(99000px)` paints `x=0..10` at 50.5%. The adjacent production probes at 50% and 52% are far outside. | `{alwaysHidden:true}`. | A valid continuous-time entry is missed by the fixed grid. |
| Frozen static author transform | A box captured as `x=900..1100` and later painted with `rotate(180deg)` about its top-left reaches `x=700..900`. | The static decision tests only `x=900..1100` and returns `{alwaysHidden:true}` for an 800-wide viewBox. | The in-view transformed portion is deleted. |
| Motion path channel | At `offset-distance:50%`, Chromium paints `x=110..130` while computed `transform` remains `none`. | No `IntraFrameAnimation` field carries offset path/distance/rotate/anchor. | Motion cannot be reconstructed from the transform string. |
| Projective near-plane geometry | `perspective(100px)` with `translateZ(40px) rotateY(60deg)` paints the nominal 200 by 120 box at `x=654.106..807.952`, `y=94.458..545.542`. | Projective animation is rejected; static culling still lacks a projective visual bound. | Retention is required until exact `w`-plane handling exists. |

A static nested-transform control also confirmed wrapper composition:
`translate(1000)` outside `translate(-1000)` leaves the child at `x=100..120`.
Removing either wrapper moves the result. This is the negative control for any
implementation that accidentally flattens the tree to the nearest animation.

## Required model

The implementation work should separate two geometries that the current box
conflates:

1. a **transform reference box** matching the box actually used by the emitted
   SVG wrapper (`fill`, `stroke`, or local viewport), including its origin and
   effective-zoom coordinate space; and
2. a **visual/ink bound** for intersection, including transformed descendants,
   stroke, outline, shadow, filter displacement/blur, masks, clips, and any
   raster fallback surface.

For each subtree, construct the emitted transform-operation stack and all of
its local timing functions. Partition the global scene clock at every relevant
delay, active-interval, iteration, direction, fill, and step discontinuity.
Within each interval, propagate the visual bound from the inner wrapper through
each ancestor operation using a source-transcribed conservative swept-bound
routine. Matching function lists must be interpolated as functions before they
are composed. A failed parse, incompatible/decomposition-only list, independent
channel not represented in capture, projective singularity, unbounded motion
path, or non-finite result returns `unknown`; `unknown` means visible for that
interval.

This may over-retain correlated nested motion because successively bounding
each operation loses correlation. That is safe. It must never tighten a box
from sampled pixels or tune a threshold to these fixtures. An exact global
extremum implementation can replace an over-bound only when its rule comes from
the operation model and carries an oracle discriminator.

## Required controls

The implementation and browser gate should include these independent rows:

- static in-view, static off-view, exact edge-touch, and a neutral-wrapper
  mutation;
- frozen static rotate/skew and a pure live translate/scale control;
- SVG `fill-box`, `stroke-box`, and `view-box` origins, plus HTML content/border
  reference boxes; percentage, keyword, pixel, asymmetric, and effective-zoom
  origins;
- transformed descendant ink outside a parent's box, thick stroke, outline,
  outset shadow, pixel-moving filter, clip, mask, and raster-surface bounds;
- entering, leaving, leave-then-enter, and a visibility interval narrower than
  the retired 2% sample spacing;
- matching translate/scale lists in both orders, negative scale, rotation
  extrema, incompatible list/decomposition fallback, and a mutation that blends
  endpoint matrices;
- nested animated ancestors, child own animation, fused tracks with distinct
  delay/duration/easing, positive and negative delay, steps, repeat, alternate,
  and pre/post fill states;
- offset path/distance/rotate/anchor and a no-motion-path control; and
- affine `matrix3d()` without perspective, projective paint, a near-plane
  crossing, and a non-finite/unknown retention control at zoom and DPR variants.

The live oracle must record the exact Chromium quad or ink rectangle and the
generated SVG's visibility state at the same global time. Its activation
mutations must fail independently when substituting the border-box proxy,
nearest-only timing, endpoint-matrix interpolation, or fixed sample grid.

## Follow-up ownership

- **DM-2460 — Model rendered SVG reference and visual bounds for viewBox
  culling.** Owns exact fill/stroke/view reference boxes, separate visual
  bounds, static frozen transforms/effects, and unknown-state retention.
- **DM-2461 — Use composed global-timeline swept bounds for animated viewBox
  culling (implemented).** Owns function-first interpolation, nested/own
  timing, global interval partitioning, conservative operation bounds, and
  removal of fixed sampling as a proof mechanism.
- **DM-2462 — Add a live Chromium animated-culling geometry oracle.** Owns the
  generated adversarial matrix, mutation controls, environment fingerprints,
  and parity/semantic registry wiring.

## Source map

All Chromium paths below are relative to
`external/chromium/third_party/blink/renderer`; Skia is read at the Chromium
checkout's pinned revision rather than at the submodule worktree HEAD.

- `core/style/computed_style.cc:1372-1412` — used transform-box mapping.
- `core/style/computed_style.cc:1429-1490` — reference-box origin and transform,
  motion-path, and independent-operation order.
- `core/style/computed_style.cc:1495-1518,1551-1758` — motion-path reference box,
  distance, ray/path, anchor, and rotation.
- `core/layout/svg/transform_helper.cc:93-149` — SVG fill/stroke/view reference
  boxes, effective zoom, and full transform computation.
- `core/layout/transform_utils.cc:17-48` — fragment-aware layout content/border
  reference boxes.
- `core/paint/svg_model_object_painter.cc:15-26` — transforms and pixel-moving
  filters disable the ordinary SVG cull-rect optimization.
- `core/paint/svg_container_painter.cc:36-90` — transform-related descendants,
  local visual bounds, and infinite-cull fallback.
- `external/chromium/ui/gfx/geometry/transform_operations.cc:47-95,339-372`
  — function-list blending, conservative interval bounds, decomposition, and
  discrete fallback. The Blink counterpart is
  `platform/transforms/transform_operations.cc` at the same Chromium revision.
- `external/chromium/ui/gfx/geometry/transform.cc:775-920` — quad mapping and
  non-positive homogeneous-`w` handling.
- `external/skia/src/core/SkM44.cpp:164-224` at
  `62efacd37737505732dbe3d8daa62abd679626a1` — perspective rectangle edge
  clipping and infinite bounds.
