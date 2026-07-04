/**
 * Unit tests for the glyph font-identity comparator (DM-1686).
 *
 * Synthetic glyphs only — no Playwright, no real fonts. Shapes are rendered
 * with 4×4 supersampling so edges carry realistic anti-aliased coverage, and
 * a subpixel offset parameter reproduces the phase noise the comparator must
 * tolerate. Real-font behavior (lookalike families, weight steps) is covered
 * by the e2e suite + the calibration harness (tools/glyph-compare-calibrate.ts).
 */
import { describe, expect, it } from "vitest";
import {
  compareGlyphCoverage,
  countHoles,
  distanceTransform,
  extractCoverage,
  orientationHistogram,
  ridgeStrokeWidths,
  type CoverageMap,
} from "./glyph-compare.js";

// ── Synthetic rendering helpers ────────────────────────────────────────────

type InsideFn = (x: number, y: number) => boolean;

/** Supersample (4×4) an inside-predicate into a coverage map, then wrap it
 *  as a CoverageMap via extractCoverage (black ink on white). `ox`/`oy`
 *  shift the shape by a subpixel amount. */
function renderShape(w: number, h: number, inside: InsideFn, ox = 0, oy = 0): CoverageMap {
  const rgba = new Uint8Array(w * h * 4);
  const S = 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S - ox;
          const py = y + (sy + 0.5) / S - oy;
          if (inside(px, py)) hits++;
        }
      }
      const cov = hits / (S * S);
      const lum = Math.round(255 * (1 - cov));
      const o = (y * w + x) * 4;
      rgba[o] = lum; rgba[o + 1] = lum; rgba[o + 2] = lum; rgba[o + 3] = 255;
    }
  }
  return extractCoverage(rgba, w, h, 4);
}

/** Parametric "H" glyph: two vertical stems + a crossbar, with optional
 *  serifs (wider slabs at stem ends), slant (x shear), and scale. Canvas is
 *  84×84; the glyph occupies roughly x∈[20,64], y∈[16,68]. */
function glyphH(opts: {
  stroke?: number; serif?: boolean; slantDeg?: number; scale?: number;
} = {}): InsideFn {
  const stroke = opts.stroke ?? 6;
  const serif = opts.serif ?? false;
  const shear = Math.tan(((opts.slantDeg ?? 0) * Math.PI) / 180);
  const s = opts.scale ?? 1;
  const cx = 42, cy = 42;
  const left = 22, right = 62, top = 16, bottom = 68;
  const midY = 44;
  return (px, py) => {
    // Un-scale then un-shear around the glyph center.
    let x = cx + (px - cx) / s;
    const y = cy + (py - cy) / s;
    x += (y - cy) * shear;
    if (y < top || y > bottom) return false;
    const inStem = (sxc: number): boolean => Math.abs(x - sxc) <= stroke / 2;
    if (inStem(left) || inStem(right)) return true;
    // Crossbar.
    if (Math.abs(y - midY) <= stroke / 2 && x >= left && x <= right) return true;
    if (serif) {
      const serifHalf = stroke * 1.4;
      const serifDepth = 3.5;
      const nearEnd = y <= top + serifDepth || y >= bottom - serifDepth;
      if (nearEnd && (Math.abs(x - left) <= serifHalf || Math.abs(x - right) <= serifHalf)) return true;
    }
    return false;
  };
}

/** Annulus ("O"-like ring): one counter. `gapDeg` > 0 opens the ring into a
 *  "C" (zero counters). */
function glyphO(opts: { gap?: boolean } = {}): InsideFn {
  const cx = 42, cy = 42, rOuter = 26, rInner = 17;
  return (px, py) => {
    const dx = px - cx, dy = py - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r > rOuter || r < rInner) return false;
    if (opts.gap) {
      const a = Math.atan2(dy, dx); // gap on the right, ±0.4 rad
      if (Math.abs(a) < 0.4) return false;
    }
    return true;
  };
}

// ── Loader / primitive tests ───────────────────────────────────────────────

describe("extractCoverage", () => {
  it("detects dark-on-light ink and measures the ink box", () => {
    const m = renderShape(84, 84, glyphH());
    expect(m.inkBox.w).toBeGreaterThan(40);
    expect(m.inkBox.h).toBeGreaterThan(50);
    expect(m.inkSum).toBeGreaterThan(500);
    expect(m.notes.some((n) => n.includes("inverted"))).toBe(false);
  });

  it("handles light-on-dark polarity identically", () => {
    const dark = renderShape(84, 84, glyphH());
    // Invert: white ink on black.
    const w = 84, h = 84;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const lum = Math.round(255 * dark.cov[i]);
      rgba[i * 4] = lum; rgba[i * 4 + 1] = lum; rgba[i * 4 + 2] = lum; rgba[i * 4 + 3] = 255;
    }
    const light = extractCoverage(rgba, w, h, 4);
    expect(light.notes.some((n) => n.includes("inverted"))).toBe(true);
    expect(light.inkBox).toEqual(dark.inkBox);
    expect(light.inkSum).toBeCloseTo(dark.inkSum, 0);
  });
});

describe("distanceTransform", () => {
  it("computes exact Euclidean distances", () => {
    // Single ON pixel at (2, 1) in a 5×4 grid.
    const w = 5, h = 4;
    const mask = new Uint8Array(w * h);
    mask[1 * w + 2] = 1;
    const dt = distanceTransform(mask, w, h);
    expect(dt[1 * w + 2]).toBe(0);
    expect(dt[1 * w + 3]).toBe(1);
    expect(dt[2 * w + 3]).toBeCloseTo(Math.SQRT2, 5);
    expect(dt[3 * w + 0]).toBeCloseTo(Math.sqrt(4 + 4), 5);
  });

  it("returns Infinity for an empty mask", () => {
    const dt = distanceTransform(new Uint8Array(9), 3, 3);
    expect(dt[4]).toBe(Infinity);
  });
});

describe("countHoles", () => {
  const binarize = (m: CoverageMap): Uint8Array => {
    const out = new Uint8Array(m.cov.length);
    for (let i = 0; i < m.cov.length; i++) out[i] = m.cov[i] >= 0.5 ? 1 : 0;
    return out;
  };
  it("finds the counter of an O and none in a C", () => {
    const o = renderShape(84, 84, glyphO());
    const c = renderShape(84, 84, glyphO({ gap: true }));
    expect(countHoles(binarize(o), 84, 84)).toBe(1);
    expect(countHoles(binarize(c), 84, 84)).toBe(0);
  });
});

describe("ridgeStrokeWidths", () => {
  it("recovers the stroke width of a uniform bar", () => {
    const w = 60, h = 40;
    const mask = new Uint8Array(w * h);
    for (let y = 10; y < 10 + 8; y++) for (let x = 5; x < 55; x++) mask[y * w + x] = 1; // 8px bar
    const widths = ridgeStrokeWidths(mask, w, h);
    expect(widths.length).toBeGreaterThan(10);
    const sorted = [...widths].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    expect(median).toBeGreaterThanOrEqual(6);
    expect(median).toBeLessThanOrEqual(9);
  });
});

describe("orientationHistogram", () => {
  it("separates vertical-stem energy from sheared stems", () => {
    const upright = renderShape(84, 84, glyphH());
    const slanted = renderShape(84, 84, glyphH({ slantDeg: 14 }));
    const hu = orientationHistogram(upright.cov, 84, 84);
    const hs = orientationHistogram(slanted.cov, 84, 84);
    let l1 = 0;
    for (let i = 0; i < hu.length; i++) l1 += Math.abs(hu[i] - hs[i]);
    expect(l1).toBeGreaterThan(0.2);
  });
});

// ── End-to-end verdicts on synthetic glyphs ────────────────────────────────

describe("compareGlyphCoverage verdicts", () => {
  it("matches the same glyph at different subpixel phases", () => {
    const a = renderShape(84, 84, glyphH());
    const b = renderShape(84, 84, glyphH(), 0.4, 0.27);
    const r = compareGlyphCoverage(a, b);
    expect(r.verdict).toBe("match");
    expect(r.hardSignals).toEqual([]);
  });

  it("matches the same glyph shifted by whole pixels (alignment)", () => {
    const a = renderShape(84, 84, glyphH());
    const b = renderShape(84, 84, glyphH(), 2.3, -1.6);
    const r = compareGlyphCoverage(a, b);
    expect(r.verdict).toBe("match");
  });

  it("flags a 25% heavier stroke (weight mismatch)", () => {
    const a = renderShape(84, 84, glyphH({ stroke: 6 }));
    const b = renderShape(84, 84, glyphH({ stroke: 7.5 }));
    const r = compareGlyphCoverage(a, b);
    expect(r.verdict).toBe("mismatch");
    expect([...r.hardSignals, ...r.softSignals]).toEqual(
      expect.arrayContaining([expect.stringMatching(/mass|stroke/)]),
    );
  });

  it("flags added serifs", () => {
    const a = renderShape(84, 84, glyphH({ serif: false }));
    const b = renderShape(84, 84, glyphH({ serif: true }));
    const r = compareGlyphCoverage(a, b);
    expect(r.verdict).toBe("mismatch");
  });

  it("flags a slanted (italic/oblique) variant", () => {
    const a = renderShape(84, 84, glyphH());
    const b = renderShape(84, 84, glyphH({ slantDeg: 12 }));
    const r = compareGlyphCoverage(a, b);
    expect(r.verdict).toBe("mismatch");
  });

  it("flags an 8% size difference", () => {
    const a = renderShape(84, 84, glyphH());
    const b = renderShape(84, 84, glyphH({ scale: 1.08 }));
    const r = compareGlyphCoverage(a, b);
    expect(r.verdict).toBe("mismatch");
    expect(r.hardSignals).toContain("size");
  });

  it("flags a topology change (O vs C)", () => {
    const a = renderShape(84, 84, glyphO());
    const b = renderShape(84, 84, glyphO({ gap: true }));
    const r = compareGlyphCoverage(a, b);
    expect(r.verdict).toBe("mismatch");
    expect(r.hardSignals).toContain("topology");
  });

  it("throws on a blank image", () => {
    const blank = renderShape(84, 84, () => false);
    const a = renderShape(84, 84, glyphH());
    expect(() => compareGlyphCoverage(a, blank)).toThrow(/no ink/);
  });

  it("throws when the ink is too small to classify", () => {
    const tiny = renderShape(84, 84, (x, y) => Math.abs(x - 42) < 2 && Math.abs(y - 42) < 2);
    const a = renderShape(84, 84, glyphH());
    expect(() => compareGlyphCoverage(a, tiny)).toThrow(/too small/);
  });

  it("attaches a low-resolution warning for small ink", () => {
    const smallH: InsideFn = (x, y) =>
      Math.abs(x - 42) < 6 && Math.abs(y - 42) < 8
      && (Math.abs(x - 38) < 1.5 || Math.abs(x - 46) < 1.5 || Math.abs(y - 42) < 1.5);
    const a = renderShape(84, 84, smallH);
    const b = renderShape(84, 84, smallH, 0.3, 0.2);
    const r = compareGlyphCoverage(a, b);
    expect(r.warnings.some((w) => w.includes("recommended"))).toBe(true);
  });
});
