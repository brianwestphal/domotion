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

## Or skip the HTML entirely

Generate a polished animated SVG from a template:

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
