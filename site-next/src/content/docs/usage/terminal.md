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

You can also skip the recorder and run a command live in a pseudo-terminal
(everything after `--` is the command):

```bash
domotion term -o build.svg -- npm test
domotion term --theme dark -- git clone https://github.com/acme/web.git
```

## Useful flags

- `--theme <name>` — base color theme (e.g. `catppuccin`, `dark`); override
  individual colors with `--bg` / `--fg` or a `--theme-file <json>`
- `--cursor block|bar|underline|none` (`--cursor-color <c>`)
- `--font-size <n>` (default 14) · `--font-family <stack>`
- `--cols <n>` / `--rows <n>` — override the recorded grid
- `--mode incremental|full` — `incremental` (default) reveals each line on its
  timeline; `full` renders a complete screen per frame (use for scrolling output)

Run `domotion term --help` for the full list.

## Timing

The *rendered* play length differs from the recording's wall time (the timing
knobs — `--settle-ms`, `--min-frame-ms`, `--max-frame-ms`, `--tail-ms` — re-time
it). `term` prints the rendered length on stderr (e.g.
`… 13.60s play length …`) — use that number when sizing an `animate` cast
frame's `duration`.

## Compose with intro/outro and window chrome

A terminal session shines wrapped in an intro/outro and window chrome. The window
frame is just an SVG you supply — the bundled demos use a macOS-style window, but
a Windows- or Linux-style frame composites the same way. Use an
[`animate`](/domotion/usage/animate/) config with a `cast` frame, or
[`composite`](/domotion/usage/composite/) to place the animated terminal window
on a desktop. The [showcase](/domotion/showcase/) terminal demos are built this
way — a continuous clone → install → configure → run session rendered through
this exact `--cast` path, then composited into a window bezel:

<img src="/domotion/demos/terminal-onboarding.svg" alt="A macOS terminal window running git clone, npm install, configure, and run in one continuous session" style="width:100%;height:auto" loading="lazy" />
