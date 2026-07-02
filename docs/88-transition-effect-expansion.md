# 88 — Transition & effect expansion (SVG-safe)

**Status: shipped (DM-1524 + DM-1542).** This doc is the reference for the
transition/effect vocabulary added on top of the original set (crossfade /
push-left / scroll / cut / magic-move — see `docs/08-animation-model.md`). Every
effect here is expressed in **`transform` + `clip-path` + `opacity` + gradients
only** — the properties that composite identically on Blink and WebKit. **None
animate a CSS `filter`** (blur/glow): an animated `filter` is Chromium-only inside
`<img>` and was rejected before, so film-look blur/glow belongs in the video
export path, not the SVG (see `docs/84-viewer-browser-support.md`).

All of these are pure CSS `@keyframes` baked into the self-contained SVG — no JS,
no SMIL — so they play as a plain `<img>` on every supported engine.

## Directional pushes

`push-left` and `scroll` were the original pair (`scroll` is a vertical push
upward). DM-1524 completes the compass with **`push-right`**, **`push-up`**, and
**`push-down`**. All five route through one slide engine (`emitSlideFrame` /
`slideKeyframes` in `src/animation/animator.ts`): the outgoing frame slides out by
a signed displacement on an axis and the incoming frame slides in from the
opposite side — **both frames move together**, a true push (not a cover).

| Type | Outgoing exits | Incoming enters from |
|---|---|---|
| `push-left` | left (−X) | right |
| `push-right` | right (+X) | left |
| `push-up` (== `scroll`) | up (−Y) | below |
| `push-down` | down (+Y) | above |

`push-up` is a byte-identical alias of `scroll` (same `{axis: Y, sign: −1}`);
prefer whichever name reads better in your config.

## Clip-path reveals: `wipe`, `iris`

These are **reveal-on-top** transitions: the outgoing frame HOLDS fully painted
beneath and hard-cuts out at the window end, while the incoming frame unveils on
top via an animated `clip-path` and RESTS fully revealed (identity clip).

- **`wipe`** — a linear left→right reveal: the incoming frame's clip animates
  `inset(0 100% 0 0)` → `inset(0 0 0 0)`.
- **`iris`** — an expanding circle from the center: `circle(0px at cx cy)` →
  `circle(Rpx at cx cy)`, where `R = ⌈hypot(w/2, h/2)⌉` (reaches the farthest
  corner). Rests fully open.

The reveal wrapper is an inner `<g class="fr-N">` carrying the `clip-path`
animation; the frame's own `opacity` stays 1 through its window (the clip does the
hiding) and step-cuts at the end.

Radial and clock wipes (a sweeping conic mask) are **not** shipped — a conic
gradient / `conic` mask has cross-engine caveats worth a dedicated pass; tracked
as a follow-up.

### Optional named easing on reveals + dollies (DM-1550)

By default the `wipe` / `iris` reveal and the `zoom-in` / `zoom-out` dolly (below)
run **linear**. Set `transition.easing` to a named easing from the motion-preset
vocabulary (`docs/08`) — including the sampled multi-oscillation springs
`spring-soft` / `spring-bouncy` — or a raw CSS easing string, and it is applied to
the reveal / dolly SEGMENT only:

```jsonc
{ "type": "wipe",    "duration": 700, "easing": "spring-bouncy" }
{ "type": "zoom-in", "duration": 600, "easing": "spring-soft" }
```

The easing is authored on the transition that DRIVES the next frame's entrance
(the reveal / dolly plays on that successor). It's resolved through
`resolveEasingPreset` and emitted as a per-keyframe `animation-timing-function`
on the reveal-open / dolly-start stop, so the surrounding holds stay linear. A
sampled spring `linear(...)` overshoots its target and rings down: on a wipe the
reveal edge shoots past full-reveal, retreats a sliver, and settles; on a zoom the
scale overshoots `scale(1)` and rings back — a lively pop. Both still **rest at
identity** (the last keyframe pins the fully-revealed clip / `scale(1)`). The
other transition types ignore `easing` (their motion is fixed). Purely
`clip-path` / `transform` — no animated filter.

## Scale dollies: `zoom-in`, `zoom-out`

Both ride the crossfade opacity machinery (the frames cross-dissolve) with a scale
on an inner `<g class="fz-N">` wrapper of the incoming frame, resting at
`scale(1)`:

- **`zoom-in`** — incoming grows `scale(0.9)` → `scale(1)` (a dolly-in).
- **`zoom-out`** — incoming settles `scale(1.1)` → `scale(1)` (a dolly-out).

The scale pivots about the **viewport center** via a numeric-px `transform-origin`
(`w/2 h/2`), with no `transform-box: fill-box` — the same userspace-origin
approach `src/animation/composite.ts` uses so the pivot is identical on
Blink/WebKit/Gecko (`fill-box` on an SVG group misbehaves in Firefox — docs/84).

## `shine` — the swept-highlight sweep

`shine` is a crossfade with a **diagonal gradient highlight swept across the whole
viewport** over the handoff window, on top of the dissolve. The sweep is the
shared `buildShineSweep` helper (`src/animation/shine.ts`), which also backs the
`shine` motion overlay (below). A band of a linear-gradient (transparent →
highlight → transparent) travels via `transform: translateX`, clipped to the box —
no animated filter.

## The `shine` motion overlay (DM-1542)

The same glint is available as a per-frame **overlay** (`kind: "shine"`) — the
"shine" motion preset. It can't be a from/to on the element itself (a moving
masked gradient isn't a single property animation), so it lives as an overlay
backed by `buildShineSweep`:

```jsonc
{
  "kind": "shine",
  "x": 30, "y": 280, "width": 132, "height": 34,  // box the glint is clipped to
  "radius": 8,           // DM-1551: round the clip to follow a pill/button's corners
  "delay": 900,          // ms from frame start to the first sweep (default 200)
  "duration": 850,       // one-shot sweep length in ms (default 900)
  "repeat": "infinite",  // omit for a single sweep; a count / "infinite" shimmers
  "repeatPeriodMs": 2000,
  "color": "#ffffff", "opacity": 0.55, "bandWidth": 40, "skewDeg": 14  // all optional
  // "anchor": { "selector": ".badge" }  // CLI: resolves x/y/width/height/radius from the box
}
```

**Rounded clip (DM-1551).** `radius` (px) rounds the clip rect so the glint
follows a rounded element's corners instead of showing square edges over them —
clamped to half the shorter side by `buildShineSweep`. Omit / `0` for a square
clip (byte-identical to the pre-radius default).

**Anchor auto-sizing (DM-1549 / DM-1551).** When the overlay carries an
`anchor: { selector }` (CLI, or the imperative `resolveOverlays` primitive), the
resolver measures the anchored element's border box and auto-fills `x` / `y`
(top-left), `width` / `height`, AND `radius` (from the element's computed
`border-radius`) — so a `shine` sizes and rounds itself to whatever it's anchored
to. An explicit positive `width` / `height` or an explicit `radius` still wins;
otherwise they come from the box (`width` / `height` default to `0` in the config,
i.e. "take it from the anchor").

Outside its sweep window the band parks fully off the clipped box (paints
nothing), so the underlying content **rests at identity** — a Domotion re-capture
of a rested frame sees no glint and can't double-transform it.

## Sampled spring easing (DM-1542)

The motion-preset easing set (`docs/08`, motion-presets section) gains two
**true multi-oscillation springs**. A real damped spring rings past its target
several times before settling — which a single `cubic-bezier` cannot express (a
bezier is monotonic in time and can overshoot only once). So they are baked to CSS
**`linear(...)`** keyframe samples, the cross-engine carrier for an arbitrary
sampled curve (Chrome 113+, Safari 17.2+, Firefox 112+ — first-class per
`docs/84`), via `springLinearEasing` in `src/animation/easing.ts`:

- **`spring-bouncy`** — damping ratio 0.25: ~3 overshoots, a lively bounce.
- **`spring-soft`** — damping ratio 0.6: a single gentle overshoot, quick settle.

The single-overshoot `spring` / `back-*` presets stay plain `cubic-bezier`s (no
sampling needed). Both spring presets pin their first/last samples to exactly
`0`/`1`, so the motion starts at `from` and **rests at `to` (identity)**.

Use a spring like any named easing — on a motion preset or a raw intra-frame
animation:

```jsonc
{ "selector": ".badge", "preset": "pop", "easing": "spring-bouncy", "duration": 600 }
{ "selector": ".card", "property": "translateX", "from": "-260px", "to": "0px",
  "duration": 1400, "easing": "spring-bouncy",
  "fuse": [{ "property": "opacity", "from": "0", "to": "1" }] }
```

## Where to look

- `src/animation/animator.ts` — transition routing (`PUSH_DIRS`, `REVEAL_KINDS`,
  `emitSlideFrame`, `emitRevealFrame`, the zoom `entranceScale` + `shine` sweep in
  the crossfade branch) and the `shine` overlay (`renderShineOverlay`).
- `src/animation/shine.ts` — the shared `buildShineSweep` helper.
- `src/animation/easing.ts` — `springEasingFn` / `springLinearEasing`.
- `src/animation/motion-presets.ts` — the `spring-bouncy` / `spring-soft` presets.
- CLI + schema: the `transition.type` enum in `src/cli/animate.ts` and the
  generated `schemas/animate-config.schema.json`; the `shine` overlay in
  `src/animation/overlay-schema.ts`.
- Runnable demo: `examples/showcase-transitions.ts` →
  `examples/output/transition-{wipe,iris,zoom,shine,effects}.svg`.

## Runnable examples

`npx tsx examples/showcase-transitions.ts` regenerates the committed golden SVGs,
one clean two-scene loop per transition plus `transition-effects.svg` (a
`spring-bouncy` intra-frame slide-in with a shine overlay). Open them in a browser
or scrub with `svg-scrubber`.
