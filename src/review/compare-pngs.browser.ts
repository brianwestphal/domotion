import { perceptualDigest } from "./side-digest.js";
type Region = {
  area: number;
  maxSeverity: number;
  highSevFraction: number;
  x: number;
  y: number;
  w: number;
  h: number;
};
export interface BrowserComparisonConfig {
  regionDilatePx: number;
  minRegionArea: number;
  shiftMatchRadius: number;
  shiftMatchDist: number;
  highSevPct: number;
  minHighSevFraction: number;
  maxReportedRegions: number;
}

/** Typed browser-side PNG analyzer; esbuild bundles this and its digest dependency. */
export async function compareImages(
  expectedB64: string,
  actualB64: string,
  tilePx: number,
  significantDist: number,
  config: BrowserComparisonConfig,
) {
  const loadImg = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  const [expected, actual] = await Promise.all([
    loadImg("data:image/png;base64," + expectedB64),
    loadImg("data:image/png;base64," + actualB64),
  ]);
  const w = Math.max(expected.width, actual.width);
  const h = Math.max(expected.height, actual.height);
  const c1 = document.createElement("canvas");
  c1.width = w;
  c1.height = h;
  c1.getContext("2d")!.drawImage(expected, 0, 0);
  const d1 = c1.getContext("2d")!.getImageData(0, 0, w, h).data;
  const c2 = document.createElement("canvas");
  c2.width = w;
  c2.height = h;
  c2.getContext("2d")!.drawImage(actual, 0, 0);
  const d2 = c2.getContext("2d")!.getImageData(0, 0, w, h).data;
  const diffCanvas = document.createElement("canvas");
  diffCanvas.width = w;
  diffCanvas.height = h;
  const diffCtx = diffCanvas.getContext("2d")!;
  const diffData = diffCtx.createImageData(w, h);
  const maxDist = Math.sqrt(255 * 255 * 3);
  const TILE = tilePx;
  const SIG = significantDist;
  const DILATE = config.regionDilatePx;
  const MIN_AREA = config.minRegionArea;
  const SHIFT_R = config.shiftMatchRadius;
  const SHIFT_D2 = config.shiftMatchDist * config.shiftMatchDist;
  const HIGH_SEV = config.highSevPct;
  const MIN_HSF = config.minHighSevFraction;
  // Neighborhood-tolerant subpixel-shift detector. Returns true when the
  // expected[x,y] color appears within SHIFT_R px in actual AND
  // actual[x,y] appears within SHIFT_R px in expected (both within
  // squared-distance SHIFT_D2). Both directions required so a one-sided
  // recolor (new element appearing in only one image) doesn't get
  // absorbed as a "shift".
  function isShift(d1: Uint8ClampedArray, d2: Uint8ClampedArray, x: number, y: number) {
    const i = (y * w + x) * 4;
    const e0 = d1[i],
      e1 = d1[i + 1],
      e2 = d1[i + 2];
    const a0 = d2[i],
      a1 = d2[i + 1],
      a2 = d2[i + 2];
    const x0 = Math.max(0, x - SHIFT_R);
    const x1 = Math.min(w - 1, x + SHIFT_R);
    const y0 = Math.max(0, y - SHIFT_R);
    const y1 = Math.min(h - 1, y + SHIFT_R);
    let minE_in_actual = Infinity;
    let minA_in_expected = Infinity;
    for (let ny = y0; ny <= y1; ny++) {
      for (let nx = x0; nx <= x1; nx++) {
        const j = (ny * w + nx) * 4;
        const dr1 = e0 - d2[j],
          dg1 = e1 - d2[j + 1],
          db1 = e2 - d2[j + 2];
        const d1d = dr1 * dr1 + dg1 * dg1 + db1 * db1;
        if (d1d < minE_in_actual) minE_in_actual = d1d;
        const dr2 = a0 - d1[j],
          dg2 = a1 - d1[j + 1],
          db2 = a2 - d1[j + 2];
        const d2d = dr2 * dr2 + dg2 * dg2 + db2 * db2;
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
  function rgbY(d: Uint8ClampedArray, i: number) {
    return d[i] * 0.298912 + d[i + 1] * 0.586611 + d[i + 2] * 0.114478;
  }
  function hasManySiblings(d: Uint8ClampedArray, x1: number, y1: number) {
    const x0 = Math.max(x1 - 1, 0);
    const y0 = Math.max(y1 - 1, 0);
    const x2v = Math.min(x1 + 1, w - 1);
    const y2v = Math.min(y1 + 1, h - 1);
    let zeroes = x1 === x0 || x1 === x2v || y1 === y0 || y1 === y2v ? 1 : 0;
    const pos = (y1 * w + x1) * 4;
    for (let xx = x0; xx <= x2v; xx++) {
      for (let yy = y0; yy <= y2v; yy++) {
        if (xx === x1 && yy === y1) continue;
        const pos2 = (yy * w + xx) * 4;
        if (d[pos] === d[pos2] && d[pos + 1] === d[pos2 + 1] && d[pos + 2] === d[pos2 + 2]) zeroes++;
        if (zeroes > 2) return true;
      }
    }
    return false;
  }
  function antialiased(d: Uint8ClampedArray, x1: number, y1: number, dOther: Uint8ClampedArray) {
    const x0 = Math.max(x1 - 1, 0);
    const y0 = Math.max(y1 - 1, 0);
    const x2v = Math.min(x1 + 1, w - 1);
    const y2v = Math.min(y1 + 1, h - 1);
    let zeroes = x1 === x0 || x1 === x2v || y1 === y0 || y1 === y2v ? 1 : 0;
    let min = 0,
      max = 0;
    let minX = -1,
      minY = -1,
      maxX = -1,
      maxY = -1;
    const pos = (y1 * w + x1) * 4;
    const baseY = rgbY(d, pos);
    for (let xx = x0; xx <= x2v; xx++) {
      for (let yy = y0; yy <= y2v; yy++) {
        if (xx === x1 && yy === y1) continue;
        const pos2 = (yy * w + xx) * 4;
        const delta = rgbY(d, pos2) - baseY;
        if (delta === 0) zeroes++;
        else if (delta < 0) {
          if (delta < min) {
            min = delta;
            minX = xx;
            minY = yy;
          }
        } else {
          if (delta > max) {
            max = delta;
            maxX = xx;
            maxY = yy;
          }
        }
      }
    }
    if (zeroes < 2) return false;
    if (minX < 0 || maxX < 0) return false;
    return (
      (hasManySiblings(d, minX, minY) && hasManySiblings(dOther, minX, minY)) ||
      (hasManySiblings(d, maxX, maxY) && hasManySiblings(dOther, maxX, maxY))
    );
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
      const dg = d1[i + 1] - d2[i + 1];
      const db = d1[i + 2] - d2[i + 2];
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      // Subpixel-shift filter (DM-715 follow-up). If the expected color
      // appears within SHIFT_R px in actual AND vice versa, treat as a
      // translation artifact, not a real diff. Runs BEFORE AA detection
      // because it's strictly cheaper to short-circuit shift pixels
      // (most real-world diff is 1-px-shifted antialiased glyphs).
      let shifted = false;
      if (dist > 0 && SHIFT_R > 0) shifted = isShift(d1, d2, x, y);
      let isAA = false;
      if (dist > 0 && !shifted) isAA = antialiased(d1, x, y, d2) || antialiased(d2, x, y, d1);
      const norm = isAA || shifted ? 0 : dist / maxDist;
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
      if (dist > SIG && !isAA && !shifted) {
        tileSig[ti]++;
        totalSig++;
      }
      // Diff image is a literal per-channel absolute difference (DM-379).
      diffData.data[i] = Math.abs(dr);
      diffData.data[i + 1] = Math.abs(dg);
      diffData.data[i + 2] = Math.abs(db);
      diffData.data[i + 3] = 255;
    }
  }
  // DM-715 region pass: dilate the nonAaMask by DILATE pixels so glyph
  // strokes (sparse runs of diff pixels) and near-by patches merge into
  // single components, then flood-fill 4-connected. Each component's
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
  const regions: Region[] = [];
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
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;
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
          if (dil[np] && labels[np] === 0) {
            labels[np] = nextLabel;
            stack[sp++] = np;
          }
        }
        if (cx < w - 1) {
          const np = cur + 1;
          if (dil[np] && labels[np] === 0) {
            labels[np] = nextLabel;
            stack[sp++] = np;
          }
        }
        if (cy > 0) {
          const np = cur - w;
          if (dil[np] && labels[np] === 0) {
            labels[np] = nextLabel;
            stack[sp++] = np;
          }
        }
        if (cy < h - 1) {
          const np = cur + w;
          if (dil[np] && labels[np] === 0) {
            labels[np] = nextLabel;
            stack[sp++] = np;
          }
        }
      }
      regions.push({
        area,
        maxSeverity: maxSev,
        highSevFraction: area > 0 ? highSev / area : 0,
        x: minX,
        y: minY,
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
  // Shift-inclusive aggregates: the same components, scored with the
  // high-severity-fraction gate lifted. Purely derived — no second region
  // pass — so they cannot drift from the primary numbers.
  let strictMaxRegionArea = 0;
  for (const r of regions) {
    if (r.area >= MIN_AREA && r.area > strictMaxRegionArea) strictMaxRegionArea = r.area;
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
  function rect(x0: number, y0: number, ww: number, hh: number, r: number, g: number, b: number) {
    if (ww <= 0 || hh <= 0) return;
    for (let dx = 0; dx < ww; dx++) {
      const top = (y0 * w + (x0 + dx)) * 4;
      const bot = ((y0 + hh - 1) * w + (x0 + dx)) * 4;
      diffData.data[top] = r;
      diffData.data[top + 1] = g;
      diffData.data[top + 2] = b;
      diffData.data[top + 3] = 255;
      diffData.data[bot] = r;
      diffData.data[bot + 1] = g;
      diffData.data[bot + 2] = b;
      diffData.data[bot + 3] = 255;
    }
    for (let dy = 0; dy < hh; dy++) {
      const lft = ((y0 + dy) * w + x0) * 4;
      const rgt = ((y0 + dy) * w + (x0 + ww - 1)) * 4;
      diffData.data[lft] = r;
      diffData.data[lft + 1] = g;
      diffData.data[lft + 2] = b;
      diffData.data[lft + 3] = 255;
      diffData.data[rgt] = r;
      diffData.data[rgt + 1] = g;
      diffData.data[rgt + 2] = b;
      diffData.data[rgt + 3] = 255;
    }
  }
  // Magenta outlines for regions (cap at top 32 so we don't spam huge
  // images with dozens of low-area outlines).
  for (let i = 0; i < Math.min(surviving.length, config.maxReportedRegions); i++) {
    const r = surviving[i];
    rect(r.x, r.y, r.w, r.h, 255, 0, 255);
  }
  // Worst tile keyed off non-AA % first (was the pass/fail signal pre-
  // DM-715, still useful as the "where is the noise densest" navigator),
  // with sig% then avg% as successive tiebreaks — yellow box in diff.png
  // points at the tile most responsible for the residual scatter.
  let worstSigPct = 0,
    worstAvgPct = 0,
    worstNonAaPct = 0,
    worstIdx = 0;
  for (let i = 0; i < tileDist.length; i++) {
    if (tilePixCount[i] === 0) continue;
    const nonAaPct = (tileNonAa[i] / tilePixCount[i]) * 100;
    const sigPct = (tileSig[i] / tilePixCount[i]) * 100;
    const avgPct = (tileDist[i] / tilePixCount[i]) * 100;
    if (
      nonAaPct > worstNonAaPct ||
      (nonAaPct === worstNonAaPct && sigPct > worstSigPct) ||
      (nonAaPct === worstNonAaPct && sigPct === worstSigPct && avgPct > worstAvgPct)
    ) {
      worstNonAaPct = nonAaPct;
      worstSigPct = sigPct;
      worstAvgPct = avgPct;
      worstIdx = i;
    }
  }
  const worstTx = worstIdx % tilesX;
  const worstTy = (worstIdx / tilesX) | 0;
  const ox = worstTx * TILE,
    oy = worstTy * TILE;
  const ow = Math.min(TILE, w - ox),
    oh = Math.min(TILE, h - oy);
  rect(ox, oy, ow, oh, 255, 220, 0);
  diffCtx.putImageData(diffData, 0, 0);
  // Cap the returned regions payload at 32 to keep the JSON small;
  // surviving array is already sorted area-desc.
  const trimmedRegions = surviving.slice(0, config.maxReportedRegions);
  return {
    expectedDigest: perceptualDigest(d1, w, h),
    actualDigest: perceptualDigest(d2, w, h),
    nonAaPixels: totalNonAa,
    nonAaPixelPct: (totalNonAa / totalPixels) * 100,
    diffPct: (totalDist / totalPixels) * 100,
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
    strictRegionCount: surviving.length + shiftyRegionCount,
    strictRegionArea: totalChangedArea + shiftyRegionArea,
    strictMaxRegionArea,
    coveragePct: (totalChangedArea / totalPixels) * 100,
    regions: trimmedRegions,
    diffDataUrl: diffCanvas.toDataURL("image/png"),
  };
}
