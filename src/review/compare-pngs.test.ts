import { describe, it, expect } from "vitest";
import {
  passes,
  classifyDiff,
  PASS_THRESHOLD_NON_AA_PIXELS,
  MIN_REGION_AREA,
  REGION_DILATE_PX,
  SHIFT_MATCH_RADIUS,
  SHIFT_MATCH_DIST,
  HIGH_SEV_PCT,
  MIN_HIGH_SEV_FRACTION,
  type CompareResult,
} from "./compare-pngs.js";

/**
 * DM-1057 / DM-715: guard the documented pass criterion (doc 12). The pixel
 * pipeline runs in a browser, but the two pure scalar deciders — `passes` (the
 * region-count gate) and `classifyDiff` (the verdict tiers) — are testable here,
 * and they're the contract reviewers and the suites depend on.
 */

const base: CompareResult = {
  nonAaPixels: 0, nonAaPixelPct: 0, diffPct: 0, sigPixelPct: 0,
  worstTilePct: 0, worstTileSignificantPct: 0,
  worstTileRect: { x: 0, y: 0, w: 0, h: 0 },
  regionCount: 0, totalChangedArea: 0, maxRegionSeverity: 0,
} as unknown as CompareResult;

describe("passes(): region-count is the pass gate (DM-715)", () => {
  it("passes iff regionCount === 0 — independent of nonAaPixels", () => {
    expect(passes({ ...base, regionCount: 0, nonAaPixels: 9999 })).toBe(true);  // scatter allowed
    expect(passes({ ...base, regionCount: 1, nonAaPixels: 0 })).toBe(false);    // one real region fails
    expect(passes({ ...base, regionCount: 42 })).toBe(false);
  });

  it("the legacy non-AA threshold is retained only for back-compat (0)", () => {
    expect(PASS_THRESHOLD_NON_AA_PIXELS).toBe(0);
  });
});

describe("classifyDiff(): verdict tiers", () => {
  it("0 regions → clean", () => {
    expect(classifyDiff(0, 0)).toBe("clean");
    expect(classifyDiff(0, 5)).toBe("clean"); // region count dominates
  });
  it("escalates by (regionCount, coveragePct)", () => {
    expect(classifyDiff(2, 0.04)).toBe("trivial");
    expect(classifyDiff(5, 0.4)).toBe("minor");
    expect(classifyDiff(15, 1.9)).toBe("moderate");
    expect(classifyDiff(16, 0.1)).toBe("major");   // too many regions
    expect(classifyDiff(3, 2.5)).toBe("major");    // too much coverage
  });
  it("coverage and count both bound a tier (the stricter wins)", () => {
    // 2 regions but heavy coverage → not trivial; falls through to a worse tier.
    expect(classifyDiff(2, 1.0)).toBe("moderate");
  });
});

describe("pipeline constants are sane (doc 12)", () => {
  it("region + shift + severity constants hold their documented values", () => {
    expect(MIN_REGION_AREA).toBe(15);
    expect(REGION_DILATE_PX).toBe(3);
    expect(SHIFT_MATCH_RADIUS).toBe(2);
    expect(SHIFT_MATCH_DIST).toBe(35);
    expect(HIGH_SEV_PCT).toBe(50);
    expect(MIN_HIGH_SEV_FRACTION).toBeCloseTo(0.15);
  });
});
