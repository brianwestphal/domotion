import { describe, expect, it } from "vitest";

import {
  BACKDROP_CASES,
  BACKDROP_REQUIRED_FAMILIES,
  runBackdropSourceSurfaceAudit,
} from "../tools/backdrop-source-surface-audit.js";

describe("DM-2357 live backdrop source-surface transitions", () => {
  it("records all requested families and defeats final/no-surface mutations", async () => {
    const report = await runBackdropSourceSurfaceAudit([1]);
    expect(report.verdict).toBe("investigation-complete");
    expect(report.blockers).toEqual([]);
    expect(report.rows).toHaveLength(BACKDROP_CASES.length);
    const families = new Set(report.rows.map((row) => row.family));
    for (const family of BACKDROP_REQUIRED_FAMILIES) expect(families, family).toContain(family);
    expect(report.rows.every((row) => row.rootMatchesSourceModel)).toBe(true);
    expect(report.rows.every((row) => row.targetBackdropFilter !== "none")).toBe(true);
    expect(report.rows.filter((row) => row.actualRasterOwners > 0).every((row) => row.underCapture.discriminated)).toBe(true);
    expect(report.rows.filter((row) => row.actualRasterOwners > 0).every((row) => row.overCapture.discriminated)).toBe(true);
    expect(report.rows.every((row) => row.vectorOrder.rasterBeforeTargetVector !== false)).toBe(true);
    expect(report.rows.filter((row) => row.id !== "pseudo" && row.id !== "fixed").every((row) => row.vectorOrder.matchesSourceSiblingOrder)).toBe(true);
    expect(report.rows.find((row) => row.id === "fixed")?.vectorOrder.matchesSourceSiblingOrder).toBe(false);
    expect(report.productionGaps).toContain("fixed:backdrop/sibling order drift");

    // The investigation deliberately freezes the currently missing ownership
    // boundary: generated pseudo paint has no serialized backdrop source.
    const pseudo = report.rows.find((row) => row.id === "pseudo");
    expect(pseudo).toMatchObject({ expectedRasterOwners: 1, actualRasterOwners: 0, ownershipComplete: false });
    expect(report.productionGaps).toContain("pseudo:serialized ownership 0/1");
  }, 240_000);
});
