---
title: Install & quick start
description: Install Domotion and capture your first self-contained animated SVG.
---

## Install

```bash
npm install domotion-svg
```

Domotion auto-installs Playwright's Chromium on first use
(`npx playwright install chromium`). On CI you may want to pre-install it to keep
the first job fast.

## What's included

The package ships several command-line tools:

- **`domotion`** — the main CLI: `capture` a page, `animate` multi-frame flows,
  `template` polished graphics, `term` terminal recordings, and `composite`
  layered SVGs.
- **`svg-to-video`** — render an animated SVG to MP4 / WebM / GIF (and more).
  [→ Export](/domotion/usage/export/)
- **`svg-to-image`** — render any frame of an SVG to a PNG / JPEG still.
  [→ Export](/domotion/usage/export/)
- **`svg-scrubber`** — a video-style bench to play, scrub, trim, and
  export-frame an animated SVG locally.
- **`svg-review`** — a local diff viewer comparing a generated SVG against an
  expected PNG (the same pixel-diff the regression suites use).

Every tool takes `--help`.

## Capture a page

The fastest way in is the `domotion` CLI. Point it at a URL or HTML file:

```bash
# Zero-install: the package ships several bins, so name the bin explicitly.
npx -p domotion-svg domotion capture https://example.com -o example.svg

# A local file, a specific viewport, only the .hero region, optimized.
domotion capture ./demo.html --width 1200 --height 600 --selector ".hero" --optimize -o hero.svg
```

Open `example.svg` in a browser — it's a complete, self-contained SVG.

## Make it move

For a multi-frame animation, write a small JSON config and run `domotion animate`:

```bash
domotion animate ./demo.json
```

```json
{
  "width": 1280,
  "height": 720,
  "frames": [
    { "input": "step1.html", "duration": 1500, "transition": { "type": "crossfade", "duration": 300 } },
    { "input": "step2.html", "duration": 1500 }
  ]
}
```

## No HTML? Start from a template

Don't want to write any HTML? Generate a polished animated SVG straight from a
template — charts, kinetic-text headlines, lower-thirds, device mockups, and
looping backgrounds, from a few flags. This is the lowest-effort way in:

```bash
domotion template chart --type column --data "42,68,55,90,34,76" \
  --labels "Jan,Feb,Mar,Apr,May,Jun" --title "Monthly signups" -o chart.svg
```

## Next steps

- [Usage](/domotion/usage/capture/) — every CLI with copy-paste examples.
- [Showcase](/domotion/showcase/) — what Domotion produces.
- [Developer docs](/domotion/developer/api/) — the API, the animate-config
  format, and building custom templates.

Run `domotion --help` or `domotion <command> --help` at any time for the
authoritative flag reference.
