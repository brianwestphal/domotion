/**
 * Native macOS glyph-outline extraction via the CoreText helper binary
 * (`tools/macos-glyph-extractor`). DM-385 / DM-388.
 *
 * Used as the path-extraction backend for fonts whose outlines fontkit
 * can't read — primarily PingFang, whose outlines live in the proprietary
 * Apple `hvgl` table. The helper opens the font through CoreText (which
 * understands `hvgl`) and returns SVG path data we can drop into the same
 * `<defs>`/`<use>` pipeline as fontkit-extracted glyphs.
 *
 * The wrapper exposes a fontkit-compatible subset of the `Font` API (the
 * fields `text-to-path.ts` reads): `unitsPerEm`, ascent/descent, underline /
 * strikeout metrics, `glyphForCodePoint`, `getGlyph`, and `layout`. The
 * renderer treats it interchangeably with a fontkit Font.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = process.env.DOMOTION_HELPER_PATH
  ?? path.resolve(HERE, "..", "tools", "macos-glyph-extractor", "domotion-glyph-paths");

let helperAvailable: boolean | null = null;
export function isCoretextHelperAvailable(): boolean {
  if (helperAvailable != null) return helperAvailable;
  if (process.platform !== "darwin") { helperAvailable = false; return false; }
  if (process.env.DOMOTION_DISABLE_HELPER) { helperAvailable = false; return false; }
  helperAvailable = existsSync(HELPER_PATH);
  return helperAvailable;
}

interface PathCommand { command: string; args: number[] }

interface CoretextGlyph {
  id: number;
  advanceWidth: number;
  path: { commands: PathCommand[] };
  codePoints?: number[];
}

interface MetaResponse {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition?: number;
  underlineThickness?: number;
  strikeoutPosition?: number;
  strikeoutThickness?: number;
}

interface GlyphResponse {
  id: number;
  advance: number;
  bbox: { x: number; y: number; w: number; h: number };
  d: string;
}

// Parse the Swift helper's SVG path-data string into fontkit's command-array
// format. The helper emits exactly: `M x y`, `L x y`, `Q cx cy x y`,
// `C c1x c1y c2x c2y x y`, `Z` — space-separated, no relative variants.
function parseSvgPath(d: string): PathCommand[] {
  if (d.length === 0) return [];
  const tokens = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: PathCommand[] = [];
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i++];
    switch (t) {
      case "M": out.push({ command: "moveTo", args: [num(), num()] }); break;
      case "L": out.push({ command: "lineTo", args: [num(), num()] }); break;
      case "Q": out.push({ command: "quadraticCurveTo", args: [num(), num(), num(), num()] }); break;
      case "C": out.push({ command: "bezierCurveTo", args: [num(), num(), num(), num(), num(), num()] }); break;
      case "Z": out.push({ command: "closePath", args: [] }); break;
    }
  }
  return out;
}

// Spawn the helper once, request meta + a batch of glyphs in one envelope.
interface HelperRequest {
  fonts: Array<{ ref: string; postscriptName?: string; fontPath?: string; size: number }>;
  queries: Array<
    | { type: "meta"; fontRef: string }
    | { type: "glyphs"; fontRef: string; glyphs: Array<{ cp?: number; id?: number }> }
  >;
}
interface HelperResponse {
  results: Array<MetaResponse & { type: "meta" } | { type: "glyphs"; glyphs: GlyphResponse[] }>;
}

function callHelper(request: HelperRequest): HelperResponse {
  const proc = spawnSync(HELPER_PATH, [], {
    input: JSON.stringify(request),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (proc.status !== 0) {
    throw new Error(`coretext helper failed (exit ${proc.status}): ${proc.stderr}`);
  }
  return JSON.parse(proc.stdout);
}

export interface CoretextFontInstance {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition: number;
  underlineThickness: number;
  "OS/2"?: { yStrikeoutPosition?: number; yStrikeoutSize?: number };
  availableFeatures?: string[];
  glyphForCodePoint(cp: number): CoretextGlyph;
  getGlyph(id: number): CoretextGlyph;
  layout(text: string, features?: string[]): {
    glyphs: CoretextGlyph[];
    positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  };
}

export function createCoretextFont(spec: {
  postscriptName?: string;
  fontPath?: string;
}): CoretextFontInstance | null {
  if (!isCoretextHelperAvailable()) return null;

  // Open at size=1000 first so we can read unitsPerEm. Then re-open at
  // size=unitsPerEm so all glyph paths come back in design-unit space — this
  // matches fontkit's coordinate convention so the existing
  // `scale(fontSize/unitsPerEm, ...)` transform in text-to-path.ts works.
  let metaResp: MetaResponse;
  try {
    const probe = callHelper({
      fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, size: 1000 }],
      queries: [{ type: "meta", fontRef: "f" }]
    });
    const r = probe.results[0];
    if (r.type !== "meta") throw new Error("unexpected response shape");
    metaResp = r;
  } catch {
    return null;
  }

  const unitsPerEm = metaResp.unitsPerEm;
  const renderSize = unitsPerEm;

  // Per-(cp, id) caches — each glyph is fetched at most once per Node process.
  const cpToGlyph = new Map<number, CoretextGlyph>();
  const idToGlyph = new Map<number, CoretextGlyph>();
  const missingCp = new Set<number>();

  function fetchByCps(cps: number[]): void {
    const need = cps.filter((cp) => !cpToGlyph.has(cp) && !missingCp.has(cp));
    if (need.length === 0) return;
    const resp = callHelper({
      fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, size: renderSize }],
      queries: [{ type: "glyphs", fontRef: "f", glyphs: need.map((cp) => ({ cp })) }]
    });
    const r = resp.results[0];
    if (r.type !== "glyphs") return;
    for (let i = 0; i < need.length; i++) {
      const cp = need[i];
      const g = r.glyphs[i];
      if (g == null || g.id === 0) {
        missingCp.add(cp);
        continue;
      }
      const glyph: CoretextGlyph = {
        id: g.id,
        advanceWidth: g.advance,
        path: { commands: parseSvgPath(g.d) },
        codePoints: [cp]
      };
      cpToGlyph.set(cp, glyph);
      idToGlyph.set(g.id, glyph);
    }
  }

  function fetchById(id: number): CoretextGlyph {
    const cached = idToGlyph.get(id);
    if (cached != null) return cached;
    const resp = callHelper({
      fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, size: renderSize }],
      queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ id }] }]
    });
    const r = resp.results[0];
    if (r.type !== "glyphs") {
      const empty: CoretextGlyph = { id, advanceWidth: 0, path: { commands: [] } };
      idToGlyph.set(id, empty);
      return empty;
    }
    const g = r.glyphs[0];
    const glyph: CoretextGlyph = {
      id: g.id,
      advanceWidth: g.advance,
      path: { commands: parseSvgPath(g.d) }
    };
    idToGlyph.set(id, glyph);
    return glyph;
  }

  function notdef(id = 0): CoretextGlyph {
    return { id, advanceWidth: 0, path: { commands: [] } };
  }

  return {
    unitsPerEm,
    ascent: metaResp.ascent ?? 0,
    descent: metaResp.descent ?? 0,
    underlinePosition: metaResp.underlinePosition ?? 0,
    underlineThickness: metaResp.underlineThickness ?? 0,
    "OS/2": {
      yStrikeoutPosition: metaResp.strikeoutPosition,
      yStrikeoutSize: metaResp.strikeoutThickness
    },
    availableFeatures: [],

    glyphForCodePoint(cp: number): CoretextGlyph {
      if (missingCp.has(cp)) return notdef(0);
      if (!cpToGlyph.has(cp)) fetchByCps([cp]);
      return cpToGlyph.get(cp) ?? notdef(0);
    },

    getGlyph(id: number): CoretextGlyph {
      return fetchById(id);
    },

    layout(text: string): {
      glyphs: CoretextGlyph[];
      positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
    } {
      // Batch every codepoint in one helper call before assembling the result.
      const cps: number[] = [];
      for (const ch of text) cps.push(ch.codePointAt(0)!);
      fetchByCps(cps);

      const glyphs: CoretextGlyph[] = [];
      const positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }> = [];
      for (const cp of cps) {
        const g = cpToGlyph.get(cp) ?? notdef(0);
        glyphs.push(g);
        positions.push({ xAdvance: g.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 });
      }
      return { glyphs, positions };
    }
  };
}

/** Drop the in-memory glyph-resolution caches. Currently a no-op since each
 *  `createCoretextFont` returns its own closure-bound cache, but exposed for
 *  parity with `clearWebfonts` / `clearGlyphDefs`. */
export function clearCoretextCache(): void {
  helperAvailable = null;
}
