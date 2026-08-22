import { describe, expect, it } from "vitest";
import { runSvgEffectCombinationOracle } from "../tools/svg-effect-combination-oracle.js";

describe("generated SVG effect combination oracle (DM-2358)", () => {
  it("keeps every pairwise native-SVG case source-exact and proves new capture transitions", async () => {
    const report = await runSvgEffectCombinationOracle({ deviceScaleFactors: [1] });
    expect(report.fingerprint.chromiumVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(report.fingerprint.playwrightVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.corpus).toEqual({ cases: 24, expectedPairs: 953, coveredPairs: 953 });
    expect(report.grammar).toEqual({ bareUrlSupported: true, urlPlusGeometryBoxRejected: true });
    expect(report.structuralErrors).toEqual([]);
    expect(report.rows).toHaveLength(24);
    expect(report.rows.filter((row) => !row.pass)).toEqual([]);
    expect(report.rows.every((row) => row.pixels.meanAbsoluteChannelError === 0)).toBe(true);
    expect(report.mutations).toHaveLength(3);
    expect(report.mutations.every((mutation) => mutation.moved)).toBe(true);
    expect(report.verdict).toBe("source-exact-native-svg-delegation");
  }, 30_000);
});
