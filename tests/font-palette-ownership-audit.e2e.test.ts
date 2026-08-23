import { describe, expect, it } from "vitest";

import { FONT_PALETTE_CASES, runFontPaletteOwnershipAudit } from "../tools/font-palette-ownership-audit.js";

describe("font-palette production raster identity", () => {
  it("preserves both palettes in forward and reverse capture order", async () => {
    const report = await runFontPaletteOwnershipAudit({ dprs: [1] });
    expect(report.verdict).toBe("source-exact");
    expect(report.nativeRows).toHaveLength(FONT_PALETTE_CASES.length);
    expect(report.nativeRows.every((row) => row.pass)).toBe(true);
    expect(report.productionOrders).toHaveLength(2);
    for (const row of report.productionOrders) {
      expect(row.warnings).toEqual([]);
      expect(row.sourcePngSha256[0]).not.toBe(row.sourcePngSha256[1]);
      expect(row.capturedPngCount).toBe(2);
      expect(row.capturedUniquePngCount).toBe(2);
      expect(row.captureHasFontPaletteFact).toBe(true);
      expect(row.capturedPaletteRecords).toHaveLength(2);
      expect(row.capturedPngSha256).toEqual(row.sourcePngSha256);
      expect(row.selectedRepresentation).toBe("colr");
      expect(row.svgImageCount).toBe(2);
    }
    expect(report.productionOrders[0].capturedPngSha256[0])
      .toBe(report.productionOrders[1].capturedPngSha256[1]);
  }, 30_000);
});
