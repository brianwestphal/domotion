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

```json
{
  "width": 1100, "height": 720, "background": "#000", "duration": 13600,
  "layers": [
    { "svg": "desktop.svg", "x": 0, "y": 0, "width": 1100, "height": 720 },
    { "cast": "build.cast", "term": { "theme": "dark" },
      "chrome": { "device": "window", "label": "build" },
      "x": 150, "y": 90,
      "animations": [
        { "property": "scale", "from": 1, "to": 1.28, "start": 6000, "duration": 800, "transformOrigin": "0 0" }
      ] }
  ]
}
```

Per layer: one source (`svg` / `cast` / `template`), placement
(`x`/`y`/`width`/`height`/`clip`), a timeline (`start`, `mode`, `duration`),
optional device `chrome`, and `animations` (move / scale / fade, plus
`clipScaleX`/`clipScaleY` to resize a layer's box so its content reflows).

The programmatic equivalent is `composeAnimatedLayers(layers, opts)`. Run
`domotion composite --help` and see `examples/composite/` in the repo.
