import { describe, expect, it } from "vitest";

import {
  buildBrowserHarfBuzzSubstitutionReport,
} from "../tools/browser-harfbuzz-substitution-oracle.js";

describe("browser HarfBuzz substitution-stream ownership", () => {
  it("authenticates each exact data-URI face and browser glyph count before raster", async () => {
    const report = await buildBrowserHarfBuzzSubstitutionReport({
      evidence: "proposal",
      includeBrowser: true,
    });
    expect(report.verdict).toBe("exact-logical-agreement");
    expect(report.rasterization).toBe("blocked-until-exact-logical-agreement");
    expect(report.cases).toHaveLength(4);
    for (const item of report.cases) {
      expect(item.exactProductionAgreement).toBe(true);
      expect(item.browser).toMatchObject({
        customFaceAgreement: true,
        exactGlyphCountAgreement: true,
        glyphIds: { status: "not-exposed-by-cdp" },
      });
      expect(item.browser!.origins).toHaveLength([...item.input.text].length);
    }
    expect(report.mutationCoverage.complete).toBe(true);
  }, 120_000);
});
