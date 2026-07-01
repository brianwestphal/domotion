---
title: Why Domotion
description: The case for shipping animated demos as self-contained SVGs instead of video, GIFs, or screenshots.
---

Animated product demos usually mean a heavy MP4, a low-quality GIF, a fragile
live iframe, or a stack of screenshots. Domotion gives you one self-contained
animated SVG instead. Here's why that's worth it.

## How it compares

|                                    |  Domotion SVG  | Screen recording (MP4) |    GIF    |    Lottie    | Live iframe | Hand-built CSS |
| ---------------------------------- | :------------: | :--------------------: | :-------: | :----------: | :---------: | :------------: |
| Typical payload                    |    tens of KB    |           MB           |   large   | small–medium | page weight |     small      |
| Crisp at any size                  |       ✓        |           ✗            |     ✗     |      ✓       |      ✓      |       ✓        |
| Embeds as a plain `<img>`          |       ✓        |           ✗            |     ✓     |      ✗       |      ✗      |       ✗        |
| Offline / CSP-safe, no runtime     |       ✓        |           ✓            |     ✓     |      ✗       |      ✗      |       ✓        |
| Regenerate from source             |  one command   |       re-record        | re-record |      ~       |      ✓      |       ✓        |
| Animation & simulated interaction  |       ✓        |           ✓            |     ✓     |      ✓       |      ✓      |    limited     |
| Authoring effort                   |      low       |          low           |    low    |     high     |   medium    |      high      |

Domotion's trade-off: it's raster-faithful to Chromium's paint rather than a
live DOM, and animation plays wherever CSS runs (see below). In exchange you get
one dependency-free file that looks identical everywhere.

## It embeds where video can't

A `<img src="demo.svg">` drops into places a `<video>` can't — Markdown docs,
slide decks, PDFs, and anywhere a content-security-policy blocks external media
or scripts. The SVG carries no external assets — no font files, no image
requests, no JavaScript — so it can't be blocked, can't 404 a dependency, and
works fully offline.

Where the CSS animation actually _plays_ depends on the host. It animates in any
real browser: your docs site, a landing page, GitLab, self-hosted HTML. A few
surfaces sanitize SVG and show a **static first frame** instead — GitHub READMEs
and npm package pages proxy and strip the animation, and many email clients drop
SVG entirely. For those, export a crisp static frame, a GIF, or an MP4 (see
[Export to video / image](/domotion/usage/export/)). Either way it stays one
self-contained file with no external dependencies.

## Tiny next to video

A short screen-recording is often hundreds of KB to several MB of H.264. The
same demo as a Domotion SVG is typically **tens of KB**, because it ships vectors
and CSS keyframes, not pixels-per-frame. Smaller payloads mean faster pages — a
real Core Web Vitals / LCP win versus a heavy autoplay video or GIF above the
fold — and cheaper bandwidth, and it lazy-loads like any other image.

## Resolution-independent — render once, fits every device

A raster video is baked at one resolution; retina, 4K, and print make it look
soft, and "supporting" them means re-encoding multiple sizes. An SVG is
resolution-independent: the **same file** is razor-sharp on a phone, a 5K
display, a projector, and on paper — no re-render, no re-compress, no `@2x` set.

## Pixel-faithful text, identical everywhere

Text is captured as actual glyph outlines, so the output is crisp at any zoom and
renders identically in every browser — no font loading, no fallback flash, no
hinting differences. It's an image that respects how the page was actually
painted. Because the glyphs are vector paths, the text isn't selectable or
searchable when embedded via `<img>`; give the image an `alt` for accessibility,
or inline the `<svg>` if you need the underlying text in the DOM.

## Repeatable — for demos *and* review

A demo is defined by a small JSON config (or a script), so regenerating it after
a UI change is one command, not a re-record. On the same platform, the same input
produces the same output byte-for-byte, so you can commit the SVG, **diff it in
version control**, and review rendering changes like code.

Output is calibrated per platform — macOS is pixel-exact, while Linux and Windows
match within a small native-hinting margin — so regenerate baselines on the same
OS you commit from. That makes a captured demo a usable **golden fixture** for
catching unintended rendering drift, though Domotion itself doesn't ship a
pass/fail visual-diff for your own app.

## Themeable and composable

Transparent backgrounds round-trip, so a demo drops onto any host background.
Dark/light captures come from the same source. And because each demo is just an
SVG, you can **composite** them — nest an animated terminal inside an animated
desktop, place a scrolling site inside a browser bezel — without re-shooting.

## Built for the AI era

Domotion is driven by a declarative config and a documented design playbook, so
an AI agent can author, render, *look at the pixels*, and iterate on a demo
end-to-end. See [Using AI to drive Domotion](/domotion/developer/using-ai/).

---

Ready to try it? Head to the [quick start](/domotion/start/quickstart/), or see
what it produces in the [showcase](/domotion/showcase/).
