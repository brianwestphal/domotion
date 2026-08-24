import { describe, expect, it } from "vitest";
import { runSvgEffectCombinationOracle } from "../tools/svg-effect-combination-oracle.js";

describe("generated SVG effect combination oracle (DM-2358)", () => {
  it("keeps every pairwise native-SVG case source-exact and proves new capture transitions", async () => {
    const report = await runSvgEffectCombinationOracle({ deviceScaleFactors: [1] });
    expect(report.fingerprint.chromiumVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(report.fingerprint.playwrightVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.schemaVersion).toBe(2);
    expect(report.corpus).toEqual({
      cases: 37,
      expectedPairs: 1088,
      coveredPairs: 1088,
      expectedTargetedTriples: 83,
      coveredTargetedTriples: 83,
      missingTargetedTriples: [],
    });
    expect(report.grammar).toEqual({ bareUrlSupported: true, urlPlusGeometryBoxRejected: true });
    expect(report.structuralErrors).toEqual([]);
    expect(report.rows).toHaveLength(37);
    expect(report.rows.filter((row) => !row.pass)).toEqual([]);
    expect(report.mutations).toHaveLength(3);
    expect(report.mutations.every((mutation) => mutation.moved)).toBe(true);
    expect(report.logicalMutations).toHaveLength(4);
    expect(report.logicalMutations.every((mutation) => mutation.rejected)).toBe(true);
    expect(report.rows.some((row) => row.logical.owner === "chromium-projective-raster")).toBe(true);
    expect(report.verdict).toBe("source-exact-native-svg-delegation");
  }, 30_000);
});
