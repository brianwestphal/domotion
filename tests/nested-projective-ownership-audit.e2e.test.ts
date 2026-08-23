import { describe, expect, it } from "vitest";

import {
  NESTED_PROJECTIVE_CASES,
  NESTED_PROJECTIVE_REQUIRED_FAMILIES,
  runNestedProjectiveOwnershipAudit,
} from "../tools/nested-projective-ownership-audit.js";

describe("DM-2356 live nested projective ownership audit", () => {
  it("proves every Blink used-context root is the minimal production owner", async () => {
    const report = await runNestedProjectiveOwnershipAudit({ dprs: [1] });
    expect(report.verdict).toBe("investigation-complete");
    expect(report.blockers).toEqual([]);
    expect(report.rows).toHaveLength(NESTED_PROJECTIVE_CASES.length);
    expect(new Set(report.rows.map((row) => row.family)))
      .toEqual(new Set(NESTED_PROJECTIVE_REQUIRED_FAMILIES));
    expect(report.rows.every((row) => row.sourceModelMatchesDesign)).toBe(true);
    expect(report.rows.every((row) => row.atomicOneApplication)).toBe(true);
    expect(report.restorationExact).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.mutations).toHaveLength(9);
    expect(report.mutations.every((mutation) => mutation.killed)).toBe(true);

    expect(report.rows.every((row) => row.ownerMinimal && row.vectorSentinelRetained
      && !row.sentinelBakedIntoRaster && row.atomicOneApplication)).toBe(true);
    expect(report.productionGaps).toEqual([]);
    expect(report.sourceVsSvgChangedFraction.dpr1).toBeGreaterThan(0);
    expect(report.sourceVsSvgChangedFraction.dpr1).toBeLessThan(1);
  }, 90_000);
});
