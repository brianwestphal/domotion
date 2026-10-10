import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable, resolveSystemFallbackFonts } from "@domotion/text-engine/testing";

const describeWindows = process.platform === "win32" && isGlyphHelperAvailable() ? describe : describe.skip;

describeWindows("Windows Malgun diagnostic", () => {
  it("records the helper's selected face and file for archaic Hangul", () => {
    for (const weight of [200, 300, 400]) {
      for (const locale of ["ko", "en"]) {
        const result = resolveSystemFallbackFonts([0x11fa], "Helvetica", {
          weight,
          italic: false,
          fontSize: 16,
          baseFamilyName: "ui-serif",
          locale,
        }).get(0x11fa);
        console.log("Malgun helper result", JSON.stringify({ weight, locale, result }));
        expect(result).toBeDefined();
      }
    }
  });
});
