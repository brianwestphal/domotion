import { describe, expect, it } from "vitest";

import { runBackgroundClipTextOracle } from "../tools/background-clip-text-oracle.js";

describe("DM-2366 background-clip:text URL/color browser paint", () => {
  it("keeps vector glyph-masked signal edges within four device pixels", async () => {
    const report = await runBackgroundClipTextOracle([1]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].structuralErrors).toEqual([]);
    expect(report.rows[0].capturedUrlLayers).toBeGreaterThanOrEqual(5);
    expect(report.rows[0].alphaMasks).toBeGreaterThanOrEqual(6);
    expect(report.rows[0].vectorPatterns).toBeGreaterThanOrEqual(5);
    expect(report.verdict).toBe("source-exact");
  }, 120_000);
});
