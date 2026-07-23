import { describe, it, expect } from "vitest";
import {
  passes,
  passesStrict,
  classifyDiff,
  PASS_THRESHOLD_NON_AA_PIXELS,
  MIN_REGION_AREA,
  REGION_DILATE_PX,
  SHIFT_MATCH_RADIUS,
  SHIFT_MATCH_DIST,
  HIGH_SEV_PCT,
  MIN_HIGH_SEV_FRACTION,
  strictCapsFor,
  type CompareResult,
} from "./compare-pngs.js";

/** The calibrated caps, named once so the cases below read as behavior rather
 *  than arithmetic. Passed explicitly so these tests are host-independent. */
const CAPS = strictCapsFor("darwin")!;

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

describe("passesStrict(): the no-motion bar (doc 12)", () => {
  // The default gate suppresses connected components whose pixels are mostly
  // low-severity, on the theory that they are glyph-shape drift. For callers
  // comparing two renders of the SAME content at the SAME positions that theory
  // is wrong — a solid block flipping z-order is large AND low-severity, so it
  // lands in `shiftyRegion*` and `regionCount` reports clean. These pin that the
  // strict bar reads the suppressed bucket and bounds it by area.
  const clean: CompareResult = {
    ...base, regionCount: 0, strictRegionCount: 0, strictRegionArea: 0, strictMaxRegionArea: 0,
  };

  // The measured guard-disabled compressor build: two equal-sized solid blocks
  // swapping z-order — 3712 px, all of it filed as low-severity.
  const zOrderSwap: CompareResult = {
    ...clean,
    shiftyRegionCount: 1, shiftyRegionArea: 3712,
    strictRegionCount: 1, strictRegionArea: 3712, strictMaxRegionArea: 3712,
  };

  it("agrees with passes() when nothing was suppressed", () => {
    expect(passesStrict(clean, CAPS)).toBe(true);
    expect(passesStrict({ ...clean, regionCount: 1 }, CAPS)).toBe(false); // still subsumes passes()
  });

  it("fails the case the default gate calls clean: one block-sized suppressed region", () => {
    expect(passes(zOrderSwap)).toBe(true);              // the blind spot
    expect(passesStrict(zOrderSwap, CAPS)).toBe(false); // ...closed
  });

  it("forgives the sparse glyph-edge drift the clean compressor fixtures carry", () => {
    // Measured ceiling across every state of every compressed-run fixture on a
    // clean macOS build: 6 components, 215 px total, 88 px largest.
    const glyphDrift: CompareResult = {
      ...clean, strictRegionCount: 6, strictRegionArea: 215, strictMaxRegionArea: 88,
    };
    expect(passesStrict(glyphDrift, CAPS)).toBe(true);
  });

  it("bounds the largest single region AND the total independently", () => {
    // One oversized component, small total → the per-region cap catches it.
    expect(passesStrict({
      ...clean, strictRegionCount: 1,
      strictRegionArea: CAPS.maxRegionArea + 1,
      strictMaxRegionArea: CAPS.maxRegionArea + 1,
    }, CAPS)).toBe(false);
    // Many mid-sized components, none over the per-region cap → the total
    // backstop catches it.
    expect(passesStrict({
      ...clean, strictRegionCount: 8,
      strictRegionArea: CAPS.totalRegionArea + 1,
      strictMaxRegionArea: CAPS.maxRegionArea,
    }, CAPS)).toBe(false);
    // Exactly at both caps still passes (inclusive bounds).
    expect(passesStrict({
      ...clean, strictRegionCount: 4,
      strictRegionArea: CAPS.totalRegionArea,
      strictMaxRegionArea: CAPS.maxRegionArea,
    }, CAPS)).toBe(true);
  });

  it("counts regions, not raw pixels — scatter below the area floor never reaches it", () => {
    // The text-heavy 12-state fixture legitimately carries hundreds of non-AA
    // pixels and thousands of shift-absorbed ones with zero real change.
    expect(passesStrict({ ...clean, nonAaPixels: 235, shiftedPixels: 5062 }, CAPS)).toBe(true);
  });

  it("degrades to passes() where the bar has no calibrated caps, never to a silent true", () => {
    // Non-darwin hosts render these fixtures with substitute faces whose drift
    // overlaps the known break, so there is no honest cap yet. Callers there get
    // exactly the platform-agnostic gate they enforced before the bar existed —
    // which still fails a real structural region.
    expect(strictCapsFor("linux")).toBeNull();
    expect(strictCapsFor("win32")).toBeNull();
    expect(passesStrict(zOrderSwap, null)).toBe(true);
    expect(passesStrict({ ...zOrderSwap, regionCount: 1 }, null)).toBe(false);
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

  it("the no-motion caps clear the measured clean ceiling and stay under the known break", () => {
    // Clean macOS ceiling: 88 px largest / 215 px total. Known break: 3712 px.
    expect(CAPS.maxRegionArea).toBe(256);
    expect(CAPS.totalRegionArea).toBe(512);
    expect(CAPS.maxRegionArea).toBeGreaterThan(88 * 2);
    expect(CAPS.totalRegionArea).toBeGreaterThan(215 * 2);
    expect(CAPS.maxRegionArea).toBeLessThan(3712 / 4);
    expect(CAPS.totalRegionArea).toBeLessThan(3712);
  });
});
