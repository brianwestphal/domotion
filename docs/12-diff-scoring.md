# Domotion: visual-diff scoring

Requirements for the PNG-comparison metric shared by every visual-regression
runner. Origin: DM-281 (the original baseline metric was raw per-pixel RGB
distance with no anti-aliasing awareness, so glyph-rendering drift dominated the
signal and structurally-broken renders could pass under generous thresholds).
DM-383 replaced the bucketed avg/sig/tile thresholds with a strict
"every non-AA pixel fails" gate. **DM-715 then replaced that** with
**region-based scoring** — the current contract — because a strict per-pixel gate
flagged every page as a failure: our font substitution differs from Chrome's by a
pixel or two on essentially every glyph, so `nonAaPixels` is never zero in
practice even when nothing structural is wrong.

## Pass criterion (DM-715)

A fixture passes iff **`regionCount === 0`** — i.e. there is no surviving
connected-component *region* of real, structural change. `passes(cmp)` is exactly
`cmp.regionCount === 0`.

Scatter (a pixel here, a pixel there from glyph-edge differences) is allowed; a
*contiguous block* of genuine change (a missing border, a recolored element, a
swapped image, a misplaced shadow) is not. The earlier `nonAaPixels === 0` rule
(DM-383) is gone; `nonAaPixels` and the old bucketed percentages are now
**diagnostic only** — still computed and printed so reviewers can gauge severity,
but they no longer gate pass/fail. `PASS_THRESHOLD_NON_AA_PIXELS = 0` is retained
as a back-compat export only.

## The pipeline — from raw pixel diff to region count

The comparator runs four layers of noise suppression on top of the raw RGB diff,
in this order, then counts what survives. (All constants are exported from
`src/review/compare-pngs.ts`.)

1. **Sub-pixel shift pre-filter** (`SHIFT_MATCH_RADIUS = 2`, `SHIFT_MATCH_DIST = 35`).
   For every differing pixel, sample the `(2·radius+1)²` neighborhood in the
   *opposite* image; if `expected[x,y]` finds a near-match in `actual` **and**
   `actual[x,y]` finds a near-match in `expected` (both within `SHIFT_MATCH_DIST`),
   the pixel is a shift artifact and is removed from the diff mask **before** AA
   detection and region analysis. This cleanly catches the "whole text block
   translated 1 px" case the AA detector can't — each pixel there is a correct
   rendering at the wrong position.

2. **Pixelmatch-style anti-aliasing detector** (a port of mapbox/pixelmatch's
   `antialiased()`; DM-281 / DM-383). Any pixel that looks like sub-pixel glyph
   coverage along an edge is zeroed out. Run twice — once anchored in `expected`,
   once in `actual` — and unioned (a pixel is AA if either anchor classifies it).
   See the recap below.

3. **Connected-components region detection** (`REGION_DILATE_PX = 3`,
   `MIN_REGION_AREA = 15`; DM-715). The surviving non-AA diff pixels are dilated by
   3 px so neighbors merge, then flood-filled into components. A component whose
   *original* (un-dilated) diff-pixel area is below `MIN_REGION_AREA` is dropped as
   residual scatter.

4. **High-severity gate** (`HIGH_SEV_PCT = 50`, `MIN_HIGH_SEV_FRACTION = 0.15`). A
   surviving component counts as a *real* structural change only when at least 15%
   of its diff pixels exceed 50% per-pixel severity (normalized color distance).
   Text-rendering / font-substitution diffs concentrate in low-severity edge
   pixels; a genuine image swap or recolor produces large runs of high-severity
   pixels. Without this gate, any paragraph where our font substitution differs
   from Chrome's would blow up the region count with no real change present.

`regionCount` is the number of components that pass layers 3 + 4. Pass requires it
to be zero.

## What the AA detector does (recap)

For each pixel `p` whose color differs between expected and actual:

1. Walk `p`'s 3×3 neighborhood in the source image. Compute Y-channel (luminance,
   ITU-R BT.601) delta to each neighbor.
2. Track `zeroes` (neighbors identical to `p`) and the most-extreme negative /
   positive Y deltas with their coordinates.
3. Bail (not AA) if `zeroes < 2` (no flat region around) or no high-contrast
   neighbor exists in either direction.
4. The pixel is AA if the darkest- or brightest-neighbor cell has many same-color
   siblings in BOTH images (`hasManySiblings`) — i.e. the contrasty neighbor sits
   on a stroke that continues, so `p` is sub-pixel coverage along an edge.

AA-classified pixels contribute 0 to every metric. They are still drawn into
`*-diff.png` (literal absolute difference) so reviewers can see what was filtered.

## Metrics

| metric | role | meaning |
|---|---|---|
| `regionCount` | **pass/fail gate** | surviving structural-change regions (layers 3+4). Pass = 0. |
| `totalChangedArea` | diagnostic | total original-diff-pixel area inside surviving regions |
| `maxRegionSeverity` | diagnostic | max per-pixel normalized distance % inside any region |
| `coveragePct` | diagnostic | `totalChangedArea / totalPixels · 100` — drives the verdict tier |
| `nonAaPixels` / `nonAaPixelPct` | diagnostic | differing pixels not classified AA (the old DM-383 gate) |
| `diffPct` | diagnostic | average normalized color distance %, AA pixels excluded |
| `sigPixelPct` | diagnostic | % of pixels with `dist > SIGNIFICANT_PIXEL_DIST (40)` and !AA |
| `worstTilePct` / `worstTileSignificantPct` | diagnostic | per-`TILE_PX(64)`-tile avg / sig% for the worst tile |

`classifyDiff(regionCount, coveragePct)` buckets a result into a one-word
**verdict** reviewers can scan: `clean` (0 regions) → `trivial` (≤2 regions,
coverage < 0.05%) → `minor` (≤5, < 0.5%) → `moderate` (≤15, < 2%) → `major`
(anything more — once an image is "lots wrong" the gradations stop being useful).

## Diff image legend

The diff PNG is a **literal per-channel absolute difference** between expected and
actual:

```
diff[i] = |expected[i] - actual[i]|       (per R/G/B channel, alpha=255)
```

Black pixels are exact matches; brighter pixels show what changed and in which
color (a red glyph that should have been blue paints magenta; a small AA shift on
a black-on-white edge paints dim gray). The fill itself is uninterpreted — no
thresholding, no red tint, no dimmed-source overlay (DM-379).

Two overlays are painted on top of the difference fill:

- **Magenta (255, 0, 255) 1-px outlines** around each surviving region (DM-715) —
  the actual pass/fail signal — capped at the top 32 so a busy image isn't
  spammed with outlines.
- A single **yellow rectangle** outlining the worst tile, keyed off non-AA% first
  (then sig%, then avg% as tiebreaks) — a "where is the residual noise densest"
  navigator. (Pre-DM-715 this tile was the pass/fail signal; it's now just a
  pointer.)

To know *which* pixels were classified AA, re-derive from the source images with
the algorithm above — the diff PNG doesn't encode that distinction.

## Per-platform coverage floor

The visual gate is calibrated to macOS. On Linux / Windows the host rasterizer
grid-fits native text (FreeType / DirectWrite) while Domotion fills unhinted
vector outlines, so a per-platform coverage cap is applied in the runner
(`tests/runner.tsx`) instead of requiring `regionCount === 0` there — see
`docs/42-cross-platform-fallback-calibration.md` ("Per-platform visual-gate
hinting floor", DM-262 / DM-884).

## Edge cases / out of scope

- The shift pre-filter (layer 1) handles small translations of identical content;
  large translations beyond `SHIFT_MATCH_RADIUS` are not chased — fixtures should
  reflect the same captured layout for both expected and actual.
- The AA detector classifies any pixel that "looks like part of a smooth edge" as
  AA, so a real difference falling on a smooth edge in both images can be filtered
  — but the high-severity region gate (layer 4) is what ultimately decides
  structural change, so an isolated filtered pixel rarely matters.
- `hasManySiblings` does an exact-color comparison; subtly different colors across
  an edge gradient can fool it. Pixelmatch tolerates this via `colorDelta`; a
  future iteration could add the relaxed match.

## Shared comparator

The implementation lives in **`src/review/compare-pngs.ts`** (there is no
`tests/` copy). It's imported by every visual-regression runner —
`tests/runner.tsx` (features / showcase), `tests/html-test-suite.tsx` (the
html-test sweep), `tests/real-world.tsx` — and by the published **`svg-review`**
CLI, so the pass criterion, AA detection, shift pre-filter, region scoring, and
the diff-PNG overlays are identical everywhere. The pixel work runs inside
`page.evaluate(...)` because the canvas APIs that decode and walk the PNGs only
exist in a browser context. The pure scalar helpers (`passes`, `classifyDiff`)
are unit-tested in `src/review/compare-pngs.test.ts`.

## Tests

- `npm run demos:test:html` — full html-test suite; `results.json` carries the
  per-fixture metrics above so reviewers can triage by `verdict` / `coveragePct`.
- `npm test` — unit tests, including `compare-pngs.test.ts` for the `passes`
  region-count gate and the `classifyDiff` tier boundaries.
