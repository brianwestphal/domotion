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

`crossfade`, `cut`, `push-left`, `scroll`, `magic-move`.

## Beyond static frames

A frame also supports:

- **Intra-frame `animations`** — animate a captured element (`opacity`,
  `transform`, `translateX/Y`, `scale`, `width`/`height`, `clipPath`).
- **Overlays** — `typing` / `tap` / `svg` / `blink`, optionally anchored to an
  element's box.
- **A config-level `cursor`** — an on-screen pointer, explicit or `"auto"`.
- **Continuous-session frames** — carry client-side state across steps
  (`"continue": true` + DOM `actions` + `waitForText` / `waitForGone` /
  `waitForCount`), for real interaction demos.
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
