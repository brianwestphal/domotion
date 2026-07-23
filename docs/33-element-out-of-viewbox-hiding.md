# 33 — Element-level out-of-viewBox hiding (DM-603, Phase 2 of DM-599)

Phase 2 of the animation-performance work. Phase 1 ([doc 8 §Out-of-frame paint suppression](08-animation-model.md)) drops entire frames from paint while they're outside their show window. Phase 2 drops individual *elements within a frame* whose bboxes don't intersect the viewBox at the relevant times.

## Why

Phase 1 alone misses the dominant cost on the use case that triggered DM-599: **a single tall capture being scrolled through a fixed-size viewBox via an intra-frame `translateY` animation**. Example: an 800×600 viewBox displaying a 800×4000 captured page that scrolls from `translateY(0)` to `translateY(-3400px)` over 8 seconds. At every moment ~600 px of content is in the viewBox and ~3400 px is outside — but the browser still rasterizes the off-viewBox 3400 px on every frame.

Other cases Phase 2 covers:

- **Static off-viewBox content** — an element captured at `y = 1800` of a 600-tall frame because its parent had `overflow: visible`. The renderer faithfully emits it; it's never visible but currently always rasterized.
- **Intra-frame `translate*` animations on smaller elements** — a toast that slides in from `translateY(-100px)` to `translateY(0px)` is off-viewBox before the animation runs.
- **Future actual-scroll transitions** — if `scroll` is ever made geometrically scroll between frames (currently it's an opacity-only fade-with-tail; see [Open question 2](#open-questions) below), the same machinery handles it.

## Inputs (already available)

The data needed is already in the pipeline:

- **`CapturedElement.x / y / width / height`** — every captured element carries its bbox in the parent frame's coordinate space (see `src/capture/types.ts`'s `CapturedElement` interface).
- **`IntraFrameAnimation.from / to / duration / delay`** — every intra-frame animation has explicit start and end values in CSS units.
- **`AnimationConfig.width / height`** — the viewBox dimensions.

No SVG parsing, no DOM measurement, no `getBBox()` runtime call. Phase 2 is a pure composition-time transform.

## Design

### Per-element visibility intervals

For each captured element, compute the set of time intervals during which its transformed bbox intersects the viewBox `[0, 0, viewportW, viewportH]`. Emit `display: none` for the *complement* of that set.

**Static element (no ancestor with `data-domotion-anim`, no ancestor in a scroll transition)**:
- Intersection of `(x, y, width, height)` with `(0, 0, viewportW, viewportH)`.
- Empty → always hidden → emit `style="display: none"` directly on the element's `<g>`. No keyframes.
- Non-empty → always visible → no change.

**Animated element (matches a `data-domotion-anim`, or descendant of one)**:
- Parse `from` and `to` of the relevant `IntraFrameAnimation`. The supported properties that can move an element off-viewBox are `transform`, `translateX`, `translateY`. Other properties (`width`, `height`, `opacity`, `clipPath`) don't shift the bbox.
- Compute `bbox_start = bbox + apply(from)` and `bbox_end = bbox + apply(to)`.
- Four cases:

  | start∩vb | end∩vb | Action |
  |---|---|---|
  | empty | empty | (no boundary crossing) Always hidden during this animation's lifetime → emit `display: none` keyframes spanning the whole scene cycle. |
  | empty | non-empty | Element enters viewBox during animation. Hide *before* the animation (`0%` → `animStart`); show during the animation; keep showing after. |
  | non-empty | empty | Element exits viewBox during animation. Show before; show during; hide *after* (`animEnd` → `100%`). |
  | non-empty | non-empty | Visible throughout the animation. No hide keyframes. (The interim translation might pass entirely through off-viewBox space for some weird path, but we conservatively don't hide during animation — matches the DM-599 feedback rule.) |

- **DM-599 feedback rule** (verbatim): *"if an animation starts out of view box and then enters, or starts in the view box and then exits, you should only hide the element once the animation is done."* This maps to the table above — never hide DURING an animation that crosses the boundary, only before or after.

**Descendant in a scrolled subtree** — an element inside a `<g class="anim-<id>">` whose animation is `translateY` (or `translateX`, or `transform: translate(...)`) inherits that transform. Its effective bbox at any time t is `parent_bbox + interpolated_translate(t)`. For a long scrolling page, this is the main case.

To keep the math tractable: compute the **visible time range** for an element under a `translate*` animation analytically. For `translateY(from → to)` with linear interpolation:

```
t_visible_start = clamp(((-element.y) - to_y) / (from_y - to_y), 0, 1)  // when element top hits viewport bottom
t_visible_end   = clamp(((viewportH - element.y - element.height) - to_y) / (from_y - to_y), 0, 1)
```

(Derivation: at progress `p ∈ [0, 1]`, transformY = `from_y + p*(to_y - from_y)`. Element top in viewport coords = `element.y + transformY`. Visible iff `element.y + transformY + element.height > 0` AND `element.y + transformY < viewportH`. Solve for `p`.)

If easing is non-linear, the inversion is harder; we use the linear approximation as a lower bound (over-hide is wrong, under-hide is OK — the consequence of being wrong is the element flickers off when it shouldn't). For correctness with non-linear easing we'd sample-and-test. **Proposed**: linear interpolation only for Phase 2; flag for follow-up if non-linear easings become important.

### CSS emission

Three output shapes, per element:

1. **Always hidden (no animation, off-viewBox)** — emit `style="display:none"` directly on the element's `<g>`. No CSS rule, no keyframes.
2. **Animated, hide before / after only** — emit a `@keyframes` block with the standard discrete-snap pattern (0.001 % gap between on/off keyframes, animation-timing-function: step-end). The shipped `buildCullKeyframes` helper in `src/tree-ops/viewbox-culling.ts` produces this block (toggling `visibility`, not `display`). Apply via a per-element class `dh-<n>` (display-hide-N).
3. **Always hidden during scroll animation** — same `@keyframes` shape but the visible window is empty. Effectively equivalent to `style="display:none"` but parameterized through the keyframe pipeline for uniformity.

Classes are coalesced when N elements share the same visible interval (common in long-scroll captures where contiguous rows have identical t_visible_start / t_visible_end). Map `(t_visible_start, t_visible_end) → className`, emit one keyframes block per unique interval.

### Composition pipeline integration

- **Capture time**: no change. `CapturedElement.{x,y,width,height}` already populated.
- **Render time (`src/render/element-tree-to-svg.ts elementTreeToSvg`)**: no change. Each element still emits as `<g>` with its existing transform.
- **Composition time (`src/animation/animator.ts generateAnimatedSvg`)**: new pre-pass walks the captured trees, classifies each element by visibility behavior (always-visible / always-hidden / window-hidden), and emits the CSS class assignments + keyframes. Static `display:none` elements get the style attribute pasted onto their `<g>` directly via post-emission string surgery (or, preferred: add a `displayNone?: boolean` field to `CapturedElement` and let the renderer honor it).

The trees passed to the animator are already-rendered `svgContent` strings, not `CapturedElement` objects. To use captured bboxes at composition time, **the AnimationFrame interface needs to also carry the original tree**, or the renderer needs to inline data attributes (`data-bbox="x y w h"`) the animator can parse back out.

**Proposed**: extend `AnimationFrame` with an optional `tree?: CapturedElement` field. When present, the animator uses the tree for bbox analysis. Backwards-compatible (existing callers passing only `svgContent` get no Phase 2 benefit but still work).

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
3. **Non-linear easing**: sample at N=50 points; take the bounding t-interval where bbox intersects viewBox. Under-hide is fine (visually correct), over-hide would cause flicker — the bounding interval makes over-hide structurally impossible.

## Implementation (shipped)

1. **`CapturedElement.displayNone?: boolean`** and **`CapturedElement.cullClass?: string`** — new fields. The renderer in `src/render/element-tree-to-svg.ts` honors them on the element's outermost `<g>` wrapper. `needsGroup` is forced true whenever either field is set so the cull markers never get dropped on elements that otherwise wouldn't have wrapped.
2. **`src/tree-ops/viewbox-culling.ts`** — new module. Exports:
   - **`cullElementsOutsideViewBox(tree, viewportW, viewportH, animations?, frameStartMs, totalDurationMs)`** — walks the tree, mutates `displayNone` / `cullClass` per element, returns `{ css }` containing all the `@keyframes cull-<start>-<end>` blocks keyed by visible-window equivalence. Accepts either a single `CapturedElement` or an array of siblings.
   - **`decideCull(staticBbox, vw, vh, ctx)`** — pure per-element decision function exposed for tests / future reuse.
   - Coalescing: elements with identical `(visStartPct, visEndPct)` share a cull class so the keyframes block count is bounded by the number of unique intervals (≈ viewport rows, not source rows).
   - Naming: the class name is derived from the window itself — `cull-<start>-<end>` with `.` encoded as `_` (e.g. `cull-8_419-91_581` for visible during [8.419%, 91.581%]) — never from a per-call counter. Frames are culled one call at a time but their CSS is concatenated into ONE scene-wide `<style>`, so counter-based names (`cull-0`, `cull-1`, …) collided across frames: the last frame's `@keyframes cull-0` clobbered every earlier frame's different window, hiding those frames' elements during their own frame. Window-derived names make identical windows share a class scene-wide (byte-identical keyframes) and distinct windows can never collide.
3. **`AnimationFrame.cullCss?: string`** — new optional field on the animator's frame interface. The animator splices each frame's CSS into the scene-wide `<style>` block alongside the existing `fv-*` / `fd-*` / `tN` keyframes, deduping blocks whose class (= window) repeats across frames so each unique window is emitted once.
4. **CLI integration** —
   - **`runCapture` (single frame)** calls `cullElementsOutsideViewBox(tree, w, h)` with no animations — pure static cull pass, returns empty CSS, mutates `displayNone` only.
   - **`runAnimate` (multi-frame)** computes `frameStartMs` and `totalDurationMs`, calls `cullElementsOutsideViewBox(tree, w, h, resolvedAnimations, frameStartMs, totalDurationMs)` BEFORE `elementTreeToSvg`. The keyframes CSS is forwarded to the animator via `AnimationFrame.cullCss`.
5. **Unit tests** in `src/tree-ops/viewbox-culling.test.ts` (18 tests) — static intersection, enter-during-animation, exit-during-animation, fully-inside, never-visible, path-crosses-during-anim, translateX axis, non-translate property (no bbox shift), tree walk with mixed visibility, coalescing, child-anim-overrides-parent-anim, keyframes structure (step-end timing, `var(--scene-dur)`).

## Algorithm details

### Static intersection

`bboxIntersectsViewport(bbox, vw, vh) = bbox.x < vw && bbox.x + bbox.w > 0 && bbox.y < vh && bbox.y + bbox.h > 0`.

### Translate parsing

`translateFromAnimValue(prop, value)` extracts an `(tx, ty)` pixel offset from the animation's `from`/`to` string. Supports `<n>px`, plain `<n>`, the named functions `translate(...)`, `translateX(...)`, `translateY(...)`. Non-translate properties (`width`, `height`, `opacity`, `clipPath`) return `null` so the analyzer treats them as no-ops on the bbox.

### Easing

`evalEasing(easing, t)` returns the eased progress in `[0, 1]`. Recognised: `linear` (default), `step-start`, `step-end`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, `cubic-bezier(a, b, c, d)`. The bezier inversion uses 16 rounds of bisection — overkill for this use, fine for the cost.

### Per-element decision

For a given static bbox + animation context:

1. If no animation context: static intersection only.
2. Otherwise, compute bbox at `from` and `to`. If both intersect: always visible.
3. If both miss AND no sample in `(0, 1)` (50 samples, eased) intersects: always hidden → `displayNone`.
4. Otherwise compute the visible scene-cycle window:
   - `visStart = fromVisible ? 0 : animStartPct` (hide-before iff from-state is off-viewBox)
   - `visEnd = toVisible ? 100 : animEndPct` (hide-after iff to-state is off-viewBox)
   - If `visStart <= 0 && visEnd >= 100`: always visible. Else emit a cull class.

This implements the DM-599 feedback rule literally: never hide during an animation that crosses the boundary; hide only before (if from is off-viewBox) or after (if to is off-viewBox).

### Inherited animation

When recursing into children, the inherited animation context is the nearest ancestor's animation (or `null` at the root). A child's own `animId` overrides the inherited context — the same way CSS transforms on a child don't compose with the parent's keyframe transform unless explicitly added. Each element gets its decision based on its own static bbox + the effective animation at its level.

## Follow-ups (filed separately, if needed)

- **Geometric scroll between frames** — if/when we want the `scroll` transition to actually translate (it currently doesn't; out of scope per DM-603 feedback). The cull machinery here would extend trivially.
- **Container-level hide (vs leaf-level)** — if measurement shows leaf-level coalescing isn't enough.
- **Bbox-area threshold** — if profiling shows tiny elements dominate the keyframes-block count and matter for bundle size.
- **CSS-transform-aware static cull** — today the static bbox in `CapturedElement.{x,y,width,height}` is the post-author-transform bbox (capture freezes transforms before `getBoundingClientRect`). If we ever stop freezing, the cull would need to compose author transforms too.
