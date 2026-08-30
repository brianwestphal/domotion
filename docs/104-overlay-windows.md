---
id: "requirements/overlay-windows"
title: "104 — Per-overlay windows (endAt) and per-state overlays inside a compressed run"
kind: "contract"
status: "current"
owners: ["animation","platform-release"]
platforms: ["windows"]
tickets: ["DM-1767","DM-1796","DM-1799"]
code: ["examples/animate/editor-session/","examples/animate/form-fill/","examples/animate/overlay-window/","src/animation/animator.test.ts","src/animation/animator.ts","src/animation/overlay-schema.ts","src/cli/animate.test.ts","src/cli/animate.ts","tests/overlay-window.e2e.test.ts"]
aliases: ["docs/104-overlay-windows.md","doc-104"]
---

# 104 — Per-overlay windows (`endAt`) and per-state overlays inside a compressed run

Status: **shipped** (DM-1767; the window's closing edge reworked in DM-1796 — §3.1). Two changes to the **overlay model**:

1. an **explicit per-overlay window** — an overlay ends where the author says, independent of its frame;
2. **per-state overlays** on a compressed run (`states:`, [docs/43 §11](43-declarative-animate-config.md)) — anchor-resolved against the state they belong to and bounded to that state's hold.

Together they remove the last reason a frame carrying an overlay had to stay *outside* an automatic compressed run, so `autoCompress` ([docs/43 §13.1](43-declarative-animate-config.md)) now collapses those runs whole.

---

## 1. Why the frame was the wrong unit

Overlay lifetime was **frame-scoped**, everywhere:

| Kind | What the frame's end meant |
|---|---|
| `typing` | the typed text, mask, and parked caret hold to the frame's end, then fade (or, with `holdToFrameEnd`, cut at it — reworked in DM-1796, §3.1) |
| `blink` | toggles across the frame's hold, then off |
| `interact` | `hover` / `focus` hold at peak to ~the frame's end before releasing |
| `shine` | the sweep is clamped to the frame's hold |
| `svg` | visible for the frame's hold; `exit` is measured back from its end |
| `tap` | *nothing* — a tap is fully described by its own `delay` + a fixed 500 ms ripple |

That is a fine default and it is still the default. It is only a *problem* when an overlay must outlive or under-live its frame — and the case that forces the issue is compression. A compressed run collapses N config frames into **one** animation frame, so "the frame's end" becomes the end of the whole run: an overlay authored on the third of five members would stop dying at its own cut and instead hold across the remaining states. There was no way to say otherwise, which is why `overlays` was a run-splitting exclusion.

The second half of the same problem is **where** an anchored overlay lands. `anchor: { selector }` (and `maxWidth: "anchor"`) resolves against the **live page**, once per frame, after that frame's actions. A collapsed run leaves the page at its **last** state — and layout moving between states is precisely why the run compresses at all — so a state-3 overlay would anchor against state-5 geometry.

Neither is fixable in the collapse pass. Both are properties of the overlay model.

## 2. `endAt` — the explicit window end

Every overlay kind accepts an optional **`endAt`**: the ms, **from frame start**, at which that overlay's window closes.

```jsonc
{ "kind": "typing", "text": "sanitize the session id", "x": 24, "y": 96,
  "endAt": 1200 }                                  // gone at 1.2 s, whatever the frame's duration is
```

**Semantics.**

- Omitted (the default) the window ends with the frame — byte-identical to before this feature. Every existing config is unchanged.
- **Clamped to the frame's `duration`.** An overlay may end **early**, never late: it still cannot leak across the cut into the next frame. A sub-millisecond window is floored at 1 ms.
- The window end replaces the frame's end **wherever the kind consulted it** (the table above), so the meaning is uniform: `typing` holds and fades against `endAt`, `blink` stops toggling at it, `interact` releases before it, `shine` clamps its sweep to it, `svg` hides at it and measures `exit` back from it.
- **`tap`** is the exception worth stating: it never consulted the frame's end, so `endAt` is not a shortening of an existing hold but a **cut** — a ripple still running when the window closes is cut short, and one whose `delay` falls at or past the window is not emitted at all.
- `endAt` composes with the kind's own knobs rather than replacing them: `interact`'s `holdMs` / `releaseMs` and `shine`'s `duration` are measured against the window, not the frame. (`typing`'s exit is its own topic — see §3.1.)

**Starting the window.** The complement already existed on five kinds as `delay`; DM-1767 adds it to the sixth:

```jsonc
{ "kind": "svg", "src": "./badge.svg", "x": 420, "y": 24, "width": 160, "height": 90,
  "delay": 900, "endAt": 2600,                     // on screen for [0.9 s, 2.6 s)
  "enter": { "from": "bottom", "duration": 300 } }
```

- **`delay` on an `svg` overlay** (default `0` — appears with the frame, as it always has) shifts the whole visibility window. `enter.delay` remains an *additional* nudge measured from that appear time, so an unset `delay` is byte-identical to before.
- With that, **every kind has the same `[delay, endAt]` window**. That uniformity is what makes the run rewrite below a mechanical re-basing rather than six special cases.

**Useful outside a compressed run too.** An annotation that should vanish partway through a long frame no longer needs the frame split in two just to get a shorter lifetime.

## 3. Per-state overlays on a `states:` run

A state may carry its own **`overlays`**, using the same authoring vocabulary as a frame's:

```jsonc
{ "input": "./editor.html", "duration": 1200,
  "states": [
    { "duration": 400 },
    { "duration": 400, "actions": [{ "type": "evaluate", "script": "ins(2)" }],
      "overlays": [{ "kind": "blink", "width": 40, "height": 24,
                     "anchor": { "selector": "#target", "at": "top-left" } }] },
    { "duration": 400, "actions": [{ "type": "evaluate", "script": "ins(4)" }] }
  ] }
```

**Semantics.**

- **Anchors resolve at that state.** Each state's overlays are anchor-resolved *while the page is at that state* — inside `buildStatesRunContent`'s capture loop, right after the state's capture. So a `selector` anchor / `maxWidth: "anchor"` sees the layout the overlay was authored against, not the run's final layout.
- **The window is the state's slice.** The overlay is re-based onto the outer frame's timeline: its **effective** `delay` (the authored value, or the kind's own default — `typing` 300 ms, `tap` 50 ms, `shine`/`interact` 200 ms, `blink`/`svg` 0) is shifted by the state's offset into the run, and `endAt` is pinned to the state's end. An `endAt` authored on a per-state overlay is read **relative to its state** and clamped to the state's hold, so it can bound the overlay *inside* the state but never past it.
- **Paint order.** A frame-level overlay on the same frame spans the whole run and paints first; per-state overlays follow in state order, then declaration order.
- **Per-region timing** (`advances`, [docs/43 §11.1](43-declarative-animate-config.md)): a state's anchors resolve in the capture **round** that state was driven in. States sharing a round advance *disjoint* regions and the non-region remainder is byte-identical across rounds (the run's checked precondition), so an anchor inside the region the state advances — or in the unchanging chrome — is exact. Anchoring to an element inside a *different* region, which may be ahead of or behind this state, resolves against that round's position; anchor within the state's own region when the placement must be exact. **(DM-1799: no longer a caveat.)** Per-region-timing runs now resolve their per-state anchors against each state's **assembled tree** rather than the live page, so a cross-region anchor is exact too. See [docs/61](61-overlay-resolution-primitive.md) — "Two box producers, one arithmetic".

## 3.1 Leaving the window (DM-1796)

A window has two edges, and the closing one has to be as careful as the opening one. A `typing` overlay used to start fading **150 ms before** its window ended and sit fully transparent for the last ~50 ms — which is exactly wrong for the thing it exists to do. The whole point of a typing overlay is that it gets **replaced**: the next frame (or the next state of a compressed run) carries the same value as real captured text. Fading early opens a hole where the value is on *neither* side of the handoff. Measured on `examples/animate/form-fill/`: a hard ~120 ms blank in the field, reported as "the input value disappears then reappears".

So a typing overlay now holds at **full opacity through its window's end** and leaves the way its frame does:

| Situation | Exit |
|---|---|
| `cut` into a following frame, **or a compressed-run state snap** (`endAt`) | hard `step-end` cut at the boundary — the replacement appears in the same instant |
| a non-`cut` frame transition | dissolves across the frame's own transition window, travelling with the frame |
| the scene's **last** frame | the historical graceful fade (hold to −150 ms, fade over 100 ms) — nothing takes over before the loop wraps, and there is no handoff to protect |

The boundary tick deliberately belongs to the **visible** state: the full-opacity stop sits *at* the boundary and the drop an epsilon (~0.01% of the timeline) after it, so the overlay and its replacement overlap for well under a display frame. Choosing a sub-frame overlap over a sub-frame gap is the right bias — a momentary double-strike is imperceptible, a momentary hole flickers.

This makes `endAt` on a per-state overlay strictly stronger than "the overlay is bounded": the state's snap **is** its handoff, so the overlay is opaque right up to it.

## 4. What this changes for `autoCompress`

`overlays` is **no longer** a run-splitting exclusion. When a run collapses, each member's `overlays` become that member's **state's** overlays; the anchor frame's become state 0's. Everything in §3 then applies, and the result reproduces the authored per-frame behavior exactly: the overlay resolves against its own capture and dies at its own cut.

`animations`, `textTracks`, `forceState`, a `selector` subtree capture, and the content kinds remain exclusions — they have no per-state equivalent, and the hand-authored `states:` block (which carries them at frame level) is still the answer there.

**Measured on the committed example corpus.** Two examples contain overlay-carrying `continue` + `cut` runs, and both now collapse:

| Example | Animation frames | Bytes |
|---|---|---|
| `examples/animate/form-fill/` | 4 → **2** | 53 KB → **46 KB** (−12%) |
| `examples/animate/editor-session/` | 11 → **6** | 187 KB → **158 KB** (−15%) |

Both were verified **pixel-identical** to their previous output — rasterized and diffed frame by frame across their whole timelines (32 and 48 sample times; `regionCount === 0`, 0.000% non-AA pixels at every sample). That is the compressor's standing guarantee (compression trades bytes and live-DOM weight, never fidelity) now extended over the overlays.

This supersedes the "why per-frame `overlays` split rather than ride along" note in [docs/43 §13.1](43-declarative-animate-config.md), which described exactly the two gaps closed here.

## 5. Where it lives

| Concern | Code |
|---|---|
| `endAt` on every kind + `delay` on `svg` | `src/animation/overlay-schema.ts` |
| Window resolution + per-kind threading | `overlayWindowEndMs` / `emitFrameOverlays` in `src/animation/animator.ts` |
| How a typing overlay leaves its window (DM-1796) | `OverlayExit` + `renderTypingOverlay` in `src/animation/animator.ts` |
| Each kind's default start delay | `OVERLAY_DEFAULT_DELAY_MS` in `src/animation/animator.ts` (internal — not on the published barrel) |
| Per-state `overlays` authoring + validation | `runStateSchema` in `src/cli/animate.ts` |
| Per-state anchor resolution + re-basing | `buildStatesRunContent` in `src/cli/animate.ts` |
| Member overlays → state overlays on collapse | `collapseCompressibleRuns` in `src/cli/animate.ts` |

Runnable example: **`examples/animate/overlay-window/`** — two `endAt`-bounded annotations sharing one frame, plus a `states:` run whose per-state overlays anchor to a marker that moves 44 px per state (the golden asserts four *distinct* ring positions, so a regression to once-per-frame anchoring fails loudly).

Tests: `src/animation/animator.test.ts` ("per-overlay window — `endAt`"), `src/cli/animate.test.ts` ("member overlays ride along as per-state overlays"), and the rasterized end-to-end proof in `tests/overlay-window.e2e.test.ts` — a three-frame run whose middle member anchors an overlay to a **moving** element, asserting in painted pixels that it appears in its state only and at *that* state's position.

## 6. Not covered

- **No per-overlay window on the `cursor` overlay.** The cursor is scene-global with its own event timeline ([docs/13](13-cursor-overlay.md)); it is not a per-frame overlay and takes no `endAt`.
- **No `startAt`.** Each kind's `delay` already is the window's start; a second spelling would be ambiguous.
- **A window cannot extend past its frame.** Spanning frames would reintroduce exactly the cross-cut leakage every overlay renderer clamps against. An overlay that should span a whole compressed run is authored at **frame** level, which already means that.
