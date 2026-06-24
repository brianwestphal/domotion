# 08 — Animation model: transitions, overlays, intra-frame motion

The animation pipeline composes multiple captured frames into a single SVG with CSS keyframe transitions between frames, optional per-frame overlays, and (with this doc's additions) intra-frame property animations and SVG overlays.

> **Runnable examples.** `examples/animate/` has one self-contained config per feature in this doc — crossfade, `cut` + typing overlay + intra-frame progress fill, `push-left`, a `scroll` block, and a `kind: "svg"` overlay — each with a committed golden SVG you can open. They double as a regression suite (`npm run demos:test:animate`). See `examples/animate/README.md`.

> **Config validation.** The `domotion animate` JSON config is validated against a zod schema (`animateConfigSchema` in `src/cli/animate.ts`) — that schema is the source of truth for the config shape. Invalid configs fail with a path-specific message, e.g. `animate: frames[0].duration: Invalid input: expected number, received string`.

> **Planned expansion (design).** `docs/43-declarative-animate-config.md` specs a declarative expansion of this config — continuous-session frames (stateful multi-step capture), DOM-mutation / interaction actions, richer readiness waits, selector-anchored overlays, a config-level cursor, `vars` + `${}` interpolation, and a small `evaluate` escape hatch — so interaction demos rarely need the programmatic API. `docs/44-repeating-animations.md` specs repeating animations — `repeat`/`alternate` on intra-frame animations, a blinking typing caret, and a `blink` overlay. Design only; not all implemented yet.

## Frame composition (existing behavior)

A `generateAnimatedSvg` call takes a list of `AnimationFrame`s. Each frame has:

- `svgContent` — the SVG fragment from `elementTreeToSvg`.
- `duration` — ms held at full visibility.
- `transition` — how this frame transitions to the next.
- `overlays` — typing/tap effects layered on top during the frame's hold.

The composer emits one `<svg>` document with a `<style>` block of `@keyframes` driving each frame's timeline. Routing by transition:

- **crossfade** (and the default) **composites** — each frame is emitted as a complete, independently z-ordered `<g class="f f-N">` sub-SVG and the frames cross-dissolve via interpolated opacity. This is what a crossfade *is*: two fully-realized scenes fading into each other. It deliberately does **not** flatten the frames into one tree (doing so loses per-frame stacking — a later frame's full-bleed background could occlude its own foreground — and degrades the fade into a step-end switch).
- **push-left / scroll** use the same per-frame `<g>` groups plus a transform timeline (`translateX` / `translateY`) so the outgoing frame slides off while the incoming one slides in.
- **cut** composites the same way, with a step-end `fv-${i}` opacity timeline so frames swap instantly (no fade). It does **not** merge.

> **History.** There used to be an element-merge fast path (`mergeFrames`) that flattened cut/crossfade sequences into one de-duplicated tree to save bytes. It was removed: DM-854 (it dropped per-frame z-order and step-end-switched crossfades instead of fading) and DM-865 (it mis-rendered *near-identical* frames — the same DOM evolved, as continuous-session capture produces — because differing text in a shared element slot can't be gated per frame). Recovering the size win as `<defs>`/symbol-level glyph sharing across intact frame groups (which preserves each frame's layout) is future work. The `mergeFrames` fast path has since been removed entirely — every sequence now composites by z-ordering its per-frame `<g class="f f-N">` groups (see the history note in `src/animation/animator.ts`); there is no longer a merge module to call.

## Out-of-frame paint suppression (DM-599)

Frames not currently in their show window are dropped from paint via `display: none` keyframes that run in parallel with the existing opacity timeline. Always-on; no opt-in required.

- Each frame `i` gets a paired `fd-${i}` keyframes block that toggles `visibility` between `visible` and `hidden` at the visibility boundaries, applied to `.f-${i}` alongside the `fv-${i}` opacity animation. The `fd-${i}` animation always uses `step-end` timing so the flip is instant, regardless of how `fv-${i}` is timed (linear for crossfade tails, step-end for cut). For `cut` frames the toggle is folded directly into `fv-${i}` since both properties already snap together. The base `.f { display: none; }` rule means frames start hidden until the keyframe flips them in. (DM-641: the parallel toggle moved from `display` to `visibility` — animating away from a `display: none` start never ticks in Chromium.)
- **Scroll fade tail**: the visible window is extended through the 200 ms fade-out tail (`fadeEndPct`, not `transEndPct`) so the element stays `display: inline` while `opacity` interpolates from 1 to 0 — otherwise the discrete snap of `display: none` at 50% of the fade segment would visually clip the tail.

The CSS spec interpolates discrete properties by snapping at 50% of a segment by default. We sidestep that with `step-end` timing on the parallel `fd-${i}` animation, which yields an instant flip at the desired boundary.

**What this doesn't cover yet** (tracked separately):
- **Element-level intersection inside a frame's hold time** (long-scroll captures where most rows are off-viewBox at any instant). Requires per-element bbox analysis at SVG-string composition time.
- **Intra-frame animations** (`animations: [...]` declarations) whose `from`/`to` keep elements outside the viewBox. The rule: hide before / after the animation only, never during it (per DM-599 feedback). Requires bbox + transform analysis on the animated element.

## Transitions

| Type | Behavior | Path |
|---|---|---|
| `crossfade` | Outgoing fades out while incoming fades in (windows overlap). | Composited (per-frame `<g class="f f-N">`). |
| `push-left` | Outgoing slides off to the left, incoming slides in from the right. | Composited + transform. |
| `scroll` | Vertical scroll between frames; both stay visible during the transition. | Composited + transform. |
| `cut` | **New (DM-208).** Instant — no fade, no slide. `duration` ignored. | Composited (step-end `fv-N`). |
| `magic-move` | **New (DM-898).** Elements shared between the two frames slide from their old position to their new one; added/removed elements cross-fade. Keynote "Magic Move". | Composited prev/next blobs (hard-cut at the window edges) + a bridge composite over the window. See `docs/53-magic-move-transition.md`. |

`cut` is the right pick for any case where adjacent frames represent "the page was just updated" rather than "we're transitioning between two screens" — e.g. progress-bar resizing, a new line appearing in a terminal, a panel toggling. It's also cleaner than the 0-duration-crossfade hack we currently use in the install-demo.

`magic-move` is for "the same scene rearranged" — a card that grows, a list item that relocates, a logo that moves between slides. It diffs the two frames' captured element trees (`diffTrees`), then over the transition window slides the matched elements and cross-fades the rest. It needs both frames' element trees (the CLI has them); a magic-move frame without a built bridge layer degrades to `crossfade`. v1 (DM-898) is translate-only — size/style morph (DM-899), `data-magic-key` author pairing (DM-900), and reduced-motion / nesting hardening (DM-901) are the remaining phases. Full contract: `docs/53-magic-move-transition.md`.

## Intra-frame property animations (DM-209)

Some animations belong INSIDE a frame, not between frames: a progress bar filling, a panel scrolling, an overlay sliding in. These can't be expressed with frame-level transitions because the change is a property change on a single static capture.

### Surface

Per-frame `animations` array:

```json
{
  "animations": [
    {
      "selector": ".progress",
      "property": "width",
      "from": "0%",
      "to": "100%",
      "duration": 2000,
      "easing": "ease-out",
      "delay": 150
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `selector` | yes | CSS selector matching one or more elements in the frame's captured tree. Resolved at capture time, not at render time — so the selector is against the source HTML, not the SVG output. |
| `property` | yes | One of `width`, `height`, `opacity`, `transform`, `translateX`, `translateY`, `scale`, `clipPath`. `scale` desugars to `transform: scale(<from→to>)` (a unitless factor). |
| `from` / `to` | yes | CSS value strings (`"0%"`, `"240px"`, `"translateY(-200px)"`, `"0.6"` for `scale`, etc). |
| `duration` | yes | Animation length in ms, scoped to this frame's hold time. Must be ≤ frame's `duration`. |
| `easing` | no | CSS easing string. Default `linear`. |
| `delay` | no | Ms after the frame becomes visible before the animation starts. Default `0`. |
| `transformOrigin` | no | DM-1297. For a `transform` / `scale` / `translate*` animation, the origin the transform resolves about (`"center"`, `"50% 50%"`, `"left top"`, …). SVG transforms are origin-(0,0) by default, so a `scale`/`rotate` would shrink/orbit toward the SVG origin; setting this emits `transform-box: fill-box; transform-origin: <value>` on the animated group so the transform pivots about the element's OWN bounding box (e.g. a center-origin scale-pop). Ignored for non-transform properties. |

### Implementation

1. **Capture-side**: when the user supplies `animations`, resolve `selector` against the live DOM during the capture pass. Tag matching elements with stable per-element IDs (e.g. `data-anim-id="a0"`). Those IDs survive into the `CapturedElement` tree and into the rendered SVG output (as a `class="anim-a0"` or similar).
2. **Render-side**: for each animation entry, emit a CSS `@keyframes` block targeting the tagged elements. The keyframe percentages map the animation's `delay` and `duration` against the global scene clock, gated by the frame's visibility window so the animation only runs when the frame is on screen.
3. **Easing**: pass through as `animation-timing-function`. The merged-fast-path's step-end timing applies only to per-frame visibility classes; intra-frame animations get their own classes with their own easing.

### Constraints

- `width` / `height` animations work for elements with explicit `width` / `height` declared in the source HTML. CSS-percentage values stay percentages; px values stay px.
- `transform` animations always go through `transform: <from>` → `transform: <to>` and stack with any captured `transform` on the element via a wrapper `<g>`.
- `clipPath` animations are the cleanest way to do a typing-style left-to-right reveal of captured text: tag the element with `data-domotion-anim="<id>"` in two consecutive frames, then animate `clipPath` from `inset(0 100% 0 0)` to `inset(0 0 0 0)` on the first frame. Because both frames render the same captured glyph paths at the same positions, there's no visual shift between the "typing" reveal and the "after typing" hold — they're literally the same paths under different clip windows. Prefer this over the procedural `kind: "typing"` overlay when the typed text needs to align pixel-perfect with subsequent captured frames.
- **The animation moves the element's WHOLE subtree.** The renderer treats an animated element (one carrying an `animId`) as a stacking-context root, so its descendants render nested inside the `class="anim-<id>"` wrapper and all animate together — even when those descendants are flex/grid items, which the paint-order flattening pass would otherwise hoist out to an ancestor (correct for static z-ordering, but it would drain the wrapper and leave only the element's own box animating). This mirrors CSS, where an animated `transform`/`opacity`/`filter` creates a stacking context. Practically: animating a flex container's `opacity` fades the whole panel, and sliding a flex item translates its text/icons with it. The lower-third built-in template (a panel that fades + slides as one unit) depends on this.

## Frame-local SVG overlays (DM-210)

Today's overlays are typing and tap effects rendered procedurally. A new kind composites a separately-captured SVG file into a frame:

```json
{
  "kind": "svg",
  "src": "./example.svg",
  "x": 50,
  "y": 100,
  "width": 280,
  "height": 580,
  "enter": { "from": "bottom", "duration": 400, "easing": "ease-out" },
  "animations": [...]
}
```

| Field | Meaning |
|---|---|
| `src` | Path to an SVG file. Inlined at composition time (NOT referenced as `<image href>`). Resolved relative to the config file's directory. |
| `x` / `y` | Top-left corner in the captured frame's coordinate space. |
| `width` / `height` | Render size. The embedded SVG's viewBox is preserved; it scales to fit. |
| `enter` | Optional. Sugar over `animations` for entrance — see DM-211. |
| `exit` | Optional. Same shape as `enter`. |
| `animations` | Optional. Same intra-frame animations as on the parent frame, but scoped to elements within the embedded SVG. |

Implementation notes:

- IDs in the embedded SVG are namespaced (e.g. `f3-ov0-` prefix) before inlining to avoid collisions with the host SVG's IDs.
- The overlay is wrapped in a `<g transform="translate(x y)">` with a clipPath at `width × height`.
- Overlay visibility tracks the frame's visibility window unless overridden by `enter`/`exit`/`animations`.

### Composition order

Within a frame: captured DOM → SVG overlays (in the order declared) → typing/tap overlays. Layered front-to-back accordingly.

## Slide-in / slide-out entrance sugar (DM-211)

Most entrance animations are "translate from off-screen to in-place over N ms with ease-out". Sugar over the underlying intra-frame animation:

```json
{ "enter": { "from": "bottom", "duration": 400, "easing": "ease-out", "delay": 0 } }
```

`from`: `"top"` | `"bottom"` | `"left"` | `"right"`.

Desugars into:

```json
{
  "animations": [
    { "selector": "<this overlay>", "property": "translateY", "from": "<height-or-width>px", "to": "0px", "duration": 400, "easing": "ease-out", "delay": 0 }
  ]
}
```

(For `top`/`bottom` it's `translateY` with negative/positive offset; for `left`/`right` it's `translateX`.)

`exit` is the same shape; emits an animation that ends with the element off-screen at the end of the frame's hold time minus `duration`.

## Worked example: redesigned install-demo (DM-207)

Storyboard — combines all of the above:

1. Frame 1: terminal HTML, hold 0ms.
   - `overlays: [{ kind: "typing", text: "npm install domotion-svg", x: 28, y: 56, speed: 70 }]`
2. Frame 2: same terminal + the typed command baked in. Transition `cut`. Hold 150ms.
3. Frame 3: terminal + "resolving dependencies" line + empty progress bar. Transition `cut`. Hold 2000ms.
   - `animations: [{ selector: ".progress-fill", property: "width", from: "0%", to: "100%", duration: 2000, easing: "ease-out" }]`
4. Frame 4: terminal at end-state with package list. Transition `cut`. Hold 2000ms.
5. Frame 5: terminal + second prompt typed. Transition `cut`. Hold 0ms.
   - `overlays: [{ kind: "typing", text: "domotion capture https://example.com -o example.svg", x: 28, y: 88, speed: 70 }]`
6. Frame 6: terminal with capture-output lines, content scrolls so the latest line stays in view. Transition `cut`. Hold 3000ms.
   - `animations: [{ selector: ".terminal-content", property: "translateY", from: "0px", to: "-180px", duration: 1500, easing: "ease-out", delay: 1000 }]`
7. Frame 7: same terminal + a phone-framed `example.svg` overlay sliding in from the bottom.
   - Pre-captured: `domotion capture https://example.com --mobile --width 240 --height 180 -o build/example.svg` (consumer wraps in their own phone bezel)
   - `overlays: [{ kind: "svg", src: "./build/example.svg", x: 180, y: 0, width: 280, height: 580, enter: { from: "bottom", duration: 600, easing: "ease-out" } }]`

The captured HTML for frames 2–6 is hand-authored to match what each terminal state would actually look like; the animations live in the JSON config, not the HTML.
