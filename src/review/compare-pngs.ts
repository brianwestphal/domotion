import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { BROWSER_COMPARISON_JS } from "./compare-pngs.browser.generated.js";

/**
 * Shared PNG comparator used by every visual-regression runner in `tests/`.
 * Compares two PNGs and writes a diff image. Pass/fail and diagnostic
 * metrics are computed identically across `tests/runner.tsx` (features /
 * showcase), `tests/html-test-suite.tsx`, and `tests/real-world.tsx`.
 *
 * Two layers of noise suppression run on top of the raw RGB pixel diff:
 *
 *   1. Pixelmatch-style AA detector — zeros out any pixel that looks like
 *      sub-pixel glyph coverage (DM-281 / DM-383).
 *   2. Connected-components on the surviving "non-AA" diff mask, dilated
 *      by 3 px so nearby pixels merge into one region. Regions smaller
 *      than `MIN_REGION_AREA` are dropped as residual scatter. (DM-715.)
 *
 * The remaining regions are taken as "real" change. The pass criterion is
 * region-count zero. Scalar diagnostics (`diffPct`, `sigPixelPct`,
 * worst-tile metrics, the raw `nonAaPixels` count) are still reported so
 * reviewers can see how much pre-region noise survived AA filtering.
 *
 * A third layer sits on top of the region pass: the high-severity-fraction
 * gate, which drops components whose pixels are mostly low-severity — the
 * signature of glyph-shape / font-substitution drift. Those land in
 * `shiftyRegionCount` / `shiftyRegionArea` instead of `regionCount`. That is
 * deliberate for the fidelity sweeps, but it means a difference that merely
 * LOOKS like moved content can score `regionCount === 0` with thousands of
 * pixels changed. `strictRegionCount` reports the region count with that gate
 * lifted, for callers that know content must not move — see the field docs
 * and `passesStrict()`.
 *
 * The work runs inside `page.evaluate(...)` because the canvas APIs needed
 * to decode and walk the PNGs only exist in a browser context.
 */

/** Per-pixel distance threshold (0..441) above which a pixel counts as
 *  "clearly different" rather than antialias noise. 40 ≈ 9% of max distance. */
export const SIGNIFICANT_PIXEL_DIST = 40;

/** Tile size in pixels for the per-tile diagnostic metrics. */
export const TILE_PX = 64;

/** Connected-components params (DM-715). Diff pixels surviving AA filtering
 *  are dilated by `REGION_DILATE_PX` then flood-filled into regions. Regions
 *  whose ORIGINAL diff-pixel area is below `MIN_REGION_AREA` are treated as
 *  scatter and excluded from `regionCount` / `totalChangedArea`. */
export const REGION_DILATE_PX = 3;
export const MIN_REGION_AREA = 15;

/** Neighborhood-tolerant matching for sub-pixel shifts (follow-up to DM-715).
 *  For every diff pixel, sample the (2*SHIFT_MATCH_RADIUS+1)² neighborhood in
 *  the opposite image; if both `expected[x,y]` finds a near-match in actual
 *  AND `actual[x,y]` finds a near-match in expected (both within
 *  `SHIFT_MATCH_DIST`), the pixel is treated as a shift artifact and excluded
 *  from the diff mask BEFORE AA detection and region analysis run. Catches
 *  cleanly the "whole text block translated 1 px" case where Yee's AA
 *  detector can't help because each pixel is a correct rendering at the wrong
 *  position. */
export const SHIFT_MATCH_RADIUS = 2;
export const SHIFT_MATCH_DIST = 35;

/** Region high-severity gate. A connected component is treated as a "real"
 *  structural change only when at least `MIN_HIGH_SEV_FRACTION` of its diff
 *  pixels exceed `HIGH_SEV_PCT` per-pixel severity. Text-rendering /
 *  font-substitution diffs concentrate in edge AA pixels (low individual
 *  severity); a genuine image swap or recolor produces large runs of
 *  high-severity pixels. Without this layer, every paragraph of text on a
 *  page where our font substitution differs from Chrome's blows up the
 *  region count even though no real structural change exists. */
export const HIGH_SEV_PCT = 50;
export const MIN_HIGH_SEV_FRACTION = 0.15;

/** Qualitative-tier bucket. Maps the per-fixture pair (regionCount,
 *  coveragePct) onto a single short verdict reviewers can scan at a glance.
 *  Anything past `major` is bundled into `major` — once an image is "lots
 *  wrong" the gradations stop being useful. Coverage % is total-changed-area
 *  / total-image-pixels * 100. */
export type DiffVerdict = "clean" | "trivial" | "minor" | "moderate" | "major";
export function classifyDiff(regionCount: number, coveragePct: number): DiffVerdict {
  if (regionCount === 0) return "clean";
  if (regionCount <= 2 && coveragePct < 0.05) return "trivial";
  if (regionCount <= 5 && coveragePct < 0.5) return "minor";
  if (regionCount <= 15 && coveragePct < 2.0) return "moderate";
  return "major";
}

export interface CompareResult {
  /** DM-1874: perceptual fingerprint of Chrome's `expected.png`. Lets a baseline
   *  diff say WHICH side moved — an oracle wobble and a renderer regression look
   *  identical in the distance metric alone, and telling them apart has cost a
   *  full bisect before. Deliberately lossy; see `side-digest.ts`. */
  expectedDigest?: string;
  /** DM-1874: the same fingerprint for our `actual`. */
  actualDigest?: string;
  /** Pixels that differ AND are not classified as glyph anti-aliasing by the
   *  Yee detector. Diagnostic only since DM-715 — see `regionCount` for
   *  pass/fail. */
  nonAaPixels: number;
  /** `nonAaPixels / totalPixels * 100`. Diagnostic. */
  nonAaPixelPct: number;
  /** Average normalized color distance %, AA pixels excluded. Diagnostic. */
  diffPct: number;
  /** Image-wide fraction of pixels with `dist > SIGNIFICANT_PIXEL_DIST` and
   *  not classified AA. Diagnostic. */
  sigPixelPct: number;
  /** Average color distance % for the worst-scoring tile. Diagnostic. */
  worstTilePct: number;
  /** Sig-pixel % for the worst-scoring tile. Diagnostic. */
  worstTileSignificantPct: number;
  /** Pixel rect of the worst tile (also drawn as a yellow box on the diff
   *  PNG so reviewers can navigate to it). */
  worstTileRect: { x: number; y: number; w: number; h: number };

  // DM-715 region scoring ------------------------------------------------------

  /** Number of surviving connected-components regions on the non-AA diff
   *  mask (after 3-px dilation merge + small-region cull). Pass requires 0. */
  regionCount: number;
  /** Total original-diff-pixel area inside the surviving regions. */
  totalChangedArea: number;
  /** Max normalized color distance % (per-pixel `dist / maxDist * 100`)
   *  inside any surviving region. */
  maxRegionSeverity: number;
  /** Non-AA diff pixels that DIDN'T survive region culling (i.e. landed in
   *  components smaller than `MIN_REGION_AREA` after dilation). */
  scatteredPixels: number;
  /** Pixels that differed BUT were absorbed by the neighborhood-tolerant
   *  matching filter (subpixel-shift detector). These never reach the AA
   *  detector or the region mask. Useful diagnostic for "how much of the
   *  raw diff was just 1-px translation noise" — a number close to the
   *  total raw-diff count means most of the visible change was sub-pixel
   *  shift, not structural change. */
  shiftedPixels: number;
  /** Region count that passed the area floor but was culled by the
   *  high-severity-fraction gate — i.e. shape diffs where most pixels are
   *  low-distance edge AA (typical of font substitution / glyph shape
   *  differences). They aren't pure shift artifacts (so the shift filter
   *  didn't catch them) but they aren't real structural change either. */
  shiftyRegionCount: number;
  /** Total area inside `shiftyRegionCount` regions. */
  shiftyRegionArea: number;

  // Shift-inclusive ("strict") region scoring ----------------------------------

  /** Region count with the high-severity-fraction gate LIFTED — every
   *  connected component that cleared the `MIN_REGION_AREA` scatter floor,
   *  whether or not its pixels read as moved/reshaped rather than recolored.
   *  Exactly `regionCount + shiftyRegionCount`.
   *
   *  This is deliberately NOT the pass criterion for the fidelity sweeps. There
   *  the two images come from different rasterizers (Chrome's grid-fitted
   *  native text vs our unhinted outlines), so whole paragraphs land in the
   *  low-severity bucket with nothing structurally wrong, and suppressing them
   *  is load-bearing.
   *
   *  The trio exists for callers that know both images depict content at
   *  IDENTICAL positions, where "it only moved" is itself the bug — e.g. the
   *  frame-sequence compressor's flipbook-parity checks, since layout snaps at
   *  state boundaries. Two equal-sized solid blocks swapping z-order scores 0
   *  on `regionCount` and 1 here.
   *
   *  Note what is NOT lifted: the per-pixel sub-pixel-shift pre-filter still
   *  runs, so differences confined to a ±2 px neighborhood never reach any
   *  region count. That layer stays on even for strict callers because
   *  transform-composed groups genuinely rasterize a sub-pixel phase off a
   *  directly-placed one — measured, the CLEAN compressor fixtures carry
   *  hundreds to thousands of such pixels with zero real change, so a
   *  pixel-level shift-inclusive bar fails on correct output. */
  strictRegionCount: number;
  /** Total original-diff-pixel area inside the `strictRegionCount` regions.
   *  Exactly `totalChangedArea + shiftyRegionArea`. */
  strictRegionArea: number;
  /** Area of the LARGEST single region counted by `strictRegionCount` (0 when
   *  there are none). The sharpest of the three for "did a block move or swap
   *  z-order": glyph-shape drift is inherently sparse and splits into many
   *  small edge-following components, while a moved or reordered element
   *  produces one dense component the size of the element. */
  strictMaxRegionArea: number;
  /** `totalChangedArea` expressed as a percentage of the image's pixels.
   *  Use this rather than the raw count when summarizing — "0.28%" reads
   *  more intuitively than "2858 px" without needing to know the canvas
   *  size. */
  coveragePct: number;
  /** Qualitative severity tier derived from `regionCount` + `coveragePct`.
   *  See `classifyDiff`. */
  verdict: DiffVerdict;
  /** Per-region breakdown: area + max severity + high-sev fraction +
   *  bounding box. Sorted by `area` descending; capped at the top 32
   *  regions to keep payload small. */
  regions: Array<{
    area: number;
    maxSeverity: number;
    highSevFraction: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }>;
}

/** Raw output of the in-page diff `page.evaluate` — every `CompareResult`
 *  metric EXCEPT the caller-derived `verdict`, plus the base64 diff-PNG data
 *  URL. Deriving it from `CompareResult` keeps the page-eval return shape, the
 *  cast below, and the public result from drifting (DM-1072). */
interface EvalDiffResult extends Omit<CompareResult, "verdict"> {
  diffDataUrl: string;
}

/** Node-side serialization stage for the browser analyzer's wire result. */
export function finalizeEvalDiffResult(result: EvalDiffResult): { pngBytes: Buffer; metrics: CompareResult } {
  const comma = result.diffDataUrl.indexOf(",");
  if (comma < 0) throw new Error("PNG comparison returned an invalid data URL");
  const { diffDataUrl: _diffDataUrl, ...rawMetrics } = result;
  return {
    pngBytes: Buffer.from(result.diffDataUrl.slice(comma + 1), "base64"),
    metrics: {
      ...rawMetrics,
      verdict: classifyDiff(result.regionCount, result.coveragePct),
    },
  };
}

/**
 * Compare `expectedPath` vs `actualPath` and write a literal absolute-difference
 * diff PNG to `diffPath`. Returns the full metric set. DM-715 pass criterion:
 * `regionCount === 0`.
 *
 * `comparePage` is any Playwright Page — it just needs to be navigable and to
 * support canvas. Callers typically dedicate a separate page so the run page
 * can keep its viewport / state.
 */
function cleanCompareResult(): CompareResult {
  return {
    nonAaPixels: 0,
    nonAaPixelPct: 0,
    diffPct: 0,
    sigPixelPct: 0,
    worstTilePct: 0,
    worstTileSignificantPct: 0,
    worstTileRect: { x: 0, y: 0, w: 0, h: 0 },
    regionCount: 0,
    totalChangedArea: 0,
    maxRegionSeverity: 0,
    scatteredPixels: 0,
    shiftedPixels: 0,
    shiftyRegionCount: 0,
    shiftyRegionArea: 0,
    strictRegionCount: 0,
    strictRegionArea: 0,
    strictMaxRegionArea: 0,
    coveragePct: 0,
    verdict: "clean",
    regions: [],
  };
}

/** Browser-owned pixel analysis for inputs already proven byte-distinct. */
/** How many regions the comparison outlines on the diff image AND returns in `regions` (both use the
 *  same cap: an outlined region is a reported one). Interpolated into the browser source. */
export const MAX_REPORTED_REGIONS = 32;

export function buildBrowserComparisonSource(
  expectedBytes: Buffer,
  actualBytes: Buffer,
  tilePx: number = TILE_PX,
  significantDist: number = SIGNIFICANT_PIXEL_DIST,
): string {
  const expectedB64 = expectedBytes.toString("base64");
  const actualB64 = actualBytes.toString("base64");

  const config = {
    regionDilatePx: REGION_DILATE_PX,
    minRegionArea: MIN_REGION_AREA,
    shiftMatchRadius: SHIFT_MATCH_RADIUS,
    shiftMatchDist: SHIFT_MATCH_DIST,
    highSevPct: HIGH_SEV_PCT,
    minHighSevFraction: MIN_HIGH_SEV_FRACTION,
    maxReportedRegions: MAX_REPORTED_REGIONS,
  };
  return `(async () => {
${BROWSER_COMPARISON_JS}
return browserComparison.compareImages(${JSON.stringify(expectedB64)}, ${JSON.stringify(actualB64)}, ${tilePx}, ${significantDist}, ${JSON.stringify(config)});
})()`;
}

/** Browser execution stage for inputs already proven byte-distinct. */
async function analyzeDifferentPngs(
  comparePage: Page,
  expectedBytes: Buffer,
  actualBytes: Buffer,
  tilePx: number,
  significantDist: number,
): Promise<EvalDiffResult> {
  const source = buildBrowserComparisonSource(expectedBytes, actualBytes, tilePx, significantDist);
  return (await comparePage.evaluate(source)) as EvalDiffResult;
}

/** Distinct-input coordinator: analyze in Chromium, then serialize in Node. */
async function compareDifferentPngs(
  comparePage: Page,
  expectedBytes: Buffer,
  actualBytes: Buffer,
  diffPath: string,
  tilePx: number = TILE_PX,
  significantDist: number = SIGNIFICANT_PIXEL_DIST,
): Promise<CompareResult> {
  const result = await analyzeDifferentPngs(comparePage, expectedBytes, actualBytes, tilePx, significantDist);

  // Drop the data URL (written to disk below); every remaining field IS a
  // CompareResult metric, so the spread can't drift from the interface.
  const finalized = finalizeEvalDiffResult(result);
  writeFileSync(diffPath, finalized.pngBytes);
  return finalized.metrics;
}

export async function comparePngs(
  comparePage: Page,
  expectedPath: string,
  actualPath: string,
  diffPath: string,
  tilePx: number = TILE_PX,
  significantDist: number = SIGNIFICANT_PIXEL_DIST,
): Promise<CompareResult> {
  const expectedBytes = readFileSync(expectedPath);
  const actualBytes = readFileSync(actualPath);
  // Byte equality is a Node orchestration decision: avoid decoding and walking
  // millions of pixels in Chromium when the encoded inputs are identical.
  if (expectedBytes.length === actualBytes.length && expectedBytes.equals(actualBytes)) {
    copyFileSync(expectedPath, diffPath);
    return cleanCompareResult();
  }
  return compareDifferentPngs(comparePage, expectedBytes, actualBytes, diffPath, tilePx, significantDist);
}

/** DM-715: pre-region pass criterion (every differing pixel must be classified
 *  AA). Retained as a constant only for back-compat with callers that imported
 *  it directly; pass/fail is `passes()` which now reads `regionCount`. */
export const PASS_THRESHOLD_NON_AA_PIXELS = 0;

/** DM-715 pass criterion: zero surviving region (every connected component
 *  of non-AA-diff pixels was smaller than `MIN_REGION_AREA` after the 3-px
 *  dilation merge). Scatter is allowed; structural change is not. */
export function passes(cmp: CompareResult): boolean {
  return cmp.regionCount === 0;
}

/** Caps for the no-motion bar (`passesStrict`). Calibrated on every platform.
 *
 *  Sized from measurement, not taste. Across every state of every
 *  compressed-run fixture on a correct macOS build, the shift-inclusive regions
 *  are entirely sparse glyph-edge drift (max per-pixel severity 34.5%, zero
 *  pixels above the high-severity threshold, ~5–11% fill density inside each
 *  bounding box); most fixtures score a flat 0. Ceiling: 88 px for the largest
 *  single region, 215 px total. The paint-order bug the caps exist to catch —
 *  two equal-sized solid blocks swapping z-order — is instead a single DENSE
 *  component of 3712 px. The caps sit ~3x above the clean ceiling and 5–15x
 *  below the known break, the widest separation the two populations allow.
 *
 *  `maxRegionArea` is the sharper of the two: glyph drift splits into many
 *  small edge-following components, while a moved or reordered element produces
 *  one component the size of the element. `totalRegionArea` is the backstop for
 *  a bug that scatters mid-sized components instead of making one big one.
 *
 *  ONE cap set covers every platform, and the same numbers macOS always used —
 *  the other hosts were raised to meet them rather than the bar being relaxed to
 *  fit the other hosts.
 *
 *  They could not be shared at first. The same correct build measured up to
 *  749 px largest / 3289 px total in the Linux container — overlapping the
 *  3712 px break, so no Linux cap could both pass a correct build and fail a
 *  broken one, and non-darwin hosts fell back to a plain `regionCount === 0`
 *  gate with the blind spot these caps exist to close. The cause was not the
 *  compressor and not the comparator: Chrome does not use LCD (subpixel) text
 *  antialiasing inside a composited layer, and a compressed run wraps paired
 *  content in animated transform groups that get their own layer. So on a host
 *  where LCD text is on, the compressed render was being compared against an
 *  LCD-antialiased flipbook and every glyph edge in the frame differed. macOS
 *  has had LCD text off since Big Sur, which is the only reason it looked
 *  calibrated and the others did not.
 *
 *  The fixtures now rasterize with it off on every host (`PARITY_LAUNCH_OPTS`
 *  in `tests/flipbook-parity.ts`) and additionally pin their own bundled faces
 *  (`tests/fixture-fonts.ts`) instead of asking for host-dependent families.
 *  Chromium 147 changed path-edge rasterization between a direct frame and the
 *  equivalent animated layer. Re-measuring the current 900x420 two-pane corpus
 *  on macOS gives a clean ceiling of 94 px for one component and 1636 px in
 *  total, still with `regionCount === 0`; disabling GPU compositing produces
 *  the same result. The known out-of-position-reopen break remains separated:
 *  3712 px with `regionCount === 0`, including a component larger than the
 *  unchanged 256 px single-region cap. The same Chromium build's pinned Linux
 *  x64 run measures 2065 px total in the two-pane fixture (48 sparse regions,
 *  135 px largest, zero high-severity regions). GitHub's macOS 26.6.2 runner
 *  image moved the clean ceiling to 2835 px total / 171 px largest, with five
 *  edge components crossing the default high-severity classification. The 3072
 *  aggregate cap admits those measured scattered text-edge floors while the
 *  independent 256 px component cap still rejects the known structural break.
 *
 *  Unlike the visual gate's per-platform hinting floor ("Per-platform coverage
 *  floor" in docs/12-diff-scoring.md), this bar needs no per-platform relief:
 *  there both images come from DIFFERENT rasterizers, so the host's text
 *  rendering is inherently part of the measurement; here both come from ours. */
export interface StrictCaps {
  maxRegionArea: number;
  totalRegionArea: number;
}
export function strictCapsFor(_platform: NodeJS.Platform | string): StrictCaps {
  return { maxRegionArea: 256, totalRegionArea: 3072 };
}
/** The host's caps. Never null: the bar is calibrated on every platform. */
export const STRICT_CAPS = strictCapsFor(process.platform);

/** The no-motion pass criterion: "nothing block-sized moved or swapped paint
 *  order". Lifts the high-severity-fraction gate that splits components between
 *  `regionCount` and `shiftyRegionCount`, then bounds ALL of them by area (see
 *  `strictCapsFor` for the measured sizing). Requiring `passes()` as well would
 *  put that raster-sensitive severity split back into the strict gate even
 *  though the strict aggregates already contain both buckets.
 *
 *  Use this ONLY where both images are known to depict the same content at the
 *  same positions — e.g. the frame-sequence compressor's flipbook-parity
 *  checks, where both PNGs come out of our own renderer and layout snaps at
 *  state boundaries. The fidelity sweeps must keep using `passes()`: there the
 *  two images come from different rasterizers, low-severity suppression is what
 *  keeps every paragraph of text from reading as structural change, and these
 *  caps would fail essentially every text-bearing fixture.
 *
 *  `caps` defaults to the host's, which are now the same on every platform.
 *  Pass an explicit set to score a result against different numbers; passing
 *  `null` deliberately degrades the bar to plain `passes()`. */
export function passesStrict(cmp: CompareResult, caps: StrictCaps | null = STRICT_CAPS): boolean {
  if (caps == null) return passes(cmp);
  return cmp.strictMaxRegionArea <= caps.maxRegionArea && cmp.strictRegionArea <= caps.totalRegionArea;
}
