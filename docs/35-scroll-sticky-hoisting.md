# 35. Scroll composer: position:sticky hoisting

The `--scroll` capture flow (`src/scroll/{executor,composer}.ts`) renders the page at multiple scrollY positions and stacks the captures inside a translating composite. The composer hoists `position: fixed` subtrees onto a viewport-level overlay (doc 33-like fold; the actual code lives in `src/scroll/hoist-fixed.ts` per DM-643) so a site header captured at viewport-y = 0 in every segment renders once, on top, in viewport coordinates — instead of being smeared down the composite once per segment.

`position: sticky` doesn't fit cleanly into either bucket. A sticky element starts as an in-flow item that scrolls with its container; once scrolling crosses the container's stick-edge it pins to the viewport like a fixed element. So in a multi-segment scroll capture, the *same* element should:

- Scroll inline (stay inside the per-segment tree, at its in-flow `(x, y)`) during the segments where it hasn't yet hit its stick-point.
- Hoist to the viewport overlay during the segments where it's pinned.
- Switch back to inline if the stuck window ends mid-scroll (the container's bottom passed under the viewport top — the element "un-sticks" as the container scrolls out from under it).

This doc captures the requirements for that two-phase rendering.

## Inputs

- `ScrollSegmentCapture[]` from `src/scroll/executor.ts` — one entry per scroll-Y captured. Each `tree: CapturedElement[]` is the live page's element tree at that moment, with full computed styles including `styles.position` ∈ `{static, relative, absolute, fixed, sticky}`.
- The viewport dimensions `(viewportW, viewportH)`.
- The current DM-643 fixed-element hoisting is the baseline — sticky-handling is additive and must not disturb it.

## Identifying sticky candidates

Walk each capture's tree and collect every element whose `styles.position === "sticky"`. These are the candidates.

A sticky element's captured `(x, y, width, height)` is its viewport-relative bounding box at that scrollY, so:

- During its in-flow phase: `y` decreases (in viewport coordinates) as the user scrolls down — the element scrolls up with the rest of the content.
- During its stuck phase: `y` is constant — usually equal to the CSS `top` value (Chromium reports the actual painted position).
- After the stuck window ends (container's bottom passed under viewport top): `y` resumes decreasing.

## Cross-segment identity

A sticky element appears in *multiple* segment captures. To stitch them together as one logical element we need a key that survives the in-flow → stuck transition. Specifically `y` (and possibly `x`) will move; everything else should be stable.

**Identity key**: `(tag, rounded(width), rounded(height), structural-path)` — the element's tag, its layout box size (sticky elements rarely change size at the stick-edge), and its position in the DOM tree (index-of-child at each ancestor up to body). The path-in-tree is captured at walk time by `src/capture/script/walker/index.ts` and is the most direct stable identifier we have.

Alternative considered: `(tag, rounded(x), rounded(width), rounded(height))` — drop `y` to allow vertical motion, keep `x` since horizontal position doesn't change. This works for most sites but breaks when the sticky element ALSO moves horizontally (e.g., a left-floated note bar that snaps to viewport top with a slight horizontal nudge). Path-in-tree is more robust.

## Detecting stuck windows

For each sticky candidate matched across N segments:

1. Read its viewport-y in every segment it appears in: `ys = [y₀, y₁, …, y_{N-1}]`.
2. Find runs of consecutive segments where `|ys[i+1] − ys[i]| < ε` (say `ε = 1 px`) — those are "stuck windows". A stuck window of length 1 (a single segment with one neighbour) is *not* stuck (the element happens to have momentarily zero motion between two snapshot moments); require at least 2 consecutive segments at the same `y` to call it stuck.

Other constraints for a window to qualify as a stuck window:

- The element's `y` matches its CSS `top` (or the offset implied by its `top` + container's content edge). We can read this off the captured styles cheaply if needed; the empirical "same y across N consecutive snapshots" criterion is sufficient in practice and avoids re-doing Chromium's sticky-edge math.

## Rendering

For each sticky element with one or more stuck windows:

**Inline (in-flow) segments** — segments NOT inside a stuck window:
- Element stays in the per-segment captured tree as today. The composer renders it at its captured viewport-y, which the composite-translate carries into the right composite-y slot. No change from baseline.

**Stuck-window segments**:
- Strip the element from those segments' captured trees (so the in-flow phase doesn't double-paint).
- Emit ONE rendered copy of the element on the viewport overlay, positioned at the viewport-y from the stuck window.
- Attach a visibility timeline class to that overlay copy: `visibility: visible` during the stuck-window segments, `visibility: hidden` outside (uses the same `visibility`-toggle approach as DM-641 — never `display: none`).

**Multiple stuck windows for one element**:
- Each window contributes an overlay group with its own visibility timeline. A sticky element that re-sticks twice (rare but possible — two containers in sequence both have sticky descendants of the same type) emits two overlay groups.

**z-order**:
- The sticky overlay sits on top of the scrolling composite (same place the DM-643 fixed overlay sits), so it paints over scrolling content while it's stuck. This matches how Chromium composites the live page.

## Interaction with the DM-643 fixed overlay

- A pure `position: fixed` element flows through `src/scroll/hoist-fixed.ts` unchanged.
- A `position: sticky` element flows through the new sticky-handling path. If it's stuck for ALL segments (the element is `top: 0` in a container that begins above the viewport), the stuck-window math degenerates to "every segment" and the rendered output is equivalent to the fixed case (one overlay copy, always visible).
- Both overlays live in the same `<g>` block after the scrolling composite. Their relative order matches the document order at the first segment.

## Capture-side requirements

Path-in-tree identity needs to be carried on `CapturedElement`. Either:

1. Add a `path?: number[]` field at capture time. Cheap (index-per-level walk).
2. Compute on-the-fly inside the composer by walking each tree in pre-order and remembering the path. Avoids touching the capture types but means walking each tree twice per compose pass.

Option 2 is preferred — keeps `CapturedElement` lean and doesn't bake a new field into the serialised tree. Implementation lives in `src/scroll/hoist-sticky.ts` alongside the existing hoist-fixed module.

## Acceptance criteria

Carried forward from DM-645:

- A page whose nav switches from in-flow to sticky-stuck mid-scroll renders both phases correctly in the animated SVG (visual inspection on a real fixture).
- Pure-`fixed` elements continue to render as DM-643 set up (regression test).
- Unit tests in `src/scroll/hoist-sticky.test.ts` cover:
  - **Never stuck** — sticky candidate whose captured `y` strictly decreases across all segments. Element is left inline, no overlay emitted.
  - **Always stuck** — sticky candidate whose captured `y` is constant in every segment. Element is stripped from every segment and emitted once on the overlay.
  - **Stuck mid-scroll** — sticky candidate whose `y` decreases for the first K segments then stays constant for the rest. Element renders inline for the first K segments, on overlay for the rest, with the overlay's visibility timeline gated to those segments.
  - **Two stuck windows** — sticky candidate that sticks, un-sticks, then sticks again. Two overlay groups, each with its own visibility window.

## Out of scope / follow-ups

- **Horizontal sticky** (`left`/`right` sticky in horizontal scrolls). Handled by the same machinery on the x-axis; the executor's `axis === "x"` mode triggers an `xs` array instead of `ys`. Defer until we have a real horizontal fixture.
- **Sticky inside a transformed/scrollable ancestor** (a sticky element inside an `overflow: scroll` panel that itself scrolls inside the page). Chromium composites these inside their ancestor's scroll context; the element's captured viewport-y won't match the page-scroll behavior. This requires walking the captured ancestor scroll containers, which the executor doesn't track today.
- **Crossfading the in-flow → stuck transition**. The current proposal is a hard cut at the segment boundary between phases. If the boundary lands awkwardly mid-stick-edge in the live page, the consumer may see a 1-frame jump. A short visibility crossfade between adjacent segments would smooth this; can be layered on later.
