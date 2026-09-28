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
    expect(new Set(report.rows.map((row) => row.family))).toEqual(new Set(NESTED_PROJECTIVE_REQUIRED_FAMILIES));
    expect(report.rows.every((row) => row.sourceModelMatchesDesign)).toBe(true);
    expect(report.rows.every((row) => row.atomicOneApplication)).toBe(true);
    expect(report.restorationExact).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.mutations).toHaveLength(9);
    expect(report.mutations.every((mutation) => mutation.killed)).toBe(true);

    expect(
      report.rows.every(
        (row) =>
          row.ownerMinimal && row.vectorSentinelRetained && !row.sentinelBakedIntoRaster && row.atomicOneApplication,
      ),
    ).toBe(true);
    expect(report.productionGaps).toEqual([]);
    expect(report.sourceVsSvgChangedFraction.dpr1).toBeGreaterThan(0);
    expect(report.sourceVsSvgChangedFraction.dpr1).toBeLessThan(1);
  }, 90_000);

  it("materializes one atomic raster per owner under the vertical/RTL fractional-zoom profile", async () => {
    // Regression: at zoom:1.25 the `ordinary` and `independent` planes lay
    // entirely outside the capture viewport, so their owners rasterized as
    // empty and the release gate saw zero images on every platform.
    const report = await runNestedProjectiveOwnershipAudit({
      dprs: [1],
      profile: "vertical-rtl-fractional-zoom-scroll",
    });
    expect(report.blockers).toEqual([]);
    expect(report.productionGaps).toEqual([]);
    expect(report.rows).toHaveLength(NESTED_PROJECTIVE_CASES.length);
    for (const family of ["ordinary-dom-break", "independent-projective-planes"] as const) {
      const row = report.rows.find((candidate) => candidate.family === family);
      expect(row?.ownerMinimal).toBe(true);
      expect(row?.atomicRasterOccurrences).toBe(row?.expectedOwnerIds.length);
      expect(row?.staticTransformApplications).toBe(row?.expectedOwnerIds.length);
    }
    expect(report.rows.every((row) => row.atomicOneApplication && row.vectorSentinelRetained)).toBe(true);
  }, 90_000);
});
