import { describe, expect, it } from "vitest";
import { runPseudoFragmentGeometryOracle } from "../tools/pseudo-fragment-geometry-oracle.js";

describe("DM-2466 live Chromium pseudo-fragment protocol oracle", () => {
  it("joins one snapshot epoch to ordered physical pseudo quads and rejects every structural mutation", async () => {
    const report = await runPseudoFragmentGeometryOracle({ deviceScaleFactors: [1] });
    expect(report.sourcePins).toEqual({
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
      skia: "62efacd37737505732dbe3d8daa62abd679626a1",
    });
    expect(report.chromiumVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(report.rows).toHaveLength(40);
    expect(report.rows.filter((row) => !row.pass)).toEqual([]);
    expect(report.mutations).toHaveLength(10);
    expect(report.mutations.filter((mutation) => !mutation.rejected)).toEqual([]);
    expect(report.requiredStates.every((state) => report.coveredStates.includes(state))).toBe(true);

    const mixed = report.rows.find((row) => row.id === "mixed-content");
    expect(mixed?.contentItems).toEqual(["text", "image", "text"]);
    expect(mixed?.imageFragments).toBe(1);
    const multicol = report.rows.find((row) => row.id === "multicol");
    expect(multicol?.boxFragments).toBeGreaterThan(3);
    expect(multicol?.record?.boxFragments.some((fragment) =>
      fragment.fragmentainerTranslation != null && Math.abs(fragment.fragmentainerTranslation.x) > 50
    )).toBe(true);
    expect(report.verdict).toBe("source-exact");
  }, 60_000);
});
