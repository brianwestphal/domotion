# 44 — Repeating animations: blink, pulse, typing caret

Status: **shipped**. Spec for repeating / looping animations in the animation pipeline; all three mechanisms are implemented — `repeat`/`alternate` on `IntraFrameAnimation` (`src/animation/animator.ts`; config schema in `src/cli/animate.ts`), the typing-overlay blinking `caret`, and the standalone `blink` overlay (DM-869 / DM-870 / DM-871). See `docs/08-animation-model.md` for the one-shot intra-frame animation model this extends, and `docs/43-declarative-animate-config.md` for the config surface.

## Why

Nothing can **blink** — a repeating on/off cycle held for a frame's duration. `IntraFrameAnimation` animates a property once (`from`→`to` over a duration, then holds); overlays don't loop. Use cases that need a repeat: a terminal block cursor / textarea caret, a recording dot, an attention pulse on a focused field, a breathing highlight. Building the review-loop demo, a blinking caret wasn't expressible, so it fell back to a static focus state.

## Three mechanisms

These compose; each is independently useful. Recommended build order (smallest/most-general first) is noted; each has its own implementation ticket.

### 1. Repeating intra-frame animations (the general primitive)

Extend `IntraFrameAnimation` (see `docs/08`) with two optional fields:

```jsonc
{ "selector": ".caret", "property": "opacity", "from": "1", "to": "0",
  "duration": 530, "repeat": "infinite", "alternate": true }
```

- `repeat`: a positive integer (iteration count) or `"infinite"`. Maps to CSS `animation-iteration-count`.
- `alternate`: boolean. When true, maps to `animation-direction: alternate` so the animation ping-pongs (`from`→`to`→`from`) instead of restarting at `from` each iteration. A smooth pulse/breathe wants `alternate: true`; a hard blink wants a step timing function (or just opacity 1↔0 with `alternate`).

This is the most general form — it turns *any* intra-frame property animation into a loop: blinking carets (`opacity` 1→0), pulsing highlights (`background`/`opacity`), breathing dots (`transform: scale`). The keyframe block is unchanged; only the `animation` shorthand's iteration-count/direction change.

Semantics: the repeat is **gated by the frame's visibility window** (same as one-shot intra-frame animations) — it loops only while the frame is on screen, and the loop period must divide sensibly into the frame's hold time (a partial last cycle is fine; it just pauses when the frame leaves).

**Build first** — smallest change, most reusable, and the substrate the other two can lower onto.

### 2. `caret` on the typing overlay (highest-value specific form)

The `typing` overlay reveals text but leaves no insertion caret. Add a `caret` option that renders a blinking bar at the current type position and **persists blinking after typing completes** (until the frame ends):

```jsonc
{ "kind": "typing", "text": "Sanitize the session id…", "x": 28, "y": 56,
  "caret": true }
// or: "caret": { "color": "#e6edf3", "width": 2, "blinkMs": 530 }
```

- Tracks the type cursor during typing, then blinks in place at the end of the text.
- Defaults: `width` 1–2px, `color` inherits the typing color, `blinkMs` ≈ 530 (browser caret cadence). Blink = opacity 1↔0 on a `blinkMs` cycle.
- Pairs with the typing-overlay wrap (`bgWidth`, DM-840): on a wrapped field the caret sits at the end of the last wrapped line.

This is the concrete thing the review-loop demo needed. Implemented as an extension of the typing overlay's renderer (it already computes per-character positions), reusing mechanism 1's repeat for the blink.

### 3. `blink` overlay primitive (standalone)

A general standalone blinker, for carets/dots not tied to a typing overlay (recording dot, attention pulse on a focused field):

```jsonc
{ "kind": "blink", "anchor": { "selector": ".rec", "at": "center" },
  "width": 10, "height": 10, "periodMs": 800, "color": "#ef4444" }
```

- Positioned by `x`/`y` or by an `anchor` (selector bbox — see `docs/43` §5).
- Renders a bar/box that toggles opacity on a `periodMs` cycle for the frame's hold.
- Sugar over mechanism 1 (a `blink` overlay is a small rect + a repeating opacity animation), so it lands after 1 + 2.

## Shared semantics

- **Blink vs. fade.** A hard blink (caret, cursor) wants opacity to *snap* 1↔0 — emit with `step-end`/`steps(1)` timing or a two-stop keyframe. A pulse/breathe wants a smooth `ease-in-out` with `alternate`. The config picks via the timing function (mechanism 1's easing) or sensible per-kind defaults (caret = snap; pulse = smooth).
- **Looping is bounded by the frame.** All three loop only while their frame is on screen; the existing frame-visibility gating (`fv-`/cull) still applies. Across the scene's infinite outer loop the blink resumes each cycle.
- **No JS.** All of this is CSS `@keyframes` with `animation-iteration-count` / `direction` — no `evaluate`, no runtime scripting.

## Non-goals (v1)

- Arbitrary multi-keyframe timelines (more than `from`/`to`). If a demo needs a 5-stop animation, that's the programmatic API. v1 is repeat/alternate over the existing two-stop model.
- Synchronizing blinks across elements to a shared clock beyond what a shared `periodMs` + the global scene start already give.

## Rollout

Mechanism 1 (repeat/alternate on `IntraFrameAnimation`) is the substrate — build it first. Mechanism 2 (typing caret) is the highest-value specific form and lowers onto 1. Mechanism 3 (`blink` overlay) is standalone sugar, last. Each has its own implementation ticket. Update `docs/08` (animation model) once mechanism 1 ships and the CLI `--help` per the declarative-config doc surface.
