# 94 — Interaction-state capture (`:hover` / `:active` / `:focus`)

Status: **v1 shipped** (DM-1516) — explicit forced-pseudo-state capture. Of the
auto-detection directions in the second half, **Option 3's MutationObserver
harness is now partially shipped** (DM-1564 — JS-driven added/removed-node reveal
via the `jsReveal` field; the attribute/style property-tween is a follow-up). The
rest remain **design options** enumerated for a maintainer to pick from.

## The problem

Domotion's only pointer feedback so far is a synthetic ring/cursor overlay drawn
*on top of* the captured paint. But real sites change their own appearance on
interaction — a button darkens on `:hover`, a field gets a focus ring on
`:focus`, a card lifts via `.card:has(.cta:hover)`, JS toggles a class on
`mouseover`. That native feedback is what makes an interaction demo read as
*real*. We want to capture it, not fake it.

Two halves, mirroring the ticket:

- **(b) Explicit manual simulation — BUILT.** The author tells a frame to enter a
  state ("hover this button") and Domotion captures the page's *real* styling for
  that state. This also sets up the future no-DOM (PDF) input path, where the
  "state" is authored rather than detected.
- **(a) Auto-detection — DESIGNED, not built.** Detect what a page *itself*
  changes around a pointer event and synthesize the transition automatically. The
  options are enumerated below with tradeoffs.

## v1 — forced pseudo-state capture (BUILT)

### Authoring shape

A per-frame `forceState` array on the `animate` config
(`docs/43-declarative-animate-config.md` §10):

```jsonc
{
  "width": 460, "height": 320,
  "cursor": { "events": [
    { "frame": 0, "at": 200, "type": "move", "to": { "x": 230, "y": 120 } },
    { "frame": 1, "at": 0, "type": "move", "selector": ".cta" }
  ] },
  "frames": [
    { "input": "./pricing-card.html", "duration": 1400,
      "transition": { "type": "crossfade", "duration": 400 } },
    { "continue": true, "duration": 1800,
      "forceState": [ { "selector": ".cta", "states": ["hover"] } ] }
  ]
}
```

- `selector` — forced on **every** matched element; throws if it matches nothing
  (same fail-fast as an action selector).
- `states` — a non-empty list from `hover` / `active` / `focus` /
  `focus-within` / `focus-visible` / `visited` / `target` / `enabled` /
  `disabled` / `checked` / `indeterminate` / `read-only` / `read-write` / `link`
  (the well-supported subset of CDP's `forcedPseudoClasses`).

The runnable example is `examples/animate/hover-state/`. Frame 1 is a `continue`
frame that forces `.cta:hover` and cross-fades from the rest frame; the cursor
moves onto the button so the pointer sits where the hover is happening.

### Why a per-frame field (not an action)

`forceState` is a **capture-time state modifier**, not a sequential DOM mutation.
It doesn't fit the `runActions` model (which drives Playwright DOM operations in
order); it operates one level down, at the CDP layer, and its whole point is to
be in effect *at the moment of capture*. A declarative per-frame field expresses
that precisely, and combines naturally with the existing cursor/ring so the
pointer sits on the hovered element. (An `action` variant that forces-then-marks
a frame was considered and rejected for v1 — it would duplicate the field's job
with worse ergonomics.)

### Mechanism — CDP `CSS.forcePseudoState`

The clean way to make a page enter `:hover` *without* moving a real mouse (which
is fragile — any later pointer move or layout shift drops it, and it can't hold
`:active`/`:focus` cleanly) is the Chrome DevTools Protocol. Via a Playwright CDP
session:

1. `page.context().newCDPSession(page)`
2. `CSS.enable` + `DOM.enable`
3. `DOM.getDocument({ depth: -1 })` → the document root node
4. `DOM.querySelectorAll({ nodeId: root, selector })` → the matched node ids
5. `CSS.forcePseudoState({ nodeId, forcedPseudoClasses: states })` per node

Then the **normal** capture runs. Because forcing a pseudo-state makes Chromium
re-resolve style, the capture's `getComputedStyle` reads (and the paint they
drive) reflect the page's real interaction rules — including cascade siblings
like `.card:has(.cta:hover)`. No authoring on top of the page's own CSS.

The imperative primitive is exported from the package root:

```ts
import { applyForcedPseudoStates } from "domotion-svg";
await applyForcedPseudoStates(page, [{ selector: ".cta", states: ["hover"] }]);
// …then captureElementTree(page, …) paints the forced styling.
```

so a scripting-API caller can force state before its own `captureElementTree`,
not just via the declarative config (the `docs/63` "expose the per-feature
primitive" pattern).

### The one non-obvious invariant — don't detach the session

A `CSS.forcePseudoState` override lives for the **lifetime of the CDP session
that set it**. Detaching the session (or disabling the CSS domain) clears the
override *immediately*. So the session must stay attached until **after** the
capture that's supposed to record the forced paint — otherwise the hover vanishes
between the CDP call and the capture, and the frame silently paints the rest
state. `applyForcedPseudoStates` therefore leaves its session attached (reclaimed
when the page/context closes); `src/cli/force-state.test.ts` pins this as a
regression guard (it was a real bug found in review — the first cut detached in a
`finally` and captured the rest color).

### Fallback if CDP were unavailable

CDP `forcePseudoState` was verified working from Playwright-Chromium before it
was adopted. If it hadn't been, the fallback is a `page.evaluate` class/attribute
application — add an author-provided `is-hover` class (or set an attribute) whose
CSS the page (or the author) defines — surfaced as an `applyState` action. That's
strictly worse (it needs the page to author a matching class, so it can't trigger
the page's *own* `:hover` rules with zero setup), which is why forced pseudo-state
is preferred. It remains the documented degradation path.

### Verification

Proven by rasterizing the **rendered SVG** (not live HTML): the forced-hover
frame's captured SVG carries the page's hover color (`#2ea043` →
`rgb(46,160,67)`) where the rest frame carries the base color (`#238636` →
`rgb(35,134,54)`), and the `.card:has(.cta:hover)` blue border appears only in
the hover frame. Guarded by:

- `src/cli/force-state.test.ts` — schema validation + `applyForcedPseudoStates`
  control flow against a fake CDP session (fan-out to all matches, no-match
  throw, no-detach invariant).
- `src/cli/force-state.e2e.test.ts` — real-Chromium round-trip: force → capture →
  assert the hover color (and the `:has()` cascade sibling) is in the SVG, and
  the full `composeAnimateConfig` path captures a forced-hover `continue` frame.
- `tests/animate-examples.tsx` (`hover-state`) — the committed golden's frame 1
  contains the hover color and frame 0 does not.

## (a) Auto-detection options — DESIGNED, not built

The v1 above is *explicit*: the author names the element and the state. The
richer ask is to **auto-detect** what a page changes around a pointer event and
synthesize the transition. Four directions, with tradeoffs. The binding
constraint throughout: **output animation is cross-engine `@keyframes` only**
(plays inside `<img>`, no JS/SMIL, never animated CSS `filter`, rests at
identity — `docs/84`). So "auto-detect a change" always reduces to "produce two
(or more) captured states and a keyframe transition between them."

### Option 1 — Two-frame rest→forced-hover cross-fade (cheapest; a thin sugar over v1)

Capture the element at rest and again with `forceState` hover, then cross-fade.
This is essentially what the `hover-state` example does by hand; the sugar would
be a single `hoverReveal: { selector }` that expands to the two frames + cursor
move.

- **Pros:** trivial; entirely built on shipped primitives; cross-engine by
  construction (crossfade is opacity-only).
- **Cons:** no *detection* — the author still names the element. Doesn't discover
  JS-driven changes. A dissolve, not a physical transition (no travel/scale of
  the thing that actually moved).
- **Composes with `@keyframes`:** yes, natively.
- **Recommendation:** ship as ergonomic sugar; it's the 80% case.

### Option 2 — Drive a real pointer, diff computed styles, synthesize the transition

`page.hover()` / `mouse.move()` onto the element, then diff `getComputedStyle`
(and geometry) **before vs after** across the subtree. From the diff, emit an
intra-frame animation for the properties that actually changed (background,
transform, box-shadow-as-ring, border-color…), so the change *animates* rather
than dissolves.

- **Pros:** real *detection* — catches CSS-transition-driven changes the page
  defines, and produces a property-accurate transition (the button's real
  color/scale track). Reuses the existing intra-frame `animations` emitter.
- **Cons:** meaningfully more complex. Must map arbitrary computed-style deltas to
  the animatable-property vocabulary and decide easing/duration (read the page's
  own `transition-*`?). `box-shadow`/`filter` deltas don't map cleanly to the
  cross-engine keyframe set (no animated `filter`) — those degrade to a
  crossfade of that layer. Geometry diffs can be noisy (sub-px reflow).
- **Composes with `@keyframes`:** partially — transform/opacity/color/clip
  deltas map to keyframes; shadow/filter deltas fall back to opacity crossfade of
  the affected element.
- **Recommendation:** the highest-value *detection* option; scope it to a
  property allow-list that maps cleanly to keyframes, crossfade the rest.

### Option 3 — MutationObserver + style-diff harness around dispatched pointer events

**Status: partially shipped (DM-1564)** — the MutationObserver harness + the
added/removed-node crossfade path are built (see "v2 — the `jsReveal`
MutationObserver harness" below); the attribute/style **property tween** for
surviving nodes is the remaining follow-up (it reuses Option 2's computed-style-
diff engine).

For **JS-driven** feedback (a framework toggling a class / injecting a tooltip /
swapping text on `mouseover`/`mousedown`), install a `MutationObserver` (+ a
style-diff sweep) around a *dispatched* pointer event sequence, capture the
before and after DOM/paint, and synthesize the transition from the recorded
mutations.

- **Pros:** the only option that catches changes CSS-state forcing can't — actual
  DOM mutations from the page's own JS (added nodes, text swaps, class flips).
  Directly serves the "via JS on `mouseover`/`mousedown`" part of the ticket.
- **Cons:** the most complex and least deterministic. Requires settling async JS,
  debouncing observer noise, and deciding which mutations are "the feedback" vs
  incidental. Added nodes (a tooltip) are a fresh capture → crossfade-in, not a
  property tween.
- **Composes with `@keyframes`:** as add/remove → crossfade (like magic-move's
  `mmf-` add/remove path) plus property tweens for surviving nodes. Never needs
  JS in the output.
- **Recommendation:** a later, opt-in mode; pair with Option 2 (CSS diff) so one
  pass covers both CSS- and JS-driven feedback.

#### v2 — the `jsReveal` MutationObserver harness (shipped, DM-1564)

The per-frame `jsReveal` field opts a frame into JS-feedback detection. It
dispatches a real pointer event at a target, watches the page's own DOM mutations
with a `MutationObserver`, waits for them to **settle** (a quiet debounce window,
capped by an overall timeout), and synthesizes the reveal:

```jsonc
{
  "input": "./menu.html",
  "duration": 2000,
  "cursor": { "events": [ { "frame": 0, "at": 200, "type": "move", "selector": "#account" } ] },
  "jsReveal": {
    "selector": "#account",   // dispatch the event here
    "event": "mouseover",     // mouse*/pointer*/click; default mouseover
    "settleMs": 600,          // max wait for the JS to settle
    "debounceMs": 120,        // quiet window that counts as "settled"
    "holdMs": 700,            // rest hold + after hold
    "crossfadeMs": 300        // the rest→after crossfade
  }
}
```

**What it captures.** In `examples/animate/js-reveal/`, hovering an "Account"
button runs a JS handler that **injects a dropdown menu** (+1 DOM node) and sets
`aria-expanded="true"` (which the page's own CSS then styles). The harness
observes `+1 node, 1 attr`, waits for the settle, re-captures, and cross-fades
rest→after. None of that is reachable via `forceState`: there is no CSS
pseudo-state to force — the feedback is a script mutating the DOM.

**Mechanism — nest, don't extend the animator.** Exactly like `typeResample`
(docs/93 §2) and `cast` frames: the rest + after captures become a 2-frame
in-memory `AnimationConfig` (rest → crossfade → after) that `generateAnimatedSvg`
composes into one self-contained SVG, namespaced (`jr<i>_`) and dropped in as the
single outer frame's `svgContent` with `embeddedAnimationPeriodMs`. One outer
animation frame per config frame — the 1:1 invariant holds — and **no animator
change**. When the observer sees no mutation, the frame emits just the rest state
(a still frame): there was no feedback, so it doesn't invent one.

**What's deferred (follow-up).** Attribute-/style-only deltas (a class flip that
only recolors a surviving node, an aria change with no visual paint) currently
ride the same rest→after crossfade — they *dissolve* rather than *tween*. Routing
those through a **property-accurate computed-style-diff tween** is Option 2's
engine; when that lands, `jsReveal` should classify surviving-node attribute
deltas onto the tween and keep the crossfade only for added/removed nodes. The
`MutationSummary` already distinguishes `structural` (added/removed) from
attribute/character-data changes, so the split point exists.

- `src/cli/mutation-detect.ts` — `detectJsMutations` (the observer + dispatch +
  settle) and `buildJsRevealAnimation` (the crossfade compositor), wired into
  `composeAnimateFrames` via the per-frame `jsReveal` field in `src/cli/animate.ts`.
- Tests: `src/cli/mutation-detect.test.ts` (pure defaulting),
  `src/cli/mutation-detect.e2e.test.ts` (real-Chromium: injected node + aria
  detected, no-op times out, no-match throws, config path nests the crossfade),
  and the `js-reveal` entry in `tests/animate-examples.tsx` (committed golden).

### Option 4 — Overlay-only fake for no-DOM / PDF inputs

When there is **no DOM** (a PDF or image input — the future direction the ticket
flags), auto-detection is impossible; the author *declares* the feedback as a
synthetic overlay (a translucent hover fill / focus ring / press-darken rect over
a named region). This is the manual-simulation path generalized to inputs that
can't be forced.

- **Pros:** the only option that works with no DOM; fully deterministic; reuses
  the overlay system.
- **Cons:** purely synthetic — it does not reflect any real styling (there is
  none to reflect). Author must position/style the fake by hand.
- **Composes with `@keyframes`:** yes — it's an overlay with an opacity/transform
  keyframe, same as `tap`/`blink`/`shine`.
- **Recommendation:** build alongside the no-DOM (PDF) input work, not before —
  it has no consumer until then.

### How they relate

v1 (forced pseudo-state) is the foundation Options 1–2 build on (both need a way
to *enter* the state to capture it). Option 2 is the natural next step for CSS
feedback; Option 3 extends detection to JS feedback; Option 4 is the no-DOM
degenerate case for a different input pipeline entirely. None require anything in
the output beyond the existing cross-engine `@keyframes` vocabulary.

## Related

- `docs/43-declarative-animate-config.md` §10 — the `forceState` field surface.
- `docs/63-cursor-action-primitives.md` — the imperative-primitive pattern
  `applyForcedPseudoStates` follows, and the cursor overlay it pairs with.
- `docs/13-cursor-overlay.md` — the pointer overlay placed on the hovered element.
- `docs/84-viewer-browser-support.md` — the cross-engine `@keyframes`-only output
  constraint every auto-detection option must satisfy.
- `examples/animate/hover-state/` — the runnable v1 (forceState) demo + golden.
- `examples/animate/js-reveal/` — the runnable Option-3 (`jsReveal`) demo: a JS
  dropdown injected on `mouseover`, detected + cross-faded in. + committed golden.
- `src/cli/mutation-detect.ts` — the `jsReveal` MutationObserver harness
  (`detectJsMutations` / `buildJsRevealAnimation`).
