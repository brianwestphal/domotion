# 08 — Animation model: transitions, overlays, intra-frame motion

The animation pipeline composes multiple captured frames into a single SVG with CSS keyframe transitions between frames, optional per-frame overlays, and (with this doc's additions) intra-frame property animations and SVG overlays.

## Frame composition (existing behaviour)

A `generateAnimatedSvg` call takes a list of `AnimationFrame`s. Each frame has:

- `svgContent` — the SVG fragment from `elementTreeToSvg`.
- `duration` — ms held at full visibility.
- `transition` — how this frame transitions to the next.
- `overlays` — typing/tap effects layered on top during the frame's hold.

The composer emits one `<svg>` document with a `<style>` block of `@keyframes` driving each frame's visibility timeline. All-crossfade sequences take the merged-fast-path (one element per visual identity, with per-element step-end opacity timelines); other sequences fall back to the per-frame-atomic path.

## Transitions

| Type | Behaviour | Path |
|---|---|---|
| `crossfade` | Outgoing fades out while incoming fades in (windows overlap). | Merged fast path when all frames use it. |
| `push-left` | Outgoing slides off to the left, incoming slides in from the right. | Per-frame atomic. |
| `scroll` | Vertical scroll between frames; both stay visible during the transition. | Per-frame atomic. |
| `cut` | **New (DM-208).** Instant — no fade, no slide. `duration` ignored. | Merged fast path (subset of `crossfade` with `duration: 0`). |

`cut` is the right pick for any case where adjacent frames represent "the page was just updated" rather than "we're transitioning between two screens" — e.g. progress-bar resizing, a new line appearing in a terminal, a panel toggling. It's also cleaner than the 0-duration-crossfade hack we currently use in the install-demo.

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
| `property` | yes | One of `width`, `height`, `opacity`, `transform`, `translateX`, `translateY`, `clipPath`. |
| `from` / `to` | yes | CSS value strings (`"0%"`, `"240px"`, `"translateY(-200px)"`, etc). |
| `duration` | yes | Animation length in ms, scoped to this frame's hold time. Must be ≤ frame's `duration`. |
| `easing` | no | CSS easing string. Default `linear`. |
| `delay` | no | Ms after the frame becomes visible before the animation starts. Default `0`. |

### Implementation

1. **Capture-side**: when the user supplies `animations`, resolve `selector` against the live DOM during the capture pass. Tag matching elements with stable per-element IDs (e.g. `data-anim-id="a0"`). Those IDs survive into the `CapturedElement` tree and into the rendered SVG output (as a `class="anim-a0"` or similar).
2. **Render-side**: for each animation entry, emit a CSS `@keyframes` block targeting the tagged elements. The keyframe percentages map the animation's `delay` and `duration` against the global scene clock, gated by the frame's visibility window so the animation only runs when the frame is on screen.
3. **Easing**: pass through as `animation-timing-function`. The merged-fast-path's step-end timing applies only to per-frame visibility classes; intra-frame animations get their own classes with their own easing.

### Constraints

- `width` / `height` animations work for elements with explicit `width` / `height` declared in the source HTML. CSS-percentage values stay percentages; px values stay px.
- `transform` animations always go through `transform: <from>` → `transform: <to>` and stack with any captured `transform` on the element via a wrapper `<g>`.
- `clipPath` animations are the cleanest way to do a typing-style left-to-right reveal of captured text: tag the element with `data-domotion-anim="<id>"` in two consecutive frames, then animate `clipPath` from `inset(0 100% 0 0)` to `inset(0 0 0 0)` on the first frame. Because both frames render the same captured glyph paths (the merge fast-path dedupes them), there's no visual shift between the "typing" reveal and the "after typing" hold — they're literally the same paths under different clip windows. Prefer this over the procedural `kind: "typing"` overlay when the typed text needs to align pixel-perfect with subsequent captured frames.

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
