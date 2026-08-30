---
id: "requirements/custom-transition-recipes"
title: "118 — Declarative custom transition recipes"
kind: "contract"
status: "current"
owners: ["animation"]
platforms: []
tickets: ["DM-2072"]
code: []
aliases: ["docs/118-custom-transition-recipes.md","doc-118"]
---

# 118 — Declarative custom transition recipes

DM-2072 provides an open-ended transition escape hatch without accepting viewer code. A `custom` transition composes bounded primitives on the incoming and outgoing layers and lowers to the same normalized plan and one CSS scene clock as built-ins.

```json
{
  "type": "custom", "duration": 420, "easing": "ease-out",
  "custom": {
    "zOrder": "incoming-on-top",
    "incoming": {
      "opacity": 0.1,
      "translate": { "x": 0.2, "y": -0.1 },
      "scale": { "from": 0.85, "origin": { "x": 0.5, "y": 0.5 } },
      "clip": { "shape": "radial", "origin": { "x": 0.5, "y": 0.5 }, "radius": 1 }
    },
    "outgoing": {
      "opacity": 0,
      "translate": { "x": -0.1, "y": 0.05 },
      "scale": { "to": 1.15, "origin": { "x": 0.3, "y": 0.7 } }
    },
    "overlay": { "angle": 25, "bandWidth": 0.2, "color": "#ffeeaa", "opacity": 0.4 },
    "reducedMotion": "crossfade",
    "loop": "hold-last"
  }
}
```

## Safe primitive contract

- Incoming opacity starts at the authored `[0,1]` value and settles at 1; outgoing opacity starts at 1 and settles at its authored value.
- Translate x/y are viewport fractions in `[-2,2]`; incoming offsets settle at zero and outgoing offsets start at zero.
- Scale is `[0.01,4]`, with viewport-relative origin coordinates in `[0,1]`; incoming `from` and outgoing `to` are independently owned wrappers and the incoming layer always rests at `scale(1)`.
- Incoming clip reuses the strict linear/radial/clock reveal union from doc 117 and rests fully revealed. Outgoing clip is deliberately unsupported because collapsing an outgoing layer can expose uncovered viewport pixels; validation rejects it and directs authors to incoming clip ownership.
- The optional overlay is the supported gradient shine primitive. Raw CSS, filter, mask, JavaScript, SMIL, and arbitrary SVG markup are not schema fields and fail strict validation.

At least one primitive is required on each layer. A combined incoming scale + radial/clock clip must share one origin; differing origins fail with an actionable error because the composed wrapper has one entrance pivot. Z-order is explicitly `incoming-on-top`, matching reveal ownership and guaranteeing coverage.

## Timeline, motion preference, and loops

All selected channels emit CSS keyframes against the existing master duration. Independent wrappers let translate, entrance scale, exit scale, clip, opacity, and shine coexist without competing for one CSS property declaration.

`reducedMotion` is `crossfade` or `cut`: under `prefers-reduced-motion: reduce`, transform and clip tracks are disabled while the frame timeline remains authoritative; `cut` also selects step-end frame timing. `loop` is `hold-last` or `crossfade-to-first`; the former preserves Domotion's default final hold, while the latter opts the final recipe into the existing loop handoff.

Schema/normalization tests reject raw and unsupported channels. Unit output tests assert one timeline and no script/SMIL/filter/mask. Chromium and WebKit both sample the representative 1440×900 multi-primitive recipe at transition quartiles with continuous full-frame coverage.
