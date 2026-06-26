---
title: Compositing
description: domotion composite — nest animated layers inside animated layers, each on its own timeline.
---

`domotion composite <config.json>` stacks **layers** — each a `cast`, a
`template`, or a pre-rendered `svg`, any of which may be animated — into one
self-contained animated SVG, each placed and on its own timeline with its
animation preserved.

This is how you nest one animated thing inside another: a terminal window
resizing on a desktop, a scrolling site inside a browser bezel.

```bash
domotion composite ./desktop-terminal.json -o desktop.svg
```

## A real config

This is the exact config behind the desktop-terminal demo on the
[showcase](/domotion/showcase/). A static desktop `svg` layer, with an animated
terminal `cast` layer wrapped in `window` chrome placed on top — the window
rises and fades in, then the recorded build session plays:

```json
{
  "width": 1100,
  "height": 720,
  "background": "#000",
  "duration": 13600,
  "layers": [
    { "svg": "desktop.svg", "x": 0, "y": 0, "width": 1100, "height": 720 },
    {
      "cast": "../term/sample.cast",
      "term": { "mode": "incremental", "theme": "dark" },
      "chrome": { "device": "window", "label": "build — widget", "theme": "dark" },
      "x": 222, "y": 170,
      "animations": [
        { "property": "translateY", "from": 24, "to": 0, "start": 0, "duration": 500, "easing": "ease-out" },
        { "property": "opacity", "from": 0, "to": 1, "start": 0, "duration": 500, "easing": "ease-out" }
      ]
    }
  ]
}
```

<img src="/domotion/demos/composite-config-demo.svg" alt="A macOS desktop with a terminal window that rises and fades in, then runs a build session" style="width:100%;height:auto" loading="lazy" />

Paths inside a config (`svg`, `cast`) resolve relative to the config file's own
directory. The output path comes from `-o`, else the config's `output` key, else
stdout.

## Per layer

- **one source** — `svg`, `cast`, or `template` (with `params` / `term` options)
- **placement** — `x` / `y` / `width` / `height` / `clip` / `clipRadius`
- **a timeline** — `start`, `mode` (`hold` / `stretch` / `loop`), `duration`
- **device `chrome`** — `{ device: phone|browser|window, label, theme }`
- **`animations`** — `scale` / `translateX` / `translateY` / `opacity` /
  `transform`, plus `clipScaleX` / `clipScaleY` to resize a layer's box so its
  content reflows

The programmatic equivalent is `composeAnimatedLayers(layers, opts)`. Run
`domotion composite --help` and see `examples/composite/` in the repo.
