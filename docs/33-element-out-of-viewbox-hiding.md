# 33 — Element-level out-of-viewBox hiding (DM-603 / DM-2460 / DM-2461)

Phase 2 of the animation-performance work. Phase 1 ([doc 8 §Out-of-frame paint suppression](08-animation-model.md)) drops entire frames from paint while they're outside their show window. Phase 2 drops individual *elements within a frame* whose bboxes don't intersect the viewBox at the relevant times.

## Why

Phase 1 alone misses the dominant cost on the use case that triggered DM-599: **a single tall capture being scrolled through a fixed-size viewBox via an intra-frame `translateY` animation**. Example: an 800×600 viewBox displaying a 800×4000 captured page that scrolls from `translateY(0)` to `translateY(-3400px)` over 8 seconds. At every moment ~600 px of content is in the viewBox and ~3400 px is outside — but the browser still rasterizes the off-viewBox 3400 px on every frame.

Other cases Phase 2 covers:

- **Static off-viewBox content** — an element captured at `y = 1800` of a 600-tall frame because its parent had `overflow: visible`. The renderer faithfully emits it; it's never visible but currently always rasterized.
- **Intra-frame `translate*` animations on smaller elements** — a toast that slides in from `translateY(-100px)` to `translateY(0px)` is off-viewBox before the animation runs.
- **Future actual-scroll transitions** — if `scroll` is ever made geometrically scroll between frames (currently it's an opacity-only fade-with-tail; see [Open question 2](#open-questions) below), the same machinery handles it.

## Inputs

The culler consumes three source-owned inputs:

- **renderer facts derived from `CapturedElement`** —
  `src/render/culling-geometry.ts` classifies the actual emitted subtree as an
  exact fill/stroke/view reference box and a separate bounded visual surface,
  or explicitly as empty/unknown. The source HTML carrier rectangle is only
  one possible generated paint primitive; it is never a fallback proxy for the
  animation group's geometry.
- **`IntraFrameAnimation`** — transform endpoints/timing plus optional
  `transformOrigin` and `transformBox` (`fill-box` by default, with
  `stroke-box` and `view-box` supported).
- **`AnimationConfig.width / height`** — the generated SVG viewBox.

No SVG string parsing, browser measurement, or runtime `getBBox()` call is
needed. The geometry pass mirrors renderer branches before SVG serialization.

## Design

### Per-element visibility intervals

For each captured element, compute the set of time intervals during which its transformed bbox intersects the viewBox `[0, 0, viewportW, viewportH]`. Emit `display: none` for the *complement* of that set.

**Static element (no live animation wrapper)**:
- Intersect the renderer-owned visual bound with
  `(0, 0, viewportW, viewportH)`, after every frozen affine SVG wrapper on the
  path and every finite emitted overflow clip.
- A known bounded surface with empty intersection may emit
  `style="display: none"`. Unknown, empty, singular, non-finite, or genuinely
  3D facts retain the subtree.
- Reference boxes do not substitute for visual bounds: outline/shadow/filter
  ink and exact replaced/raster surfaces can reach the viewBox while an HTML
  border box does not.

**Animated element (matches a `data-domotion-anim`, or descendant of one)**:

- Build the same root-to-leaf wrapper stack emitted by the renderer. A child's
  animation adds an inner transform; it never replaces an animated ancestor.
- Resolve each declared origin inside the generated wrapper's used
  `fill-box`, `stroke-box`, or root `view-box`. If that reference is unknown or
  can change under a descendant animation, retain. An unset origin preserves
  SVG's `(0,0)` default. Independently applying `display:none` to a descendant
  would itself mutate an ancestor's fill/stroke box, so those reference-box
  contributors remain emitted; a viewport reference has no such dependency.
- Map every transform track onto the global scene clock using its frame origin,
  delay, duration, easing, iteration count, alternate direction, and `both`
  fill state. Independently timed fused tracks keep their own clocks.
- Partition `[0%,100%]` at every start/end, iteration, and step discontinuity.
  Within each partition, interpolate supported matching `translate` and
  `scale` functions **before** composing them. Propagate the box through the
  operation list in reverse application order, including every per-corner 2D
  rotation-arc extremum, then through each wrapper from inner to outer.
- The result is a conservative AABB for every continuous-time partition. A
  partition whose bound intersects the viewBox is possibly visible. The one
  emitted visibility window is the hull of all such partitions, deliberately
  retaining any gap that a single class cannot represent.
- Permanent `display:none` is allowed only when **every** partition is known
  and disjoint. Mismatched lists that require matrix decomposition, skew,
  matrices/3D/projective transforms, percentage translation, invalid or
  unbounded timing, and any non-finite result return unknown. Unknown means no
  cull class and no `display:none`.

This is the source-backed form of the DM-599 feedback rule: an entering or
leaving animation is retained across its complete possibly-visible partition,
and only proven hold phases before/after may be hidden. It also covers crossings
narrower than any raster sample interval; finite samples are never evidence that
a continuously animated SVG remains absent between them.

### CSS emission

Three output shapes, per element:

1. **Always hidden (no animation, off-viewBox)** — emit `style="display:none"` directly on the element's `<g>`. No CSS rule, no keyframes.
2. **Animated, hide before / after only** — emit a `@keyframes` block with the standard discrete-snap pattern (0.001 % gap between on/off keyframes, animation-timing-function: step-end). The shipped `buildCullKeyframes` helper in `src/tree-ops/viewbox-culling.ts` produces this block (toggling `visibility`, not `display`). Apply via a per-element class `dh-<n>` (display-hide-N).
3. **Always hidden during scroll animation** — same `@keyframes` shape but the visible window is empty. Effectively equivalent to `style="display:none"` but parameterized through the keyframe pipeline for uniformity.

Classes are coalesced when N elements share the same visible interval (common in long-scroll captures where contiguous rows have identical t_visible_start / t_visible_end). Map `(t_visible_start, t_visible_end) → className`, emit one keyframes block per unique interval.

### Composition pipeline integration

- **Capture time** records the paint/geometry facts already required by the
  renderer; culling adds no browser probe.
- **Pre-render tree pass** calls `buildRendererCullGeometry`, threads every
  animation's selected reference box into the continuous sweep, and writes
  `displayNone` / `cullClass` on the owning `CapturedElement`.
- **Render time** puts a cull class on the outer group and an animation class
  on its separate inner group. Atomic Chromium snapshots use the same order;
  their already-baked frozen static/filter state is not re-applied.
- **Composition time** emits/deduplicates the cull keyframes alongside the
  ordinary frame and intra-frame animation CSS.

## Output size budget

Each `<g>` that becomes `display: none` adds ~16 bytes (`style="display:none"`). Each unique-interval keyframes block adds ~150–200 bytes plus the per-element class assignment (~10 bytes). For a 4000-row scrolling page captured at full height, naïve emission could add 50–100 KB. After gzip (DM-602) the per-element repetition compresses tightly — keyframes share the same shape and only the percentages differ.

Mitigation, in priority order:

1. **Coalesce identical intervals** — N elements sharing the same `(t_visible_start, t_visible_end)` share one keyframes block. For uniform scroll over a list of similar rows, this collapses to O(viewport-height / row-height) blocks instead of O(rows).
2. **Threshold by bbox area** — skip Phase 2 for elements smaller than some pixel count (e.g. <4 px²). Tiny glyphs don't move the perf needle individually. *Punted: complicates the model; measure first.*
3. **Container vs leaf** — apply hide on the highest `<g>` ancestor that's fully off-viewBox rather than every leaf. *Punted: requires bbox roll-up which is straightforward but additional work; measure first.*

The composition-time pre-pass is O(elements) for static analysis, O(elements × animations) for animated analysis — both fast.

## Resolved design choices (per DM-603 feedback)

1. **Always-on.** Trust coalescing + gzip to keep output size bounded. No opt-in flag.
2. **Scope = ALL drawing in our SVGs**, not specific transitions. The user's exact framing: *"this optimization isn't related to any particular transition type or animation type, it should be for ALL drawing within our svgs. Large SVGs trying to render too much at once get slow / choppy."* The current `scroll` transition is "probably wrong" but is out of scope here — `translateY` / `translateX` intra-frame animations are the supported scroll mechanism.
3. **Non-linear easing**: cubic-bezier extrema are bounded continuously from
   the polynomial derivative (including control-point overshoot); CSS step
   discontinuities become explicit clock partitions. Unsupported timing syntax
   fails closed. No finite sample grid can prove continuous exclusion.

## Implementation (shipped)

1. **`CapturedElement.displayNone?: boolean`** and **`CapturedElement.cullClass?: string`** — new fields. The renderer in `src/render/element-tree-to-svg.ts` honors them on the element's outermost `<g>` wrapper. `needsGroup` is forced true whenever either field is set so the cull markers never get dropped on elements that otherwise wouldn't have wrapped.
2. **`src/render/culling-geometry.ts`** — renderer-owned exact/bounded facts,
   static affine mapping, emitted overflow clipping, raster surfaces, and
   explicit empty/unknown states. **`src/tree-ops/viewbox-culling.ts`** — tree integration and decisions;
   **`src/tree-ops/swept-transform-bounds.ts`** — the pure source-transcribed
   continuous-time operation/timing model. The public tree module exports:
   - **`cullElementsOutsideViewBox(tree, viewportW, viewportH, animations?, frameStartMs, totalDurationMs)`** — walks the tree, mutates `displayNone` / `cullClass` per element, returns `{ css }` containing all the `@keyframes cull-<start>-<end>` blocks keyed by visible-window equivalence. Accepts either a single `CapturedElement` or an array of siblings.
   - **`decideCull(staticBbox, vw, vh, ctx)`** — pure per-element decision function exposed for tests / future reuse.
   - Coalescing: elements with identical `(visStartPct, visEndPct)` share a cull class so the keyframes block count is bounded by the number of unique intervals (≈ viewport rows, not source rows).
   - Naming: the class name is derived from the window itself — `cull-<start>-<end>` with `.` encoded as `_` (e.g. `cull-8_419-91_581` for visible during [8.419%, 91.581%]) — never from a per-call counter. Frames are culled one call at a time but their CSS is concatenated into ONE scene-wide `<style>`, so counter-based names (`cull-0`, `cull-1`, …) collided across frames: the last frame's `@keyframes cull-0` clobbered every earlier frame's different window, hiding those frames' elements during their own frame. Window-derived names make identical windows share a class scene-wide (byte-identical keyframes) and distinct windows can never collide.
3. **`AnimationFrame.cullCss?: string`** — new optional field on the animator's frame interface. The animator splices each frame's CSS into the scene-wide `<style>` block alongside the existing `fv-*` / `fd-*` / `tN` keyframes, deduping blocks whose class (= window) repeats across frames so each unique window is emitted once.
4. **CLI integration** —
   - **`runCapture` (single frame)** calls `cullElementsOutsideViewBox(tree, w, h)` with no animations — pure static cull pass, returns empty CSS, mutates `displayNone` only.
   - **`runAnimate` (multi-frame)** computes `frameStartMs` and `totalDurationMs`, calls `cullElementsOutsideViewBox(tree, w, h, resolvedAnimations, frameStartMs, totalDurationMs)` BEFORE `elementTreeToSvg`. The keyframes CSS is forwarded to the animator via `AnimationFrame.cullCss`.
5. **Unit tests** in `src/tree-ops/{swept-transform-bounds,viewbox-culling}.test.ts`
   cover static/enter/exit/never-visible decisions; function-first negative
   scale; a 50.5% crossing between the retired grid points; both transform-list
   orders; nested ancestor/child clocks; independently timed fused tracks;
   positive/negative delay and hold phases; repeat/alternate/steps; cubic-bezier
   overshoot extrema; finite/non-finite and projective/mismatched fail-closed
   controls; origin variants; coalescing; and keyframe/class stability.

## Algorithm details

### Static intersection

`bboxIntersectsViewport(bbox, vw, vh) = bbox.x < vw && bbox.x + bbox.w > 0 && bbox.y < vh && bbox.y + bbox.h > 0`.

### Operation and timing model

`conservativeSweptBoxes` parses each supported transform endpoint into an
ordered list of translate/scale/2D-rotate primitives. `none` supplies identity primitives;
two non-empty lists must have matching primitive sequences. Parameters are
interpolated from their eased progress range, then each operation expands the
current AABB in reverse order. This follows Chromium's
`TransformOperations::BlendedBoundsForBox`; importantly it does not interpolate
the already-composed endpoint matrix. The transcription is pinned to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`, specifically
`ui/gfx/geometry/transform_operations.cc:58-95,339-372` and
`transform_operation.cc:177-510`. Independent fused tracks concatenate in
the declaration order emitted by `composeAnimStop` while retaining their own
timing models.

Each timing model records a global start, duration, iteration count, alternate
direction, and easing. Before start it fills at `from`; after a finite active
duration it fills at the direction-dependent terminal value. Infinite and
finite repeats partition every iteration. Named/cubic-bezier easing uses a
monotonic x inversion and all y-derivative extrema, so overshoot is included;
steps partition every discontinuity. Negative delay begins the scene inside the
correct iteration. Unknown syntax or excessive/unbounded partition counts
returns unknown.

For nested animation carriers, the tree walk appends rather than replaces a
context. A leaf box is swept through the innermost wrapper first and every
ancestor afterward. Successive AABB expansion may lose timing correlation and
over-retain; it cannot remove a reachable point.

### Transform origin and renderer geometry

Scale/rotation is applied as `T(origin) · operations · T(-origin)`. With no
authored origin, the emitted SVG wrapper uses `(0,0)`. A set origin resolves
keyword, percentage, or px syntax inside the renderer-owned used `fill-box`,
`stroke-box`, or `view-box`. Blink's mapping is pinned in
`TransformHelper::ComputeReferenceBox`: SVG object bbox, stroke bbox, or
resolved viewport respectively. An unavailable or time-varying reference box
retains paint. A frozen static affine wrapper is applied to visual bounds for a
static decision; a live animation sharing that path retains until the exact
wrapper interleave can be represented without changing operation order.

### Per-element decision

`decideCull` requests all scene partitions. `null` means retain. Otherwise it
intersects each conservative bound with the viewBox. No possibly-visible
partition permits permanent `display:none`; one or more produce the hull
`[first.startPct,last.endPct]`; a hull spanning the scene emits no class. Exact
edge-touch remains non-intersection under the existing strict rectangle rule.
The bottom-up tree walk then unions each element hull with every descendant
hull before attaching an ancestor class, because ancestor `visibility` governs
overflow-visible child paint; a parent's own box can never narrow its subtree.

## Follow-ups (filed separately, if needed)

- **Geometric scroll between frames** — if/when we want the `scroll` transition to actually translate (it currently doesn't; out of scope per DM-603 feedback). The cull machinery here would extend trivially.
- **Container-level hide (vs leaf-level)** — if measurement shows leaf-level coalescing isn't enough.
- **Bbox-area threshold** — if profiling shows tiny elements dominate the keyframes-block count and matter for bundle size.
- **Independent full live oracle** — DM-2462 owns the broad global-timeline
  Chromium activation matrix. DM-2460 includes a focused reference-box
  discriminator at zoom/DPR variants, not that replacement gate.
