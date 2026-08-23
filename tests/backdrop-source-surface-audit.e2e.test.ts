import { describe, expect, it } from "vitest";

import {
  BACKDROP_CASES,
  BACKDROP_REQUIRED_FAMILIES,
  runBackdropSourceSurfaceAudit,
} from "../tools/backdrop-source-surface-audit.js";

describe("live backdrop source-surface transitions", () => {
  it("proves source ownership and logical equivalence at DPR 1 and 2", async () => {
    const report = await runBackdropSourceSurfaceAudit([1, 2]);
    expect(report.schemaVersion).toBe(2);
    expect(report.verdict).toBe("investigation-complete");
    expect(report.strictVerdict).toBe("source-exact");
    expect(report.blockers).toEqual([]);
    expect(report.productionGaps).toEqual([]);
    expect(report.backdropWarnings).toEqual([]);
    expect(report.rows).toHaveLength(BACKDROP_CASES.length * 2);
    const families = new Set(report.rows.map((row) => row.family));
    for (const family of BACKDROP_REQUIRED_FAMILIES) expect(families, family).toContain(family);
    expect(report.rows.every((row) => row.rootMatchesSourceModel)).toBe(true);
    expect(report.rows.every((row) => row.targetBackdropFilter !== "none")).toBe(true);
    expect(report.rows.every((row) => row.ownershipComplete)).toBe(true);
    expect(report.rows.every((row) => row.ownerGeometry.exact)).toBe(true);
    expect(report.rows.every((row) => row.productionEquivalent)).toBe(true);
    expect(report.rows.filter((row) => row.actualRasterOwners > 0).every((row) => row.underCapture.discriminated)).toBe(true);
    expect(report.rows.filter((row) => row.actualRasterOwners > 0).every((row) => row.overCapture.discriminated)).toBe(true);
    expect(report.rows.every((row) => row.vectorOrder.rasterBeforeTargetVector !== false)).toBe(true);
    expect(report.rows.filter((row) => row.id !== "pseudo").every((row) => row.vectorOrder.matchesSourceSiblingOrder)).toBe(true);
    expect(report.rows.filter((row) => !row.pixelEquivalent).every((row) =>
      row.sourceEdgeResidual.sourceEdgeOnly && row.sourceEdgeResidual.logicalInteriorChangedPixels === 0,
    )).toBe(true);
    expect(report.rows.filter((row) => row.id === "transform").every((row) =>
      row.capturePasses.screenshots === 2
      && row.productionEquivalent
      && row.sourceEdgeResidual.logicalInteriorChangedPixels === 0,
    )).toBe(true);
    expect(report.rows.filter((row) => row.id === "pseudo").every((row) =>
      row.expectedRasterOwners === 1 && row.actualRasterOwners === 1,
    )).toBe(true);
  }, 240_000);
});
