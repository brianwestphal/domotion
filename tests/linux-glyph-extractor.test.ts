import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";

// DM-872: validates the Linux FreeType glyph extractor
// (tools/linux-glyph-extractor). Mirrors the macOS CoreText helper test
// (src/render/glyph-helper.test.ts). Skipped automatically when:
//   - we're not on Linux (the helper is platform-specific), or
//   - the helper binary isn't built yet (run tools/linux-glyph-extractor/build.sh).
// so this file is inert on macOS/Windows CI and on a clean Linux checkout that
// hasn't built the helper.
//
// The helper emits outlines in font design units, y-UP, via FT_LOAD_NO_SCALE —
// exactly fontkit's `glyph.path.commands` convention — so a direct fontkit
// comparison is the parity oracle. (A wrong y-negation would flip the bbox
// y-range; the bbox assertions below catch that.)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(HERE, "..", "tools", "linux-glyph-extractor", "domotion-glyph-paths");

const helperAvailable = process.platform === "linux" && existsSync(HELPER);
const describeHelper = helperAvailable ? describe : describe.skip;

// Resolve a system font file across distro layout differences; null when absent
// (the individual case skips rather than failing on a runner without that font).
function resolveFontFile(candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
const LIBERATION_SANS = resolveFontFile([
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/liberation-fonts/LiberationSans-Regular.ttf",
  "/usr/share/fonts/TTF/LiberationSans-Regular.ttf",
]);
const FREE_SANS = resolveFontFile([
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  "/usr/share/fonts/gnu-free/FreeSans.ttf",
  "/usr/share/fonts/TTF/FreeSans.ttf",
]);

interface GlyphResult {
  id: number;
  advance: number;
  bbox: { x: number; y: number; w: number; h: number };
  d: string;
}
interface MetaResult {
  type: "meta";
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
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error(`helper exit ${proc.status}: ${proc.stderr}`);
  return JSON.parse(proc.stdout);
}

function helperGlyph(fontPath: string, cp: number): GlyphResult {
  const resp = callHelper({
    fonts: [{ ref: "f", fontPath, size: 1000 }],
    queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ cp }] }],
  });
  return (resp.results[0] as { glyphs: GlyphResult[] }).glyphs[0];
}

// Normalize either source into a [{ type, coords[] }] command list for parity
// comparison. fontkit command names → SVG path letters.
const FK_TO_LETTER: Record<string, string> = {
  moveTo: "M",
  lineTo: "L",
  quadraticCurveTo: "Q",
  bezierCurveTo: "C",
  closePath: "Z",
};
function fontkitCommands(cmds: Array<{ command: string; args: number[] }>) {
  return cmds.map((c) => ({ type: FK_TO_LETTER[c.command], coords: c.args.slice() }));
}
function parseDCommands(d: string) {
  const tokens = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const argCount: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
  const out: Array<{ type: string; coords: number[] }> = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i++];
    const n = argCount[t];
    const coords: number[] = [];
    for (let k = 0; k < n; k++) coords.push(Number(tokens[i++]));
    out.push({ type: t, coords });
  }
  return out;
}

// Assert the helper's outline matches fontkit's command-for-command within a
// numeric tolerance (both emit exact design-unit integers, so this is tight).
function expectOutlineParity(fontPath: string, cp: number) {
  const font = fontkit.openSync(fontPath) as any;
  const fk = font.glyphForCodePoint(cp);
  const helper = helperGlyph(fontPath, cp);

  expect(helper.id).toBe(fk.id);
  expect(Math.abs(helper.advance - fk.advanceWidth)).toBeLessThan(1);

  const fkCmds = fontkitCommands(fk.path.commands);
  const heCmds = parseDCommands(helper.d);
  expect(heCmds.map((c) => c.type)).toEqual(fkCmds.map((c) => c.type));
  // Real on-curve / control points are exact integer font units → they match
  // exactly. The only divergence is the implied on-curve midpoint TrueType
  // inserts between two consecutive off-curve points: FreeType's
  // FT_Outline_Decompose computes it with integer division (truncating the .5),
  // while fontkit uses an exact float midpoint — so a single coordinate can
  // differ by up to 0.5 font units (~0.004px at 16px). Since Chromium also
  // rasterizes through FreeType, the helper's truncated value is the
  // Chromium-faithful one; this tolerance is the floor, not slop.
  const COORD_TOLERANCE = 1; // font units; FreeType integer-midpoint divergence is ≤ 0.5
  for (let i = 0; i < fkCmds.length; i++) {
    expect(heCmds[i].coords.length).toBe(fkCmds[i].coords.length);
    for (let k = 0; k < fkCmds[i].coords.length; k++) {
      expect(Math.abs(heCmds[i].coords[k] - fkCmds[i].coords[k])).toBeLessThan(COORD_TOLERANCE);
    }
  }
}

describeHelper("Linux FreeType glyph extractor", () => {
  const describeLiberation = LIBERATION_SANS ? describe : describe.skip;
  const describeFreeSans = FREE_SANS ? describe : describe.skip;

  describeLiberation("Liberation Sans", () => {
    it("reports font metadata in design units", () => {
      const resp = callHelper({
        fonts: [{ ref: "f", fontPath: LIBERATION_SANS, size: 1000 }],
        queries: [{ type: "meta", fontRef: "f" }],
      });
      const meta = resp.results[0] as MetaResult;
      expect(meta.unitsPerEm).toBe(2048);
      expect(meta.ascent).toBeGreaterThan(0);
      expect(meta.descent).toBeLessThan(0);
      expect(meta.underlineThickness).toBeGreaterThan(0);
    });

    it("extracts the H outline byte-faithfully vs fontkit (validates y-up + line mapping)", () => {
      const H = helperGlyph(LIBERATION_SANS!, 0x48);
      expect(H.id).toBeGreaterThan(0);
      expect(H.d).toMatch(/^M /);
      expect(H.d).toMatch(/Z$/);
      expect(H.d).not.toMatch(/[QC]/); // H is all straight lines
      // y-up: the cap-height extent is positive (above baseline), not negative.
      expect(H.bbox.y).toBe(0);
      expect(H.bbox.h).toBeGreaterThan(0);
      expectOutlineParity(LIBERATION_SANS!, 0x48);
    });

    it("returns id=0 / empty path for a codepoint the font lacks", () => {
      const han = helperGlyph(LIBERATION_SANS!, 0x6f22); // 漢 — not in Liberation Sans
      expect(han.id).toBe(0);
      expect(han.d).toBe("");
    });

    it("accepts pre-resolved glyph ids as well as codepoints", () => {
      const byCp = helperGlyph(LIBERATION_SANS!, 0x48);
      const resp = callHelper({
        fonts: [{ ref: "f", fontPath: LIBERATION_SANS, size: 1000 }],
        queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ id: byCp.id }] }],
      });
      const byId = (resp.results[0] as { glyphs: GlyphResult[] }).glyphs[0];
      expect(byId.id).toBe(byCp.id);
      expect(byId.d).toBe(byCp.d);
    });
  });

  describeFreeSans("FreeSans Math-Alphanumeric (DM-838 / DM-876)", () => {
    // The upright FreeSans.ttf carries the full Mathematical Alphanumeric block
    // (U+1D400–1D7FF); 𝑎 (U+1D44E) is gid 6385. fontkit can read those outlines,
    // and so can this extractor — both return a real, non-empty glyph. (The
    // earlier "FreeSans lacks the block" record was the FreeSansOblique face by
    // mistake, corrected in DM-876.) So this is positive parity coverage, not an
    // empty-regression guard.
    it("extracts math-italic 𝑎 (U+1D44E) and matches fontkit", () => {
      const a = helperGlyph(FREE_SANS!, 0x1d44e);
      expect(a.id).toBe(6385);
      expect(a.d.length).toBeGreaterThan(0);
      expect(a.d).toMatch(/Q/); // curved glyph
      expectOutlineParity(FREE_SANS!, 0x1d44e);
    });
  });
});
