---
title: Animate (multi-frame)
description: domotion animate — stitch captured frames into one animated SVG with CSS keyframe transitions.
---

`domotion animate <config.json>` captures multiple frames and stitches them into
one animated SVG. The config is validated against the shipped JSON Schema (see
the full [Animate config reference](/domotion/developer/reference/animate-config-reference/)).

```bash
domotion animate ./demo.json
# writes demo.svg next to the config
```

## A real config

This is the exact config behind the "before → after" code-card demo on the
[showcase](/domotion/showcase/). Two HTML frames, joined by a `push-left`
transition — each slides in from the right while the previous slides off left:

```json
{
  "width": 720,
  "height": 400,
  "frames": [
    {
      "input": "./before.html",
      "duration": 2000,
      "transition": { "type": "push-left", "duration": 500 }
    },
    {
      "input": "./after.html",
      "duration": 2400,
      "transition": { "type": "push-left", "duration": 500 }
    }
  ]
}
```

```bash
domotion animate ./before-after-refactor.json
```

<img src="/domotion/demos/before-after-refactor.svg" alt="A push-left transition between two code cards, before and after a refactor" style="width:100%;height:auto" loading="lazy" />

Paths inside a config (`input`, overlay `src`) resolve relative to the config
file's own directory.

## Scroll a tall page in one frame

A single frame can scroll a long page via the pattern grammar instead of
crossfading discrete frames. This is the config behind the scrolling-landing
demo:

```json
{
  "width": 480,
  "height": 640,
  "frames": [
    {
      "input": "./landing.html",
      "duration": 7000,
      "scroll": { "pattern": "down:bottom/5s", "prescroll": false }
    }
  ]
}
```

<img src="/domotion/demos/scroll-landing.svg" alt="A tall landing page scrolled top to bottom with a pinned sticky nav" style="width:100%;height:auto" loading="lazy" />

## Frame kinds

- **`input`** — capture an HTML file / URL
- **`template`** — embed a built-in [template](/domotion/usage/templates/)
- **`cast`** — embed a [terminal recording](/domotion/usage/terminal/)

## Transitions

Compatibility presets include `crossfade`, `cut`, `push-left`, `scroll`,
`magic-move`, `wipe`, `iris`, `wipe-clock`, `zoom-in`, `zoom-out`, and `shine`.
Every transition takes an `easing`
(including `cubic-bezier(...)`), and they **compose** when chained: a frame enters
the way the previous transition handed off to it (fades in after a crossfade,
slides in after a push/scroll, reveals after a wipe/iris, dollies after a zoom)
and exits its own way — so you can mix types freely across a sequence.

Use the canonical parameterized families when the preset defaults are too
coarse. Angles are degrees; distances and origins are viewport-relative:

```json
{ "type": "push", "duration": 320, "push": { "angle": 35, "distance": 0.8 } }
{ "type": "reveal", "duration": 360, "reveal": { "shape": "clock", "origin": { "x": 0.4, "y": 0.6 }, "startAngle": 90, "direction": "counterclockwise" } }
{ "type": "zoom", "duration": 300, "zoom": { "fromScale": 1.2, "origin": { "x": 0.5, "y": 0.35 } } }
{ "type": "shine", "duration": 300, "shine": { "angle": 20, "bandWidth": 0.25, "color": "#fff", "opacity": 0.5 } }
```

For a branded handoff, `custom` safely composes incoming and outgoing opacity,
translate, scale, an incoming linear/radial/clock reveal, and an optional shine
overlay. The schema is strict: it accepts no raw CSS, JavaScript, filters, masks,
SMIL, or arbitrary SVG. Every recipe declares `reducedMotion` (`crossfade` or
`cut`) and loop behavior (`hold-last` or `crossfade-to-first`). See the generated
[Animate config reference](/domotion/developer/reference/animate-config-reference/)
for the complete bounded shape.

## Beyond static frames

A frame also supports:

- **Intra-frame `animations`** — animate a captured element (`opacity`,
  `transform`, `translateX/Y`, `scale`, `width`/`height`, `clipPath`); set an
  `easing` on each (they default to `linear`).
- **Overlays** — `typing` / `tap` / `svg` / `blink` / `shine` / `interact`,
  optionally anchored to an element's box. Typing renders character-by-character
  with the field's real caret and supports `mode`, `jitter`, `mistakes`, `kern`
  (GPOS-kerned proportional typing), and `caret.shape` (`bar`/`block`/`underscore`).
- **A config-level `cursor`** — an on-screen pointer, explicit or `"auto"`.
- **Continuous-session frames** — carry client-side state across steps
  (`"continue": true` + DOM `actions` + `waitForText` / `waitForGone` /
  `waitForCount`), for real interaction demos.
- **Real interaction-state capture** — `forceState` applies a real CSS
  `:hover`/`:active`/`:focus` before capture; `hoverReveal` / `hoverDetect`
  auto-synthesize a hover reveal; `jsReveal` dispatches a JS event and captures
  the MutationObserver result. For high-fidelity typing that shows the page's own
  input mask/validation/font, a **`typeResample`** frame field re-captures the
  live field one keystroke at a time.
- **`vars` + `${}` interpolation.**

```json
{
  "width": 1280, "height": 720,
  "frames": [
    { "input": "form.html",
      "actions": [{ "type": "click", "selector": ".submit" }],
      "overlays": [{ "kind": "typing", "selector": "input", "text": "hello" }],
      "duration": 1500,
      "transition": { "type": "crossfade", "duration": 300 } },
    { "continue": true, "duration": 1500 }
  ]
}
```

Run `domotion animate --help` and see the full
[config reference](/domotion/developer/reference/animate-config-reference/).
