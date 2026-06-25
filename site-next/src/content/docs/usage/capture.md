---
title: Capture a page
description: domotion capture — one frame of a URL, HTML file, or HAR archive as a self-contained SVG.
---

`domotion capture <input>` captures a single frame. `<input>` is a URL, a local
`.html` file, `-` for stdin, or a `.har` archive.

```bash
domotion capture https://example.com -o out.svg
domotion capture ./card.html -o card.svg --width 1200 --height 630 --selector ".hero"
cat page.html | domotion capture - -o page.svg
```

## Useful flags

- `--width N` / `--height N` — viewport (default 800×600)
- `--selector <css>` — capture one element (default `body`)
- `--clip x,y,w,h` — capture a sub-region
- `--wait-for <css>` / `--wait <ms>` — readiness
- `--color-scheme light|dark` · `--mobile`
- `--optimize` — run the SVGO pass
- `--chrome phone|browser|window` — wrap in a device bezel (`--chrome-label`, `--chrome-theme`)
- `--debug` — write a reproduction bundle for `svg-review`

## Animated scroll, in one capture

`--scroll "<pattern>"` captures a long page at successive scroll offsets and
composes one scrolling SVG:

```bash
domotion capture ./long-page.html --scroll "down:bottom/8s" -o scroll.svg
```

Tune with `--scroll-speed <px/s>` and `--scroll-selector <css>` for an inner
scroller.

Run `domotion capture --help` for the full list.
