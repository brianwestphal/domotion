import { describe, expect, it } from "vitest";
import { runVerticalDecorationBrowserOracle } from "../tools/vertical-decoration-browser-oracle.js";

describe("DM-2514 live Chromium vertical decoration side oracle", () => {
  it("authenticates central/script and sideways transforms at coherent DPR 1 and 4", async () => {
    const report = await runVerticalDecorationBrowserOracle();
    expect(report.chromiumVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(report.deviceScaleFactors).toEqual([1, 4]);
    expect(report.rows).toHaveLength(16);
    expect(report.rows.filter((row) => !row.pass)).toEqual([]);
    expect(report.rows.every((row) => row.redPixelCount > 0)).toBe(true);
    for (const id of new Set(report.rows.map((row) => row.id))) {
      const pair = report.rows.filter((row) => row.id === id);
      expect(pair.map((row) => row.deviceScaleFactor)).toEqual([1, 4]);
      expect(pair[0].actualSide).toBe(pair[1].actualSide);
    }
    expect(report.rasterPhase).toBe("native-coverage-observation");
    expect(report.acceptanceRole).toBe("categorical-source-authentication-only");
    expect(report.verdict).toBe("browser-authenticates-source-sides");
  }, 60_000);
});
