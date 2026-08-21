import { describe, expect, it } from "vitest";
import { glyphRasterRepresentation, glyphUsesRasterRepresentation } from "./text-to-path.js";
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

  it("honors an exact helper-reported color representation even when DirectWrite exposes a base outline", () => {
    const mixed = font({ COLR: {}, CPAL: {}, glyf: {} });
    const selected = { ...glyph(7), rasterRepresentation: "colr" as const };
    expect(glyphRasterRepresentation(mixed, "mixed", selected, 32)).toBe("colr");
  });

  it("carries every selected-glyph raster kind across the outline boundary", () => {
    const mixed = font({ glyf: {} });
    for (const rasterRepresentation of ["sbix", "colr", "bitmap", "svg"] as const) {
      expect(glyphRasterRepresentation(mixed, "mixed", {
        ...glyph(11), rasterRepresentation,
      }, 32)).toBe(rasterRepresentation);
    }
  });

  it("keeps an unmarked outline vector in the same mixed face", () => {
    const mixed = font({ COLR: {}, CPAL: {}, glyf: {} });
    expect(glyphRasterRepresentation(mixed, "mixed", glyph(8), 32)).toBeNull();
  });

  it("moves only when the selected-glyph marker changes", () => {
    const mixed = font({ COLR: {}, CPAL: {}, glyf: {} });
    const base = glyph(9);
    expect(glyphUsesRasterRepresentation(mixed, "mixed", base, 32)).toBe(false);
    expect(glyphUsesRasterRepresentation(mixed, "mixed", {
      ...base, rasterRepresentation: "colr",
    }, 32)).toBe(true);
  });

  it("requires complete Blink color-table pairs", () => {
    expect(glyphUsesRasterRepresentation(font({ CBDT: {}, CBLC: {} }), "x", glyph(1, []), 32)).toBe(true);
    expect(glyphUsesRasterRepresentation(font({ CBDT: {} }), "x", glyph(1, []), 32)).toBe(false);
    expect(glyphUsesRasterRepresentation(font({ COLR: {} }), "x", glyph(1, []), 32)).toBe(false);
    expect(glyphUsesRasterRepresentation(font({ CPAL: {} }), "x", glyph(1, []), 32)).toBe(false);
    expect(glyphRasterRepresentation(font({ CBDT: {}, CBLC: {} }), "x", glyph(1, []), 32)).toBe("bitmap");
    expect(glyphRasterRepresentation(font({ COLR: {}, CPAL: {} }), "x", glyph(1, []), 32)).toBe("colr");
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
