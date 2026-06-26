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
- `--optimize` / `--no-optimize` — the SVGO pass (`.svgz` output implies `--optimize`)
- `--chrome phone|browser|window` — wrap in a device bezel (`--chrome-label`, `--chrome-theme light|dark`)
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
