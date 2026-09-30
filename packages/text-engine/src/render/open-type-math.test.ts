import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as fontkit from "fontkit";
import { readMathRadicalData } from "./open-type-math.js";
import { selectMathRadicalShape, type MathRadicalGlyph } from "./math-radical-shape.js";

function mathFont(coverageFormat: 1 | 2 = 1) {
  const bytes = new Uint8Array(350);
  const view = new DataView(bytes.buffer);
  const put = (at: number, value: number) => view.setUint16(at, value, false);
  put(0, 1); // MATH major version
  put(4, 10); // MathConstants offset
  put(8, 230); // MathVariants offset
  put(10 + 8 + 45 * 4, 85);
  put(10 + 8 + 46 * 4, 170);
  put(10 + 8 + 47 * 4, 68);
  put(10 + 8 + 48 * 4, 78);
  put(230, 100); // minConnectorOverlap
  put(232, 20); // coverage offset
  put(236, 1); // vertical glyph count
  put(240, 40); // construction offset
  put(250, coverageFormat);
  put(252, 1);
  if (coverageFormat === 1) put(254, 1657);
  else {
    put(254, 1657);
    put(256, 1659);
    put(258, 0);
  }
  put(270, 20); // assembly offset
  put(272, 2); // variant count
  put(274, 1657);
  put(276, 1188);
  put(278, 1658);
  put(280, 1855);
  put(290, 0); // assembly italics correction
  put(294, 3); // part count
  const parts = [
    [1661, 200, 200, 1905, 0],
    [1664, 650, 650, 651, 1],
    [1662, 550, 0, 642, 0],
  ];
  parts.forEach((part, i) => part.forEach((value, j) => put(296 + i * 10 + j * 2, value)));
  return { directory: { tables: { MATH: { offset: 0, length: bytes.length } } }, stream: { buffer: bytes } };
}

describe("OpenType MATH radical records", () => {
  const stixPath = "/System/Library/Fonts/Supplemental/STIXTwoMath.otf";
  it.skipIf(!existsSync(stixPath))("reads macOS STIX Two Math's installed radical variants and assembly", () => {
    const font = fontkit.openSync(stixPath);
    const radicalId = font.glyphForCodePoint(0x221a).id;
    const data = readMathRadicalData(font, radicalId);
    expect(data).toMatchObject({
      verticalGap: 85,
      displayStyleVerticalGap: 170,
      ruleThickness: 68,
      extraAscender: 78,
      minConnectorOverlap: 100,
    });
    expect(data?.variants.map((variant) => variant.glyphId)).toEqual([1657, 1658, 1659, 1660]);
    expect(data?.assembly.map((part) => part.glyphId)).toEqual([1661, 1664, 1662]);
    expect(selectMathRadicalShape(data!, (id) => font.getGlyph(id), 3500)?.glyphs.length).toBeGreaterThan(3);
  });

  it.each([1, 2] as const)("reads constants, vertical coverage format %i, variants and assembly", (format) => {
    expect(readMathRadicalData(mathFont(format), 1657)).toEqual({
      verticalGap: 85,
      displayStyleVerticalGap: 170,
      ruleThickness: 68,
      extraAscender: 78,
      variants: [
        { glyphId: 1657, advance: 1188 },
        { glyphId: 1658, advance: 1855 },
      ],
      assembly: [
        { glyphId: 1661, startConnector: 200, endConnector: 200, advance: 1905, extender: false },
        { glyphId: 1664, startConnector: 650, endConnector: 650, advance: 651, extender: true },
        { glyphId: 1662, startConnector: 550, endConnector: 0, advance: 642, extender: false },
      ],
      minConnectorOverlap: 100,
    });
  });

  it("rejects truncated and malformed table records without reading beyond the SFNT", () => {
    const font = mathFont();
    font.directory.tables.MATH.length = 210;
    expect(readMathRadicalData(font, 1657)).toBeNull();
    font.directory.tables.MATH.length = 350;
    font.stream.buffer[0] = 2;
    expect(readMathRadicalData(font, 1657)).toBeNull();
  });

  it("chooses the smallest sufficient ink variant, then an assembled extender", () => {
    const data = readMathRadicalData(mathFont(), 1657)!;
    const glyph = (id: number): MathRadicalGlyph => ({
      id,
      path: { commands: [{ command: "moveTo", args: [0, 0] }] },
      bbox: {
        minX: 0,
        minY: 0,
        maxX: 200,
        maxY: id === 1657 ? 1188 : id === 1658 ? 1855 : id === 1661 ? 1905 : id === 1664 ? 650 : 642,
      },
      advanceWidth: 210,
    });
    expect(selectMathRadicalShape(data, glyph, 1200)?.glyphs.map((part) => part.glyph.id)).toEqual([1658]);
    const assembled = selectMathRadicalShape(data, glyph, 2700);
    expect(assembled?.glyphs.map((part) => part.glyph.id)).toEqual([1661, 1664, 1662]);
    expect(assembled!.bbox.maxY).toBeGreaterThanOrEqual(2700);
    expect(selectMathRadicalShape(data, (id) => (id === 1657 ? undefined : glyph(id)), 1200)?.glyphs[0].glyph.id).toBe(
      1658,
    );
    expect(selectMathRadicalShape(data, (id) => (id === 1664 ? undefined : glyph(id)), 2700)?.glyphs[0].glyph.id).toBe(
      1658,
    );
  });
});
