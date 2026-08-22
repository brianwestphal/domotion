import { describe, expect, it } from "vitest";

import {
  NESTED_PROJECTIVE_CASES,
  NESTED_PROJECTIVE_REQUIRED_FAMILIES,
  runNestedProjectiveOwnershipAudit,
} from "../tools/nested-projective-ownership-audit.js";

describe("DM-2356 live nested projective ownership audit", () => {
  it("proves Blink context roots and detects current outer-owner/vector absorption drift", async () => {
    const report = await runNestedProjectiveOwnershipAudit({ dprs: [1] });
    expect(report.verdict).toBe("investigation-complete");
    expect(report.blockers).toEqual([]);
    expect(report.rows).toHaveLength(NESTED_PROJECTIVE_CASES.length);
    expect(new Set(report.rows.map((row) => row.family)))
      .toEqual(new Set(NESTED_PROJECTIVE_REQUIRED_FAMILIES));
    expect(report.rows.every((row) => row.sourceModelMatchesDesign)).toBe(true);
    expect(report.rows.every((row) => row.atomicOneApplication)).toBe(true);
    expect(report.mutations).toHaveLength(6);
    expect(report.mutations.every((mutation) => mutation.killed)).toBe(true);

    expect(report.rows.filter((row) => row.ownerMinimal).map((row) => row.id)).toEqual([
      "shared@dpr1",
      "extension@dpr1",
      "independent@dpr1",
      "affine@dpr1",
    ]);
    expect(report.rows.filter((row) => !row.ownerMinimal).map((row) => row.id)).toEqual([
      "perspective@dpr1",
      "ordinary@dpr1",
      "flat@dpr1",
      "opacity@dpr1",
      "overflow@dpr1",
      "isolation@dpr1",
      "clip@dpr1",
      "mask@dpr1",
      "filter@dpr1",
    ]);
    expect(report.rows.filter((row) => !row.ownerMinimal)
      .every((row) => !row.vectorSentinelRetained && row.sentinelBakedIntoRaster)).toBe(true);
    expect(report.productionGaps).toContain(
      "perspective: owner np-perspective-outer != np-perspective-plane",
    );
    expect(report.productionGaps).toContain(
      "overflow: owner np-overflow-outer != np-overflow-inner",
    );
    expect(report.sourceVsSvgChangedFraction.dpr1).toBeGreaterThan(0);
    expect(report.sourceVsSvgChangedFraction.dpr1).toBeLessThan(1);
  }, 90_000);
});
