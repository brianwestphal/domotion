---
title: Animate config format
description: The JSON config that drives domotion animate — frames, transitions, overlays, actions, and cursor.
---

`domotion animate` is driven by a JSON config validated against a published JSON
Schema (`schemas/animate-config.schema.json`, shipped in the package). Point a
JSON-Schema-aware editor at the `$schema` key for autocomplete and validation.

## Shape

```json
{
  "width": 1280,
  "height": 720,
  "output": "demo.svg",
  "optimize": true,
  "cursor": "auto",
  "vars": { "brand": "#6366f1" },
  "frames": [ /* … */ ]
}
```

## A frame

```json
{
  "input": "step1.html",
  "duration": 1500,
  "transition": { "type": "crossfade", "duration": 300 },
  "animations": [
    { "selector": ".bar", "property": "width", "from": "0%", "to": "100%",
      "duration": 1200, "easing": "cubic-bezier(0.215,0.61,0.355,1)" }
  ],
  "overlays": [
    { "kind": "typing", "selector": "input", "text": "hello", "caret": true }
  ]
}
```

- **Frame source:** `input` (HTML/URL), `template`, or `cast`.
- **Transitions:** `crossfade` · `cut` · `push-left` · `scroll` · `magic-move`.
- **`animations`** — per-element: `opacity`, `transform`, `translateX/Y`,
  `scale`, `width`/`height`, `clipPath`; with `easing`, `delay`, `repeat`,
  `alternate`, `transformOrigin`.
- **`overlays`** — `typing` / `tap` / `svg` / `blink`, optionally anchored to an
  element's box.
- **Continuous sessions** — omit `input` or set `"continue": true`, then drive
  the page with `actions` and wait with `waitForText` / `waitForGone` /
  `waitForCount`.
- **`cursor`** — `"auto"` (derive a pointer from interactions) or an explicit
  `{ events: [...] }` timeline.
- **`vars` + `${name}`** — interpolated into any string field.

:::note
This summary will be replaced by the canonical grammar synced from the repo's
scroll-pattern and animate docs in a later phase. Run `domotion animate --help`
for the authoritative reference today.
:::
