import type { Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

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

export interface CompareResult {
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
  /** Per-region breakdown: area + max severity + high-sev fraction +
   *  bounding box. Sorted by `area` descending; capped at the top 32
   *  regions to keep payload small. */
  regions: Array<{
    area: number;
    maxSeverity: number;
    highSevFraction: number;
    x: number; y: number; w: number; h: number;
  }>;
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
export async function comparePngs(
  comparePage: Page,
  expectedPath: string,
  actualPath: string,
  diffPath: string,
  tilePx: number = TILE_PX,
  significantDist: number = SIGNIFICANT_PIXEL_DIST,
): Promise<CompareResult> {
  const expectedB64 = readFileSync(expectedPath).toString("base64");
  const actualB64 = readFileSync(actualPath).toString("base64");

  const result = (await comparePage.evaluate(
    `(async () => {
      const loadImg = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
      const [expected, actual] = await Promise.all([
        loadImg("data:image/png;base64,${expectedB64}"),
        loadImg("data:image/png;base64,${actualB64}")
      ]);
      const w = Math.max(expected.width, actual.width);
      const h = Math.max(expected.height, actual.height);
      const c1 = document.createElement("canvas"); c1.width = w; c1.height = h;
      c1.getContext("2d").drawImage(expected, 0, 0);
      const d1 = c1.getContext("2d").getImageData(0, 0, w, h).data;
      const c2 = document.createElement("canvas"); c2.width = w; c2.height = h;
      c2.getContext("2d").drawImage(actual, 0, 0);
      const d2 = c2.getContext("2d").getImageData(0, 0, w, h).data;
      const diffCanvas = document.createElement("canvas");
      diffCanvas.width = w; diffCanvas.height = h;
      const diffCtx = diffCanvas.getContext("2d");
      const diffData = diffCtx.createImageData(w, h);
      const maxDist = Math.sqrt(255 * 255 * 3);
      const TILE = ${tilePx};
      const SIG = ${significantDist};
      const DILATE = ${REGION_DILATE_PX};
      const MIN_AREA = ${MIN_REGION_AREA};
      const SHIFT_R = ${SHIFT_MATCH_RADIUS};
      const SHIFT_D2 = ${SHIFT_MATCH_DIST * SHIFT_MATCH_DIST};
      const HIGH_SEV = ${HIGH_SEV_PCT};
      const MIN_HSF = ${MIN_HIGH_SEV_FRACTION};
      // Neighborhood-tolerant subpixel-shift detector. Returns true when the
      // expected[x,y] color appears within SHIFT_R px in actual AND
      // actual[x,y] appears within SHIFT_R px in expected (both within
      // squared-distance SHIFT_D2). Both directions required so a one-sided
      // recolor (new element appearing in only one image) doesn't get
      // absorbed as a "shift".
      function isShift(d1, d2, x, y) {
        const i = (y * w + x) * 4;
        const e0 = d1[i], e1 = d1[i+1], e2 = d1[i+2];
        const a0 = d2[i], a1 = d2[i+1], a2 = d2[i+2];
        const x0 = Math.max(0, x - SHIFT_R);
        const x1 = Math.min(w - 1, x + SHIFT_R);
        const y0 = Math.max(0, y - SHIFT_R);
        const y1 = Math.min(h - 1, y + SHIFT_R);
        let minE_in_actual = Infinity;
        let minA_in_expected = Infinity;
        for (let ny = y0; ny <= y1; ny++) {
          for (let nx = x0; nx <= x1; nx++) {
            const j = (ny * w + nx) * 4;
            const dr1 = e0 - d2[j], dg1 = e1 - d2[j+1], db1 = e2 - d2[j+2];
            const d1d = dr1*dr1 + dg1*dg1 + db1*db1;
            if (d1d < minE_in_actual) minE_in_actual = d1d;
            const dr2 = a0 - d1[j], dg2 = a1 - d1[j+1], db2 = a2 - d1[j+2];
            const d2d = dr2*dr2 + dg2*dg2 + db2*db2;
            if (d2d < minA_in_expected) minA_in_expected = d2d;
          }
        }
        return minE_in_actual <= SHIFT_D2 && minA_in_expected <= SHIFT_D2;
      }
      // Yee anti-aliasing detector ported from mapbox/pixelmatch (BSD).
      // A pixel is AA when it sits on an edge in either image (zeroes >= 2
      // around it + a contrasty neighbor) and that contrasty neighbor has
      // many same-color siblings in BOTH images (the edge continues, so the
      // pixel is sub-pixel coverage along it). DM-281 / DM-383: runs on every
      // nonzero pixel so glyph anti-aliasing is excluded at any contrast.
      function rgbY(d, i) { return d[i] * 0.298912 + d[i+1] * 0.586611 + d[i+2] * 0.114478; }
      function hasManySiblings(d, x1, y1) {
        const x0 = Math.max(x1 - 1, 0);
        const y0 = Math.max(y1 - 1, 0);
        const x2v = Math.min(x1 + 1, w - 1);
        const y2v = Math.min(y1 + 1, h - 1);
        let zeroes = (x1 === x0 || x1 === x2v || y1 === y0 || y1 === y2v) ? 1 : 0;
        const pos = (y1 * w + x1) * 4;
        for (let xx = x0; xx <= x2v; xx++) {
          for (let yy = y0; yy <= y2v; yy++) {
            if (xx === x1 && yy === y1) continue;
            const pos2 = (yy * w + xx) * 4;
            if (d[pos] === d[pos2] && d[pos+1] === d[pos2+1] && d[pos+2] === d[pos2+2]) zeroes++;
            if (zeroes > 2) return true;
          }
        }
        return false;
      }
      function antialiased(d, x1, y1, dOther) {
        const x0 = Math.max(x1 - 1, 0);
        const y0 = Math.max(y1 - 1, 0);
        const x2v = Math.min(x1 + 1, w - 1);
        const y2v = Math.min(y1 + 1, h - 1);
        let zeroes = (x1 === x0 || x1 === x2v || y1 === y0 || y1 === y2v) ? 1 : 0;
        let min = 0, max = 0;
        let minX = -1, minY = -1, maxX = -1, maxY = -1;
        const pos = (y1 * w + x1) * 4;
        const baseY = rgbY(d, pos);
        for (let xx = x0; xx <= x2v; xx++) {
          for (let yy = y0; yy <= y2v; yy++) {
            if (xx === x1 && yy === y1) continue;
            const pos2 = (yy * w + xx) * 4;
            const delta = rgbY(d, pos2) - baseY;
            if (delta === 0) zeroes++;
            else if (delta < 0) { if (delta < min) { min = delta; minX = xx; minY = yy; } }
            else { if (delta > max) { max = delta; maxX = xx; maxY = yy; } }
          }
        }
        if (zeroes < 2) return false;
        if (minX < 0 || maxX < 0) return false;
        return (hasManySiblings(d, minX, minY) && hasManySiblings(dOther, minX, minY))
            || (hasManySiblings(d, maxX, maxY) && hasManySiblings(dOther, maxX, maxY));
      }
      const tilesX = Math.ceil(w / TILE);
      const tilesY = Math.ceil(h / TILE);
      const tileDist = new Float64Array(tilesX * tilesY);
      const tileSig = new Uint32Array(tilesX * tilesY);
      const tileNonAa = new Uint32Array(tilesX * tilesY);
      const tilePixCount = new Uint32Array(tilesX * tilesY);
      let totalDist = 0;
      let totalSig = 0;
      let totalNonAa = 0;
      let totalShifted = 0;
      const totalPixels = w * h;
      // DM-715: parallel non-AA-diff mask. 1 = pixel survived AA filtering
      // and counts as a real diff. Use this for the region pass below.
      const nonAaMask = new Uint8Array(w * h);
      // Per-pixel severity (norm * 100). We reuse this in region aggregation
      // to compute maxRegionSeverity without rewalking the rgb data.
      const sevPct = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const ty = (y / TILE) | 0;
        for (let x = 0; x < w; x++) {
          const tx = (x / TILE) | 0;
          const i = (y * w + x) * 4;
          const dr = d1[i] - d2[i];
          const dg = d1[i+1] - d2[i+1];
          const db = d1[i+2] - d2[i+2];
          const dist = Math.sqrt(dr*dr + dg*dg + db*db);
          // Subpixel-shift filter (DM-715 follow-up). If the expected color
          // appears within SHIFT_R px in actual AND vice versa, treat as a
          // translation artifact, not a real diff. Runs BEFORE AA detection
          // because it's strictly cheaper to short-circuit shift pixels
          // (most real-world diff is 1-px-shifted antialiased glyphs).
          let shifted = false;
          if (dist > 0 && SHIFT_R > 0) shifted = isShift(d1, d2, x, y);
          let isAA = false;
          if (dist > 0 && !shifted) isAA = antialiased(d1, x, y, d2) || antialiased(d2, x, y, d1);
          const norm = (isAA || shifted) ? 0 : dist / maxDist;
          totalDist += norm;
          const ti = ty * tilesX + tx;
          tileDist[ti] += norm;
          tilePixCount[ti]++;
          if (shifted) totalShifted++;
          if (dist > 0 && !isAA && !shifted) {
            tileNonAa[ti]++;
            totalNonAa++;
            const px = y * w + x;
            nonAaMask[px] = 1;
            sevPct[px] = norm * 100;
          }
          if (dist > SIG && !isAA && !shifted) { tileSig[ti]++; totalSig++; }
          // Diff image is a literal per-channel absolute difference (DM-379).
          diffData.data[i]   = Math.abs(dr);
          diffData.data[i+1] = Math.abs(dg);
          diffData.data[i+2] = Math.abs(db);
          diffData.data[i+3] = 255;
        }
      }
      // DM-715 region pass: dilate the nonAaMask by DILATE pixels so glyph
      // strokes (sparse runs of diff pixels) and near-by patches merge into
      // single components, then flood-fill 8-connected. Each component's
      // "area" tallies ORIGINAL nonAaMask pixels (not dilated) — that's
      // the count we care about for pass/fail; dilation is only there to
      // glue together pixels that visually belong together.
      const dil = new Uint8Array(w * h);
      if (totalNonAa > 0) {
        // Two-pass separable dilation (horizontal then vertical) — O(w*h*DILATE)
        // each pass.
        const tmp = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
          const row = y * w;
          // Forward sweep tracking distance since last 1.
          let lastOne = -DILATE - 1;
          for (let x = 0; x < w; x++) {
            if (nonAaMask[row + x]) lastOne = x;
            if (x - lastOne <= DILATE) tmp[row + x] = 1;
          }
          // Backward sweep covering 1's encountered on the right side too.
          lastOne = w + DILATE + 1;
          for (let x = w - 1; x >= 0; x--) {
            if (nonAaMask[row + x]) lastOne = x;
            if (lastOne - x <= DILATE) tmp[row + x] = 1;
          }
        }
        for (let x = 0; x < w; x++) {
          let lastOne = -DILATE - 1;
          for (let y = 0; y < h; y++) {
            if (tmp[y * w + x]) lastOne = y;
            if (y - lastOne <= DILATE) dil[y * w + x] = 1;
          }
          lastOne = h + DILATE + 1;
          for (let y = h - 1; y >= 0; y--) {
            if (tmp[y * w + x]) lastOne = y;
            if (lastOne - y <= DILATE) dil[y * w + x] = 1;
          }
        }
      }
      // 4-connected flood fill on the dilated mask. Per-component stats track
      // ORIGINAL nonAaMask hits (the area we report) AND the original pixel
      // with the highest severity (for maxSeverity per region).
      const labels = new Int32Array(w * h);
      const regions = [];
      const stack = new Int32Array(w * h);
      let nextLabel = 1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          if (!dil[p] || labels[p] !== 0) continue;
          // BFS-style fill using a stack of pixel indices.
          let sp = 0;
          stack[sp++] = p;
          labels[p] = nextLabel;
          let area = 0;
          let maxSev = 0;
          let highSev = 0;
          let minX = x, maxX = x, minY = y, maxY = y;
          while (sp > 0) {
            const cur = stack[--sp];
            const cy = (cur / w) | 0;
            const cx = cur - cy * w;
            if (nonAaMask[cur]) {
              area++;
              const s = sevPct[cur];
              if (s > maxSev) maxSev = s;
              if (s >= HIGH_SEV) highSev++;
            }
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;
            // 4-neighbors.
            if (cx > 0) {
              const np = cur - 1;
              if (dil[np] && labels[np] === 0) { labels[np] = nextLabel; stack[sp++] = np; }
            }
            if (cx < w - 1) {
              const np = cur + 1;
              if (dil[np] && labels[np] === 0) { labels[np] = nextLabel; stack[sp++] = np; }
            }
            if (cy > 0) {
              const np = cur - w;
              if (dil[np] && labels[np] === 0) { labels[np] = nextLabel; stack[sp++] = np; }
            }
            if (cy < h - 1) {
              const np = cur + w;
              if (dil[np] && labels[np] === 0) { labels[np] = nextLabel; stack[sp++] = np; }
            }
          }
          regions.push({
            area,
            maxSeverity: maxSev,
            highSevFraction: area > 0 ? highSev / area : 0,
            x: minX, y: minY,
            w: maxX - minX + 1,
            h: maxY - minY + 1,
          });
          nextLabel++;
        }
      }
      // Cull regions below the area floor AND regions whose high-severity
      // fraction is below the gate (text-rendering / glyph-shape diffs
      // typical of font substitution).
      const surviving = regions.filter((r) => r.area >= MIN_AREA && r.highSevFraction >= MIN_HSF);
      // Count area in "shifty" regions (text-like) separately so we don't lose
      // visibility into them — they go into scatter (below) by accounting.
      let shiftyRegionArea = 0;
      let shiftyRegionCount = 0;
      for (const r of regions) {
        if (r.area >= MIN_AREA && r.highSevFraction < MIN_HSF) {
          shiftyRegionArea += r.area;
          shiftyRegionCount++;
        }
      }
      surviving.sort((a, b) => b.area - a.area);
      let totalChangedArea = 0;
      let maxRegionSeverity = 0;
      for (const r of surviving) {
        totalChangedArea += r.area;
        if (r.maxSeverity > maxRegionSeverity) maxRegionSeverity = r.maxSeverity;
      }
      const scatteredPixels = totalNonAa - totalChangedArea;
      // Draw a 1-px magenta outline around each surviving region on the diff
      // PNG. The yellow worst-tile box is still painted below; the magenta
      // outlines pinpoint the actual region(s) responsible for failure so
      // reviewers can navigate straight to them without grid arithmetic.
      function rect(x0, y0, ww, hh, r, g, b) {
        if (ww <= 0 || hh <= 0) return;
        for (let dx = 0; dx < ww; dx++) {
          const top = (y0 * w + (x0 + dx)) * 4;
          const bot = ((y0 + hh - 1) * w + (x0 + dx)) * 4;
          diffData.data[top] = r; diffData.data[top+1] = g; diffData.data[top+2] = b; diffData.data[top+3] = 255;
          diffData.data[bot] = r; diffData.data[bot+1] = g; diffData.data[bot+2] = b; diffData.data[bot+3] = 255;
        }
        for (let dy = 0; dy < hh; dy++) {
          const lft = ((y0 + dy) * w + x0) * 4;
          const rgt = ((y0 + dy) * w + (x0 + ww - 1)) * 4;
          diffData.data[lft] = r; diffData.data[lft+1] = g; diffData.data[lft+2] = b; diffData.data[lft+3] = 255;
          diffData.data[rgt] = r; diffData.data[rgt+1] = g; diffData.data[rgt+2] = b; diffData.data[rgt+3] = 255;
        }
      }
      // Magenta outlines for regions (cap at top 32 so we don't spam huge
      // images with dozens of low-area outlines).
      const MAX_OUTLINES = 32;
      for (let i = 0; i < Math.min(surviving.length, MAX_OUTLINES); i++) {
        const r = surviving[i];
        rect(r.x, r.y, r.w, r.h, 255, 0, 255);
      }
      // Worst tile keyed off non-AA % first (was the pass/fail signal pre-
      // DM-715, still useful as the "where is the noise densest" navigator),
      // with sig% then avg% as successive tiebreaks — yellow box in diff.png
      // points at the tile most responsible for the residual scatter.
      let worstSigPct = 0, worstAvgPct = 0, worstNonAaPct = 0, worstIdx = 0;
      for (let i = 0; i < tileDist.length; i++) {
        if (tilePixCount[i] === 0) continue;
        const nonAaPct = (tileNonAa[i] / tilePixCount[i]) * 100;
        const sigPct = (tileSig[i] / tilePixCount[i]) * 100;
        const avgPct = (tileDist[i] / tilePixCount[i]) * 100;
        if (
          nonAaPct > worstNonAaPct
          || (nonAaPct === worstNonAaPct && sigPct > worstSigPct)
          || (nonAaPct === worstNonAaPct && sigPct === worstSigPct && avgPct > worstAvgPct)
        ) {
          worstNonAaPct = nonAaPct;
          worstSigPct = sigPct;
          worstAvgPct = avgPct;
          worstIdx = i;
        }
      }
      const worstTx = worstIdx % tilesX;
      const worstTy = (worstIdx / tilesX) | 0;
      const ox = worstTx * TILE, oy = worstTy * TILE;
      const ow = Math.min(TILE, w - ox), oh = Math.min(TILE, h - oy);
      rect(ox, oy, ow, oh, 255, 220, 0);
      diffCtx.putImageData(diffData, 0, 0);
      // Cap the returned regions payload at 32 to keep the JSON small;
      // surviving array is already sorted area-desc.
      const REGIONS_CAP = 32;
      const trimmedRegions = surviving.slice(0, REGIONS_CAP);
      return {
        nonAaPixels: totalNonAa,
        nonAaPixelPct: (totalNonAa / totalPixels) * 100,
        diffPercent: (totalDist / totalPixels) * 100,
        sigPixelPct: (totalSig / totalPixels) * 100,
        worstTilePct: worstAvgPct,
        worstTileSignificantPct: worstSigPct,
        worstTileRect: { x: ox, y: oy, w: ow, h: oh },
        regionCount: surviving.length,
        totalChangedArea,
        maxRegionSeverity,
        scatteredPixels,
        shiftedPixels: totalShifted,
        shiftyRegionCount,
        shiftyRegionArea,
        regions: trimmedRegions,
        diffDataUrl: diffCanvas.toDataURL("image/png"),
      };
    })()`,
  )) as {
    nonAaPixels: number;
    nonAaPixelPct: number;
    diffPercent: number;
    sigPixelPct: number;
    worstTilePct: number;
    worstTileSignificantPct: number;
    worstTileRect: { x: number; y: number; w: number; h: number };
    regionCount: number;
    totalChangedArea: number;
    maxRegionSeverity: number;
    scatteredPixels: number;
    shiftedPixels: number;
    shiftyRegionCount: number;
    shiftyRegionArea: number;
    regions: Array<{ area: number; maxSeverity: number; highSevFraction: number; x: number; y: number; w: number; h: number }>;
    diffDataUrl: string;
  };

  writeFileSync(diffPath, Buffer.from(result.diffDataUrl.split(",")[1], "base64"));
  return {
    nonAaPixels: result.nonAaPixels,
    nonAaPixelPct: result.nonAaPixelPct,
    diffPct: result.diffPercent,
    sigPixelPct: result.sigPixelPct,
    worstTilePct: result.worstTilePct,
    worstTileSignificantPct: result.worstTileSignificantPct,
    worstTileRect: result.worstTileRect,
    regionCount: result.regionCount,
    totalChangedArea: result.totalChangedArea,
    maxRegionSeverity: result.maxRegionSeverity,
    scatteredPixels: result.scatteredPixels,
    shiftedPixels: result.shiftedPixels,
    shiftyRegionCount: result.shiftyRegionCount,
    shiftyRegionArea: result.shiftyRegionArea,
    regions: result.regions,
  };
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
