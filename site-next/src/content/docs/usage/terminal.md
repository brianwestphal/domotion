---
title: Terminal sessions
description: domotion term — turn an asciinema recording into a self-contained animated terminal SVG.
---

`domotion term --cast <file.cast>` converts a recorded terminal session into a
self-contained animated SVG — real text, real ANSI color, native SVG (no raster
frames).

Record with [asciinema](https://asciinema.org), then convert:

```bash
asciinema rec demo.cast -c "npm test"
domotion term --cast demo.cast -o demo.svg
```

Options cover theme, font size, and timing — run `domotion term --help`.

## Timing

The *rendered* play length differs from the recording's wall time (the timing
knobs re-time it). `term` prints the rendered length on stderr (e.g.
`… 13.60s play length …`) — use that number when sizing an `animate` cast
frame's `duration`.

## Compose with intro/outro and window chrome

A terminal session shines wrapped in an intro/outro and macOS window chrome. Use
an [`animate`](/domotion/usage/animate/) config with a `cast` frame, or
[`composite`](/domotion/usage/composite/) to place the animated terminal window
on a desktop. The [showcase](/domotion/showcase/) terminal demos are built this
way.
