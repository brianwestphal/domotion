# 97 — Caret shapes (bar / block / underscore)

## Summary

The simulated-typing surfaces — the `typing` overlay and the `typeResample` re-capture caret — can draw the insertion caret in any of the three shapes Blink models via its `CaretShape` enum and the CSS `caret-shape` property (DM-1591):

- **`bar`** — a thin vertical bar spanning the font box (the text default).
- **`block`** — a box one character-cell wide, painted **translucent** over the cell (the terminal / retro look).
- **`underscore`** — a thin horizontal bar sitting on the baseline.

`typeResample` additionally **honors the captured field's own computed `caret-shape`** by default, so a page that styles an input with `caret-shape: block` re-samples with a block caret without the author restating it.

## Motivation

Blink draws three caret shapes and exposes `caret-shape` (Chromium 147 supports `bar` / `block` / `underscore` / `auto`). Domotion previously drew every simulated caret as a bar. Authors building a terminal/retro demo, or capturing a field that deliberately uses a block/underscore caret, had no way to match it.

The caret only paints in Blink when the window has OS focus, so it never appears in a headless capture screenshot — these surfaces are **author-driven animations**, not pixel-compared against a Chrome caret. That means the geometry is spec-faithful rather than pixel-calibrated.

## Geometry (`src/animation/caret-metrics.ts`)

`caretShapeRect()` is the single shared source of caret geometry, used by both surfaces so a bar/block/underscore caret is identical wherever it's drawn. Given the caret x, the text baseline, the font's exact ascent/descent (DM-1590), and the insertion-cell width:

| shape | x | y | width | height | opacity |
|---|---|---|---|---|---|
| `bar` | caret x | baseline − ascent | `barWidthPx` (2, or 1.5 for `typeResample`) | ascent + descent | 1 |
| `block` | caret x | baseline − ascent | one cell | ascent + descent | **0.5** |
| `underscore` | caret x | baseline | one cell | `≈ fontSize / 12` (≥1px) | 1 |

- **Block alpha `0.5`** mirrors Blink's `color_.SetAlpha(0.5)` in `caret_display_item_client.cc`, so the glyph shows through the block.
- **Cell width** is the advance of the character the caret sits on. At the insertion point (end of typed text) there is no next character, so it uses the **space advance** in the caret's font — a natural "empty cell", matching editor/terminal block cursors.
- **Underscore** sits *on* the baseline (top of the bar at the baseline), `≈ 1/12 em` thick with a 1px floor.

## Authoring

### `typing` overlay

`caret` accepts a `shape` alongside the existing `color` / `width` / `blinkMs`:

```jsonc
{ "kind": "typing", "text": "npm run build", "x": 40, "y": 120,
  "caret": { "shape": "block", "color": "#58ff9b" } }
```

`shape` defaults to `bar`. The caret still rides the growing text edge and blinks.

### `typeResample`

`caretShape` on the `typeResample` config:

```jsonc
{ "typeResample": { "selector": "#terminal", "text": "ls -la", "caretShape": "block" } }
```

- **`"auto"` (default)** — honor the field's computed CSS `caret-shape` (Blink resolves `auto` → a bar for text).
- **`bar` / `block` / `underscore`** — force that shape regardless of the field's CSS.

The `typeResample` caret is a `blink` overlay; a block caret sets the overlay's new `fillOpacity: 0.5` (also added to the `blink` overlay schema).

## Not covered

- **Static (non-typing) captures** don't draw a caret at all — the caret only appears on the animated typing surfaces. A focused input in a plain capture has no caret in either Chrome's headless screenshot or Domotion's output, so there's nothing to honor there.
- The **terminal renderer** already draws a block cursor (`buildCursor`, `src/terminal/incremental.ts`, full cell at ~0.7 alpha) — its own convention, unchanged by this feature.

## Testing / demos

- `src/animation/caret-metrics.test.ts` — `caretShapeRect` geometry per shape (bar/block/underscore, cell-width clamp, underscore thickness/baseline).
- `src/cli/type-resample.test.ts` — `caretShape` defaulting to `auto` + forced shapes.
- `examples/animate/caret-shapes/` — a committed golden demo cycling a bar, block, and underscore caret (wired into `tests/animate-examples.tsx`). Verified by rasterizing the SVG: the block reads as a translucent box, the underscore as a thin baseline bar.

## Files

- `src/animation/caret-metrics.ts` — `CaretShape`, `caretShapeRect`, `BLOCK_CARET_ALPHA`, `underscoreCaretThicknessPx`.
- `src/animation/animator.ts` — `buildTypingCaret` honors `caret.shape`; `renderBlinkOverlay` emits `fill-opacity`.
- `src/animation/overlay-schema.ts` — `caret.shape` on the typing overlay; `fillOpacity` on the `blink` overlay.
- `src/cli/type-resample.ts` — `measureCaret` reads the field's `caret-shape` + applies the shape; `caretShape` on the spec.
- `src/cli/animate.ts` — `caretShape` on the `typeResample` config schema.
