import { describe, expect, it } from "vitest";
import { adjustedFontInstance, fontSizeAdjustAspect, parseFontSizeAdjust } from "./family-match.js";
import type { FontInstance } from "./font-instance.js";

const glyphs = new Map([
  [0x78, { id: 10, bbox: { maxY: 1100 } }],
  [0x48, { id: 13, bbox: { maxY: 1400 } }],
  [0x30, { id: 11, advanceWidth: 1050 }],
  [0x6c34, { id: 12, advanceWidth: 2048, advanceHeight: 2300 }],
]);
const face = {
  unitsPerEm: 2048,
  ascent: 1800,
  descent: 400,
  underlinePosition: -100,
  underlineThickness: 80,
  layout: () => ({ glyphs: [], positions: [] }),
  xHeight: 1000,
  capHeight: 1400,
  glyphForCodePoint: (cp: number) => glyphs.get(cp) ?? { id: 0 },
} satisfies FontInstance & { xHeight: number; capHeight: number };

describe("font-size-adjust metric routing", () => {
  it.each([
    ["0.8", "ex-height", 0.8],
    ["ex-height 0.8", "ex-height", 0.8],
    ["cap-height 0.7", "cap-height", 0.7],
    ["ch-width 0.5", "ch-width", 0.5],
    ["ic-width from-font", "ic-width", "from-font"],
    ["ic-height 1", "ic-height", 1],
  ] as const)("parses %s", (input, metric, target) => {
    expect(parseFontSizeAdjust(input)).toEqual({ metric, target });
  });

  it.each(["none", "", "cap-height", "x-height 0.5", "0.5 junk", "-0.5"])("rejects %s", (input) => {
    expect(parseFontSizeAdjust(input)).toBeNull();
  });

  it("selects Apple's x outline top and the other platform's font metric", () => {
    expect(fontSizeAdjustAspect(face, "ex-height", "darwin")).toBe(1100 / 2048);
    expect(fontSizeAdjustAspect(face, "ex-height", "linux")).toBe(1000 / 2048);
  });

  it("reads cap height and glyph advances, including vertical advance", () => {
    expect(fontSizeAdjustAspect(face, "cap-height")).toBe(1400 / 2048);
    expect(fontSizeAdjustAspect(face, "ch-width")).toBe(1050 / 2048);
    expect(fontSizeAdjustAspect(face, "ic-width")).toBe(1);
    expect(fontSizeAdjustAspect(face, "ic-height")).toBe(2300 / 2048);
  });

  it("reads glyph bounds when a native helper omits font table metrics", () => {
    const helper = { ...face, xHeight: undefined, capHeight: undefined };
    expect(fontSizeAdjustAspect(helper, "ex-height", "darwin")).toBe(1100 / 2048);
    expect(fontSizeAdjustAspect(helper, "ex-height", "linux")).toBe(1100 / 2048);
    expect(fontSizeAdjustAspect(helper, "cap-height")).toBe(1400 / 2048);
  });

  it("uses aspect one when the requested metric is missing", () => {
    const missing = { ...face, glyphForCodePoint: () => ({ id: 0 }) };
    expect(fontSizeAdjustAspect(missing, "ch-width")).toBe(1);
    expect(fontSizeAdjustAspect(missing, "ic-height")).toBe(1);
    expect(fontSizeAdjustAspect({ ...missing, capHeight: 0 }, "cap-height")).toBe(1);
  });

  it("applies the primary used size to a fallback with a different aspect", () => {
    const fallback = { ...face, xHeight: 1500 };
    const adjusted = adjustedFontInstance(fallback, "fallback", 400, 16, 0, 100, undefined, { sizeAdjust: "0.8" }, 24);
    expect(adjusted.fontSizeAdjustScale).toBe(1.5);
    expect(adjusted.unitsPerEm).toBe(2048 / 1.5);
    expect(adjusted.glyphForCodePoint(0x78)).toEqual(face.glyphForCodePoint(0x78));
  });
});
