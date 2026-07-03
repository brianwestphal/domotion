# 94 — Interaction-state capture (`:hover` / `:active` / `:focus`)

Status: **shipped** — explicit forced-pseudo-state capture (DM-1516), a
forced-state **reset** verb (DM-1566), and all four auto-detection options: the
**`hoverReveal`** sugar (Option 1, DM-1562), **`hoverDetect`** computed-style-diff
detection (Option 2, DM-1563), Option 3's **MutationObserver harness** (DM-1564 —
the `jsReveal` field synthesizes JS-driven mutations — a crossfade for
added/removed-node changes, and an in-place property **tween** for
attribute/style-only changes that move the target, DM-1580), and Option 4's
no-DOM/PDF **`interact` overlay** fake (DM-1565).

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
- `reset: true` (instead of `states`) — DM-1566: **DROP** any forced state a
  previous frame set on `selector`, capturing the element back at rest. The
  un-hover verb for a continuous-session (`continue`) flow: force `:hover` on one
  frame, then release it on a later frame so the demo returns to its resting
  paint. `states` and `reset` are mutually exclusive.

### Clearing a forced state (`reset`) — the same-session, one-root invariant (DM-1566)

A `CSS.forcePseudoState` override is cleared by re-issuing the call with an
**empty** class list — but ONLY when it targets the SAME CDP node id the force was
set on. Two things make that hold across a `continue`-frame flow, both verified
against Chromium:

1. **One session.** The override is per-session, so the reset must run on the same
   session that set it. `applyForcedPseudoStates` caches its CDP session per page
   (never detaching it) and reuses it for every frame.
2. **One document root.** Node ids are only stable within a single
   `DOM.getDocument` id space — calling `getDocument` again re-issues ids in a
   fresh space, and clearing a *fresh-space* id does **not** clear an override set
   on the *old-space* id, even for the same element. So the cached session fetches
   the document root **once** and reuses it for all `querySelectorAll` calls; a
   later re-query then returns the id the force was set on, and the clear lands.
   The root is invalidated on main-frame navigation (a reload frame gets a new
   document, which clears forced overrides anyway).

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

## (a) Auto-detection options

The v1 above is *explicit*: the author names the element and the state. The
richer ask is to **auto-detect** what a page changes around a pointer event and
synthesize the transition. Four directions, with tradeoffs — Options 1 and 2 are
now **BUILT**; Options 3 and 4 remain designed. The binding
constraint throughout: **output animation is cross-engine `@keyframes` only**
(plays inside `<img>`, no JS/SMIL, never animated CSS `filter`, rests at
identity — `docs/84`). So "auto-detect a change" always reduces to "produce two
(or more) captured states and a keyframe transition between them."

### Option 1 — `hoverReveal` sugar (BUILT — DM-1562)

A single per-frame field, `hoverReveal: { selector }`, that auto-expands (a pure
config → config pre-pass, `expandHoverReveal` in `src/cli/animate.ts`) into two
frames — the frame at REST, then a `continue` frame that forces `:hover` on the
same selector — with a crossfade between them and a cursor move onto the element.
It's the `hover-state` example, from one line instead of two hand-wired frames.

```jsonc
{ "width": 460, "height": 320, "frames": [
  { "input": "./card.html", "duration": 1400, "hoverReveal": { "selector": ".cta" } }
] }
```

Options: `states` (default `["hover"]` — e.g. `["focus","focus-visible"]` for a
focus reveal), `crossfadeMs` (default 400), `hoverMs` (default the frame's own
`duration`), and `cursor: false` to skip the injected pointer move. The frame's
own `transition` (if any) carries OUT of the reveal pair. Runnable example:
`examples/animate/hover-reveal/`.

- **Pros:** trivial; entirely built on shipped primitives; cross-engine by
  construction (crossfade is opacity-only).
- **Cons:** no *detection* — the author still names the element. A dissolve, not a
  physical transition. → that's what Option 2 adds.

### Option 2 — `hoverDetect` computed-style-diff detection (BUILT — DM-1563)

`hoverDetect: { selector }` on a frame that loads an `input`. A browser pre-pass
(`expandHoverDetect` in `src/cli/animate.ts`, backed by the pure
`src/cli/hover-detect.ts` diff/classify helpers) drives a real `:hover`, snapshots
`getComputedStyle` (+ geometry) on the target **and its descendants** before →
after, and picks a synthesis from an allow-list of properties (color / background
/ border / box-shadow / transform / opacity):

- **`paint` change** (any color / background / border / box-shadow delta, or a
  descendant change) → a rest→hover **crossfade**, which blends the deltas
  faithfully (box-shadow included). Same shape as `hoverReveal`, but auto-chosen.
- **`motion`-only change** (ONLY `transform` / `opacity` on the target, from a
  clean rest baseline — identity transform / opacity 1) → ONE frame with an
  intra-frame keyframe **tween** so the element animates *in place* (a real
  scale/lift, not a dissolve). Reuses the shipped intra-frame `animations` emitter.
- **no change detected** → the frame is kept rest-only, with a log line so the
  author can fix the selector or confirm the page has a `:hover` rule.

```jsonc
{ "width": 420, "height": 240, "frames": [
  { "input": "./button.html", "duration": 1600, "hoverDetect": { "selector": ".cta" } }
] }
```

Runnable example: `examples/animate/hover-detect/` (a pure-scale hover → motion
tween).

- **Pros:** real *detection* — no manual `forceState`; a property-accurate motion
  tween when the change is pure transform/opacity, a faithful crossfade otherwise.
- **Cons / scope:** color / background / border can't cross-engine-keyframe (the
  intra-frame emitter animates only transform/opacity/clip/geometry, and animated
  CSS `filter` is banned — docs/84), so those degrade to the crossfade rather than
  an in-place color tween. Motion mode is deliberately restricted to the target
  element with a clean identity baseline (a non-`none` rest transform would
  double-apply against the already-baked captured paint) — everything else falls
  back to the always-faithful crossfade. Added/removed nodes (a JS tooltip) are
  out of scope here — that's Option 3.

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

### Option 4 — Overlay-only fake for no-DOM / PDF inputs (BUILT — DM-1565)

When there is **no DOM** (a PDF or image input — the future direction the ticket
flags), auto-detection is impossible; the author *declares* the feedback as a
synthetic overlay (a translucent hover fill / focus ring / press-darken rect over
a named region). This is the manual-simulation path generalized to inputs that
can't be forced. Built as the **`interact` overlay** (`kind: "interact"`) — it has
no PDF consumer yet, but it works standalone on ANY region today, so it also does
duty as a plain synthetic hover/focus/press treatment on a captured demo.

```jsonc
{
  "kind": "interact",
  "treatment": "hover",   // "hover" | "focus" | "press"
  "x": 60, "y": 50, "width": 140, "height": 40,  // the region the treatment covers
  "radius": 8,            // corner radius of the fill + ring
  "delay": 200,           // ms from frame start to the appear (default 200)
  "duration": 260,        // fade / pop-in time in ms (default 240)
  // optional overrides — all defaulted per treatment:
  "fill": "#ffffff", "fillOpacity": 0.18,  // "none" omits the fill
  "ring": "#4c9ffe", "ringWidth": 2,       // a focus ring; default on for "focus"
  "scale": 1.03,          // scale-pop target about the box center (1 = no pop)
  "holdMs": 900, "releaseMs": 180,
  "repeat": "infinite", "repeatPeriodMs": 1600  // DM-1585: ambient pulse (see below)
  // "anchor": { "selector": ".cta" }  // CLI: auto-sizes x/y/width/height/radius from the box
}
```

Each treatment fades a fill and/or focus ring IN over `duration` (with a scale
"pop" about the box center), HOLDS, then RELEASES back to nothing before the frame
ends.

**Ambient `repeat` pulse (DM-1585).** By default the treatment fires once. Setting
`repeat` (a count or `"infinite"`) turns it into an **ambient pulse** that loops on
its own `repeatPeriodMs` clock (default 1600 ms) — like `shine`'s `repeat` — for a
"look here" beat on a CTA. Each cycle rises to peak, briefly holds, releases back
to rest, then idles for the remainder of the period; `animation-fill-mode: both`
holds the rested state (opacity 0) before the first pulse and after the last, so
it still **rests at identity** (a re-capture sees nothing). The three presets: **`hover`** = translucent highlight fill + a small
scale-up; **`focus`** = a focus ring (stroke) + a faint fill; **`press`** = a
darken fill + a scale-DOWN press-in that auto-releases. Opacity + `transform:
scale` animate as **one fused keyframe animation** (a single timeline that can't
desync across engines — docs/84).

**Anchor auto-sizing.** Like `shine`, an `interact` overlay carrying an
`anchor: { selector }` (CLI, or the imperative `resolveOverlays`) auto-fills
`x`/`y` (top-left), `width`/`height`, AND `radius` (from the element's computed
`border-radius`) from the anchored element's box; an explicit positive
`width`/`height` or explicit `radius` still wins.

- **Rests at identity.** Outside its window the overlay is opacity 0 / scale(1), so
  a Domotion re-capture of a rested frame sees nothing and can't double-transform
  it — the same invariant `shine` / `tap` hold.
- **Pros:** the only option that works with no DOM; fully deterministic; reuses
  the overlay system.
- **Cons:** purely synthetic — it does not reflect any real styling (there is
  none to reflect). Author must position/style the fake by hand.
- **Composes with `@keyframes`:** yes — it's an overlay with an opacity/transform
  keyframe, same as `tap`/`blink`/`shine`. Cross-engine-safe: no animated filter.

### How they relate

v1 (forced pseudo-state) is the foundation Options 1–2 build on (both need a way
to *enter* the state to capture it) — and both reuse `applyForcedPseudoStates`.
Option 2 (`hoverDetect`) is the CSS-feedback detector; Option 3 (`jsReveal`)
extends detection to JS feedback via a MutationObserver; Option 4 (the `interact`
overlay) is the no-DOM degenerate case for a different input pipeline entirely —
it fakes the feedback instead of capturing it. None require anything in
the output beyond the existing cross-engine `@keyframes` vocabulary.

## Related

- `docs/43-declarative-animate-config.md` §10 — the `forceState` field surface.
- `docs/63-cursor-action-primitives.md` — the imperative-primitive pattern
  `applyForcedPseudoStates` follows, and the cursor overlay it pairs with.
- `docs/13-cursor-overlay.md` — the pointer overlay placed on the hovered element.
- `docs/84-viewer-browser-support.md` — the cross-engine `@keyframes`-only output
  constraint every auto-detection option must satisfy.
- `examples/animate/hover-state/` — the runnable v1 (forceState) demo + golden.
- `examples/animate/hover-reveal/` — the Option 1 `hoverReveal` sugar demo.
- `examples/animate/hover-detect/` — the Option 2 `hoverDetect` detection demo.
- `examples/animate/js-reveal/` — the runnable Option-3 (`jsReveal`) demo: a JS
  dropdown injected on `mouseover`, detected + cross-faded in. + committed golden.
- `src/cli/hover-detect.ts` — the pure diff (`diffHoverSnapshots`) + classify
  (`classifyHoverTransition`) helpers behind `hoverDetect`.
- `src/cli/mutation-detect.ts` — the `jsReveal` MutationObserver harness
  (`detectJsMutations` / `buildJsRevealAnimation`).
