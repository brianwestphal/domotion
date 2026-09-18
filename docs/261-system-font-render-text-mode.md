---
id: "requirements/system-font-render-text-mode"
title: "261 — system-font render text mode"
kind: "contract"
status: "current"
owners: ["text-fonts", "rendering"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2716","DM-CAGCSM","DM-FJZQ34","DM-ZDDJAG"]
code: ["src/render/font-resolution.ts","src/render/text-to-path.ts","src/render/text.ts","src/render/vertical-text.ts","src/render/element-tree-to-svg.ts","src/cli/capture.ts","src/cli/animate-command.ts","src/cli/index.ts","src/render/system-font-mode.test.ts"]
aliases: ["docs/261-system-font-render-text-mode.md","doc-261"]
---

# 261 — system-font render text mode

`RenderTextMode` has a third value, `"system-font"`, alongside the two
pixel-faithful modes:

- `"embedded-font"` (default) — subset `@font-face` + `<text>`; self-contained,
  pixel-faithful.
- `"paths"` — glyph outlines as `<path>`; pixel-faithful.
- `"system-font"` — ordinary painted `<text>` carrying the authored
  `font-family` stack. The **consumer's installed fonts** paint it. No embedded
  subset and no outlines are emitted.

This is an **opt-in departure from Domotion's pixel-faithful contract.** It
trades fidelity for size and legibility of the markup, for consumers who know
the referenced fonts are present on the viewing machine. When a referenced font
is absent, the viewer's own font fallback paints the text — which Domotion does
not control.

## Selecting the mode

- **CLI:** `domotion capture page.html --text-mode system-font -o out.svg`. The
  flag also newly exposes the two fidelity modes on the CLI
  (`--text-mode paths`, `--text-mode embedded-font`); the default remains
  `embedded-font`. An unknown value is rejected at the CLI boundary.
- **`animate` CLI:** `domotion animate config.json --text-mode system-font`
  selects the mode for every frame of an animated capture. The mode is a
  render-side process-global set once before the animate pipeline runs, so it
  threads through the multi-frame flipbook, compressed-states runs, and the
  `--scroll` composer (which the `capture` CLI already routes through the same
  global). Same accepted values and CLI-boundary rejection as `capture`.
- **API (scoped):** `elementTreeToSvg(tree, w, h, { renderTextMode: "system-font" })`
  applies the mode for that one call via `withRenderTextMode` and restores the
  prior process-global afterward.
- **API (process-global):** `setRenderTextMode("system-font")` /
  `withRenderTextMode("system-font", fn)`. The mode is a render-side
  process-global; prefer `withRenderTextMode` for a scoped change so a temporary
  value cannot leak into later renders.

## Emitted representation

Each captured text run becomes one `<text>`:

- `font-family` is the authored CSS family stack exactly as captured
  (`capturedFontFamilyCss(...)`), so the viewer's browser resolves it against
  its own fonts — including the generic fallback (`sans-serif`, …).
- `font-size`, plus `font-weight` / `font-style` / `font-stretch` when
  non-default, and `font-variation-settings` when the run set variation axes.
- `fill` is the captured paint color. `-webkit-text-stroke` maps to
  `stroke` / `stroke-width` (+ `paint-order`).
- No embedded font, no glyph `<path>`, no per-glyph position list.

### Positioning is run-anchor-only

Each run emits only its captured origin `x` and its alphabetic baseline
(`y + ascent`, using Chrome's captured `fontBoundingBoxAscent` when available,
else a size-relative approximation so the mode never loads a font file). The
viewing browser then **reflows** the run with the system font's own
metrics/kerning. Consequently, **horizontal positions drift from the capture
whenever the viewer's font differs from the capture host's.** This is the
accepted cost of not embedding the font; per-character position lists are
deliberately not emitted.

### Bidi is the browser's job

The other modes keep text in logical order and place each glyph with captured
per-character offsets, mirroring paired brackets themselves
(`applyBidi` / `applyBidiAt` in `text.ts`). In `system-font` mode there are no
per-character offsets, so those functions skip their mirroring and hand the
browser untouched logical text; the emitted `direction` / `unicode-bidi` drive
the browser's own UAX #9 reordering and mirroring.

An rtl run additionally emits **`text-anchor="end"`** (DM-CAGCSM). The run's
captured origin `x` is its visual-*left* edge, but SVG's default
`text-anchor: start` anchors the text's *start* — which, under `direction: rtl`,
is the *right* edge. Left unset it would place the run's right edge at its left
edge, shifting the whole run left by its width and overlapping its neighbour;
`text-anchor="end"` anchors the run's visual-left (the end, in rtl inline order)
where it was captured. Verified by rasterization against Chrome for Hebrew+Latin,
Arabic contextual joining, and paired-bracket mirroring; ltr runs emit no
`direction` and are unaffected.

## Limitations (accepted for this mode)

- **Fonts must be present on the viewer.** Absent fonts fall back to whatever
  the viewer's browser chooses. This mode makes no fidelity guarantee.
- **Positional drift** under font substitution, as above.
- **Complex-script fidelity depends on the viewer's shaping**, not Domotion's:
  synthetic dotted circles, contextual joining, and mark positioning are
  produced by the viewer's own HarfBuzz over the source text, not reproduced
  from the capture. RTL run *ordering, mirroring, and anchoring* are correct (the
  browser's UBA plus the `text-anchor="end"` fix above); only the inter-run
  horizontal spacing carries the general positional drift, as for ltr.
- **Vertical writing modes are supported** (DM-ZDDJAG). A `writing-mode:
  vertical-*` run is emitted as **one** authored `<text>` carrying the captured
  `writing-mode` and `text-orientation` (`renderVerticalSystemFontText`), so the
  viewing browser lays out the column itself — upright CJK stays upright and
  **sideways/rotated glyphs** (`text-orientation: sideways`, Latin in vertical
  text) are rotated by the browser, matching Chrome. It is one
  selectable/searchable run, not per-glyph text. Positioning is run-anchored and
  browser-reflowed, the same best-effort contract as horizontal runs (above), so
  the column's exact placement can drift when the viewer's font differs.
- Text **decorations** (underline/line-through/overline) continue to be emitted
  as Domotion's geometric SVG lines, unchanged — they are computed outside the
  text-emit funnel.

## Relationship to the real-text layer (docs 260)

Independent and composable. `--real-text` adds a *paintless* authored `<text>`
layer for search/selection/accessibility over any visible-glyph mode;
`--text-mode system-font` changes how the *visible* text is painted. In
`system-font` mode the visible `<text>` is itself authored text, so a viewer can
already select/search it.
