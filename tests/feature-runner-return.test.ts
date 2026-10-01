import { describe, expect, it } from "vitest";
import type { CompareResult } from "../src/review/compare-pngs.js";
import { countFeatureFailures, featurePasses, type FeatureTest } from "./runner.js";

const fixture: FeatureTest = { name: "return", html: "<div></div>" };
const clean: CompareResult = {
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

describe("feature suite failure count", () => {
  it("handles empty, passing, and mixed result sequences", () => {
    expect(countFeatureFailures([])).toBe(0);
    expect(countFeatureFailures([{ pass: true }, { pass: true }])).toBe(0);
    expect(countFeatureFailures([{ pass: false }, { pass: true }, { pass: false }])).toBe(2);
  });
});

describe("feature fixture scoring", () => {
  it("keeps platform floors for ordinary fixtures and honors an explicit ceiling only for that fixture", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      expect(featurePasses(fixture, clean, platform)).toBe(true);
      expect(featurePasses({ ...fixture, maxCoveragePct: -1 }, clean, platform)).toBe(false);
      expect(featurePasses(fixture, clean, platform)).toBe(true);
    }
    expect(featurePasses(fixture, { ...clean, coveragePct: 0.5, regionCount: 1 }, "linux")).toBe(true);
    expect(featurePasses({ ...fixture, maxCoveragePct: 0 }, { ...clean, coveragePct: 0.5 }, "linux")).toBe(false);
    expect(featurePasses({ ...fixture, relaxedDiffPct: 0.2 }, { ...clean, coveragePct: 0.5 }, "linux")).toBe(true);
    expect(featurePasses(fixture, { ...clean, coveragePct: 1.01, regionCount: 1 }, "linux")).toBe(false);
    expect(featurePasses(fixture, { ...clean, coveragePct: 3.99, regionCount: 1 }, "win32")).toBe(true);
    expect(featurePasses(fixture, { ...clean, coveragePct: 4.01, regionCount: 1 }, "win32")).toBe(false);
    expect(featurePasses(fixture, { ...clean, regionCount: 1 }, "darwin")).toBe(false);
  });
});
