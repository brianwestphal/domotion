---
title: Animate (multi-frame)
description: domotion animate — stitch captured frames into one animated SVG with CSS keyframe transitions.
---

`domotion animate <config.json>` captures multiple frames and stitches them into
one animated SVG. The config is validated against the shipped JSON Schema (see
[Animate config format](/domotion/developer/animate-config/)).

```bash
domotion animate ./demo.json
```

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

Run `domotion animate --help` and see the [config reference](/domotion/developer/animate-config/).
