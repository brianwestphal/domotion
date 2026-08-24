import { describe, expect, it } from "vitest";
import { colorGlyphRasterIdentity, resolvedPaletteIdentity } from "./emoji.js";

describe("color glyph raster identity", () => {
  const span = [{ fontKey: "audit-face", faceId: "/fonts/a.ttf#0", glyphIds: [7], representation: "colr" }];
  const palette = (token: string, basePalette: string, overrides: Array<{ index: number; color: string }> = []) => ({
    token, kind: "custom" as const, ruleScope: "document" as const,
    ruleFamily: "Audit", basePalette, overrides,
  });
  it("separates palette rules and ordered overrides for the same face/gid", () => {
    const a = colorGlyphRasterIdentity({ fontPalette: "--a", fontPaletteIdentity: palette("--a", "2") }, span);
    const b = colorGlyphRasterIdentity({ fontPalette: "--b", fontPaletteIdentity: palette("--b", "3", [{ index: 7, color: "red" }]) }, span);
    expect(a).not.toBe(b);
  });
  it("separates selected face, gid, and representation", () => {
    const styles = { fontPalette: "normal" };
    expect(new Set([
      colorGlyphRasterIdentity(styles, span),
      colorGlyphRasterIdentity(styles, [{ ...span[0], faceId: "/fonts/b.ttf#0" }]),
      colorGlyphRasterIdentity(styles, [{ ...span[0], glyphIds: [8] }]),
      colorGlyphRasterIdentity(styles, [{ ...span[0], representation: "svg" }]),
    ])).toHaveLength(4);
  });
  it("drops override indices outside the selected face CPAL entry count", () => {
    const key = colorGlyphRasterIdentity({ fontPalette: "--a", fontPaletteIdentity: palette("--a", "0", [{ index: 3, color: "red" }, { index: 99, color: "blue" }]) }, [{ ...span[0], paletteEntryCount: 8 }]);
    expect(key).toContain('"index":3');
    expect(key).not.toContain('"index":99');
  });
  it("resolves theme and invalid numeric bases against the selected CPAL table", () => {
    expect(resolvedPaletteIdentity({ fontPalette: "light" }, { ...span[0], paletteCount: 4, paletteTypes: [0, 0, 1, 2] }).resolvedBasePalette).toBe(2);
    expect(resolvedPaletteIdentity({ fontPalette: "--bad", fontPaletteIdentity: palette("--bad", "99") }, { ...span[0], paletteCount: 4 }).resolvedBasePalette).toBe(0);
  });
  it("canonicalizes missing custom rules and recursively equal mix endpoints like Blink", () => {
    const missing = {
      token: "--missing", kind: "custom" as const, ruleScope: null,
      ruleFamily: null, basePalette: "normal", overrides: [],
    };
    const mix = {
      token: "palette-mix(in oklab, --missing, normal)",
      kind: "mix" as const, ruleScope: null, ruleFamily: null,
      basePalette: "normal", overrides: [],
      mix: {
        colorSpace: "oklab", hueInterpolationMethod: "shorter",
        startPercentage: 50, endPercentage: 50,
        normalizedPercentage: 0.5, alphaMultiplier: 1,
        start: missing,
        end: {
          token: "normal", kind: "normal" as const, ruleScope: null,
          ruleFamily: null, basePalette: "normal", overrides: [],
        },
      },
    };
    const normalKey = colorGlyphRasterIdentity({ fontPalette: "normal" }, span);
    expect(colorGlyphRasterIdentity({ fontPaletteIdentity: missing }, span)).toBe(normalKey);
    expect(colorGlyphRasterIdentity({ fontPaletteIdentity: mix }, span)).toBe(normalKey);
  });
  it("separates time, interpolation space, hue method, and recursively resolved endpoint rules", () => {
    const mix = (normalizedPercentage: number, colorSpace = "oklab", hueInterpolationMethod = "shorter") => ({
      token: `palette-mix(in ${colorSpace}, --a ${100 - normalizedPercentage * 100}%, --b)`,
      kind: "mix" as const, ruleScope: null, ruleFamily: null, basePalette: "normal", overrides: [],
      mix: {
        colorSpace, hueInterpolationMethod,
        startPercentage: 100 - normalizedPercentage * 100,
        endPercentage: normalizedPercentage * 100,
        normalizedPercentage, alphaMultiplier: 1,
        start: palette("--a", "2", [{ index: 99, color: "red" }]),
        end: palette("--b", "3"),
      },
    });
    const identities = [mix(0.3), mix(0.5), mix(0.3, "srgb"), mix(0.3, "hsl", "longer")]
      .map((fontPaletteIdentity) => colorGlyphRasterIdentity({ fontPaletteIdentity }, [{ ...span[0], paletteEntryCount: 8 }]));
    expect(new Set(identities).size).toBe(4);
    expect(identities[0]).not.toContain('"index":99');
    const resolved = resolvedPaletteIdentity({ fontPaletteIdentity: mix(0.3) }, { ...span[0], paletteCount: 4, paletteEntryCount: 8 });
    expect(resolved.mix?.start.resolvedBasePalette).toBe(2);
    expect(resolved.mix?.end.resolvedBasePalette).toBe(3);
  });
});
