---
title: Accessibility & privacy
description: How Domotion output behaves for reduced-motion, screen readers, and privacy/CSP review — and how to label an embedded demo.
---

A Domotion SVG is a single self-contained file with **no external requests and no
scripts**. That makes it easy to host and to reason about for accessibility,
privacy, and content-security-policy review. Here's what it does, and the couple
of things you should do when you embed one.

## Reduced motion

Animated output honors **`prefers-reduced-motion: reduce`**. When a viewer has
that OS setting on, the animation pins to a static frame instead of playing:

- **`animate` / templates** cancel their transitions and show the resolved
  (post-transition) state.
- **Scroll captures** pin to the first frame (the top of the page) instead of
  scrolling.

No configuration is needed — it's built into the emitted CSS. So the same file is
motion-safe for viewers who ask for it and animated for everyone else.

## Give the embed an accessible name

Text in the output is visual capture data: it may use vector paths or `<text>`
whose characters privately address embedded glyphs, rather than preserving the
source page's semantic text. Treat it as **not readable as document text** by a
screen reader and provide an accessible name instead:

- **Embedding via `<img>` (the common case):** use the `alt` attribute, exactly
  as you would for any image.

  ```html
  <img src="demo.svg" alt="An analytics dashboard assembling itself, then a search that types itself" />
  ```

- **Inlining the `<svg>` directly in the DOM:** an `<img>` `alt` doesn't apply,
  so name the SVG itself. Pass `--title` (and optionally `--desc`) at capture
  time and Domotion emits `role="img"` plus `<title>`/`<desc>` on the root
  `<svg>`:

  ```bash
  domotion capture ./demo.html \
    --title "Analytics dashboard demo" \
    --desc "KPI cards rise in, a bar chart grows, and a search types itself" \
    -o demo.svg
  ```

  With no `--title`, the SVG carries no `role`/`title` (an image role with no name
  would be announced as an unlabeled image), so the output is unchanged.

## Privacy, offline, and CSP

The output makes **zero network requests** — subset font/glyph data and images
are embedded, and there is no JavaScript. That means:

- It works **fully offline** and inside locked-down environments.
- It's **CSP-friendly**: nothing to allowlist, no `script-src` or remote
  `img-src`/`font-src` needed for the demo itself.
- No telemetry and no third-party calls — nothing about the viewer leaves their
  browser.

See [Security & privacy](/domotion/usage/security/) for the capture-time trust
model (what happens when Domotion drives a real browser to capture your page).

## Cross-browser rendering

Because the selected glyph data travels with the SVG, playback does not depend
on the viewer's installed fonts and cannot take a different native fallback
route. Browser rasterizers may still differ slightly in antialiasing or hinting;
the captured glyph choice and positioning stay fixed.
