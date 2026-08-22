import { describe, expect, it } from "vitest";

import { runPseudoFragmentRenderOracle } from "../tools/pseudo-fragment-render-oracle.js";

describe("DM-2468 direct pseudo-fragment browser paint", () => {
  it("keeps source-owned structure and Chromium ink edges within four device pixels", async () => {
    const report = await runPseudoFragmentRenderOracle([1]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].structuralErrors).toEqual([]);
    expect(report.rows[0].terminalRecords).toBe(0);
    expect(report.rows[0].renderedRecords).toBeGreaterThan(20);
    expect(report.verdict).toBe("source-exact");
  }, 120_000);
});
