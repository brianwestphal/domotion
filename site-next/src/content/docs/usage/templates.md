---
title: Templates
description: domotion template — polished animated SVGs from a few flags.
---

`domotion template <name>` is the fastest way to a polished animated SVG without
writing HTML. `domotion template list` shows the built-ins; `domotion template
<name> --help` shows a template's parameters.

```bash
domotion template lower-third --title "Ada Lovelace" --subtitle "First Programmer" -o banner.svg
domotion template chart --type donut --data "42,28,18,12" --labels "Search,Direct,Social,Email" -o chart.svg
domotion template kinetic-text --text "Ship it" --variant pop --by char -o title.svg
```

## Built-ins

- **lower-third** — broadcast-style banner (title + subtitle + accent)
- **kinetic-text** — animated typography (rise / slide / fade / clip / pop)
- **chart** — column / bar / line / pie / donut, single or multi-series
- **chat** — a message thread that pops in one bubble at a time
- **subscribe** — a follow / subscribe pop-up with a pulsing CTA
- **background-loop** — a seamless looping animated background
- **device-mockup** — wrap a page in a phone / browser / window bezel

Pass scalar params as `--flags`, or arrays/objects via `--params '<json>'`.

Third-party templates are npm packages named `domotion-template-<name>` — install
one and use it by `<name>`. To author your own, see
[Building custom templates](/domotion/developer/custom-templates/).

## A note on charts

Single-series column/bar charts default to one neutral color with the standout
bar in the accent (our own design guidance — emphasize one, don't rainbow).
Multi-series and pie/donut use distinct colors, where color genuinely encodes the
series or slice. Override with `--colors` any time.
