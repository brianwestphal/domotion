import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { main, runPseudoFragmentRenderOracle } from "../tools/pseudo-fragment-render-oracle.js";
import { readPseudoFragmentRenderReport } from "../tools/pseudo-fragment-render-report.js";

describe("DM-2468 direct pseudo-fragment browser paint", () => {
  it("keeps source-owned structure and Chromium ink edges within four device pixels", async () => {
    const report = await runPseudoFragmentRenderOracle([1]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].structuralErrors).toEqual([]);
    expect(report.rows[0].terminalRecords).toBe(0);
    expect(report.rows[0].renderedRecords).toBeGreaterThan(20);
    expect(report.verdict).toBe("source-exact");
  }, 120_000);

  it("writes the real Chromium DPR sweep as a nested versioned report", async () => {
    const path = resolve("tests/output/pseudo-fragment-render-report/nested/report.json");
    const artifactDir = resolve("tests/output/pseudo-fragment-render-report/artifacts");
    expect(await main(["--json", path, "--artifact-dir", artifactDir])).toBe(0);
    const data = readPseudoFragmentRenderReport(path);
    expect(data.rows.map((row) => row.dpr)).toEqual([1, 2]);
    expect(data.outcome).toBe("pass");
    expect(data.rows.every((row) => row.pass)).toBe(true);
  }, 120_000);
});
