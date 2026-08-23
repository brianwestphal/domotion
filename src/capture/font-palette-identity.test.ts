import { describe, expect, it } from "vitest";
import { colorGlyphRasterIdentity, resolvedPaletteIdentity } from "./emoji.js";

describe("color glyph raster identity", () => {
  const span = [{ fontKey: "audit-face", faceId: "/fonts/a.ttf#0", glyphIds: [7], representation: "colr" }];
  it("separates palette rules and ordered overrides for the same face/gid", () => {
    const a = colorGlyphRasterIdentity({ fontPalette: "--a", fontPaletteIdentity: { token: "--a", ruleFamily: "Audit", basePalette: "2", overrides: [] } }, span);
    const b = colorGlyphRasterIdentity({ fontPalette: "--b", fontPaletteIdentity: { token: "--b", ruleFamily: "Audit", basePalette: "3", overrides: [{ index: 7, color: "red" }] } }, span);
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
    const key = colorGlyphRasterIdentity({ fontPalette: "--a", fontPaletteIdentity: { token: "--a", ruleFamily: "Audit", basePalette: "0", overrides: [{ index: 3, color: "red" }, { index: 99, color: "blue" }] } }, [{ ...span[0], paletteEntryCount: 8 }]);
    expect(key).toContain('"index":3');
    expect(key).not.toContain('"index":99');
  });
  it("resolves theme and invalid numeric bases against the selected CPAL table", () => {
    expect(resolvedPaletteIdentity({ fontPalette: "light" }, { ...span[0], paletteCount: 4, paletteTypes: [0, 0, 1, 2] }).resolvedBasePalette).toBe(2);
    expect(resolvedPaletteIdentity({ fontPalette: "--bad", fontPaletteIdentity: { token: "--bad", ruleFamily: "Audit", basePalette: "99", overrides: [] } }, { ...span[0], paletteCount: 4 }).resolvedBasePalette).toBe(0);
  });
});
