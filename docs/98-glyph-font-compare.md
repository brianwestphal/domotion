# 98 — Glyph font-identity comparator (`compare-glyphs`)

Status: **Shipped** (library + CLI + calibration harness).

Given two PNG crops of the SAME character — typically Chromium's expected
paint vs Domotion's rendered SVG — decide with high probability whether they
were rendered with **the same font** (family + size + weight + style + other
modifiers): verdict **CORRECT** (match) or **INCORRECT** (mismatch).
Deterministic, traditional computer vision — no ML, no network — so verdicts
are bit-reproducible run to run. Built because pixel-diff percentages alone
can't tell "different font" from "same font, different AA phase", which is
the judgment call every text-fidelity ticket turns on.

- Library: `src/review/glyph-compare.ts` (`compareGlyphPngs`,
  `compareGlyphCoverage`, `decide`, thresholds).
- CLI: `npx tsx tools/compare-glyphs.ts <expected.png> <actual.png>
  [--rect-a x,y,w,h] [--rect-b x,y,w,h] [--json]` — prints
  CORRECT/INCORRECT + per-metric reasons; exit 0 = correct, 1 = incorrect,
  2 = unusable input.
- Calibration harness: `npx tsx tools/glyph-compare-calibrate.ts [--quick]`
  — re-renders the corpus and reports distributions + the confusion matrix;
  run it whenever metrics or thresholds change and paste the updated numbers
  here.
- Batch sheet audit: `npx tsx tools/glyph-sheet-audit.ts --results-dir <dir>
  --fixtures-dir <dir> [--only <substr>] [--sheet <name>]` — runs the
  comparator over every glyph cell of the Unicode per-block grid fixtures
  (`../html-test/unicode/*.html`), emitting a per-codepoint CORRECT/INCORRECT
  list and a per-sheet defect count. Geometry self-aligns to the stored
  expected PNG (viewport pinned to its width; a row-projection cross-
  correlation corrects vertical reflow and flags `layout-drift`). This is how
  "which characters on which sheets render with the wrong font" is answered
  deterministically, without per-glyph AI judgment.
- Unit tests: `src/review/glyph-compare.test.ts` (synthetic supersampled
  glyphs); e2e guard: `src/review/glyph-compare.e2e.test.ts` (real fonts
  through real Chromium — a trimmed slice of the calibration corpus).

## Semantics: shape equality, not font identification

The tool answers **"is the rendered shape the same?"** — not "which font is
this?". Two fonts that draw a pixel-identical glyph for some character
(Helvetica vs Arial `l`, a plain bar in both) return **match**, and that is
the *correct* answer for fidelity review: if no pixel differs beyond
rasterization noise, the render is visually right no matter which file the
glyphs came from. Discrimination power therefore depends on the character:
`R a g e t G Q M y` carry the most identity (leg shapes, story counts,
terminal cuts, spurs); `l o 0` carry the least. When hunting a suspected
font substitution, crop a discriminative character.

## Crop requirements (the caller controls the crops)

1. **One glyph per crop**, on a **solid background**, ink in a single color.
   Either polarity works (dark-on-light or light-on-dark — auto-detected
   from the border ring). Transparency is flattened onto white.
2. **Same nominal scale for both crops.** The tool detects size differences
   — it must never be asked to compare a 1× crop against a 2× crop.
3. **Capture at 2× DPR or higher.** Rasterization noise (AA band ~1 device
   px + subpixel phase ≤ 0.5 px) is absolute, while font differences scale
   with the glyph — so bigger ink = more separation. Ink height **≥ 24 px**
   required for full sensitivity (below it a warning is attached, the
   lookalike gate loosens, and topology demotes to soft); **≥ 8 px** hard
   minimum (below it the comparison errors out). For subtle work (lookalike
   families, ±1 px font-size steps) rasterize the SVG side at 3–4× via
   `svg-to-image --scale` and screenshot the expected side at the same
   device scale.
4. Include a few px of margin around the glyph; exact centering is NOT
   required (the comparator aligns to sub-0.1 px itself). Do not let
   neighboring glyphs into the crop (a non-uniform border triggers a
   warning).

## How it works

Pipeline (all deterministic):

1. **Coverage extraction** — luminance-normalized ink coverage in [0, 1]:
   background = median of the border ring, ink = the luminance extreme
   farthest from it. This reduces both crops to rasterizer coverage maps,
   discarding color.
2. **Registration** — ink-box centers (integer) → NCC search ±3 px →
   two-pass parabolic sub-pixel refinement (residual ≲ 0.1 px). The
   fractional shift is applied **symmetrically** (−f/2 to A, +f/2 to B) so
   bilinear resampling softens both images identically — shifting only one
   would make the blur asymmetry itself read as a coverage difference.
3. **Metric battery** — each axis targets a distinct way fonts differ
   (the taxonomy follows PANOSE-1's measured axes and the optical
   font-recognition literature — Zramdini & Ingold TPAMI 1998, the CEDAR
   multifont attribute study, Huttenlocher's partial Hausdorff matching):

   | Metric | Measures | Catches |
   |---|---|---|
   | `sizeDiffPx` / `sizeRatio` | ink bbox dims | font-size, width-class, x-height differences |
   | `inkLogRatio` | total coverage mass (subpixel-invariant integral) | weight (PANOSE WeightRat analogue: bold ≈ +30–50% ink) |
   | `unexplainedA/B`, `d95`, `dMax` | distance-transform agreement of the ≥0.5 masks (percentile Hausdorff, tolerance 1.5 px) | different outlines, serifs, terminals — with the AA band excluded by construction |
   | `hotspotMax` | max 3×3-blurred \|Δcoverage\| | **the lookalike discriminator**: a concentrated patch present in one render only (terminal cut, tail, spur) that ink-*fraction* metrics dilute |
   | `strokeWidthA/B` | 4 × mean distance-to-background over ink (continuous; ridge medians quantize) | weight, stroke-thickness design |
   | `strokeContrastA/B` | ridge p90/p10 modulation — **diagnostic only** (same-pair noise reaches ln 2 at text sizes) | stroke contrast (serif vs sans), for the human reading the report |
   | `orientL1` | Sobel edge-orientation histogram (16 bins mod 180°) | slant/italic, serif energy, terminal angles |
   | `holesA/B` | counter count (4-connected, ≥ 4 px area) | structural topology (single- vs double-story, open vs closed counters) |
   | `zoningL2` | adaptive zone-grid mean-coverage RMS (zones ≥ ~6 px, box expanded 2 px so the AA skirt stays inside) | mass redistribution: x-height, midline, aperture |
   | `ncc` | normalized cross-correlation | overall similarity floor |

4. **Verdict** — any HARD threshold breach → mismatch; ≥ 2 SOFT breaches
   (¾ × hard) → mismatch; else match. Confidence: ≥ 2 hard = high, 1 hard =
   medium, softs-only = low; a clean match with zero signals = high.
   `reasons[]` explains every fired signal in typographic terms (weight,
   terminal, slant, x-height…) so the consumer knows *what* differs, not
   just that something does. Two thresholds are resolution-aware: the
   hotspot gate is 0.17 at ≥ 24 px ink but 0.24 below, and a hole-count
   difference is hard evidence only at ≥ 24 px (thin counters — the eye of
   a 16 px serif `e` — legitimately AA-flicker closed).

   **Thin-high-frequency-detail guard.** `outline` and `d95` are the only
   two signals computed on *binarized* ink via nearest-neighbor distance, so
   a ~1 px anti-aliasing phase shift of a thin, repeating feature — a dashed
   enclosing border, a hairline ring (e.g. the standalone regional-indicator
   glyphs `🇦`–`🇿`, whose dashed box is part of the glyph) — destroys local
   overlap and inflates both, while the smooth coverage correlation `ncc`
   barely moves. When a mismatch is driven *only* by that pair (`hard ⊆
   {outline, d95}`) **and** `ncc ≥ nccThinDetailFloor` (0.93), the
   disagreement is reattributed to AA phase drift and the verdict is match.
   Corpus-validated zero-regression: no different-font pair in the
   calibration set fires a mismatch on `hard ⊆ {outline, d95}` — every real
   difference also trips size / mass / stroke / hotspot / orientation /
   zoning / topology / ncc, all of which sit far above 0.93's shadow.

## Calibration (2026-07, macOS, Chromium via Playwright, DPR 2)

Corpus: `tools/glyph-compare-calibrate.ts` — 520 rendered cells, 410 scored
pairs. SAME pairs (n=200) are re-renders at a 0.37 px subpixel phase shift
across 10 families × 10 chars × {32, 16} px. DIFFERENT pairs: 9
lookalike-family pairings (Helvetica/Arial/Helvetica Neue, system-ui,
Times/Times New Roman/Georgia, Menlo/Courier, Verdana), weight steps
(400→700, 400→500), size steps (32→34, 32→33 px), italic vs upright.

Measured distributions (the numbers the default thresholds are cut from):

| Metric | SAME p95 / max | DIFF-family p50 | DIFF-weight p50 | DIFF-style p50 | Hard threshold |
|---|---|---|---|---|---|
| `unexplainedMax` | 0.000 / 0.000 | 0.005 | 0.101 | 0.090 | 0.01 |
| `d95` (px) | 1.0 / 1.0 | 1.0 | 2.0 | 2.24 | 1.5 |
| `hotspotMax` | 0.082 / 0.099 | 0.67 | 0.85 | 0.99 | 0.17 (≥24 px) / 0.24 |
| `inkLogRatio` | 0.001 / 0.001 | 0.064 | 0.401 | 0.009 | ln 1.10 |
| `strokeLogRatio` | 0.053 / 0.182 | 0.027 | 0.319 | 0.017 | ln 1.22 |
| `orientL1` | 0.137 / 0.232 | 0.162 | 0.119 | 0.322 | 0.32 |
| `zoningL2` | 0.006 / 0.013 | 0.065 | 0.207 | 0.168 | 0.075 |
| `ncc` (min) | 0.9917 | — | — | — | 0.975 floor |
| `sizeDiffPx` | 1.0 / 1.0 | 2.0 | 3.0 | 2.0 | max(2 px, 3.5%) |

**Result: 200/200 same pairs match, 153/153 decisive different pairs caught
— zero errors** — including every discriminative-char pair of the
notoriously close Helvetica vs Arial, Helvetica vs Helvetica Neue, and
Times vs Times New Roman. Advisory pairs (weak chars on lookalike pairs,
~3% size steps, the 400→500 real-medium step): 54/57 additionally caught;
the 3 matches are Helvetica/Arial/Helvetica Neue `l` — a visually identical
bar, which per the shape-equality semantics is the *correct* verdict.

Re-run after any metric/threshold change and update this table; the stored
per-pair metrics land in
`tests/output/glyph-compare-calibration/results.json` and can be re-decided
offline via the exported `decide()` without re-rendering.

## Limits + practical notes

- **Single-glyph scale floor**: a ~3% size step (32 vs 33 px at DPR 2) sits
  at the detection floor — half those advisory pairs are caught, half not.
  At 4× crops the same 3% clears the gate. Font *metrics* differences also
  show up earlier through line-level layout (advance widths), which the
  visual suites already flag.
- **Advance width is invisible**: a Verdana-vs-Tahoma-style pair (same
  skeleton, different side bearings) is inseparable from a single centered
  glyph by design; compare a two-glyph crop (spacing becomes shape) or the
  layout metrics instead.
- **Weak characters**: `l o 0` can be genuinely identical across families —
  crop `R a g e t G Q` when testing for substitution (per the
  font-identification literature: leg/tail shapes, story counts, terminal
  cuts, spurs carry the identity).
- **CJK/complex scripts**: the metric battery is script-agnostic (it only
  sees ink), and dense ideographs give MORE signal per crop, not less. The
  calibration corpus is Latin; expect the same behavior but verify against
  a per-script pair before leaning hard on a razor-thin verdict.
- Rendering-stack gamma/stem-darkening differences shift apparent stroke
  weight by ≲ 0.5 px without a font change; the mass/stroke thresholds
  carry margin for this, but if a future rasterizer change introduces a
  systematic ink bias between expected and actual crops, recalibrate with
  text-vs-path same pairs added to the corpus.

## Origin

Ticket DM-1686 (local Hot Sheet): text-rendering fidelity work kept hitting
the question "is this glyph painted with the wrong font, or is this AA
noise?", and eyeballing diff PNGs answered it unreliably. The research pass
behind the metric selection (PANOSE-1 axes and measurement formulas,
forensic per-character discriminators, OFR feature literature,
AA-tolerant comparison techniques) is summarized in the metric table above.
