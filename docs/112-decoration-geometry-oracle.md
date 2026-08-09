# Text-Decoration Geometry Oracle

`tools/decoration-oracle.ts` (`npm run decorations:oracle`) grades text-decoration
GEOMETRY — the painted line's y-position, thickness, and skip-ink painted
segments — against Chrome's actual paint and against Blink's transcribed rules.
It exists because whole-fixture pixel-diff structurally rewards the WRONG
decoration constants: an intentionally mis-tuned geometry can compensate for a
rasterization gap the consumer's SVG renderer owns, improving the diff score
while moving further from what Chrome paints. Measured concretely: correcting
the skip-ink dilation from a fitted `max(0.5, thickness*0.5)` to Blink's real
`min(thickness, 13)` moved the painted gap unambiguously closer to Chrome's
25px, while the whole-fixture `diffPct` moved the other way; and a fixture
passed at a displayed `0.00%` in both arms of a change whose emitted SVG
differed by an entire line segment. Decoration work is therefore gated on
geometry, not on aggregate pixel difference.

## The three answers per case

| Leg | Source | How it is obtained |
| --- | --- | --- |
| **C** Chrome-measured | Chromium's painted output | `deviceScaleFactor: 4` screenshot; decoration forced to pure red (`text-decoration-color: #ff0000`) so its pixels are separable from black glyph ink by channel arithmetic; geometry recovered by coverage-weighted row/column profiles (~±0.06 CSS px) |
| **R** Rule-predicted | Blink source, transcribed | The formulas below, fed with inputs measured from the same page (fragment top from layout; `FloatAscent` from canvas `measureText().fontBoundingBoxAscent`, which is exactly `FontMetrics::FloatAscent` at the alphabetic baseline — `core/html/canvas/text_metrics.cc:133-138`) |
| **S** SVG-emitted | Domotion's output markup | Parsed analytically — `<line>` y / stroke-width / x-extent under accumulated `translate` transforms. Never rasterized: rasterization belongs to the consumer |

## The three checks and their gates

- **C vs R — "transcription"** (always gates): validates the transcription and
  the oracle's own measurement against Chrome's paint. If this leg fails, the
  oracle must not be trusted to judge anything. Status at landing: **84/84**
  cases pass on macOS across families (Helvetica / Times / Menlo) × sizes
  (12–48, incl. fractional 32.5) × lines (underline / line-through / overline)
  × styles (solid / double) × thickness (`auto` / `from-font` / px / % / em) ×
  `text-underline-offset` (auto / px / % / em / negative) ×
  `text-underline-position` (auto / `under` / `from-font`).
- **C vs S — "skip-ink"** (gates by default; `--no-gate-skip-ink` to demote):
  compares the PAINTED SEGMENTS of the decoration (positive space — see below)
  between Chrome's paint and the emitted SVG, per edge. Status: **7/7** since
  the decoration-geometry transcription landed. (At the oracle's landing it
  was 4/7 — the 3 failures were precisely attributed to the renderer's
  then-empirical constants: dilation driven by a `ceil(fontSize/20)`
  thickness instead of Blink's `fontSize/10`, and the band sitting deeper
  than Blink's. Correcting the constants greened them, as predicted.)
- **R vs S — "svg-geometry"** (gates by default; `--no-gate-svg-geometry` to
  demote): the acceptance gate for the renderer's decoration geometry.
  Status: **84/84** — `getDecorationMetrics` + `emitDecorationLine` emit
  Blink's transcribed rules exactly (fragment-top anchoring on the captured
  FloatAscent, per-style paint snap at emit). While the renderer carried its
  empirical constants this leg failed 61/84 by design and was off by
  default; it was armed, and defaulted on, when the transcription landed.

## Transcribed rules (Chromium rev `7d859f27`)

All horizontal-tb, alphabetic baseline, zoom 1. `ascF` = `FloatAscent`
(already integer-rounded with platform hacks by
`platform/fonts/font_metrics.cc:117` `SkScalarRoundToScalar`, plus the macOS
+15% ascent hack for Times/Helvetica/Courier at `:135-148`), `ascI` =
`lround(ascF)`, `fs` = used font size, `t` = resolved thickness, `LU(x)` =
`round(x*64)/64` (LayoutUnit).

- **thickness** (`core/paint/text_decoration_info.cc:65-92`, `max(1,t)` at
  `:449-451`): auto → `fs/10`; `from-font` → the font's underline thickness
  metric (or `fs/10` when absent); length/percent → `roundf(px)`, percent of
  `fs`.
- **underline offset** (`core/layout/text_decoration_offset.cc:16-35,91-135`):
  - auto position: `top = ascI + gap + roundf(extra)`, where
    `gap = extraIsAuto ? max(1, ceil(t/2)) : 0` — an explicit
    `text-underline-offset` length zeroes the auto gap.
  - `from-font` position: `top = roundf(ascF + underlinePos + extra)`;
    `underlinePos` is positive below the baseline (Skia's
    `fUnderlinePosition`; macOS negates `CTFontGetUnderlinePosition` —
    `external/skia` `src/ports/SkScalerContext_mac_ct.cpp`, rev `ebf5052`).
  - `under` position: `top = floor(LU(ascF + NTD) + LU(extra)) + 1`, where
    `NTD` is `NormalizedTypoDescent` — OS/2 sTypoAscender/Descender
    normalized to sum to the em size keeping their ratio
    (`platform/fonts/simple_font_data.cc:360-431`).
- **overline**: `top = floor(LU(ascF − ascI)) − floor(t)`
  (`text_decoration_offset.cc:52-89`, `TextTop`).
- **line-through**: `top = 2*ascF/3 − t/2`, unrounded
  (`text_decoration_info.cc:385-386`).
- **double**: second bar offset `+(t+1)` (underline), `−(t+1)` (overline),
  `floor(t+1)` (line-through) (`text_decoration_info.cc:259-279`), each bar
  snapped independently.
- **paint snap** (HTML solid/double): `topSnapped = floor(top + 0.5)`,
  `heightSnapped = max(floor(t), 1)` (`decoration_line_painter.cc`
  `SnapYAxis` / `RoundDownThickness` / `DrawLineAsRect`).
- **skip-ink**: intercept band = `DecorationLinePainter::Bounds` per style,
  inset 0.5px top and bottom (`core/paint/text_painter.cc:589-590`); each
  glyph intercept dilated horizontally by `min(LINE thickness, 13)`
  (`:607-608`, `kDecorationClipMaxDilation` at `:46`) — the line's own
  thickness even when the band is taller (double, wavy).
- **dashed / dotted** (`decoration_line_painter.cc:47-53,55-76,409-417`):
  midline `floor(top + max(t/2, 0.5))`, shifted down 0.5 when `roundf(t)` is
  odd; stroke width stays the unrounded `t`; endpoints TRUNCATE to integers
  (`GetSnappedPointsForTextLine` returns int-coordinate `gfx::Point`s) and
  the dash pattern is fitted over that integer span once, before the
  thick-dotted endpoint inset. The skip-ink band is the snapped midline ±
  `roundf(t)/2`.
- **wavy** (`decoration_line_painter.cc:181-212,288-345,477-533`): the HTML
  wave is a repeating one-wavelength tile of the cubic centerline (control
  points at ±`cpDist`, both at mid-wavelength x), stroked at `t`, centerline
  at `top + wavy_offset + 0.5`. The pattern rect — the band that crops the
  tile and feeds the skip-ink intercepts — is the floor/ceil of the STROKE
  BOUNDING RECT of that centerline: `Path::StrokeBoundingRect` is the tight
  bounds of the Skia-stroked outline (`getFillPath(...).computeTightBounds()`
  — `platform/geometry/path.cc:161-166`, fetched at rev `7d859f27`), which
  is analytically `0.5 ± (cpDist/(2√3) + t/2)` (the cubic's visual amplitude
  is `cpDist/(2√3)`, the extremum of `3s(1−s)(1−2s)`), NOT the conservative
  control-point bounds (`±cpDist`). The C leg confirms the tight reading:
  the measured painted extent matches `2·(cpDist/(2√3)) + t` on every wavy
  case.

## Painted segments, not gap intervals

The skip-ink comparison is expressed in positive space — the maximal painted
runs of the bar — rather than gap intervals. Two reasons:

1. In the heavy-dilation regime (e.g. an 8px-thick underline under descender
   text) nearly the whole line is clipped away and only slivers survive;
   "gaps" stop being well-defined while segments remain exact.
2. A red-absent pixel column can mean CLIPPED OUT (a real gap) or merely
   OVERPAINTED (text paints over the underline, so a descender crossing a
   `skip-ink: none` bar also reads red-absent). Segment extraction treats
   WHITE columns as the only separators — a real clip gap always carries a
   white dilation margin — and takes segment edges from red columns only, so
   ink neither splits a continuous bar nor smears an edge.

## Discrimination proof

The oracle was validated by feeding it the known-wrong dilation constant
(`pad = max(0.5, thickness*0.5)` — the fitted value the skip-ink code used to
carry) against the correct `min(thickness, 13)`:

| Constant | Skip-ink verdict | Worst edge error |
| --- | --- | --- |
| `min(t, 13)` (Blink's rule) | 4/7 pass; failures ≤1.45px, all attributed to the separate empirical-band defect | 1.45px |
| `max(0.5, t*0.5)` (fitted) | 1/7 pass; every auto-thickness case flips to FAIL (1.1–1.8px edges); explicit-thickness discriminators reach 3.95px and a 5-vs-1 segment-count mismatch | 3.95px |

The correct constant scores strictly better on every case — the ordering that
whole-fixture pixel-diff inverted.

## Blind spots (what this oracle cannot see)

- **Dotted / dashed / wavy / spelling / grammar lines** — only solid and
  double are graded. Dash phase, dot geometry, and the wavy tile are not
  measured at all.
- **X-extent vs a rule** — segment edges are compared C-vs-S, but the run's
  overall start/end is not checked against a transcribed rule; a run painted
  short at both ends by the same amount on both sides would pass.
- **`from-font` and `under` inputs come from fontkit** (post table, OS/2) —
  Blink reads the same nominal metrics via Skia/CoreText; a face where the
  two disagree mis-attributes a transcription-leg failure. Canvas
  `TextMetrics.emHeightDescent` would provide `NormalizedTypoDescent` from
  Chrome itself but is behind experimental-web-platform-features in the
  Chromium Playwright ships.
- **Discrimination floor** — the 0.9px edge tolerance cannot see a pad error
  smaller than itself; at auto thickness, fonts ≤ ~18px cannot discriminate a
  halved pad on their own (the explicit 5px/8px-thickness cases exist to
  discriminate hard).
- **Scope** — CJK and vertical writing modes, decorating-box propagation
  (decorations inherited from an ancestor box), and wrapped multi-fragment
  runs are not exercised; every case is a single fragment decorated on its
  own span.
- **Platform** — the rules are platform-generic, but the C-leg has been
  validated on macOS only.

## Usage

```sh
npm run decorations:oracle                     # full grid (~3s), gates: transcription + skip-ink + svg-geometry
npx tsx tools/decoration-oracle.ts --only helvetica.24   # substring case filter
npx tsx tools/decoration-oracle.ts --json report.json    # full per-case JSON dump
npx tsx tools/decoration-oracle.ts --keep out/           # keep per-case 4x PNGs + chunk SVGs
npx tsx tools/decoration-oracle.ts --no-gate-svg-geometry # demote the R-vs-S gate to informational
npx tsx tools/decoration-oracle.ts --no-gate-skip-ink    # demote the skip-ink gate to informational
```

Exit codes: `0` all armed gates pass · `1` an armed gate failed · `2` setup
error. Failures print a per-case geometry report (predicted vs measured top /
height / segment edges, with deltas).

Unit coverage for the pure pieces (rule algebra, SVG parsing, segment
comparison) lives in `tests/decoration-oracle.test.ts`.

Related: the font-selection analogue is `tools/font-conformance.ts`
([107](107-font-conformance-oracle.md)); the shaping analogue is
[108](108-shaping-conformance-oracle.md).
