import { describe, expect, it } from "vitest";
import { glyphUsesRasterRepresentation } from "./text-to-path.js";
import type { FontInstance } from "./font-resolution.js";

const outline = [{ command: "moveTo", args: [0, 0] }];
function font(tables: Record<string, unknown>, colrIds: number[] = []): FontInstance {
  return {
    directory: { tables },
    COLR: { baseGlyphRecord: colrIds.map((gid) => ({ gid })) },
  } as unknown as FontInstance;
}
const glyph = (id: number, commands = outline, type?: string) => ({ id, path: { commands }, type });

describe("selected glyph raster representation", () => {
  it("distinguishes a COLR glyph from an outline glyph in the same face", () => {
    const mixed = font({ COLR: {}, CPAL: {}, glyf: {} }, [7]);
    expect(glyphUsesRasterRepresentation(mixed, "mixed", glyph(7, outline, "COLR"), 32)).toBe(true);
    expect(glyphUsesRasterRepresentation(mixed, "mixed", glyph(8, outline, "COLR"), 32)).toBe(false);
  });

  it("requires complete Blink color-table pairs", () => {
    expect(glyphUsesRasterRepresentation(font({ CBDT: {}, CBLC: {} }), "x", glyph(1, []), 32)).toBe(true);
    expect(glyphUsesRasterRepresentation(font({ CBDT: {} }), "x", glyph(1, []), 32)).toBe(false);
    expect(glyphUsesRasterRepresentation(font({ COLR: {} }), "x", glyph(1, []), 32)).toBe(false);
    expect(glyphUsesRasterRepresentation(font({ CPAL: {} }), "x", glyph(1, []), 32)).toBe(false);
  });

  it("uses the selected sbix glyph image, not face naming", () => {
    const sbix = font({ sbix: {} });
    expect(glyphUsesRasterRepresentation(sbix, "arbitrary", {
      ...glyph(2, outline, "SBIX"), getImageForSize: () => new Uint8Array([1]),
    }, 32)).toBe(true);
    expect(glyphUsesRasterRepresentation(sbix, "arbitrary", {
      ...glyph(3, outline, "SBIX"), getImageForSize: () => null,
    }, 32)).toBe(false);
  });

  it("routes SVG-only glyph output but preserves an available outline", () => {
    const svg = font({ "SVG ": {}, glyf: {} });
    expect(glyphUsesRasterRepresentation(svg, "icons", glyph(4, []), 32)).toBe(true);
    expect(glyphUsesRasterRepresentation(svg, "icons", glyph(5, outline), 32)).toBe(false);
  });
});
