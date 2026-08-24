import { describe, expect, it } from "vitest";
import { createFontPaletteResolver } from "./font-palette.js";

class CSSFontPaletteValuesRule {
  constructor(public name: string, public fontFamily: string, public basePalette: string, public overrideColors: string) {}
}
const element = (rules: unknown[], adoptedRules: unknown[] = []) => ({ ownerDocument: {
  styleSheets: [{ cssRules: rules }],
  adoptedStyleSheets: adoptedRules.length === 0 ? [] : [{ cssRules: adoptedRules }],
} });

const normal = {
  token: "normal", kind: "normal", ruleScope: null, ruleFamily: null,
  basePalette: "normal", overrides: [],
};

describe("font-palette rule ownership", () => {
  it("joins the computed token to the matching requested family and preserves override order", () => {
    const { resolveFontPalette } = createFontPaletteResolver();
    expect(resolveFontPalette(element([new CSSFontPaletteValuesRule("--brand", "Audit", "3", "7 red, 3 magenta")]), { fontPalette: "--brand", fontFamily: "Audit, serif" })).toEqual({
      token: "--brand", kind: "custom", ruleScope: "document", ruleFamily: "Audit", basePalette: "3", overrides: [{ index: 7, color: "red" }, { index: 3, color: "magenta" }],
    });
  });
  it("collapses a missing or family-mismatched rule to normal", () => {
    const { resolveFontPalette } = createFontPaletteResolver();
    expect(resolveFontPalette(element([new CSSFontPaletteValuesRule("--brand", "Other", "2", "")]), { fontPalette: "--brand", fontFamily: "Audit" })).toEqual({
      token: "--brand", kind: "custom", ruleScope: null, ruleFamily: null, basePalette: "normal", overrides: [],
    });
  });

  it("uses Blink's last document rule and includes document adopted sheets", () => {
    const { resolveFontPalette } = createFontPaletteResolver();
    const el = element([
      new CSSFontPaletteValuesRule("--brand", "Audit", "1", ""),
      new CSSFontPaletteValuesRule("--brand", "Audit", "2", ""),
    ], [new CSSFontPaletteValuesRule("--brand", "Audit", "3", "7 cyan")]);
    expect(resolveFontPalette(el, { fontPalette: "--brand", fontFamily: "Audit" })).toEqual(expect.objectContaining({
      ruleScope: "document", basePalette: "3", overrides: [{ index: 7, color: "cyan" }],
    }));
  });

  it("records recursive palette-mix normalization and every resolved endpoint", () => {
    const { resolveFontPalette } = createFontPaletteResolver();
    const el = element([
      new CSSFontPaletteValuesRule("--a", "Audit", "2", "3 red"),
      new CSSFontPaletteValuesRule("--b", "Audit", "3", "7 blue"),
    ]);
    expect(resolveFontPalette(el, { fontPalette: "palette-mix(in hsl longer hue, --a 20%, palette-mix(in srgb, --b, normal) 30%)", fontFamily: "Audit" })).toEqual({
      token: "palette-mix(in hsl longer hue, --a 20%, palette-mix(in srgb, --b, normal) 30%)",
      kind: "mix", ruleScope: null, ruleFamily: null, basePalette: "normal", overrides: [],
      mix: {
        colorSpace: "hsl", hueInterpolationMethod: "longer",
        startPercentage: 20, endPercentage: 30, normalizedPercentage: 0.6, alphaMultiplier: 0.5,
        start: {
          token: "--a", kind: "custom", ruleScope: "document", ruleFamily: "Audit",
          basePalette: "2", overrides: [{ index: 3, color: "red" }],
        },
        end: {
          token: "palette-mix(in srgb, --b, normal)",
          kind: "mix", ruleScope: null, ruleFamily: null, basePalette: "normal", overrides: [],
          mix: {
            colorSpace: "srgb", hueInterpolationMethod: "shorter",
            startPercentage: 50, endPercentage: 50, normalizedPercentage: 0.5, alphaMultiplier: 1,
            start: {
              token: "--b", kind: "custom", ruleScope: "document", ruleFamily: "Audit",
              basePalette: "3", overrides: [{ index: 7, color: "blue" }],
            },
            end: normal,
          },
        },
      },
    });
  });

  it("treats animation's computed Oklab percentage as paint-time identity", () => {
    const { resolveFontPalette } = createFontPaletteResolver();
    const el = {
      ...element([]),
      getAnimations: () => [{
        effect: {
          getComputedTiming: () => ({ progress: 0.3 }),
          getKeyframes: () => [{ fontPalette: "--from" }, { fontPalette: "--to" }],
        },
      }],
    };
    const resolved = resolveFontPalette(el, {
      fontPalette: "palette-mix(in oklab, --from 70%, --to)", fontFamily: "Audit",
    });
    expect(resolved.mix).toEqual(expect.objectContaining({
      colorSpace: "oklab", startPercentage: 70, endPercentage: 30,
      normalizedPercentage: 0.3, alphaMultiplier: 1, hueInterpolationMethod: null,
    }));
    expect(resolved.mix.start).toEqual(expect.objectContaining({ token: "--from", basePalette: "normal" }));
    expect(resolved.mix.end).toEqual(expect.objectContaining({ token: "--to", basePalette: "normal" }));
  });

  it("keeps raw calc percentages in identity while clamping only normalized paint progress", () => {
    const { resolveFontPalette } = createFontPaletteResolver();
    const resolved = resolveFontPalette(element([]), {
      fontPalette: "palette-mix(in srgb, --from -30%, --to)", fontFamily: "Audit",
    });
    expect(resolved.mix).toEqual(expect.objectContaining({
      startPercentage: -30,
      endPercentage: 130,
      normalizedPercentage: 1,
      alphaMultiplier: 1,
    }));
  });

  it("captures document-owned palette state inside a shadow host and ignores shadow-local rules", () => {
    const { resolveShadowFontPalettes } = createFontPaletteResolver();
    const documentRule = new CSSFontPaletteValuesRule("--document", "Audit", "3", "");
    interface FakeElement {
      ownerDocument: FakeDocument;
      textContent: string;
      computedStyle: { fontPalette: string; fontFamily: string };
      children: FakeElement[];
      shadowRoot: { children: FakeElement[] } | null;
    }
    interface FakeDocument {
      styleSheets: Array<{ cssRules: unknown[] }>;
      adoptedStyleSheets: Array<{ cssRules: unknown[] }>;
      defaultView: { getComputedStyle: (node: FakeElement) => FakeElement["computedStyle"] };
    }
    const doc = {
      styleSheets: [{ cssRules: [documentRule] }],
      adoptedStyleSheets: [],
      defaultView: { getComputedStyle: (node: FakeElement) => node.computedStyle },
    } as FakeDocument;
    const documentOwned: FakeElement = {
      ownerDocument: doc,
      textContent: "A",
      computedStyle: { fontPalette: "--document", fontFamily: "Audit" },
      children: [],
      shadowRoot: null,
    };
    const shadowOnly: FakeElement = {
      ownerDocument: doc,
      textContent: "B",
      computedStyle: { fontPalette: "--shadow-only", fontFamily: "Audit" },
      children: [],
      shadowRoot: null,
    };
    const host = { shadowRoot: { children: [documentOwned, shadowOnly] } };
    expect(resolveShadowFontPalettes(host)).toEqual([
      expect.objectContaining({
        path: "s.0", text: "A", fontFamily: "Audit",
        palette: expect.objectContaining({ token: "--document", ruleScope: "document", basePalette: "3" }),
      }),
      expect.objectContaining({
        path: "s.1", text: "B", fontFamily: "Audit",
        palette: expect.objectContaining({ token: "--shadow-only", ruleScope: null, basePalette: "normal" }),
      }),
    ]);
  });
});
