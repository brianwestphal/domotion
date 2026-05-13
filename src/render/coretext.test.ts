import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";

// DM-385 / DM-387: validates the Swift CoreText helper.
// Tests are skipped automatically when:
//   - we're not on macOS (the helper is platform-specific)
//   - the helper binary isn't built yet (developer hasn't run build.sh)
// so this file doesn't break Linux/Windows CI before DM-389/DM-390 land.

const HELPER = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "tools",
  "macos-glyph-extractor",
  "domotion-glyph-paths"
);

const helperAvailable = process.platform === "darwin" && existsSync(HELPER);
const describeHelper = helperAvailable ? describe : describe.skip;

interface GlyphResult {
  id: number;
  advance: number;
  bbox: { x: number; y: number; w: number; h: number };
  d: string;
}
interface MetaResult {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition?: number;
  underlineThickness?: number;
  strikeoutPosition?: number;
  strikeoutThickness?: number;
}

function callHelper(request: unknown): { results: any[] } {
  const proc = spawnSync(HELPER, [], {
    input: JSON.stringify(request),
    encoding: "utf-8"
  });
  if (proc.status !== 0) {
    throw new Error(`helper exit ${proc.status}: ${proc.stderr}`);
  }
  return JSON.parse(proc.stdout);
}

describeHelper("CoreText glyph extractor", () => {
  it("extracts the Helvetica H outline at 100pt", () => {
    const response = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: 100 }],
      queries: [
        { type: "meta", fontRef: "h" },
        { type: "glyphs", fontRef: "h", glyphs: [{ cp: 0x48 }] }
      ]
    });

    const meta = response.results[0] as MetaResult;
    const glyphResult = response.results[1] as { glyphs: GlyphResult[] };

    expect(meta.unitsPerEm).toBe(2048);
    const H = glyphResult.glyphs[0];
    expect(H.id).toBeGreaterThan(0);
    expect(H.d).toMatch(/^M /);
    expect(H.d).toMatch(/Z$/);
    expect(H.advance).toBeGreaterThan(60);
    expect(H.advance).toBeLessThan(80);
  });

  it("extracts PingFang 漢 (U+6F22) where fontkit can't (DM-382)", () => {
    const response = callHelper({
      fonts: [{ ref: "p", postscriptName: "PingFangSC-Regular", size: 22 }],
      queries: [{ type: "glyphs", fontRef: "p", glyphs: [{ cp: 0x6F22 }] }]
    });
    const result = response.results[0] as { glyphs: GlyphResult[] };
    const han = result.glyphs[0];
    expect(han.id).toBeGreaterThan(0);
    expect(han.d.length).toBeGreaterThan(0);
    expect(han.advance).toBeGreaterThan(0);
  });

  it("agrees with fontkit on Helvetica H advance within 1%", () => {
    const SIZE = 100;
    const response = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: SIZE }],
      queries: [
        { type: "meta", fontRef: "h" },
        { type: "glyphs", fontRef: "h", glyphs: [{ cp: 0x48 }] }
      ]
    });
    const meta = response.results[0] as MetaResult;
    const ctH = (response.results[1] as { glyphs: GlyphResult[] }).glyphs[0];

    const collection = fontkit.openSync("/System/Library/Fonts/Helvetica.ttc") as any;
    const helvetica = collection.getFont != null ? collection.getFont("Helvetica") : collection;
    const fkGlyph = helvetica.glyphForCodePoint(0x48);
    const fkAdvancePoints = (fkGlyph.advanceWidth * SIZE) / meta.unitsPerEm;

    expect(Math.abs(ctH.advance - fkAdvancePoints)).toBeLessThan(fkAdvancePoints * 0.01);
  });

  it("returns id=0 / empty path for codepoints the font lacks", () => {
    const response = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: 16 }],
      queries: [{ type: "glyphs", fontRef: "h", glyphs: [{ cp: 0x6F22 }] }] // Han ideograph in Helvetica
    });
    const result = response.results[0] as { glyphs: GlyphResult[] };
    expect(result.glyphs[0].id).toBe(0);
    expect(result.glyphs[0].d).toBe("");
  });

  it("accepts pre-resolved glyph ids in addition to codepoints", () => {
    const probe = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: 16 }],
      queries: [{ type: "glyphs", fontRef: "h", glyphs: [{ cp: 0x48 }] }]
    });
    const id = (probe.results[0] as { glyphs: GlyphResult[] }).glyphs[0].id;

    const byId = callHelper({
      fonts: [{ ref: "h", postscriptName: "Helvetica", size: 16 }],
      queries: [{ type: "glyphs", fontRef: "h", glyphs: [{ id }] }]
    });
    const byIdGlyph = (byId.results[0] as { glyphs: GlyphResult[] }).glyphs[0];
    expect(byIdGlyph.id).toBe(id);
    expect(byIdGlyph.d.length).toBeGreaterThan(0);
  });
});
