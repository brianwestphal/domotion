import { describe, expect, it } from "vitest";
import { runVerticalDecorationBrowserOracle } from "../tools/vertical-decoration-browser-oracle.js";
import { budgetForCpuWork } from "./bounded-child.js";

// One Chromium launch (browser, GPU, network and a renderer per context, about
// six processes) and two screenshots: about 1.7 s of CPU with the browser
// included. In a loaded suite it reached a fixed 60 s timeout, so the test
// gets 100 times that CPU plus its process starts
// (docs/tool-child-process-test-bounds.md).
const ORACLE_TIMEOUT_MS = budgetForCpuWork(1_700, 6);

describe("DM-2514 live Chromium vertical decoration side oracle", () => {
  it(
    "authenticates central/script and sideways transforms at coherent DPR 1 and 4",
    async () => {
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
    },
    ORACLE_TIMEOUT_MS,
  );
});
