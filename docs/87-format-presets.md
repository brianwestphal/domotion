# 87 — Format presets (social aspect ratios)

**Status: design (DM-1521).** Implementation tracked in follow-ups. A DM-1519
follow-up: creators think in **formats** (reel, square, story), not `width ×
height`. A single `--format` flag should produce a platform-ready canvas.

## Goal

```sh
domotion template title-card --format reel   --title "Launch day"   # → 1080×1920
domotion template chart      --format square --data "12,19,7,25"    # → 1080×1080
```

One flag sets the **canvas size** and a sensible **safe-area inset**, so output
drops straight into the target surface without manual sizing.

## Presets

| Name | Size (px) | Ratio | Use |
|---|---|---|---|
| `reel` / `story` | 1080 × 1920 | 9:16 | vertical (IG/TikTok/Shorts/Stories) |
| `square` | 1080 × 1080 | 1:1 | feed square |
| `portrait` | 1080 × 1350 | 4:5 | feed portrait |
| `landscape` | 1920 × 1080 | 16:9 | YouTube / web hero |
| `WxH` | explicit | — | e.g. `--format 1600x900` |

`--format` accepts a preset name **or** a raw `WIDTHxHEIGHT`. Sizes are the 1×
authoring canvas; the SVG scales to any display size (and `--scale` / the video
export set raster resolution independently).

## Precedence

```
explicit --width/--height  >  --format preset  >  template default size
```

Explicit `--width`/`--height` still win (and can override one axis of a preset).
`--format` only supplies the canvas defaults.

## Safe-area insets

Each preset carries a **safe-area inset** (px) — vertical formats reserve
top/bottom room for platform UI (caption bars, action rails). v1 exposes the
inset to templates as a resolved `safeInset {top,right,bottom,left}`; templates
lay their content out within `canvas − safeInset` rather than the raw canvas.
Reasonable v1 defaults: reel/story ≈ 12% top / 18% bottom, others ≈ 6% all
around. (Tunable; not a platform-exact spec.)

## Implementation shape

- A `resolveFormat(fmt): { width, height, safeInset }` helper + a `FORMATS` table
  (shared, exported for the UI playground DM-1520).
- `--format` flag on `domotion template` (and later `capture`/`animate`). It sets
  the width/height a template receives (merged **before** the template's own
  defaults, same precedence machinery as the brand kit DM-1522) and passes
  `safeInset` into the render context.
- Templates read `safeInset` for content placement. **v1 lands the canvas + inset
  plumbing + has each template at least not overflow at 9:16**; per-template
  *responsive reflow* (font scaling, stacking, line-count) is a follow-up so the
  first cut isn't blocked on tuning every template for every ratio.

## Composition

- **Brand kit (DM-1522):** orthogonal — format = canvas, brand = look. Compose:
  `--brand acme.json --format reel`.
- **Creative template pack (DM-1523):** the text cards especially need to reflow
  well vertically; that per-template work rides the reflow follow-up.
- **UI playground (DM-1520):** a format dropdown driven by the same `FORMATS`.

## Follow-up tickets

- **Implement format presets** (the `FORMATS` table + `resolveFormat` +
  `--format` on `template` + `safeInset` in the render context + tests + demos in
  a couple of formats).
- **Per-template responsive reflow** (each template scales/stacks within
  `safeInset` at each ratio — lower-third, kinetic-text, chart, the DM-1523 pack).
- **`--format` on `capture` / `animate`** (viewport sizing + device-frame-aware).
