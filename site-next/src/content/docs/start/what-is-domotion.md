---
title: What is Domotion?
description: A DOM-to-animated-SVG renderer — capture real HTML/CSS as it paints in Chromium and emit one self-contained animated SVG.
---

**Domotion is a DOM-to-animated-SVG renderer.** It captures HTML/CSS rendered in
headless Chromium and converts the captured tree into a single self-contained SVG
with optional CSS animations.

The output is:

- **Pixel-faithful** to what Chromium painted — text is emitted as real glyph
  `<path>`s, so it looks identical across browsers.
- **Self-contained** — no external fonts, images, or scripts. It embeds with a
  plain `<img src="demo.svg">`.
- **Scalable** — vector + CSS keyframes, so it stays crisp at any size and loads
  lazily.

It's purpose-built for **marketing and documentation demos** that need to load
fast, embed anywhere (including where video can't go), and look identical
everywhere. See [Why Domotion](/domotion/why-domotion/) for the full case, or
the [showcase](/domotion/showcase/) for what it produces.

## What you can make

- **Single-frame captures** of a page or component (`domotion capture`).
- **Multi-frame animations** with transitions, overlays, and recorded
  interactions (`domotion animate`).
- **Templates** — polished animated SVGs from a few flags (`domotion template`).
- **Terminal sessions** from asciinema recordings (`domotion term`).
- **Composites** — animated layers nested inside animated layers
  (`domotion composite`).
- **Exports** — render any animated SVG to video (`svg-to-video`) or a still
  image (`svg-to-image`).

## Status & platform support

Domotion is an early-stage npm package. It's designed to work on macOS, Linux,
and Windows, but today the font-fidelity calibration is **only complete on
macOS** — the package installs and runs everywhere, but text rendering on
Linux/Windows isn't yet as faithful. Contributions welcome on
[GitHub](https://github.com/brianwestphal/domotion).
