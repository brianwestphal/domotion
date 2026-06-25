---
title: Why Domotion
description: The case for shipping animated demos as self-contained SVGs instead of video, GIFs, or screenshots.
---

Animated product demos usually mean a heavy MP4, a low-quality GIF, a fragile
live iframe, or a stack of screenshots. Domotion gives you one self-contained
animated SVG instead. Here's why that's worth it.

## It embeds where video can't

A `<img src="demo.svg">` works in places a `<video>` doesn't: **GitHub READMEs
and npm package pages**, Markdown docs, email, PDFs, slide decks, and anywhere a
content-security-policy blocks external media or scripts. The SVG carries no
external assets — no font files, no image requests, no JavaScript — so it can't
be blocked, can't 404 a dependency, and works fully offline.

## Tiny next to video

A short screen-recording is often hundreds of KB to several MB of H.264. The
same demo as a Domotion SVG is typically tens of KB, because it ships vectors and
CSS keyframes, not pixels-per-frame. Smaller payloads mean faster pages and
cheaper bandwidth — and it lazy-loads like any other image.

## Resolution-independent — render once, fits every device

A raster video is baked at one resolution; retina, 4K, and print make it look
soft, and "supporting" them means re-encoding multiple sizes. An SVG is
resolution-independent: the **same file** is razor-sharp on a phone, a 5K
display, a projector, and on paper — no re-render, no re-compress, no `@2x` set.

## Real, accessible text

Because text is captured as actual glyph outlines (and carries an `alt`), the
output is crisp at any zoom and reads identically in every browser — no font
loading, no fallback flash, no hinting differences. It's an image that respects
how the page was actually painted.

## Repeatable — for demos *and* testing

A demo is defined by a small JSON config (or a script), so regenerating it after
a UI change is one command, not a re-record. The output is **deterministic**, so
you can commit it, **diff it in version control**, and review changes like code.
The same capture pipeline doubles as a visual-regression signal.

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
