# 91 — Adaptive format scaling (per-ratio type)

**Status: shipped for the creative-pack text + number cards (DM-1541).** A
follow-up to DM-1537 (which confined a themeable built-in's content within
`canvas − safeInset`). Confining content makes it _fit_ a 9:16 reel; it does not
make it _read well_ there. A headline authored for a 1280×720 landscape canvas,
merely fit into a 1080×1920 reel, ends up tiny and lost in the tall frame. This
doc covers the adaptive **per-ratio scale factor** that enlarges such type so it
reads at the target ratio.

See also: [docs/87 — format presets](./87-format-presets.md) and
[docs/90 — `--format` on capture/animate](./90-format-on-capture.md).

## The scale factor

`formatScaleFactor(width, height, safeInset)` (`src/templates/formats.ts`)
returns the linear factor a template multiplies its authored font sizes / spacing
by:

```
sf = clamp( sqrt( (contentW · contentH) / (refW · refH) ), min, max )
```

- **Content box** = `canvas − safeInset` (the usable, safe area — the same box
  DM-1537 lays content within). `refW × refH` is the reference authoring box:
  `ADAPTIVE_REFERENCE` = 1280×720 minus a 96 px margin, the canvas the cards'
  literal sizes (84 px headline, 200 px stat, …) are tuned for.
- **Square-root of the usable-area ratio** → a proportional linear scale. More
  usable area → larger type.
- **Gated on `safeInset`.** With no format chosen (`safeInset == null`) it
  returns exactly `1`, so a template's default (no-format) output is
  **byte-identical** — the same opt-in contract as `safeAreaPadding` (DM-1537).
- **Clamped** to `[0.75, 1.85]` (tunable, and callers may override) so a
  pathological custom `WxH` can't produce absurd type.

### Why this gives "bigger relative type, tighter columns" at 9:16

A 9:16 reel (1080×1920, safe inset 12%/18% top/bottom, 6% sides) has a **large
usable area** over a **narrow width**. The area ratio vs the reference is ~2.2, so
`sf ≈ 1.49`: an 84 px headline becomes ~125 px. Because the cards keep their
percentage `max-width`s (e.g. `.tc-title { max-width: 90% }`), the now-larger type
**wraps sooner** — the "tighter columns" the ticket asks for is an emergent
property of scaling font size while leaving the column a fixed fraction of the
narrow canvas. On a 16:9 landscape the factor stays near proportional (the aspect
matches the reference), so those renders look essentially as before, just scaled
with the canvas.

## Which templates scale

All are opt-in via `safeInset` (no format → byte-identical):

| Template | Scaled |
|---|---|
| `title-card` | eyebrow / headline / subtitle font sizes + gap |
| `quote` | quote mark, quote text, rule, avatar, name/role + gaps |
| `caption` | caption text + scrim padding |
| `cta` | logo cap, headline, button, handles, url + gaps |
| `stat` | value cell + label + delta (width-capped, see below) |
| `counter` | value cell (width-capped) |
| `compare` | label pill font/height/pad + honors the safe inset for placement |

The flex text cards (`title-card` / `quote` / `caption` / `cta`) are the core
case — their text wraps, so scaling up is unambiguously a legibility win.

### Number cards: width-capped scaling

`stat` and `counter` render a **fixed-width, unwrappable** number. Scaling it up
by the area factor would overflow a narrow reel and clip the value. So after
scaling, the cell size is **capped to fit the safe content width** via
`fitOdometerCell(scaledCell, cols, availableW)` — `cols` is the number's total
column count (digits + separators + prefix/suffix), `availableW` is
`canvas − max(defaultPadding, safeInset)` per side. The number is thus as large as
_fits_, never clipped. The cap is only applied under a chosen format
(`availableW == 0` disables it → byte-identical default).

## Building blocks (`src/templates/builtin/text-card-common.ts`)

- `cardScaleFactor(w, h, safeInset)` — thin re-export of `formatScaleFactor` so a
  card imports its two format helpers (`cardHeadCss` + this) from one module.
- `fs(px, sf)` → a scaled `"…px"` string (`fs(84, 1)` → `"84px"`, unchanged).
- `fsNum(px, sf)` → a scaled bare number (for an SVG `font-size` attribute).
- `fitOdometerCell(cell, cols, availableW)` → the number-card width cap.

## Verification

Rendered-SVG proof (the house rule — verify the SVG, not live HTML): a
`title-card` on `--format reel` renders a large two-line headline that fills the
frame, versus a tiny single-line headline when the same 1080×1920 canvas is used
_without_ a format (`sf === 1`, landscape-tuned type). The reel `stat` number
`1,284,000` fills the safe width without clipping. Demos:
`examples/output/templates/format-reel-{title-card,quote,stat}.svg`.

## Follow-ups (not in DM-1541)

- **Adaptive scaling for the other themeable built-ins** — `kinetic-text`,
  `lower-third`, `chat`, `subscribe`, and the `chart` axis/label type don't yet
  consume the scale factor.
- **Per-ratio layout _changes_** (not just scale) — e.g. stacking a `quote`
  attribution differently, or switching a `cta` to a vertical button row, at 9:16
  vs 16:9. The current pass is uniform type/space scaling, not layout
  restructuring.
- **Tuning the reference / curve** — `ADAPTIVE_REFERENCE`, the `[0.75, 1.85]`
  clamp, and the `sqrt`-of-area curve are v1 defaults; a designer pass may prefer
  a different reference box or a gentler/steeper curve per format.
