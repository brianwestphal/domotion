import { describe, expect, it } from "vitest";
import { createFontPaletteResolver } from "./font-palette.js";

class CSSFontPaletteValuesRule {
  constructor(public name: string, public fontFamily: string, public basePalette: string, public overrideColors: string) {}
}
const element = (rules: unknown[]) => ({ ownerDocument: { styleSheets: [{ cssRules: rules }] } });

describe("font-palette rule ownership", () => {
  it("joins the computed token to the matching requested family and preserves override order", () => {
    const { resolveFontPalette } = createFontPaletteResolver();
    expect(resolveFontPalette(element([new CSSFontPaletteValuesRule("--brand", "Audit", "3", "7 red, 3 magenta")]), { fontPalette: "--brand", fontFamily: "Audit, serif" })).toEqual({
      token: "--brand", ruleFamily: "Audit", basePalette: "3", overrides: [{ index: 7, color: "red" }, { index: 3, color: "magenta" }],
    });
  });
  it("collapses a missing or family-mismatched rule to normal", () => {
    const { resolveFontPalette } = createFontPaletteResolver();
    expect(resolveFontPalette(element([new CSSFontPaletteValuesRule("--brand", "Other", "2", "")]), { fontPalette: "--brand", fontFamily: "Audit" })).toEqual({ token: "--brand", ruleFamily: null, basePalette: "normal", overrides: [] });
  });
});
