---
title: Capture a page
description: domotion capture — one frame of a URL, HTML file, or HAR archive as a self-contained SVG.
---

`domotion capture <input>` captures a single frame. `<input>` is a URL, a local
`.html` file, `-` for stdin, or a `.har` archive.

```bash
# A live URL → a self-contained SVG.
domotion capture https://example.com -o out.svg

# One element of a local HTML file, at a social-card viewport.
domotion capture ./card.html -o card.svg --width 1200 --height 630 --selector ".hero"

# From stdin.
cat page.html | domotion capture - -o page.svg
```

## Self-contained by default

The captured SVG embeds everything it needs — fonts as glyph `<path>`s and images
(including remote and cross-origin ones) as inline data URIs — so it has no
external requests and works offline, in email, or under a strict CSP. Pass
`--no-embed-images` to leave `<img>` and background images as external URL
references instead (a smaller file, but no longer self-contained).

## Bring your design mock

You don't need a running app to make a demo. If you have a static mock — a
component-library page, a hand-built HTML/CSS screen, or an HTML export from your
design tool — point `capture` straight at the file:

```bash
domotion capture ./mockup.html -o mockup.svg --width 1440 --height 900
```

The capture is pixel-faithful to how Chromium paints your markup, so the SVG
looks exactly like your mock. From there, wrap it in a
[device mockup](/domotion/usage/templates/) or turn a few states into an
[animated flow](/domotion/usage/animate/) to bring it to life — no re-drawing, no
re-export.

## The review loop

Capture, then look at the pixels with the bundled `svg-to-image`:

```bash
domotion capture ./card.html -o card.svg
svg-to-image card.svg -o card.png
```

## Useful flags

- `--width N` / `--height N` — viewport (default 800×600)
- `--selector <css>` — capture one element (default `body`)
- `--clip x,y,w,h` — capture a sub-region
- `--scroll-to x,y` — scroll the page to an offset before capturing
- `--wait <ms>` (default 200) / `--wait-for <css>` — readiness
- `--color-scheme light|dark` · `--mobile`
- `--format <preset|WxH>` — size the viewport to a social preset: `reel` (1080×1920), `square` (1080×1080), `portrait` (1080×1350), or `landscape` (1920×1080) — or a literal `WIDTHxHEIGHT`. Add `--safe-guide` to overlay the safe-area margins.
- `--brand <file.json>` — theme the captured page by injecting the brand kit's CSS custom properties (`--brand-primary`, `--brand-background`, `--brand-font-family`, …) onto `:root` before it paints, so a page authored against `var(--brand-*)` picks up the brand at capture time.
- `--optimize` / `--no-optimize` — the SVGO pass (`.svgz` output implies `--optimize`)
- `--chrome phone|browser|window` — wrap in a device bezel (`--chrome-label`, `--chrome-theme light|dark`)
- `--cross-origin-frames <hosts>` — recurse cross-origin `<iframe>`s into native SVG (see below)
- `--debug` — write a reproduction bundle for `svg-review`

A `.har` input is replayed offline (every asset must be in the archive unless
you pass `--har-fallback`); `--url <page>` overrides the inferred document URL.

## Animated scroll, in one capture

`--scroll "<pattern>"` captures a long page at successive scroll offsets and
composes one scrolling SVG:

```bash
domotion capture ./long-page.html --scroll "down:bottom/8s" -o scroll.svg
```

Tune with `--scroll-speed <px/s>` and `--scroll-selector <css>` for an inner
scroller; `--no-prescroll` skips the lazy-load warm-up pass.

## Iframes

A same-origin `<iframe>` is recursed into the capture — its document is walked
with the same logic and spliced in as native, crisply-scaling SVG
(clipped to the iframe's content box), not flattened to a raster snapshot.

A cross-origin frame stays a raster `<image>` by default (its document isn't
readable under the Same-Origin Policy). Opt in for hosts you trust with
`--cross-origin-frames`, which launches Chromium with web security disabled so
those documents become readable:

```bash
# Recurse cross-origin frames from these hosts (else "*" for all).
domotion capture ./embed.html --cross-origin-frames "youtube.com,localhost:3000" -o embed.svg
```

Only enable it for pages you trust — disabling web security also turns off CORS
for the whole capture session (the CLI prints a warning to that effect).

## Debug bundle

`--debug` writes `<output>.debug/` (override with `--debug-dir <path>`)
containing `capture.har`, `expected.png` (Chrome's screenshot of the source),
`actual.svg`, and `captured-tree.json` — a turnkey reproduction the CLI tells
you how to open in `svg-review`:

```bash
domotion capture ./card.html -o card.svg --debug
# → svg-review --expected card.debug/expected.png --actual card.debug/actual.svg
```

Run `domotion capture --help` for the full list.
