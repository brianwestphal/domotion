---
title: Security & privacy
description: What a Domotion SVG contains (inert, self-contained), the capture-time trust model, and the tool's dependency footprint — the facts a security review needs.
---

This page is written for a security or compliance reviewer clearing Domotion for
use. It covers the output artifact, what happens during capture, and the tool's
dependency footprint.

## The output is inert and self-contained

A Domotion SVG contains **no executable code**. There is no `<script>`, no event
handlers (`onload`, `onclick`, …), and no `<foreignObject>` running HTML/JS — just
static SVG markup plus CSS `@keyframes` for animation. It also makes **no external
requests**: fonts are embedded as glyph `<path>`s, images are inlined as data
URIs, and nothing is fetched at view time.

In practice that means the artifact is:

- **Safe to host** — SVG is a known XSS vector *when it carries scripts*; Domotion
  output carries none, so it can be served as a static asset.
- **CSP-friendly** — no `script-src`, no remote `img-src`/`font-src`, nothing to
  allowlist for the demo to render.
- **Offline / air-gap friendly** — it renders with no network at all.

## Capture-time trust model

Producing the SVG is separate from viewing it. To capture, Domotion drives a real
headless **Chromium** (via Playwright) and renders the page you point it at — so
**during capture** it will fetch whatever that page references (scripts, fonts,
images, XHR). Two things follow:

- **Capture the pages you trust.** Treat the input page as you would treat running
  it in your own browser. Cross-origin `<iframe>` recursion is opt-in and, when
  enabled, launches Chromium with web security (CORS) **disabled** — only use it
  on trusted pages. See [Capture a page](/domotion/usage/capture/) for that flag's
  warning.
- **Whatever is visible is baked in.** The captured DOM is serialized into the
  SVG, so anything on the page — tokens, PII, secrets shown in the UI — becomes
  part of the output. Capture from a state that's safe to publish, and review the
  artifact before sharing it.

## Dependency footprint

Domotion is an npm package (`domotion-svg`). Its main security-relevant
dependencies:

- **Playwright + a bundled Chromium** — Domotion auto-installs Chromium on first
  use. This is a large, security-relevant dependency; pin and audit it as you
  would any browser automation tool.
- **ffmpeg** — required only for `svg-to-video` (video export); not needed to
  capture or render SVGs.
- Rendering/runtime libraries: `fontkit`, `harfbuzzjs`, `sharp`, `svgo`,
  `node-pty` (terminal capture).

## License & contact

Domotion is **MIT-licensed** ([LICENSE](https://github.com/brianwestphal/domotion/blob/main/LICENSE)) —
free for commercial use, with no attribution required in the output. Report
security issues via the [GitHub repository](https://github.com/brianwestphal/domotion).
