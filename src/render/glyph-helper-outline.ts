/**
 * Native glyph response types and design-space outline conversion.
 *
 * This module is deliberately pure: it knows nothing about helper discovery,
 * process transport, font selection, or cache lifetime.
 */

export interface PathCommand { command: string; args: number[] }

/**
 * The concrete non-outline representation the platform renderer selected for
 * one glyph id. This is deliberately per-glyph rather than inferred from the
 * face's table directory: mixed faces such as Segoe UI Emoji expose ordinary
 * outlines and COLR paint from the same face.
 */
export type GlyphRasterRepresentation = "sbix" | "colr" | "bitmap" | "svg";

export function isGlyphRasterRepresentation(value: unknown): value is GlyphRasterRepresentation {
  return value === "sbix" || value === "colr" || value === "bitmap" || value === "svg";
}

export interface GlyphHelperGlyph {
  id: number;
  advanceWidth: number;
  path: { commands: PathCommand[] };
  /** Exact native glyph ink bounds in the helper's design-unit coordinate space. */
  bbox?: { minX: number; minY: number; maxX: number; maxY: number };
  codePoints?: number[];
  /** Exact native paint ownership for this selected glyph id, when the helper
   * can report it. Absent means "no per-glyph answer", not "the face has no
   * color tables"; older helper binaries remain wire-compatible. */
  rasterRepresentation?: GlyphRasterRepresentation;
}

export interface MetaResponse {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition?: number;
  underlineThickness?: number;
  strikeoutPosition?: number;
  strikeoutThickness?: number;
  /** Raw OS/2 sTypo metrics used by Blink's normalized em-height geometry. */
  typoAscender?: number;
  typoDescender?: number;
  /** False when the helper could not guarantee the face is the requested
   *  PostScript name — the by-name-only route, where the platform substitutes a
   *  default for an unknown name rather than failing. Absent from older helper
   *  binaries, so treat only an explicit `false` as a negative. */
  nameMatched?: boolean;
  /** DM-1880: CoreText's `kCTFontTraitBold` / `kCTFontTraitItalic` symbolic
   *  traits for the resolved face. macOS's synthetic-bold rule asks the TRAIT
   *  rather than a weight number (`mac/font_cache_mac.mm:424-427`), and the two
   *  disagree often enough that substituting a weight regressed a fixture.
   *  Absent from helper binaries predating the field. */
  traitBold?: boolean;
  traitItalic?: boolean;
  /** How the face was resolved: `nameMatchedInFile` | `firstFaceNoNameRequested`
   *  | `byNameVerified` | `byNameUnverified` | `systemUI`. Diagnostic. */
  resolution?: string;
  /** The PostScript name of the face actually opened. */
  postscriptName?: string;
  /** Native family name of the face actually opened. */
  familyName?: string;
  /** CoreText handle axes, including the current coordinate (macOS only). */
  ctAxes?: Array<{ tag: string; min: number; def: number; max: number; value: number }>;
  /** Physical SFNT paint tables reported by the selected native face. */
  supportedColorTables?: string[];
  /** OpenType GSUB feature tags exposed by the selected face. Native helpers
   *  predating this field are treated as reporting none. */
  availableFeatures?: string[];
}

export interface GlyphResponse {
  id: number;
  advance: number;
  bbox: { x: number; y: number; w: number; h: number };
  d: string;
  /** DM-2403: selected-glyph paint kind from the native renderer. Windows
   * transcribes Skia/DirectWrite's COLR -> SVG -> PNG decision. */
  rasterRepresentation?: GlyphRasterRepresentation;
}

// Parse the Swift helper's SVG path-data string into fontkit's command-array
// format. The helper emits exactly: `M x y`, `L x y`, `Q cx cy x y`,
// `C c1x c1y c2x c2y x y`, `Z` — space-separated, no relative variants.
export function parseSvgPath(d: string): PathCommand[] {
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

// Every helper path command is a run of (x, y) pairs — moveTo/lineTo carry one,
// quadraticCurveTo two, bezierCurveTo three, closePath none — so the y values
// are always the odd-indexed args.
function pathMinY(commands: PathCommand[]): number | null {
  let min: number | null = null;
  for (const c of commands) {
    for (let i = 1; i < c.args.length; i += 2) {
      if (min == null || c.args[i] < min) min = c.args[i];
    }
  }
  return min;
}

export function translateCommandsY(commands: PathCommand[], dy: number): PathCommand[] {
  if (dy === 0) return commands;
  return commands.map((c) => {
    if (c.args.length === 0) return c;
    const args = c.args.slice();
    for (let i = 1; i < args.length; i += 2) args[i] += dy;
    return { command: c.command, args };
  });
}

/** Glyph ids sampled to measure a face's outline offset. Low ids so every font
 *  has them; a spread so a few blank ones (`.notdef`, space) still leave inked
 *  samples to compare. */
export const OFFSET_PROBE_GLYPHS = [3, 4, 5, 6, 7, 8, 15, 20];

/**
 * DM-1831: the vertical offset between the outline CoreText hands us
 * (`CTFontCreatePathForGlyph`) and the box CoreText says the glyph occupies
 * (`CTFontGetBoundingRectsForGlyphs`). Chrome paints at the BOUNDING RECT, so
 * where the two disagree the raw outline lands in the wrong place.
 *
 * Apple Color Emoji is the one macOS face where they disagree: CoreText reports
 * every one of its glyphs 100 units (0.125 em at its 800 upem) BELOW the
 * outline it returns for that same glyph — unanimous across 102 outline glyphs,
 * and matching Chrome's painted output exactly (dx 0, dy -100.0, pixel-exact at
 * font-size 800, where one unit is one px). Ten ordinary faces (Helvetica,
 * Apple Symbols, Hiragino Sans, Times New Roman, Menlo, Zapf Dingbats, STIX Two
 * Math, Geeza Pro, Thonburi, Kohinoor Devanagari) report exactly 0 across 600
 * glyphs each. The visible symptom was a lone U+20E3 COMBINING ENCLOSING KEYCAP
 * — one of the few Apple Color Emoji glyphs that is a real outline rather than
 * an sbix bitmap, so it takes the glyph-path pipeline instead of the
 * raster-overlay one — painting its box ~4 px high at font-size 32.
 *
 * The offset is a property of the FACE, so it is measured once per font and
 * never per glyph, and only from a UNANIMOUS, MATERIAL reading. Both guards
 * earn their place: `pathMinY` is a control-point minimum while CoreText's rect
 * is a tight curve bound, so a face whose extrema sit off its control points
 * reports sub-unit noise rather than a real offset (PingFang SC scatters deltas
 * of 0 to -1 unit at 1000 upem). A genuine offset is two orders of magnitude
 * larger, so requiring agreement AND at least 1% of the em keeps that noise
 * from being read as signal.
 *
 * `probeUnitsPerEm` is the size the probe glyphs were requested at; the result
 * is scaled into the font's design-unit space.
 */
export function measureOutlineOffsetY(
  glyphs: GlyphResponse[], unitsPerEm: number, probeUnitsPerEm: number,
): number {
  const seen: number[] = [];
  for (const g of glyphs) {
    if (g == null || g.d.length === 0 || g.bbox == null) continue;
    const minY = pathMinY(parseSvgPath(g.d));
    if (minY == null) continue;
    seen.push(Math.round((g.bbox.y - minY) * unitsPerEm / probeUnitsPerEm));
  }
  if (seen.length === 0) return 0;
  const first = seen[0];
  if (!seen.every((v) => v === first)) return 0;
  return Math.abs(first) >= unitsPerEm * 0.01 ? first : 0;
}
