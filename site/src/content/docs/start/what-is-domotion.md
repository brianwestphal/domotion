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
  the exact captured glyph data and positioning are embedded, so playback does
  not fall back to fonts installed on the viewer's machine.
- **Self-contained** — no external fonts, images, or scripts. It embeds with a
  plain `<img src="demo.svg">`.
- **Scalable** — vector + CSS keyframes, so it stays crisp at any size, on any
  device, and loads lazily.

It's built for **product, documentation, marketing, and teaching demos** that
need to load fast, embed anywhere (including where video can't go — a README, a
slide deck, or an LMS lesson, offline), and remain faithful without depending on
the viewer's font inventory. See
[Why Domotion](/domotion/why-domotion/) for the full case, or the
[showcase](/domotion/showcase/) for what it produces.

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
  terminal (great for teaching CLI workflows in a tutorial or course — the
  commands stay crisp and the file works offline in an LMS).
  [→ Terminal](/domotion/usage/terminal/)
- **Composites & exports** — nest animated layers inside one another, and export
  any animated SVG to video or a still image.
  [→ Compositing](/domotion/usage/composite/) ·
  [→ Export](/domotion/usage/export/)

## Platform support

Domotion is a normal npm package that runs on **macOS, Linux, and Windows**. It
extracts the glyphs Chromium selected through CoreText, fontconfig, or
DirectWrite and embeds them in the output; the viewer's native font fallback is
never part of playback. All three capture platforms are calibrated. macOS is
held to pixel-exact parity; Linux and Windows match Chromium's glyph selection
and metrics within a documented native-hinting margin. Contributions and
platform feedback are welcome on
[GitHub](https://github.com/brianwestphal/domotion).

## Maturity & license

Domotion is **MIT-licensed** and free for commercial use. It's actively
developed and exercised by an extensive cross-platform visual-regression suite.
Linux fidelity is a required CI check; macOS is the primary calibration target;
Windows uses first-class native and release validation, with its slower broad
suites dispatched on demand. The output itself is
inert and self-contained (no scripts, no external requests), which keeps it easy
to host and to clear through a security or CSP review.
