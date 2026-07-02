# 87 — Format presets (social aspect ratios)

**Status: shipped (DM-1521 design → DM-1534 impl → DM-1537 safe-area reflow →
DM-1538 capture/animate → DM-1541 adaptive scaling).** The `FORMATS` table +
`resolveFormat` + `--format` on `domotion template` + `safeInset` plumbing are
built and tested (`src/templates/formats.ts`). A DM-1519 follow-up: creators
think in **formats** (reel, square, story), not `width × height`. A single
`--format` flag produces a platform-ready canvas.

Related docs: [90 — `--format` on capture/animate](./90-format-on-capture.md)
(viewport sizing + device-frame interaction + the informational `--safe-guide`),
and [91 — adaptive format scaling](./91-adaptive-format-scaling.md) (per-ratio
type scaling so a landscape-tuned headline reads well at 9:16).

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
- Templates read `safeInset` for content placement. The canvas + inset plumbing
  landed in DM-1534; **DM-1537 wired each themeable built-in to lay its content
  out within `canvas − safeInset`** — the flex templates (lower-third,
  kinetic-text, subscribe, chat) via `safeAreaPadding` (per-side max of the
  template's own padding and the inset), and `chart` by planning against the inner
  dimensions inside a positioned safe-rect wrapper. Without a format the layout is
  byte-identical (the inset path is opt-in). Deeper *responsive font scaling /
  stacking / line-count* per ratio is still a further refinement.

## Composition

- **Brand kit (DM-1522):** orthogonal — format = canvas, brand = look. Compose:
  `--brand acme.json --format reel`.
- **Creative template pack (DM-1523):** the text cards especially need to reflow
  well vertically; that per-template work rides the reflow follow-up.
- **UI playground (DM-1520):** a format dropdown driven by the same `FORMATS`.

## Follow-up tickets

- **Implement format presets** — ✅ done (DM-1534): the `FORMATS` table +
  `resolveFormat` + `applyFormatSize` + `--format` on `template` + `safeInset` on
  the render context + unit tests + demos (`examples/templates-demo.ts`:
  `format-reel-kinetic`, `format-square-chart`).
- **Per-template responsive reflow** — ✅ v1 done (DM-1537): the themeable
  built-ins now confine content to `canvas − safeInset` (via `safeAreaPadding` for
  the flex templates + an inner-dimension safe-rect wrapper for `chart`), with an
  e2e assertion that content lands within the safe rect at 9:16.
- **`--format` on `capture` / `animate`** — ✅ done (DM-1538): sizes the capture
  viewport via the same `resolveFormat` + precedence; device-frame-aware (format
  sizes the inner screen, bezel wraps it); `safeInset` on a raw capture is the
  informational `--safe-guide` overlay, not a reflow; threaded into `animate`'s
  template frames. See [docs/90](./90-format-on-capture.md).
- **Adaptive per-ratio font/line scaling** — ✅ done for the creative-pack text +
  number cards (DM-1541): a `formatScaleFactor` derived from the safe-area
  dimensions enlarges landscape-tuned type so it reads at 9:16 (number cards are
  width-capped so a fixed-width value never overflows). See
  [docs/91](./91-adaptive-format-scaling.md). Extended to `chart` (title / axis /
  value-label type + bar-thickness cap) in DM-1560. Remaining: the other themeable
  built-ins (`kinetic-text` / `lower-third` / `chat` / `subscribe`) and per-ratio
  layout _restructuring_ (not just scaling).
