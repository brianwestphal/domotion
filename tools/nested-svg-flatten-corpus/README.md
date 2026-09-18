# Nested-`<svg>` flatten — design-tool import corpus (DM-X6GGXV)

Purpose: decide **how far** Domotion's opt-in nested-`<svg>` flattener
(`--flatten-nested-svg`, DM-K0S6ZS / DM-7AN9AH) has to go to actually help the
design tools that motivated it (Sketch, and others that mishandle a nested
`<svg>` element on import).

Regenerate the fixtures with `node tools/nested-svg-flatten-corpus/generate.mjs`.

## Fixtures

Each dimension has a `-nested.svg` (an outer SVG wrapping a nested `<svg
viewBox width height>` — what Domotion emits **by default**) and, where Domotion
can flatten it, a `-flat.svg` (the `<g transform="matrix(...)">` form Domotion
emits with `--flatten-nested-svg`).

| # | dimension | Domotion flattens it? |
|---|---|---|
| 01 | plain nested `<svg>` (path + circle) | **yes** |
| 02 | nested `<svg>` + `<clipPath>` | **yes** |
| 03 | nested `<svg>` + `<use>` / `<symbol>` | no — gated (stays nested) |
| 04 | nested `<svg>` + `<style>` element selector | no — gated (stays nested) |
| 05 | nested `<svg>` + `<filter>` | **yes** |

The flattener gates 03/04 because `<use>`/`<symbol>` establish their own
viewports and an element-selector `<style>` would leak into the outer document
(both tracked for widening in DM-6NT73F).

## Headless data point (already collected)

librsvg (`rsvg-convert`, the GNOME/Cairo SVG renderer used by many non-browser
tools) renders `-nested` and `-flat` **pixel-identically** for 01/02/05 — as
expected, flattening is spec-preserving. Chrome does too (proved in
`tests/svg-flatten-nested.e2e.test.ts` / `tests/svg-flatten-inline-dom.e2e.test.ts`).
So the question is **not** correctness; it is whether specific **design tools'
importers** choke on the nested-`<svg>` element (and on the extra features).

## Manual procedure (needs the GUI design tools)

For each tool (Sketch, Figma, Illustrator, Inkscape):

1. Open `01-nested-only-nested.svg`. Does the icon import correctly, or is it
   blank / mis-sized / un-editable? Then open `01-nested-only-flat.svg` — does
   the `<g transform>` form import **better**?
2. Repeat for 02 and 05 (nested vs flat) to see if flattening the wrapper is
   enough when a `<clipPath>` / `<filter>` is also present.
3. Open `03-use-symbol-nested.svg` and `04-style-nested.svg` (nested only) to see
   whether the tool ALSO mishandles `<use>`/`<symbol>` and `<style>` — i.e.
   whether Domotion would need to expand those (DM-6NT73F) for the tool to import
   cleanly, or whether flattening the viewport wrapper alone already helps.

Record per tool:

| tool | 01 nested | 01 flat | 02 nested | 02 flat | 05 nested | 05 flat | 03 use | 04 style |
|---|---|---|---|---|---|---|---|---|
| Sketch | | | | | | | | |
| Figma | | | | | | | | |
| Illustrator | | | | | | | | |
| Inkscape | | | | | | | | |

## Decision this feeds

- If flattening the wrapper alone (01/02/05 flat) imports cleanly everywhere the
  nested form fails → ship `--flatten-nested-svg` as-is; DM-6NT73F is optional.
- If tools also choke on `<use>`/`<symbol>`/`<style>` (03/04) → DM-6NT73F
  (expand `<use>`/`<symbol>`, inline/scope `<style>`) is required for those SVGs
  to import, and the flattener should be extended before it's recommended for
  sprite/style-heavy sources.
