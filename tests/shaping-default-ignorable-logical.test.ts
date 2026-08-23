import { describe, expect, it } from "vitest";
import { BufferFlag } from "../vendor/harfbuzzjs/dist/index.mjs";
import { harfbuzzShapeRun } from "../src/render/harfbuzz-shaper.js";
import { renderTextAsPath } from "../src/render/text-to-path.js";
import {
  assertStandaloneDefaultIgnorableRecord,
  assertStandaloneDefaultIgnorableFace,
  compareShaping,
  ourShaping,
  type OurShaping,
  type RunSpec,
} from "../tools/shaping-conformance.js";

const MACOS_STANDALONE_SELECTORS = [
  0xE0110, 0xE0108, 0xFE06, 0xE017C, 0xE01C3, 0xE01C8,
];

function spec(cp: number): RunSpec {
  return {
    text: String.fromCodePoint(cp),
    fontFamily: '"Arial Unicode MS", "Apple Symbols", sans-serif',
    fontSize: 32,
    fontWeight: 400,
    fontStyle: "normal",
    fixtures: 1,
    example: `U+${cp.toString(16).toUpperCase()}`,
  };
}

describe("standalone default-ignorable logical shaping (DM-2521)", () => {
  it.each(MACOS_STANDALONE_SELECTORS.map((cp) => [cp]))(
    "retains U+%s as the selected face's zero-advance space glyph",
    (cp) => {
      const row = ourShaping(spec(cp));
      expect(row.glyphCount).toBe(1);
      expect(row.xs).toEqual([0]);
      expect(row.logicalRuns).toHaveLength(1);
      expect(row.logicalGlyphs).toHaveLength(1);
      expect(row.logicalGlyphs[0]).toMatchObject({
        cluster: 0,
        sourceSpan: [0, cp > 0xFFFF ? 2 : 1],
        sourceCodepointSpan: [0, 1],
        xAdvance: 0,
        yAdvance: 0,
        xOffset: 0,
        yOffset: 0,
        sourceOutline: null,
      });
      expect(() => assertStandaloneDefaultIgnorableRecord(spec(cp).text, row.logicalRuns)).not.toThrow();
    },
  );

  it("fails the source control when gid, source span, or logical retention mutates", () => {
    const row = ourShaping(spec(0xE0110));
    const mutated = structuredClone(row.logicalRuns);
    mutated[0].glyphs[0].id++;
    expect(() => assertStandaloneDefaultIgnorableRecord(spec(0xE0110).text, mutated)).toThrow(/disagrees with HarfBuzz source/);
    mutated[0].glyphs = structuredClone(row.logicalRuns[0].glyphs);
    mutated[0].glyphs[0].sourceSpan = [0, 1];
    expect(() => assertStandaloneDefaultIgnorableRecord(spec(0xE0110).text, mutated)).toThrow(/disagrees with HarfBuzz source/);
    mutated[0].glyphs = [];
    expect(() => assertStandaloneDefaultIgnorableRecord(spec(0xE0110).text, mutated)).toThrow(/produced 0 logical glyphs/);
    mutated[0] = structuredClone(row.logicalRuns[0]);
    mutated[0].sourceText = String.fromCodePoint(0xE0108);
    expect(() => assertStandaloneDefaultIgnorableRecord(spec(0xE0110).text, mutated)).toThrow(/scalar\/run record disagrees/);
    mutated[0] = structuredClone(row.logicalRuns[0]);
    mutated[0].glyphs[0].cluster = 1;
    expect(() => assertStandaloneDefaultIgnorableRecord(spec(0xE0110).text, mutated)).toThrow(/disagrees with HarfBuzz source/);
    mutated[0] = structuredClone(row.logicalRuns[0]);
    mutated[0].glyphs[0].xAdvance = 1;
    expect(() => assertStandaloneDefaultIgnorableRecord(spec(0xE0110).text, mutated)).toThrow(/disagrees with HarfBuzz source/);
    const selectedFace = row.logicalRuns[0].selected.instantiatedPostscriptName
      ?? row.logicalRuns[0].selected.postscriptName!;
    expect(() => assertStandaloneDefaultIgnorableFace(
      spec(0xE0110).text, row.logicalRuns, [`${selectedFace}×1`],
    )).not.toThrow();
    expect(() => assertStandaloneDefaultIgnorableFace(
      spec(0xE0110).text, row.logicalRuns, ["WrongFace×1"],
    )).toThrow(/selected face.*!= Chromium/);
  });

  it("keeps the zero-ink terminal without forcing a consumer glyph", () => {
    const source = spec(0xE0110);
    const svg = renderTextAsPath(source.text, 0, 64, {
      fontSize: source.fontSize,
      fontFamily: source.fontFamily,
      fontWeight: String(source.fontWeight),
      fontStyle: source.fontStyle,
      fill: "#000",
    });
    expect(svg).toContain('data-domotion-text-boundary="path-all-inkless"');
    expect(svg).not.toMatch(/<(?:text|use)\b/);
  });

  it("moves under HarfBuzz REMOVE and PRESERVE buffer-flag mutations", () => {
    const source = spec(0xE0110);
    const row = ourShaping(source);
    const selected = row.logicalRuns[0].selected;
    const shape = (bufferFlags: number) => harfbuzzShapeRun(
      selected.sourcePath!, selected.faceIndex!, source.text, "ltr", source.fontSize,
      selected.variationAxes, undefined, { bufferFlags },
    );
    expect(shape(BufferFlag.REMOVE_DEFAULT_IGNORABLES)?.glyphs).toHaveLength(0);
    const preserved = shape(BufferFlag.PRESERVE_DEFAULT_IGNORABLES)!;
    expect(preserved.glyphs).toHaveLength(1);
    expect(preserved.glyphs[0].id).not.toBe(row.logicalGlyphs[0].id);
    expect(preserved.positions[0].xAdvance).not.toBe(0);
    // Blink does not set BOT/EOT. Adding them would insert U+25CC before this
    // Mn selector and create the exact wrong two-glyph oracle shape.
    expect(shape(BufferFlag.BOT | BufferFlag.EOT)?.glyphs).toHaveLength(2);
  });

  it("makes logical omission move the public count verdict", () => {
    const row = ourShaping(spec(0xFE06));
    expect(compareShaping(
      { glyphCount: 1, faces: ["source-face×1"], xs: [0], width: 0 },
      row,
      0.5,
    )).toEqual({ verdict: "agree-exact", maxDelta: 0 });
    const omitted: OurShaping = { ...row, glyphCount: 0, xs: [], ok: false, logicalGlyphs: [], logicalRuns: [] };
    expect(compareShaping(
      { glyphCount: 1, faces: ["source-face×1"], xs: [0], width: 0 },
      omitted,
      0.5,
    ).verdict).toBe("mismatch-unrendered");
  });
});
