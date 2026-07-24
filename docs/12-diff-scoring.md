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

## The no-motion bar (`passesStrict`)

Layers 1 and 4 both forgive differences that *look like moved content*. That is
correct for the fidelity sweeps, where the two images come from different
rasterizers. It is wrong for a caller comparing two renders of the **same
content at the same positions**, because a whole element can change place — or
two elements can swap paint order — and still be scored away:

- Layer 4 is severity-based, not size-based. Two solid blocks swapping z-order
  differ by ~44% of max RGB distance, just under the 50% high-severity
  threshold, so *every* pixel of the flip is "low severity" and the entire
  component is filed under `shiftyRegionCount` / `shiftyRegionArea`. Measured on
  a deliberately broken frame-sequence compressor: **3712 differing pixels,
  `regionCount === 0`, `coveragePct` 0, verdict `clean`.**

For those callers the comparator reports three additional aggregates, computed
with layer 4 lifted (layers 1–3 still apply). They are **purely derived** from
the same components — there is no second region pass — so they cannot drift from
the primary numbers:

| metric | meaning |
|---|---|
| `strictRegionCount` | components clearing `MIN_REGION_AREA`, severity gate ignored. Exactly `regionCount + shiftyRegionCount`. |
| `strictRegionArea` | their total diff-pixel area. Exactly `totalChangedArea + shiftyRegionArea`. |
| `strictMaxRegionArea` | area of the largest single one (0 when there are none). |

`passesStrict(cmp, caps?)` is `passes(cmp)` plus `strictMaxRegionArea <=
caps.maxRegionArea` and `strictRegionArea <= caps.totalRegionArea`. It is a
**bounded** bar, not a zero bar. `caps` defaults to the host's, via
`strictCapsFor(process.platform)`, which returns `{ maxRegionArea: 256,
totalRegionArea: 512 }` on **every** platform — sized from measurement rather
than taste:

- **Clean ceiling.** Across all 54 parity checks of the compressor e2e suite on
  a correct build: 71 px largest single strict region and 206 px total on macOS,
  and a flat **0 px** on Linux. The macOS residual is sparse glyph-edge drift on
  one text-heavy fixture (max per-pixel severity 34.5%, zero high-severity
  pixels, ~5–11% fill density inside each bounding box), confined to the states
  whose insertion lands off the pixel grid. Every other fixture scores 0.
- **Known break.** The z-order flip above is a single *dense* component —
  measured at 3712 px on macOS and 3718 px in the Linux container, with
  `regionCount === 0` on both, so the caps are the only thing that catches it.

So the caps sit ~3.6x above the clean ceiling and ~7–14x below the known break.
`strictMaxRegionArea` is the sharper of the two — glyph drift splits into many
small edge-following components while a moved element produces one component the
size of the element — and the total is the backstop for a bug that scatters
mid-sized components instead of making one big one.

### One cap set for every platform — and what the fixtures owe it

The bar was macOS-only at first. The *same correct build* scored up to 749 px
largest / 3289 px total in the Linux container (and 829 px / 11423 px once every
fixture was counted), overlapping the 3712-px known break — so no Linux cap could
both pass a correct build and fail a broken one, and non-darwin callers degraded
to plain `passes()`, which the z-order flip sails straight through.

The cause was neither the compressor nor the comparator. **Chrome does not use
LCD (subpixel) text antialiasing inside a composited layer**, and a compressed
run wraps paired content in animated transform groups that get their own layer.
So on a host where LCD text is on, a grayscale-antialiased compressed render was
being compared against an LCD-antialiased flipbook, and every glyph edge in the
frame differed. macOS has had LCD text off since Big Sur — the only reason it
looked calibrated while the others did not.

Two fixture-side rules fix it, and **every compressor fixture must follow both**
or the shared caps stop holding off macOS:

1. **Rasterize with LCD text off** — launch the comparison browser with
   `PARITY_LAUNCH_OPTS` from `tests/flipbook-parity.ts` (`--disable-lcd-text`).
   This is what collapsed Linux from 829 px to 59 px. It costs nothing real:
   both images come from our own renderer, so the comparison is unchanged; it
   just stops measuring the host's AA mode instead of the compressor.
2. **Pin the fonts** — take faces from `tests/fixture-fonts.ts` rather than
   naming host-dependent families (`Menlo`, `system-ui`, `Georgia`), which
   resolve to a different face per platform. This took the remaining 59 px to 0.
   The module documents the two-halves contract: the page needs the
   `@font-face` CSS (for Chrome's layout) *and* the test needs
   `registerFixtureFonts()` (for Domotion's outlines) — miss either and the
   fixture silently falls back to a host font on one side.

Unlike the per-platform hinting floor below, this bar needs no per-platform
relief: there the two images come from *different* rasterizers, so the host's
text rendering is inherently part of the measurement; here both come from ours.

To re-measure after a change, set `FLIPBOOK_METRICS=<path>` and run the
compressor e2e suite — each parity check appends a JSON line with its raw strict
aggregates. Take the max over a correct build, then re-run against a
deliberately broken one and confirm the populations stay separated.

**Layer 1 is deliberately NOT lifted for strict callers**, and that is measured
rather than assumed: a compressed run wraps paired content in transform groups,
which rasterize a sub-pixel phase off the flipbook's direct placement, so clean
fixtures carry real shift-absorbed pixel counts (99 on one fixture, ~5300 per
state on the 12-state editor one) with zero real change. A pixel-level
shift-inclusive bar fails on correct output.

`passes()` remains the criterion for `tests/runner.tsx`,
`tests/html-test-suite.tsx`, `tests/real-world.tsx` and `svg-review`; the strict
aggregates are additive and change none of the existing values or verdicts.
Today the only consumer of `passesStrict`'s caps is the frame-sequence
compressor's flipbook-parity bar (`tests/flipbook-parity.ts`, applied at every
compressed-run e2e assertion site) — see
[`docs/100-rich-text-editing.md`](./100-rich-text-editing.md).

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
| `shiftyRegionCount` / `shiftyRegionArea` | diagnostic | components that cleared the area floor but were culled by layer 4 |
| `strictRegionCount` / `strictRegionArea` / `strictMaxRegionArea` | **no-motion gate** | the same components with layer 4 lifted — see the no-motion bar above. Not consulted by `passes()`. |

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
