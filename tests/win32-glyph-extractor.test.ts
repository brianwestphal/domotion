import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";

// DM-837: validates the Windows DirectWrite glyph extractor
// (tools/win32-glyph-extractor). Mirrors the macOS / Linux helper tests.
// Skipped automatically unless we're on Windows with the binary built, so it is
// inert on macOS/Linux CI and on a clean Windows checkout. Runs in CI on a
// windows-latest runner (the glyph-extractor-build job in windows-fidelity.yml).
//
// The helper emits outlines in font design units, y-UP (DirectWrite's emSize is
// the font's designUnitsPerEm, and the Direct2D y-down geometry is negated) —
// fontkit's `glyph.path.commands` convention. Unlike the FreeType helper (which
// shares fontkit's exact contour ordering), DirectWrite may start a contour at a
// different point, so we assert the *robust* invariants — id, advance, the
// command-type histogram (curve mapping), and the bounding box (which pins the
// y-flip sign: a wrong negation flips the cap-height bbox below the baseline) —
// rather than an exact command-for-command match.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(HERE, "..", "tools", "win32-glyph-extractor", "domotion-glyph-paths.exe");

const helperAvailable = process.platform === "win32" && existsSync(HELPER);
const describeHelper = helperAvailable ? describe : describe.skip;

function resolveFontFile(candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
const ARIAL = resolveFontFile(["C:/Windows/Fonts/arial.ttf", "C:\\Windows\\Fonts\\arial.ttf"]);
const CAMBRIA = resolveFontFile(["C:/Windows/Fonts/cambria.ttc", "C:\\Windows\\Fonts\\cambria.ttc"]);

interface GlyphResult {
  id: number;
  advance: number;
  bbox: { x: number; y: number; w: number; h: number };
  d: string;
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
    fonts: [{ ref: "f", fontPath, size: 2048 }],
    queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ cp }] }],
  });
  return (resp.results[0] as { glyphs: GlyphResult[] }).glyphs[0];
}

const FK_TO_LETTER: Record<string, string> = {
  moveTo: "M",
  lineTo: "L",
  quadraticCurveTo: "Q",
  bezierCurveTo: "C",
  closePath: "Z",
};
function histogram(types: string[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const t of types) h[t] = (h[t] ?? 0) + 1;
  return h;
}
function fontkitTypes(cmds: Array<{ command: string }>): string[] {
  return cmds.map((c) => FK_TO_LETTER[c.command]);
}
function dPoints(d: string): Array<[number, number]> {
  const tokens = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const argCount: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
  const pts: Array<[number, number]> = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i++];
    const n = argCount[t];
    for (let k = 0; k < n; k += 2) pts.push([Number(tokens[i + k]), Number(tokens[i + k + 1])]);
    i += n;
  }
  return pts;
}
function dTypes(d: string): string[] {
  return (d.match(/[MLQCZ]/g) ?? []) as string[];
}
function bbox(pts: Array<[number, number]>): [number, number, number, number] {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function fontkitPoints(cmds: Array<{ args: number[] }>): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (const c of cmds) for (let i = 0; i + 1 < c.args.length; i += 2) pts.push([c.args[i], c.args[i + 1]]);
  return pts;
}

describeHelper("Windows DirectWrite glyph extractor", () => {
  const describeArial = ARIAL ? describe : describe.skip;
  const describeCambria = CAMBRIA ? describe : describe.skip;

  describeArial("Arial", () => {
    it("reports font metadata in design units", () => {
      const resp = callHelper({
        fonts: [{ ref: "f", fontPath: ARIAL, size: 2048 }],
        queries: [{ type: "meta", fontRef: "f" }],
      });
      const meta = resp.results[0] as { unitsPerEm: number; ascent: number; descent: number };
      expect(meta.unitsPerEm).toBe(2048);
      expect(meta.ascent).toBeGreaterThan(0);
      expect(meta.descent).toBeLessThan(0); // negative-below-baseline convention
    });

    it("extracts the H outline matching fontkit (validates y-up + line mapping)", () => {
      const font = fontkit.openSync(ARIAL!) as any;
      const fk = font.glyphForCodePoint(0x48);
      const H = helperGlyph(ARIAL!, 0x48);

      expect(H.id).toBe(fk.id);
      expect(H.d).toMatch(/^M /);
      expect(H.d).toMatch(/Z$/);
      expect(H.d).not.toMatch(/[QC]/); // H is straight lines only
      expect(Math.abs(H.advance - fk.advanceWidth)).toBeLessThan(2);

      // y-up: cap-height extent is positive (above baseline). A wrong y negation
      // would make the bbox y-range negative — this is the sign pin.
      const [fkMinX, fkMinY, fkMaxX, fkMaxY] = bbox(fontkitPoints(fk.path.commands));
      const [heMinX, heMinY, heMaxX, heMaxY] = bbox(dPoints(H.d));
      expect(heMaxY).toBeGreaterThan(0);
      for (const [a, b] of [
        [fkMinX, heMinX],
        [fkMinY, heMinY],
        [fkMaxX, heMaxX],
        [fkMaxY, heMaxY],
      ]) {
        expect(Math.abs(a - b)).toBeLessThan(2);
      }

      // Same command-type histogram (curve mapping; robust to start-point order).
      expect(histogram(dTypes(H.d))).toEqual(histogram(fontkitTypes(fk.path.commands)));
    });

    it("returns id=0 / empty path for a codepoint the font lacks", () => {
      const han = helperGlyph(ARIAL!, 0x6f22); // 漢 — not in Arial
      expect(han.id).toBe(0);
      expect(han.d).toBe("");
    });
  });

  describeCambria("Cambria Math", () => {
    it("extracts a Math-Alphanumeric glyph (U+1D400 𝐀) via the .ttc face", () => {
      const resp = callHelper({
        fonts: [{ ref: "f", fontPath: CAMBRIA, postscriptName: "CambriaMath", size: 2048 }],
        queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ cp: 0x1d400 }] }],
      });
      const a = (resp.results[0] as { glyphs: GlyphResult[] }).glyphs[0];
      expect(a.id).toBeGreaterThan(0);
      expect(a.d.length).toBeGreaterThan(0);
      expect(a.d).toMatch(/C/); // DirectWrite emits cubic curves
    });
  });
});
