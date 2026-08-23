import { describe, expect, it } from "vitest";

import { FONT_PALETTE_CASES, runFontPaletteOwnershipAudit } from "../tools/font-palette-ownership-audit.js";

describe("DM-2350 live font-palette ownership discriminator", () => {
  it("proves source selection and the current palette-blind raster-cache signature", async () => {
    const report = await runFontPaletteOwnershipAudit({ dprs: [1] });
    expect(report.verdict).toBe("confirmed-palette-identity-gap");
    expect(report.nativeRows).toHaveLength(FONT_PALETTE_CASES.length);
    expect(report.nativeRows.every((row) => row.pass)).toBe(true);
    expect(report.productionOrders).toHaveLength(2);
    for (const row of report.productionOrders) {
      expect(row.warnings).toEqual([]);
      expect(row.sourcePngSha256[0]).not.toBe(row.sourcePngSha256[1]);
      expect(row.capturedPngCount).toBe(2);
      expect(row.capturedUniquePngCount).toBe(1);
      expect(row.captureHasFontPaletteFact).toBe(false);
      expect(row.selectedRepresentation).toBe("colr");
      expect(row.svgImageCount).toBe(2);
    }
    expect(report.productionOrders[0].capturedPngSha256[0])
      .not.toBe(report.productionOrders[1].capturedPngSha256[0]);
  }, 30_000);
});
