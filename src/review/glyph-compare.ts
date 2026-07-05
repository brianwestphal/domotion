/**
 * Glyph font-identity comparator (DM-1686).
 *
 * Given two PNG crops of the SAME character — one from Chromium's expected
 * paint, one from Domotion's rendered SVG — decide with high probability
 * whether they were rendered with the same font (family + size + weight +
 * style + other modifiers) or different ones, while excluding anti-aliasing /
 * subpixel-positioning noise. Deterministic, traditional computer vision — no
 * ML — so verdicts are reproducible run to run.
 *
 * Design (see docs/98-glyph-font-compare.md for the research background,
 * calibration data, and crop requirements):
 *
 *   The two crops are produced by the caller at the same nominal scale and
 *   position, so a CORRECT render differs only by rasterization noise:
 *   sub-pixel phase (≤ 0.5 px edge shift) and AA coverage differences (a
 *   ~1 device-px transition band along edges). Both are ABSOLUTE-size
 *   effects — they don't grow with the glyph — while genuine font
 *   differences (different outline, weight, optical size, slant) scale with
 *   glyph size. Distance-based outline metrics therefore separate cleanly
 *   when the ink is large enough (recommend ≥ 32 px ink height, i.e. capture
 *   crops at 2×+ DPR).
 *
 *   A battery of metrics is computed on normalized ink-coverage maps:
 *
 *     size       — ink bounding-box dimensions (wrong font size / x-height /
 *                  width class shows up here before anything else).
 *     mass       — total ink coverage ratio (PANOSE "weight" axis: bold vs
 *                  regular changes ink mass ~30-50% while the skeleton stays).
 *     outline    — symmetric distance-transform agreement of the binarized
 *                  masks after subpixel alignment: fraction of ink farther
 *                  than a tolerance from the other image's ink, plus the 95th
 *                  percentile edge distance. This is the AA-exclusion core: a
 *                  ≤ ~1 px band is rasterization noise, beyond it is shape.
 *     stroke     — stem-width distribution via an exact Euclidean distance
 *                  transform (ridge sampling): median stroke width ratio
 *                  (weight) and p90/p10 stroke contrast (PANOSE "contrast"
 *                  axis — serif faces modulate strokes, sans mostly don't).
 *     orientation— Sobel edge-orientation histogram (16 bins, magnitude
 *                  weighted): slant/italic shifts the stem bins; serifs and
 *                  terminal shapes add horizontal/diagonal energy.
 *     topology   — counter (hole) count of the binarized ink: a different
 *                  glyph shape (double-story vs single-story a, filled vs
 *                  open counters) is a hard structural signal.
 *     zoning     — 5×5 mass-distribution grid over the aligned common bbox
 *                  (classic OCR zoning): catches x-height / midline /
 *                  aperture redistribution that per-pixel metrics dilute.
 *     ncc        — peak normalized cross-correlation (overall similarity
 *                  scalar; also drives the subpixel alignment).
 *
 *   The verdict combines them: any HARD threshold breach → "mismatch";
 *   two or more SOFT breaches (¾ of hard) → "mismatch"; else "match".
 *   Thresholds were calibrated against a Playwright-rendered corpus of real
 *   same-font pairs (subpixel-offset re-renders) and different-font pairs
 *   (lookalike families, weight steps, size steps, synthetic vs real italic)
 *   — see the doc for the measured distributions.
 *
 *   Semantics note: the tool answers "is the RENDERED SHAPE the same?". Two
 *   fonts that produce pixel-identical glyphs for a character (e.g. Arial vs
 *   Helvetica 'l') return "match" — which is the right answer for fidelity
 *   review, where visual equality IS correctness.
 */

import sharp from "sharp";

// ── Types ──────────────────────────────────────────────────────────────────

/** Normalized ink-coverage map: 0 = background, 1 = full ink. */
export interface CoverageMap {
  width: number;
  height: number;
  /** Row-major coverage, length = width * height. */
  cov: Float32Array;
  /** Ink bounding box measured at coverage ≥ 0.5 (stable across AA). */
  inkBox: { x: number; y: number; w: number; h: number };
  /** Total coverage sum (sub-pixel-accurate ink mass). */
  inkSum: number;
  /** Loader diagnostics (polarity, background uniformity). */
  notes: string[];
}

export interface GlyphCompareMetrics {
  /** Ink bbox dims per image. */
  inkWidthA: number; inkHeightA: number;
  inkWidthB: number; inkHeightB: number;
  /** max(|Δw|, |Δh|) in px. */
  sizeDiffPx: number;
  /** max dimension ratio (≥ 1). */
  sizeRatio: number;
  /** ln(inkSumA / inkSumB) — weight/mass signal. */
  inkLogRatio: number;
  /** Peak normalized cross-correlation after alignment (0..1). */
  ncc: number;
  /** Alignment applied to B, px (diagnostic). */
  alignDx: number; alignDy: number;
  /** Fraction of A's ink pixels farther than `outlineTolerancePx` from B's
   *  ink (and vice versa), after alignment. The AA-excluded shape signal. */
  unexplainedA: number; unexplainedB: number;
  /** 95th-percentile / max distance (px) from each image's ink to the
   *  other's ink. */
  d95: number; dMax: number;
  /** Max 3×3-box-blurred |Δcoverage| after alignment. Local shape-evidence
   *  hotspot: a residual subpixel edge shift blurs to ≲ 0.2, a real patch of
   *  redistributed ink (different terminal cut, tail, spur) blurs to ≳ 0.4 —
   *  catches lookalike-family differences that ink-FRACTION metrics dilute. */
  hotspotMax: number;
  /** Mean stroke width per image (px), estimated as 4 × mean distance-to-
   *  background over all ink pixels (exact for a long ribbon; stable under
   *  subpixel phase, unlike ridge medians which quantize). + ln ratio. */
  strokeWidthA: number; strokeWidthB: number; strokeLogRatio: number;
  /** p90/p10 ridge-width modulation per image + ln ratio. DIAGNOSTIC ONLY —
   *  ridge sampling quantizes too coarsely at text sizes to gate on (the
   *  same-pair noise reaches ln 2); weight/design changes are gated via
   *  mass + strokeWidth instead. */
  strokeContrastA: number; strokeContrastB: number; contrastLogRatio: number;
  /** L1 distance between magnitude-weighted 16-bin edge-orientation
   *  histograms (0..2). */
  orientL1: number;
  /** Counter (hole) counts. */
  holesA: number; holesB: number;
  /** RMS difference of 5×5 zone mean coverages (0..1). */
  zoningL2: number;
}

export type GlyphVerdict = "match" | "mismatch";

export interface GlyphCompareResult {
  verdict: GlyphVerdict;
  /** high = clear margin on ≥ 2 independent axes (or zero signals at all for
   *  match); medium = single decisive axis / near-threshold; low = conflicting
   *  or near-threshold evidence — treat as "probably" and re-crop larger. */
  confidence: "high" | "medium" | "low";
  /** Human-readable explanations of every fired (or notably clean) signal. */
  reasons: string[];
  metrics: GlyphCompareMetrics;
  /** Names of metrics that breached HARD thresholds. */
  hardSignals: string[];
  /** Names of metrics that breached SOFT (¾) thresholds only. */
  softSignals: string[];
  /** Loader/validation warnings (small ink, non-uniform background, …). */
  warnings: string[];
}

/** Tunable decision thresholds. Defaults calibrated per docs/98. */
export interface GlyphCompareThresholds {
  /** Distance (px) beyond which ink is "unexplained" by the other image.
   *  1.75 px = 0.5 px subpixel phase + ~1 px AA band + margin. */
  outlineTolerancePx: number;
  /** Hard: fraction of ink unexplained at the tolerance. */
  unexplainedFrac: number;
  /** Hard: 95th-percentile edge distance, px. */
  d95Px: number;
  /** Hard: max 3×3-blurred |Δcoverage| hotspot, for ink ≥ `recommendedInkPx`.
   *  The lookalike-family discriminator (Helvetica vs Arial 'e' differs ONLY
   *  here) — calibrated same-pair noise tops out at 0.145 at ≥24 px ink. */
  hotspotMax: number;
  /** Hard hotspot for ink BELOW `recommendedInkPx` — small glyphs carry
   *  proportionally more AA-band noise (same-pair max 0.161 at 16 px), so the
   *  small-ink gate is looser and lookalike sensitivity is reduced there. */
  hotspotMaxSmall: number;
  /** Hard: max(|Δw|,|Δh|) px, after the proportional allowance below. */
  sizeDiffPx: number;
  /** Proportional size allowance (fraction of max ink height). */
  sizeDiffFrac: number;
  /** Hard: |ln(inkA/inkB)|. ln(1.18) ≈ 0.166. */
  inkLogRatio: number;
  /** Hard: |ln(strokeA/strokeB)|. */
  strokeLogRatio: number;
  /** Hard: |ln(contrastA/contrastB)|. */
  contrastLogRatio: number;
  /** Hard: orientation-histogram L1. */
  orientL1: number;
  /** Hard: zoning RMS. */
  zoningL2: number;
  /** Hard (floor): NCC below this is a mismatch signal. */
  nccMin: number;
  /** Thin-detail guard: NCC at/above which a mismatch driven ONLY by the
   *  outline/d95 pair is reattributed to anti-aliasing phase drift on a thin,
   *  repeating feature (dashed enclosure, hairline ring) rather than a font
   *  difference. Well above the highest real-difference NCC in the corpus. */
  nccThinDetailFloor: number;
  /** Soft threshold factor (soft = hard × this). */
  softFactor: number;
  /** Minimum ink-box height (px) below which comparison errors out. */
  minInkPx: number;
  /** Ink-box height below which a low-resolution warning is attached. */
  recommendedInkPx: number;
}

/**
 * Default thresholds — calibrated against the DM-1686 Playwright corpus
 * (tools/glyph-compare-calibrate.ts): same-font pairs are subpixel-offset
 * re-renders of one glyph; different pairs span lookalike families
 * (Helvetica/Arial/Helvetica Neue, Times/Times New Roman/Georgia), weight
 * steps (400→500→700), size steps (±1 px at 32 px), and synthetic oblique vs
 * real italic. See docs/98-glyph-font-compare.md § Calibration for the
 * measured same/different distributions each number is cut from.
 */
export const DEFAULT_THRESHOLDS: GlyphCompareThresholds = {
  outlineTolerancePx: 1.5,
  unexplainedFrac: 0.01,
  d95Px: 1.5,
  hotspotMax: 0.17,
  hotspotMaxSmall: 0.24,
  sizeDiffPx: 2.0,
  sizeDiffFrac: 0.035,
  inkLogRatio: Math.log(1.1),
  strokeLogRatio: Math.log(1.22),
  contrastLogRatio: Math.log(1.6), // diagnostic only — not gated (see decide)
  orientL1: 0.32,
  zoningL2: 0.075,
  nccMin: 0.975,
  nccThinDetailFloor: 0.93,
  softFactor: 0.75,
  minInkPx: 8,
  recommendedInkPx: 24,
};

// ── PNG → coverage map ─────────────────────────────────────────────────────

/**
 * Decode a PNG (path or buffer), optionally crop to `rect`, and normalize to
 * an ink-coverage map. Requirements (documented in docs/98): a single glyph
 * on a solid background, ink in a single color, either polarity (dark-on-
 * light or light-on-dark — auto-detected from the border). Transparency is
 * flattened onto white first.
 */
export async function loadGlyphCoverage(
  source: string | Buffer,
  rect?: { x: number; y: number; w: number; h: number },
): Promise<CoverageMap> {
  let img = sharp(source).flatten({ background: "#ffffff" });
  if (rect != null) {
    img = img.extract({ left: rect.x, top: rect.y, width: rect.w, height: rect.h });
  }
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return extractCoverage(data, info.width, info.height, info.channels);
}

/**
 * Pure coverage extraction from raw pixel data (exported for unit tests).
 * Luminance-based: background luminance = median of the 1-px border ring;
 * ink luminance = the luminance farthest from the background among all
 * pixels; coverage = |lum − bg| / |ink − bg|, clamped to [0, 1]. Handles both
 * polarities and any solid ink/background color pair.
 */
export function extractCoverage(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
): CoverageMap {
  const n = width * height;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    // Rec. 601 luma (matches the review comparator's rgbY weights).
    lum[i] = data[o] * 0.298912 + data[o + 1] * 0.586611 + data[o + 2] * 0.114478;
  }
  const notes: string[] = [];

  // Background = median of the border ring (robust to a few ink pixels
  // touching the crop edge).
  const border: number[] = [];
  for (let x = 0; x < width; x++) { border.push(lum[x], lum[(height - 1) * width + x]); }
  for (let y = 1; y < height - 1; y++) { border.push(lum[y * width], lum[y * width + width - 1]); }
  border.sort((a, b) => a - b);
  const bg = border[border.length >> 1];
  const borderSpread = border[Math.floor(border.length * 0.98)] - border[Math.floor(border.length * 0.02)];
  if (borderSpread > 40) {
    notes.push(
      `non-uniform background (border luminance spread ${borderSpread.toFixed(0)}) — `
      + "crop may clip the glyph or contain neighboring content",
    );
  }

  // Ink = the luminance extreme farthest from the background.
  let minL = Infinity, maxL = -Infinity;
  for (let i = 0; i < n; i++) {
    if (lum[i] < minL) minL = lum[i];
    if (lum[i] > maxL) maxL = lum[i];
  }
  const darkInk = Math.abs(minL - bg) >= Math.abs(maxL - bg);
  const ink = darkInk ? minL : maxL;
  const span = Math.abs(ink - bg);
  if (span < 32) notes.push(`low ink/background contrast (${span.toFixed(0)}/255) — coverage is noisy`);
  if (!darkInk) notes.push("light-on-dark polarity detected (inverted)");

  const cov = new Float32Array(n);
  if (span > 0) {
    const inv = 1 / span;
    for (let i = 0; i < n; i++) {
      const c = (darkInk ? bg - lum[i] : lum[i] - bg) * inv;
      cov[i] = c <= 0 ? 0 : c >= 1 ? 1 : c;
    }
  }

  // Ink bbox at coverage ≥ 0.5 + total mass.
  let x0 = width, y0 = height, x1 = -1, y1 = -1, inkSum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = cov[y * width + x];
      inkSum += c;
      if (c >= 0.5) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const inkBox = x1 >= 0
    ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
    : { x: 0, y: 0, w: 0, h: 0 };
  return { width, height, cov, inkBox, inkSum, notes };
}

// ── Exact Euclidean distance transform (Felzenszwalb–Huttenlocher) ────────

const INF = 1e20;

/** 1-D squared-distance transform via the lower envelope of parabolas. */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Exact Euclidean distance (px) from every pixel to the nearest ON pixel of
 * `mask`. Pixels of the mask itself get 0. All-OFF masks return +∞ everywhere.
 * Exported for unit tests.
 */
export function distanceTransform(mask: Uint8Array, width: number, height: number): Float32Array {
  const n = width * height;
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = mask[i] ? 0 : INF;
  const maxDim = Math.max(width, height);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);
  // Columns.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = g[y * width + x];
    dt1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) g[y * width + x] = d[y];
  }
  // Rows.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = g[row + x];
    dt1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) g[row + x] = d[x];
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = g[i] >= INF ? Infinity : Math.sqrt(g[i]);
  return out;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Pad/copy `src`'s ink-box region onto a canvas of `cw×ch`, placing the ink
 *  box's center at the canvas center (integer placement). */
function centerOnCanvas(src: CoverageMap, cw: number, ch: number): Float32Array {
  const out = new Float32Array(cw * ch);
  const { x, y, w, h } = src.inkBox;
  // Copy a margin around the ink box too (AA skirt lives outside the ≥0.5
  // bbox); clamp to source bounds.
  const M = 4;
  const sx0 = Math.max(0, x - M), sy0 = Math.max(0, y - M);
  const sx1 = Math.min(src.width - 1, x + w - 1 + M), sy1 = Math.min(src.height - 1, y + h - 1 + M);
  const dx = Math.round(cw / 2 - (x + w / 2)) ;
  const dy = Math.round(ch / 2 - (y + h / 2));
  for (let sy = sy0; sy <= sy1; sy++) {
    const ty = sy + dy;
    if (ty < 0 || ty >= ch) continue;
    for (let sx = sx0; sx <= sx1; sx++) {
      const tx = sx + dx;
      if (tx < 0 || tx >= cw) continue;
      out[ty * cw + tx] = src.cov[sy * src.width + sx];
    }
  }
  return out;
}

/** Normalized cross-correlation of two same-size coverage arrays. */
function nccOf(a: Float32Array, b: Float32Array): number {
  let sa = 0, sb = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

/** Shift `src` by integer (dx, dy) then fractional (fx, fy) via bilinear
 *  sampling. Positive shifts move content toward +x/+y. */
function shiftBilinear(src: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      let acc = 0;
      for (let oy = 0; oy <= 1; oy++) {
        const yy = y0 + oy;
        if (yy < 0 || yy >= h) continue;
        const wy = oy === 0 ? 1 - fy : fy;
        if (wy === 0) continue;
        for (let ox = 0; ox <= 1; ox++) {
          const xx = x0 + ox;
          if (xx < 0 || xx >= w) continue;
          const wx = ox === 0 ? 1 - fx : fx;
          if (wx === 0) continue;
          acc += src[yy * w + xx] * wy * wx;
        }
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** Percentile of a numeric array (nearest-rank on a sorted copy). */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Binarize coverage at 0.5. */
function binarize(cov: Float32Array): Uint8Array {
  const out = new Uint8Array(cov.length);
  for (let i = 0; i < cov.length; i++) out[i] = cov[i] >= 0.5 ? 1 : 0;
  return out;
}

/** Count interior background components (counters/holes) of a binary mask:
 *  4-connected background components not touching the canvas border.
 *  Components smaller than `minArea` px are ignored — a 1–3 px "hole" is AA
 *  flicker (e.g. the eye of a 16 px serif 'e' closing at one subpixel phase
 *  and not the other), not glyph structure. */
export function countHoles(mask: Uint8Array, w: number, h: number, minArea = 4): number {
  const label = new Int8Array(w * h); // 0 unvisited, 1 visited
  const stack = new Int32Array(w * h);
  // Flood the border-connected background first.
  let sp = 0;
  const push = (p: number): void => { if (!mask[p] && !label[p]) { label[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp > 0) {
    const p = stack[--sp];
    const y = (p / w) | 0, x = p - y * w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  // Remaining unvisited background = holes (area-filtered).
  let holes = 0;
  for (let p = 0; p < w * h; p++) {
    if (mask[p] || label[p]) continue;
    let area = 1;
    label[p] = 1;
    stack[sp++] = p;
    while (sp > 0) {
      const q = stack[--sp];
      const y = (q / w) | 0, x = q - y * w;
      if (x > 0 && !mask[q - 1] && !label[q - 1]) { label[q - 1] = 1; stack[sp++] = q - 1; area++; }
      if (x < w - 1 && !mask[q + 1] && !label[q + 1]) { label[q + 1] = 1; stack[sp++] = q + 1; area++; }
      if (y > 0 && !mask[q - w] && !label[q - w]) { label[q - w] = 1; stack[sp++] = q - w; area++; }
      if (y < h - 1 && !mask[q + w] && !label[q + w]) { label[q + w] = 1; stack[sp++] = q + w; area++; }
    }
    if (area >= minArea) holes++;
  }
  return holes;
}

/**
 * Mean stroke width (px): 4 × mean distance-to-background over all ink
 * pixels — exact for a long uniform ribbon (mean interior depth = width/4),
 * and, unlike ridge-median sampling, continuous under subpixel phase (ridge
 * DT values quantize to 2·{1, √2, 2, …}, which flips the median a full
 * quantum between phases at text sizes — the DM-1686 calibration's dominant
 * false-mismatch source). Exported for unit tests.
 */
export function meanStrokeWidth(mask: Uint8Array, w: number, h: number): number {
  const bg = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) bg[i] = mask[i] ? 0 : 1;
  const dt = distanceTransform(bg, w, h);
  let sum = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) { sum += dt[i]; n++; }
  }
  return n > 0 ? (4 * sum) / n : 0;
}

/** Ridge stroke widths: for ink pixels that are local maxima of the
 *  ink-interior distance transform, width ≈ 2·DT. Returns the sampled widths
 *  (px). Exported for unit tests. */
export function ridgeStrokeWidths(mask: Uint8Array, w: number, h: number): number[] {
  // DT to the nearest BACKGROUND pixel = depth inside the ink.
  const bg = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) bg[i] = mask[i] ? 0 : 1;
  const dt = distanceTransform(bg, w, h);
  const widths: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      const d = dt[p];
      if (d <= 0.5) continue;
      // 8-neighborhood local maximum (ties allowed — plateau ridges count).
      if (
        d >= dt[p - 1] && d >= dt[p + 1]
        && d >= dt[p - w] && d >= dt[p + w]
        && d >= dt[p - w - 1] && d >= dt[p - w + 1]
        && d >= dt[p + w - 1] && d >= dt[p + w + 1]
      ) {
        widths.push(2 * d);
      }
    }
  }
  return widths;
}

/** Magnitude-weighted 16-bin edge-orientation histogram (mod 180°),
 *  L1-normalized. Sobel on the coverage map. Exported for unit tests. */
export function orientationHistogram(cov: Float32Array, w: number, h: number): Float64Array {
  const BINS = 16;
  const hist = new Float64Array(BINS);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx =
        (cov[p - w + 1] + 2 * cov[p + 1] + cov[p + w + 1])
        - (cov[p - w - 1] + 2 * cov[p - 1] + cov[p + w - 1]);
      const gy =
        (cov[p + w - 1] + 2 * cov[p + w] + cov[p + w + 1])
        - (cov[p - w - 1] + 2 * cov[p - w] + cov[p - w + 1]);
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag < 0.05) continue;
      let angle = Math.atan2(gy, gx); // -π..π
      if (angle < 0) angle += Math.PI; // mod 180°
      let bin = Math.floor((angle / Math.PI) * BINS);
      if (bin >= BINS) bin = BINS - 1;
      hist[bin] += mag;
    }
  }
  let sum = 0;
  for (let i = 0; i < BINS; i++) sum += hist[i];
  if (sum > 0) for (let i = 0; i < BINS; i++) hist[i] /= sum;
  return hist;
}

/** Zone mean-coverage vector over the union ink bbox. The grid is adaptive:
 *  up to 5×5, but never zones narrower than ~6 px — on a skinny glyph ('l'
 *  is ~6 px wide at 16 px/2×) fixed 1-px-wide zones swing ~30% of their mass
 *  with a 0.4 px residual alignment error (a DM-1686 calibration
 *  false-mismatch source). */
function zoningVector(
  cov: Float32Array, w: number, h: number,
  box: { x: number; y: number; w: number; h: number },
  zonesX: number, zonesY: number,
): Float64Array {
  const ZX = zonesX, ZY = zonesY;
  const out = new Float64Array(ZX * ZY);
  for (let zy = 0; zy < ZY; zy++) {
    const y0 = box.y + Math.floor((zy * box.h) / ZY);
    const y1 = box.y + Math.floor(((zy + 1) * box.h) / ZY);
    for (let zx = 0; zx < ZX; zx++) {
      const x0 = box.x + Math.floor((zx * box.w) / ZX);
      const x1 = box.x + Math.floor(((zx + 1) * box.w) / ZX);
      let sum = 0, count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (x < 0 || x >= w || y < 0 || y >= h) continue;
          sum += cov[y * w + x];
          count++;
        }
      }
      out[zy * ZX + zx] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/** Max of a 3×3 box blur of |a − b| — the local shape-evidence hotspot. */
function hotspotOf(a: Float32Array, b: Float32Array, w: number, h: number): number {
  const diff = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) diff[i] = Math.abs(a[i] - b[i]);
  let best = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const s =
        diff[p - w - 1] + diff[p - w] + diff[p - w + 1]
        + diff[p - 1] + diff[p] + diff[p + 1]
        + diff[p + w - 1] + diff[p + w] + diff[p + w + 1];
      const m = s / 9;
      if (m > best) best = m;
    }
  }
  return best;
}

/** Ink bbox (cov ≥ 0.5) of a raw coverage array. */
function bboxOf(cov: Float32Array, w: number, h: number): { x: number; y: number; w: number; h: number } {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cov[y * w + x] >= 0.5) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 >= 0 ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : { x: 0, y: 0, w: 0, h: 0 };
}

// ── Core comparison ────────────────────────────────────────────────────────

/**
 * Compare two glyph coverage maps and return the verdict + full metric set.
 * Throws when either image has no ink or the ink is below
 * `thresholds.minInkPx` tall AND wide (too small to classify).
 */
export function compareGlyphCoverage(
  a: CoverageMap,
  b: CoverageMap,
  thresholds: GlyphCompareThresholds = DEFAULT_THRESHOLDS,
): GlyphCompareResult {
  const warnings = [...a.notes.map((s) => `A: ${s}`), ...b.notes.map((s) => `B: ${s}`)];
  if (a.inkBox.w === 0 || b.inkBox.w === 0) {
    throw new Error("glyph-compare: one or both crops contain no ink (blank image?)");
  }
  const maxInkA = Math.max(a.inkBox.w, a.inkBox.h);
  const maxInkB = Math.max(b.inkBox.w, b.inkBox.h);
  if (maxInkA < thresholds.minInkPx || maxInkB < thresholds.minInkPx) {
    throw new Error(
      `glyph-compare: ink too small to classify (${maxInkA}px / ${maxInkB}px; need ≥ ${thresholds.minInkPx}px). `
      + "Re-crop at a higher scale.",
    );
  }
  if (Math.max(a.inkBox.h, b.inkBox.h) < thresholds.recommendedInkPx) {
    warnings.push(
      `ink height below the recommended ${thresholds.recommendedInkPx}px — verdicts are less reliable at this `
      + "resolution; prefer 2×+ crops",
    );
  }

  // ── Common canvas, centered by ink-box centers ──
  const margin = 8;
  const cw = Math.max(a.inkBox.w, b.inkBox.w) + margin * 2;
  const ch = Math.max(a.inkBox.h, b.inkBox.h) + margin * 2;
  let ca = centerOnCanvas(a, cw, ch);
  let cb = centerOnCanvas(b, cw, ch);

  // ── Alignment: integer NCC search ±3 px, then parabolic subpixel refine ──
  let bestDx = 0, bestDy = 0, bestNcc = -Infinity;
  const nccAt = new Map<string, number>();
  const evalShift = (dx: number, dy: number): number => {
    const key = `${dx},${dy}`;
    const cached = nccAt.get(key);
    if (cached != null) return cached;
    const shifted = (dx === 0 && dy === 0) ? cb : shiftBilinear(cb, cw, ch, dx, dy);
    const v = nccOf(ca, shifted);
    nccAt.set(key, v);
    return v;
  };
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const v = evalShift(dx, dy);
      if (v > bestNcc) { bestNcc = v; bestDx = dx; bestDy = dy; }
    }
  }
  // Parabolic refinement per axis from the integer peak.
  const refine = (m1: number, c0: number, p1: number): number => {
    const den = m1 - 2 * c0 + p1;
    if (den >= 0) return 0; // not a peak — keep integer
    const off = 0.5 * (m1 - p1) / den;
    return Math.max(-0.5, Math.min(0.5, off));
  };
  let fx = refine(evalShift(bestDx - 1, bestDy), evalShift(bestDx, bestDy), evalShift(bestDx + 1, bestDy));
  let fy = refine(evalShift(bestDx, bestDy - 1), evalShift(bestDx, bestDy), evalShift(bestDx, bestDy + 1));
  // Second, finer parabolic pass at ±0.25 px around the first estimate — cuts
  // the residual misalignment to ≲ 0.1 px, which directly lowers the
  // same-render hotspot noise floor (the hotspot is the discriminator for
  // lookalike families, so alignment quality buys detection margin).
  const fineStep = 0.25;
  const fx2 = refine(
    evalShift(bestDx + fx - fineStep, bestDy + fy),
    evalShift(bestDx + fx, bestDy + fy),
    evalShift(bestDx + fx + fineStep, bestDy + fy),
  );
  const fy2 = refine(
    evalShift(bestDx + fx, bestDy + fy - fineStep),
    evalShift(bestDx + fx, bestDy + fy),
    evalShift(bestDx + fx, bestDy + fy + fineStep),
  );
  fx += fx2 * fineStep;
  fy += fy2 * fineStep;
  const alignDx = bestDx + fx;
  const alignDy = bestDy + fy;
  // Apply the shift with SYMMETRIC fractional resampling: bilinear shifting
  // softens edges slightly, so shifting only B would leave B blurrier than A
  // and the blur asymmetry itself reads as a coverage difference (inflating
  // the hotspot on crisp-edged renders). Splitting the fractional part —
  // −frac/2 to A, +frac/2 to B (the integer part stays on B; integer shifts
  // don't resample) — gives both images identical softening while keeping
  // the relative shift exact.
  const intDx = Math.round(alignDx), intDy = Math.round(alignDy);
  const fracDx = alignDx - intDx, fracDy = alignDy - intDy;
  if (fracDx !== 0 || fracDy !== 0) {
    ca = shiftBilinear(ca, cw, ch, -fracDx / 2, -fracDy / 2);
  }
  cb = shiftBilinear(cb, cw, ch, intDx + fracDx / 2, intDy + fracDy / 2);
  const ncc = nccOf(ca, cb);

  // ── Outline agreement via distance transforms ──
  const ma = binarize(ca);
  const mb = binarize(cb);
  const dtToB = distanceTransform(mb, cw, ch);
  const dtToA = distanceTransform(ma, cw, ch);
  const distsA: number[] = [];
  const distsB: number[] = [];
  let unexplA = 0, nA = 0, unexplB = 0, nB = 0;
  for (let p = 0; p < cw * ch; p++) {
    if (ma[p]) {
      nA++;
      const d = dtToB[p];
      distsA.push(d);
      if (d > thresholds.outlineTolerancePx) unexplA++;
    }
    if (mb[p]) {
      nB++;
      const d = dtToA[p];
      distsB.push(d);
      if (d > thresholds.outlineTolerancePx) unexplB++;
    }
  }
  const unexplainedA = nA > 0 ? unexplA / nA : 1;
  const unexplainedB = nB > 0 ? unexplB / nB : 1;
  const d95 = Math.max(percentile(distsA, 95), percentile(distsB, 95));
  const dMax = Math.max(
    distsA.reduce((m, v) => (v > m ? v : m), 0),
    distsB.reduce((m, v) => (v > m ? v : m), 0),
  );

  // ── Stroke geometry ──
  const strokeWidthA = meanStrokeWidth(ma, cw, ch);
  const strokeWidthB = meanStrokeWidth(mb, cw, ch);
  const strokeLogRatio = (strokeWidthA > 0 && strokeWidthB > 0)
    ? Math.log(strokeWidthA / strokeWidthB) : 0;
  // Ridge-based modulation stays as a DIAGNOSTIC (quantizes too coarsely at
  // text sizes to gate on — see the metric's doc comment).
  const contrast = (ws: number[]): number => {
    const lo = percentile(ws, 10), hi = percentile(ws, 90);
    return lo > 0 ? hi / lo : 1;
  };
  const strokeContrastA = contrast(ridgeStrokeWidths(ma, cw, ch));
  const strokeContrastB = contrast(ridgeStrokeWidths(mb, cw, ch));
  const contrastLogRatio = Math.log(strokeContrastA / strokeContrastB);

  // ── Local shape-evidence hotspot ──
  const hotspotMax = hotspotOf(ca, cb, cw, ch);

  // ── Orientation histograms ──
  const ha = orientationHistogram(ca, cw, ch);
  const hb = orientationHistogram(cb, cw, ch);
  let orientL1 = 0;
  for (let i = 0; i < ha.length; i++) orientL1 += Math.abs(ha[i] - hb[i]);

  // ── Topology ──
  const holesA = countHoles(ma, cw, ch);
  const holesB = countHoles(mb, cw, ch);

  // ── Zoning over the union bbox ──
  const boxA = bboxOf(ca, cw, ch);
  const boxB = bboxOf(cb, cw, ch);
  // Expand by an AA margin so the sub-0.5 coverage skirt is INSIDE the zoned
  // area — on a narrow stem ('l' is 3 px wide at 16 px/2×) a phase shift
  // moves ~15% of the bar's mass into a skirt column, and a box cut at the
  // ≥0.5 contour drops that mass from one image's zones but not the other's
  // (a DM-1686 calibration false-mismatch source). Including the skirt
  // restores the coverage-integral's subpixel invariance.
  const AA_MARGIN = 2;
  const ux0 = Math.max(0, Math.min(boxA.x, boxB.x) - AA_MARGIN);
  const uy0 = Math.max(0, Math.min(boxA.y, boxB.y) - AA_MARGIN);
  const ux1 = Math.min(cw, Math.max(boxA.x + boxA.w, boxB.x + boxB.w) + AA_MARGIN);
  const uy1 = Math.min(ch, Math.max(boxA.y + boxA.h, boxB.y + boxB.h) + AA_MARGIN);
  const ubox = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };
  const zonesX = Math.max(1, Math.min(5, Math.floor(ubox.w / 6)));
  const zonesY = Math.max(1, Math.min(5, Math.floor(ubox.h / 6)));
  const za = zoningVector(ca, cw, ch, ubox, zonesX, zonesY);
  const zb = zoningVector(cb, cw, ch, ubox, zonesX, zonesY);
  let zsum = 0;
  for (let i = 0; i < za.length; i++) { const d = za[i] - zb[i]; zsum += d * d; }
  const zoningL2 = Math.sqrt(zsum / za.length);

  // ── Size ──
  const sizeDiffPx = Math.max(Math.abs(a.inkBox.w - b.inkBox.w), Math.abs(a.inkBox.h - b.inkBox.h));
  const sizeRatio = Math.max(
    Math.max(a.inkBox.w, b.inkBox.w) / Math.max(1, Math.min(a.inkBox.w, b.inkBox.w)),
    Math.max(a.inkBox.h, b.inkBox.h) / Math.max(1, Math.min(a.inkBox.h, b.inkBox.h)),
  );
  const inkLogRatio = Math.log(a.inkSum / b.inkSum);

  const metrics: GlyphCompareMetrics = {
    inkWidthA: a.inkBox.w, inkHeightA: a.inkBox.h,
    inkWidthB: b.inkBox.w, inkHeightB: b.inkBox.h,
    sizeDiffPx, sizeRatio, inkLogRatio, ncc,
    alignDx, alignDy,
    unexplainedA, unexplainedB, d95, dMax, hotspotMax,
    strokeWidthA, strokeWidthB, strokeLogRatio,
    strokeContrastA, strokeContrastB, contrastLogRatio,
    orientL1, holesA, holesB, zoningL2,
  };

  return decide(metrics, thresholds, warnings);
}

/** Apply thresholds to a metric set → verdict. Exported so the calibration
 *  harness can re-decide stored metrics under candidate thresholds. */
export function decide(
  m: GlyphCompareMetrics,
  t: GlyphCompareThresholds,
  warnings: string[] = [],
): GlyphCompareResult {
  const hardSignals: string[] = [];
  const softSignals: string[] = [];
  const reasons: string[] = [];
  const maxH = Math.max(m.inkHeightA, m.inkHeightB);
  const sizeAllow = Math.max(t.sizeDiffPx, t.sizeDiffFrac * maxH);

  const check = (name: string, value: number, hard: number, describe: (v: number) => string): void => {
    const soft = hard * t.softFactor;
    if (value > hard) {
      hardSignals.push(name);
      reasons.push(describe(value));
    } else if (value > soft) {
      softSignals.push(name);
      reasons.push(`${describe(value)} (soft — below the hard threshold)`);
    }
  };

  check("size", m.sizeDiffPx, sizeAllow, (v) =>
    `ink bounding boxes differ by ${v.toFixed(1)}px (${m.inkWidthA}×${m.inkHeightA} vs ${m.inkWidthB}×${m.inkHeightB}) — size / width-class / x-height mismatch`);
  check("mass", Math.abs(m.inkLogRatio), t.inkLogRatio, () =>
    `ink mass differs ×${Math.exp(Math.abs(m.inkLogRatio)).toFixed(2)} (${m.inkLogRatio > 0 ? "A heavier" : "B heavier"}) — weight mismatch (bold vs regular?)`);
  check("outline", Math.max(m.unexplainedA, m.unexplainedB), t.unexplainedFrac, (v) =>
    `${(v * 100).toFixed(1)}% of ink is farther than ${t.outlineTolerancePx}px from the other image's ink — different glyph outline`);
  check("d95", m.d95, t.d95Px, (v) =>
    `95th-percentile edge distance ${v.toFixed(2)}px exceeds the AA/subpixel noise band — shape difference`);
  check("hotspot", m.hotspotMax, maxH >= t.recommendedInkPx ? t.hotspotMax : t.hotspotMaxSmall, (v) =>
    `local coverage hotspot ${v.toFixed(2)} — a concentrated patch of ink is present in one render and absent in the other (terminal / tail / spur difference)`);
  check("stroke", Math.abs(m.strokeLogRatio), t.strokeLogRatio, () =>
    `mean stroke width ${m.strokeWidthA.toFixed(2)}px vs ${m.strokeWidthB.toFixed(2)}px — weight/design mismatch`);
  // Stroke-modulation (contrastLogRatio) is intentionally NOT gated — ridge
  // sampling quantizes too coarsely at text sizes (same-pair noise reaches
  // ln 2); it stays in the metrics as a human-readable diagnostic.
  check("orientation", m.orientL1, t.orientL1, (v) =>
    `edge-orientation histograms differ (L1 ${v.toFixed(2)}) — slant / serif / terminal-shape difference`);
  check("zoning", m.zoningL2, t.zoningL2, (v) =>
    `ink mass distribution differs (zoning RMS ${v.toFixed(3)}) — x-height / midline / aperture difference`);
  if (m.ncc < t.nccMin) {
    hardSignals.push("ncc");
    reasons.push(`normalized cross-correlation ${m.ncc.toFixed(3)} below the ${t.nccMin} same-render floor`);
  } else if (m.ncc < 1 - (1 - t.nccMin) * t.softFactor) {
    softSignals.push("ncc");
    reasons.push(`normalized cross-correlation ${m.ncc.toFixed(3)} near the ${t.nccMin} same-render floor (soft)`);
  }
  if (m.holesA !== m.holesB) {
    // Below the recommended resolution a thin counter (the eye of a 16 px
    // serif 'e') legitimately closes at one subpixel phase and not the other,
    // so topology is only HARD evidence when the ink is big enough for
    // counters to be stable; below the floor it demotes to a soft signal.
    if (maxH >= t.recommendedInkPx) {
      hardSignals.push("topology");
      reasons.push(`counter (hole) counts differ: ${m.holesA} vs ${m.holesB} — structurally different glyph`);
    } else {
      softSignals.push("topology");
      reasons.push(`counter (hole) counts differ: ${m.holesA} vs ${m.holesB} (soft — ink below the ${t.recommendedInkPx}px floor where thin counters AA-flicker)`);
    }
  }

  // ── Thin-high-frequency-detail guard ──────────────────────────────────────
  // `outline` and `d95` are the only two signals computed on BINARIZED ink via
  // nearest-neighbor distance, so a ~1 px anti-aliasing phase shift of a thin,
  // repeating feature (a dashed enclosing border, a hairline ring) destroys
  // local overlap and inflates both — while the smooth coverage correlation
  // (NCC) barely moves. When a mismatch is driven ONLY by that pair AND NCC
  // confirms the two glyphs are globally near-identical, the disagreement is
  // AA-domain drift, not a font difference (the exact false-mismatch seen on
  // the standalone regional-indicator / dashed-enclosure glyphs). Corpus-
  // validated zero-regression: no different-font pair in the DM-1686
  // calibration set fires a mismatch on hard ⊆ {outline, d95} — every real
  // difference also trips size / mass / stroke / hotspot / orientation /
  // zoning / topology / ncc.
  if (
    hardSignals.length > 0
    && hardSignals.every((s) => s === "outline" || s === "d95")
    && m.ncc >= t.nccThinDetailFloor
  ) {
    reasons.push(
      `outline / edge-distance disagreement is confined to thin high-frequency detail `
      + `(NCC ${m.ncc.toFixed(3)} ≥ ${t.nccThinDetailFloor} — glyphs globally near-identical); `
      + `reattributed to anti-aliasing phase drift on a dashed / hairline enclosure, not a font difference`,
    );
    return {
      verdict: "match",
      confidence: "medium",
      reasons,
      metrics: m,
      hardSignals,
      softSignals,
      warnings,
    };
  }

  const mismatch = hardSignals.length >= 1 || softSignals.length >= 2;
  let confidence: GlyphCompareResult["confidence"];
  if (mismatch) {
    confidence = hardSignals.length >= 2 ? "high" : hardSignals.length === 1 ? "medium" : "low";
  } else {
    confidence = softSignals.length === 0 ? "high" : "medium";
  }
  if (!mismatch && reasons.length === 0) {
    reasons.push("all metrics within the calibrated same-render noise bands");
  }
  return {
    verdict: mismatch ? "mismatch" : "match",
    confidence,
    reasons,
    metrics: m,
    hardSignals,
    softSignals,
    warnings,
  };
}

/**
 * Convenience wrapper: load two PNGs (path or buffer, optional per-image
 * crop rects) and compare. This is what the CLI (tools/compare-glyphs.ts)
 * and agent probes call.
 */
export async function compareGlyphPngs(
  sourceA: string | Buffer,
  sourceB: string | Buffer,
  opts?: {
    rectA?: { x: number; y: number; w: number; h: number };
    rectB?: { x: number; y: number; w: number; h: number };
    thresholds?: Partial<GlyphCompareThresholds>;
  },
): Promise<GlyphCompareResult> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts?.thresholds ?? {}) };
  const [a, b] = await Promise.all([
    loadGlyphCoverage(sourceA, opts?.rectA),
    loadGlyphCoverage(sourceB, opts?.rectB),
  ]);
  return compareGlyphCoverage(a, b, thresholds);
}
