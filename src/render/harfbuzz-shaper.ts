// DM-1197: HarfBuzz shaping for the narrow set of complex-script runs where
// Domotion's macOS shaping (the CoreText glyph-helper) diverges from Chrome's.
//
// Chrome shapes complex text with HarfBuzz. For a precomposed complex-script
// letter that has a canonical base+mark decomposition (e.g. Kaithi U+110AB VA =
// U+110A5 BA + U+110BA NUKTA), HarfBuzz's USE shaper decomposes it and paints a
// base + separately-positioned nukta (the nukta sits ~3px below the base, from
// its own glyph outline). macOS CoreText instead recomposes to the precomposed
// glyph, whose built-in nukta is ~3px higher — so Domotion (which routes the
// Indic Noto fonts through the CoreText helper, because fontkit OOM-crashes on
// their GSUB tables — DM-983) paints the nukta in the wrong place.
//
// This module shapes such a run with the ACTUAL HarfBuzz library (harfbuzzjs is
// the same engine Chrome embeds), so the output is byte-identical to Chrome's:
// `hb-shape NotoSansKaithi U+110AB` → `[ktBa=0+568 | ktNukta=0@-11,0+0]`, and
// harfbuzzjs returns the same glyphs, advances and offsets, plus the outlines.
// It's robust where fontkit isn't (no GSUB-parser crash). Scoped at the call
// site (`resolveFontForCodepoint`) to ONLY the divergent codepoints, so the rest
// of the calibrated text pipeline is untouched.
import * as hb from "harfbuzzjs";
import { readFileSync } from "node:fs";

type PathCommand = { command: string; args: number[] };

interface ShapedGlyph {
  id: number;
  path: { commands: PathCommand[] };
  advanceWidth: number;
  codePoints?: number[];
}

interface ShapeResult {
  glyphs: ShapedGlyph[];
  positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  /** UTF-16 source-cluster index per glyph — lets the embedded-font emit loop
   *  anchor each cluster at its captured xOffset (the DM-1028 cluster path). */
  clusters: number[];
}

// One HarfBuzz font per file path, with a per-glyph outline cache (glyphToPath
// is the hot call). The font/face/blob are retained for the process lifetime —
// this only fires for the rare divergent codepoints, so the footprint is tiny.
interface HbEntry { font: { glyphToPath(id: number): string }; pathCache: Map<number, PathCommand[]> }
const hbFontCache = new Map<string, HbEntry | null>();

// Mirror of `glyph-helper.ts::parseSvgPath` — HarfBuzz's glyphToPath emits the
// same absolute M/L/Q/C/Z grammar the CoreText helper does (TrueType outlines
// are quadratic, so Q dominates; C handled defensively).
function parseSvgPath(d: string): PathCommand[] {
  if (d.length === 0) return [];
  const tokens = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: PathCommand[] = [];
  let i = 0;
  const num = (): number => Number(tokens[i++]);
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

function getHbEntry(fontPath: string): HbEntry | null {
  if (hbFontCache.has(fontPath)) return hbFontCache.get(fontPath)!;
  let entry: HbEntry | null = null;
  try {
    const data = readFileSync(fontPath);
    // `hb.Blob` wants an ArrayBuffer; a Node Buffer is a view onto a (possibly
    // larger, pooled) ArrayBuffer, so slice out exactly this file's bytes.
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const blob = new hb.Blob(ab);
    const face = new hb.Face(blob, 0);
    const font = new hb.Font(face);
    entry = { font: font as unknown as { glyphToPath(id: number): string }, pathCache: new Map() };
  } catch {
    entry = null; // unreadable / non-file path — caller falls back to normal shaping
  }
  hbFontCache.set(fontPath, entry);
  return entry;
}

/**
 * Shape `text` with HarfBuzz using the font at `fontPath`. Returns glyphs (with
 * outlines), GPOS positions, and per-glyph source clusters — the same shape the
 * `FontInstance.layout` consumers expect. Returns null when the font can't be
 * opened (caller keeps its existing shaping). Coordinates are font design units,
 * y-up (matching fontkit / the CoreText helper).
 */
export function harfbuzzShapeRun(fontPath: string, text: string): ShapeResult | null {
  const entry = getHbEntry(fontPath);
  if (entry == null) return null;
  const { font, pathCache } = entry;
  // harfbuzzjs frees the buffer's WASM memory automatically via a
  // FinalizationRegistry (no manual destroy/free); this only fires for the rare
  // divergent codepoints, so the per-call allocation is negligible.
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(font as unknown as hb.Font, buf);
  const infos = buf.getGlyphInfosAndPositions();
  const glyphs: ShapedGlyph[] = [];
  const positions: ShapeResult["positions"] = [];
  const clusters: number[] = [];
  for (const g of infos) {
    const gid = g.codepoint;
    let cmds = pathCache.get(gid);
    if (cmds == null) {
      cmds = parseSvgPath(font.glyphToPath(gid));
      pathCache.set(gid, cmds);
    }
    const srcCp = text.codePointAt(g.cluster);
    glyphs.push({
      id: gid,
      path: { commands: cmds },
      advanceWidth: g.xAdvance ?? 0,
      codePoints: srcCp != null ? [srcCp] : [],
    });
    positions.push({
      xAdvance: g.xAdvance ?? 0,
      yAdvance: g.yAdvance ?? 0,
      xOffset: g.xOffset ?? 0,
      yOffset: g.yOffset ?? 0,
    });
    clusters.push(g.cluster);
  }
  return { glyphs, positions, clusters };
}

/** A minimal FontInstance-shaped view used by the renderer. Declared loosely so
 *  this module doesn't depend on text-to-path's internal interface. */
interface ShapingFontView {
  layout(text: string, features?: string[]): {
    glyphs: ShapedGlyph[];
    positions: ShapeResult["positions"];
    clusters?: number[];
  };
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition: number;
  underlineThickness: number;
  availableFeatures?: string[];
  "OS/2"?: { yStrikeoutPosition?: number; yStrikeoutSize?: number };
  glyphForCodePoint(codePoint: number): { id: number; advanceWidth?: number; codePoints?: number[] };
  warmGlyphs?(codePoints: number[]): void;
  warmShapes?(texts: string[]): void;
}

/**
 * Wrap a base font instance so its `layout()` shapes via HarfBuzz (matching
 * Chrome) while every metric / coverage query delegates to the base instance
 * (which already loads the right file via the CoreText helper). Used ONLY for
 * the narrow divergent-codepoint runs; returns the base unchanged when the font
 * file can't be opened by HarfBuzz.
 */
export function makeHarfbuzzShapingInstance<T extends ShapingFontView>(base: T, fontPath: string): T {
  if (getHbEntry(fontPath) == null) return base;
  const proxy: ShapingFontView = {
    layout(text: string) {
      const res = harfbuzzShapeRun(fontPath, text);
      if (res == null) return base.layout(text); // defensive — shouldn't happen post-getHbEntry
      return res;
    },
    get unitsPerEm() { return base.unitsPerEm; },
    get ascent() { return base.ascent; },
    get descent() { return base.descent; },
    get underlinePosition() { return base.underlinePosition; },
    get underlineThickness() { return base.underlineThickness; },
    get availableFeatures() { return base.availableFeatures; },
    get "OS/2"() { return base["OS/2"]; },
    glyphForCodePoint(cp: number) { return base.glyphForCodePoint(cp); },
    warmGlyphs: base.warmGlyphs?.bind(base),
    warmShapes: base.warmShapes?.bind(base),
  };
  return proxy as T;
}
