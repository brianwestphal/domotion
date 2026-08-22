import { describe, expect, it } from "vitest";

import { blendModes, runBlendFilterPixelStageOracle } from "../tools/blend-filter-pixel-stage-oracle.js";

describe("DM-2360 live blend/filter pixel stages", () => {
  it("matches named source pixels and defeats wrong-stage mutations at DPR 1 and 2", async () => {
    const report = await runBlendFilterPixelStageOracle([1, 2]);
    const ids = new Set(report.rows.map((row) => row.id));
    for (const dpr of [1, 2]) {
      for (const mode of blendModes) {
        expect(report.rows.some((row) => row.dpr === dpr && row.id === `blend.${mode}`)).toBe(true);
      }
    }
    expect(ids).toContain("filter.blur-edge");
    expect(ids).toContain("filter.drop-shadow");
    expect(ids).toContain("surface.isolated");
    expect(ids).toContain("surface.background-stack");
    expect(report.boundaries).toEqual([
      { id: "boundary-filter", expected: "vector", actual: "vector", pass: true },
      { id: "boundary-blend", expected: "vector", actual: "vector", pass: true },
      { id: "boundary-backdrop", expected: "chromium-raster", actual: "chromium-raster", pass: true },
      { id: "boundary-convolve", expected: "chromium-raster", actual: "chromium-raster", pass: true },
      { id: "boundary-url-color", expected: "vector", actual: "vector", pass: true },
      { id: "boundary-native-convolve", expected: "vector", actual: "vector", pass: true },
    ]);
    expect(report.structuralErrors).toEqual([]);
    expect(report.unexpectedFailures).toEqual([]);
    expect(report.rows.every((row) => row.sourceModelMaxChannelError == null || row.sourceModelMaxChannelError <= 4)).toBe(true);
    expect(report.rows.every((row) => row.mutationExpectation === "moved"
      ? row.mutationMaxChannelDistance >= 8
      : row.mutationMaxChannelDistance <= 4)).toBe(true);
    expect(report.rows.find((row) => row.id === "filter.color-chain")?.pass).toBe(true);
    expect(report.rows.find((row) => row.id === "filter.blur-edge")?.pass).toBe(true);
    expect(report.rows.find((row) => row.id === "surface.background-stack")?.pass).toBe(true);
    expect(report.rows.every((row) => row.pass)).toBe(true);
    expect(report.verdict).toBe("source-exact");
  }, 360_000);
});
