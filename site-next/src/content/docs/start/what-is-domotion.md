---
title: What is Domotion?
description: Turn real HTML/CSS into one self-contained, animated SVG — accurate, scalable, embeddable anywhere, with animation and simulated interaction built in.
---

**Domotion turns real HTML/CSS into a single self-contained, animated SVG.** It
renders your markup exactly as a browser paints it, then emits one SVG file —
with optional animation and *simulated interaction* (recorded clicks, typing,
and navigation) baked in.

The output is:

- **Accurate** — a faithful reproduction of the rendered page, down to fonts:
  text is emitted as real glyph `<path>`s, so it looks identical in every
  browser.
- **Self-contained** — no external fonts, images, or scripts. It embeds with a
  plain `<img src="demo.svg">`.
- **Scalable** — vector + CSS keyframes, so it stays crisp at any size, on any
  device, and loads lazily.

It's purpose-built for **marketing and documentation demos** that need to load
fast, embed anywhere (including where video can't go), and look identical
everywhere. See [Why Domotion](/domotion/why-domotion/) for the full case, or
the [showcase](/domotion/showcase/) for what it produces.

## What you can make

- **Web app demos** — capture a whole running app and drive it like a user
  (click, type, navigate), then ship the flow as one looping SVG.
  [→ Web app demos](/domotion/usage/web-app-demos/)
- **Scroll-throughs** — pan down a long page or article as one smooth animation.
  [→ Capture](/domotion/usage/capture/)
- **Scalable screen captures** — a faithful snapshot of any page or component
  that stays crisp at any size (retina, print, projector).
  [→ Capture](/domotion/usage/capture/)
- **Animated product demos** — multi-frame flows with transitions, overlays, and
  simulated interaction. [→ Animate](/domotion/usage/animate/)
- **Templated graphics** — charts, kinetic text, lower-thirds, and device
  mockups from a few flags. [→ Templates](/domotion/usage/templates/)
- **Terminal sessions** — an asciinema recording rendered as an animated
  terminal. [→ Terminal](/domotion/usage/terminal/)
- **Composites & exports** — nest animated layers inside one another, and export
  any animated SVG to video or a still image.
  [→ Compositing](/domotion/usage/composite/) ·
  [→ Export](/domotion/usage/export/)

## Platform support

Domotion is a normal npm package that runs on **macOS, Linux, and Windows**. It
renders text by extracting real system-font glyph outlines and matching how the
browser falls back between fonts on the platform you run it on — and all three
platforms are calibrated for that. macOS is held to pixel-exact parity; Linux
and Windows match the browser's glyph selection and metrics within a small
native-hinting margin. Contributions and platform feedback are welcome on
[GitHub](https://github.com/brianwestphal/domotion).
