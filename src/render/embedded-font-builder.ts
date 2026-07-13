// DM-655: build custom standalone TTFs from extracted glyph outlines so the
// embedded-font render mode can emit `<text>` against any font Chrome paints
// with — webfonts, system fonts, variable-axis instances — not just CDN-
// fetched webfonts. Each tracked font becomes one `@font-face` whose `src:`
// is a `data:font/ttf;base64,…` URI containing JUST the glyphs the SVG uses,
// at their captured outlines and advances.
//
// Glyph addressing: every shaped glyph is assigned a sequential PUA codepoint
// (U+E000+). The `<text>` we emit contains the PUA stream, NOT the original
// codepoints — so the consumer browser performs zero shaping / kerning /
// ligature substitution and renders each glyph at its declared advance.
// fontkit already did the shaping at capture time, so this preserves
// contextual joining (Arabic init/medi/fina), ligatures (fi, ffi), and
// cluster reordering (Devanagari i-matra) without us having to ship any
// GSUB/GPOS rules in the custom font.
//
// Outline flavor (DM-1666): we emit TrueType `glyf` outlines, NOT CFF. This is
// load-bearing for fidelity, not a stylistic choice. System/webfont source
// glyphs routinely draw a letter as SEVERAL overlapping same-winding contours
// that rely on nonzero fill to union (SF Pro's bold "A" = left-leg + crossbar +
// right-leg, three overlapping contours). glyf is filled nonzero by every
// rasterizer, so the union is correct. The previous writer (opentype.js) can
// only emit CFF/`OTTO`, and Chrome rasterizes overlapping contours in an
// opentype.js CFF subset with EVEN-ODD fill — subtracting the overlap regions
// and punching holes at the joins (the "A" crossbar rendered with blue notches
// where it met the diagonals). Proven three ways: a 3-overlapping-rectangle CFF
// renders a textbook even-odd checkerboard; all four winding combinations of
// the "A" still hole; the same overlapping contours embedded as `glyf`
// (SFNS.ttf via @font-face) render solid. This also subsumes the old DM-1202
// "rare hollow glyph" note — that was the same even-odd behavior, just caught
// on one thin punctuation glyph instead of recognized as systematic.
//
// svg2ttf writes `glyf` from an SVG-font description and handles cubic→quadratic
// conversion (via cubic2quad) for CFF-source outlines. We build one SVG font per
// tracked instance from the shaped glyph outlines and hand it to svg2ttf.

// svg2ttf ships no type declarations (see svg2ttf.d.ts for the tiny surface).
import svg2ttf from "svg2ttf";
import { emboldenPathCommands } from "./embolden-outline.js";

/** A tracked glyph's outline (SVG path `d`, font units, y-up) + advance. */
interface EmbeddedGlyph {
  /** SVG path data in font units (y-up), ready to drop into an SVG-font `<glyph d=>`. */
  d: string;
  advanceWidth: number;
}

/**
 * One path command from fontkit. Mirrors fontkit's internal `Path.commands[]`
 * shape so callers can hand the raw fontkit output across without converting.
 *
 *   moveTo (x, y)
 *   lineTo (x, y)
 *   quadraticCurveTo (cx, cy, x, y)
 *   bezierCurveTo (c1x, c1y, c2x, c2y, x, y)
 *   closePath ()
 */
export interface PathCommand {
  command: string;
  args: number[];
}

interface BuilderEntry {
  /** CSS family name assigned at first registration (e.g. `dmf3`). Stable across calls. */
  cssFamily: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** Shaped-glyph-id → outline (built lazily as glyphs are seen). */
  glyphs: Map<number, EmbeddedGlyph>;
  /** Shaped-glyph-id → assigned PUA codepoint (U+E000+). */
  puaForGlyphId: Map<number, number>;
  /** Next available PUA codepoint for this entry. */
  nextPua: number;
  /**
   * Captured variant descriptors. Emitted on the `@font-face` rule so the
   * consumer browser matches the rule EXACTLY when the `<text>` carries
   * `font-style="italic"` / `font-weight="700"` — without these descriptors
   * the rule defaults to `font-style: normal; font-weight: 400` and Chromium
   * synthesizes faux italic / faux bold ON TOP of glyphs whose italic slant
   * (or bold weight) is already baked in by the variant we resolved. Result
   * pre-fix: double-italic (~2× slant) on `<i>` text against a non-bold
   * upright fallback (the Slashdot mobile `<i>` river-story abstract).
   */
  italic: boolean;
  weight: number;
}

const builderRegistry = new Map<string, BuilderEntry>();
let builderIdCounter = 0;

/** PUA-A block: U+E000..U+F8FF (6400 codepoints). Plenty for typical SVGs. */
const PUA_START = 0xE000;
const PUA_END = 0xF8FF;

/**
 * Reset per-composition state. Call alongside `clearEmbeddedFonts` at the
 * start of every `composeScrollSvg` / `elementTreeToSvg` invocation so
 * glyphs from a prior composition don't leak into the new one.
 */
export function clearEmbeddedFontBuilder(): void {
  builderRegistry.clear();
  builderIdCounter = 0;
}

/**
 * Record that a glyph is used by the current composition and return its
 * placement coordinates: which CSS family to reference and which PUA
 * codepoint to emit in the `<text>` content.
 *
 * Idempotent on (`instanceKey`, `glyphId`): repeated calls return the same
 * cssFamily + puaCodepoint, so the same glyph can be referenced many times
 * across the SVG and collapses to a single entry in the custom font.
 *
 * `instanceKey` must be stable per (font, axes-tuple). Two text runs that
 * resolve to "Inter Variable" at `wght=450 opsz=30` share an instance key;
 * a third run at `wght=540 opsz=24` gets its own.
 */
export function trackGlyphInEmbedFont(
  instanceKey: string,
  unitsPerEm: number,
  ascender: number,
  descender: number,
  glyphId: number,
  pathCommands: PathCommand[],
  advanceWidth: number,
  variant: { italic: boolean; weight: number; emboldenStrengthFU?: number } = { italic: false, weight: 400 },
): { cssFamily: string; puaCodepoint: number } | null {
  let entry = builderRegistry.get(instanceKey);
  if (entry == null) {
    entry = {
      cssFamily: `dmf${builderIdCounter++}`,
      unitsPerEm,
      ascender,
      descender,
      glyphs: new Map(),
      puaForGlyphId: new Map(),
      nextPua: PUA_START,
      italic: variant.italic,
      weight: variant.weight,
    };
    builderRegistry.set(instanceKey, entry);
  }
  const cached = entry.puaForGlyphId.get(glyphId);
  if (cached != null) return { cssFamily: entry.cssFamily, puaCodepoint: cached };

  if (entry.nextPua > PUA_END) {
    // Out of PUA-A slots. Caller falls through to paths-mode emission for
    // this glyph; the (rare) over-6400-glyph case keeps rendering, just
    // without the embedded-font fast path for the run that exceeded.
    return null;
  }
  const pua = entry.nextPua++;
  entry.puaForGlyphId.set(glyphId, pua);

  // DM-1693: when the resolved static face lacks the requested weight, Chrome
  // emboldens its outline algorithmically. Bake the same dilation into the
  // embedded glyph (the @font-face descriptor stays at the requested weight, so
  // the consumer browser synthesizes nothing on top). `emboldenPathCommands`
  // returns the input unchanged when the strength is 0 / absent.
  const cmds = variant.emboldenStrengthFU
    ? emboldenPathCommands(pathCommands, variant.emboldenStrengthFU)
    : pathCommands;
  entry.glyphs.set(glyphId, {
    d: pathCommandsToSvgPath(cmds),
    advanceWidth,
  });
  return { cssFamily: entry.cssFamily, puaCodepoint: pua };
}

/**
 * Serialize fontkit `PathCommand[]` (font units, y-up) into an SVG path `d`
 * string. Both the fontkit path space and the SVG-font glyph space are y-up
 * font units, so the coordinates pass through unchanged — svg2ttf lays them
 * straight into the `glyf` outline.
 */
function pathCommandsToSvgPath(pathCommands: PathCommand[]): string {
  const parts: string[] = [];
  for (const cmd of pathCommands) {
    const a = cmd.args;
    switch (cmd.command) {
      case "moveTo":           parts.push(`M${a[0]} ${a[1]}`); break;
      case "lineTo":           parts.push(`L${a[0]} ${a[1]}`); break;
      case "quadraticCurveTo": parts.push(`Q${a[0]} ${a[1]} ${a[2]} ${a[3]}`); break;
      case "bezierCurveTo":    parts.push(`C${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} ${a[5]}`); break;
      case "closePath":        parts.push("Z"); break;
      default: throw new Error(`embedded-font-builder: unknown glyph path command "${(cmd as { command: string }).command}"`);
    }
  }
  return parts.join("");
}

/**
 * Zero the OpenType `head` table's build timestamps so the serialized font is
 * byte-for-byte reproducible (DM-902). We pass `ts: 0` to svg2ttf so it doesn't
 * stamp `head.created` / `head.modified` with the wall-clock build time in the
 * first place, but its `head.checkSumAdjustment` and the head table's directory
 * checksum still summarize the whole font — so we zero all four fields
 * defensively here, keeping the `@font-face` `data:` URI identical run-to-run
 * (golden-SVG comparisons and reproducible builds depend on it).
 *
 * Walks the sfnt table directory to the `head` record, then zeroes the
 * directory's per-table `head` checksum, `head.checkSumAdjustment`, and
 * `head.created` / `head.modified`. Browsers / FreeType / CoreText / DirectWrite
 * don't validate either checksum for rendering, so zeroing is safe. Mutates
 * `bytes` in place.
 */
function determinizeFontTimestamps(bytes: Buffer): void {
  if (bytes.length < 12) return;
  const numTables = bytes.readUInt16BE(4);
  const DIR_START = 12;
  const REC = 16;
  for (let i = 0; i < numTables; i++) {
    const rec = DIR_START + i * REC;
    if (rec + REC > bytes.length) break;
    if (bytes.toString("ascii", rec, rec + 4) !== "head") continue;
    const headOff = bytes.readUInt32BE(rec + 8);
    // head layout: …, checkSumAdjustment@8, …, created@20 (8), modified@28 (8).
    if (headOff + 36 > bytes.length) return;
    bytes.writeUInt32BE(0, rec + 4);            // directory per-table head checksum
    bytes.writeUInt32BE(0, headOff + 8);        // head.checkSumAdjustment
    bytes.fill(0, headOff + 20, headOff + 36);  // head.created + head.modified
    return;
  }
}

/**
 * Build one `glyf`-flavored TrueType font from a tracked instance's glyphs by
 * describing it as an SVG font and handing it to svg2ttf.
 *
 * The SVG-font glyph space is font units, y-up — identical to the fontkit path
 * space the `d` strings came from — so coordinates pass through unchanged.
 * svg2ttf's `<missing-glyph>` becomes gid 0 (.notdef): an empty, zero-width
 * invisible glyph, so any codepoint the consumer queries that we DIDN'T embed
 * (shouldn't happen — we emit only registered PUA codepoints) renders blank
 * rather than tofu. Each `<glyph>` is addressed by its PUA codepoint; svg2ttf
 * builds the `cmap` from those, so the emitted `<text>` PUA stream maps to the
 * right outlines with zero shaping.
 */
function buildGlyfFontForEntry(entry: BuilderEntry): Buffer {
  const glyphEls: string[] = [];
  for (const [glyphId, g] of entry.glyphs) {
    // PUA codepoints are pure hex digits; `d` carries only path grammar
    // (M/L/Q/C/Z, numbers, spaces) — neither needs XML-escaping.
    const pua = entry.puaForGlyphId.get(glyphId)!;
    glyphEls.push(`<glyph unicode="&#x${pua.toString(16)};" horiz-adv-x="${Math.round(g.advanceWidth)}" d="${g.d}"/>`);
  }
  const svgFont =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg"><defs>` +
    `<font id="${entry.cssFamily}" horiz-adv-x="${Math.round(entry.unitsPerEm / 2)}">` +
    `<font-face font-family="${entry.cssFamily}" units-per-em="${entry.unitsPerEm}"` +
    ` ascent="${Math.round(entry.ascender)}" descent="${Math.round(entry.descender)}"/>` +
    `<missing-glyph horiz-adv-x="${Math.round(entry.unitsPerEm / 2)}"/>` +
    glyphEls.join("") +
    `</font></defs></svg>`;
  return Buffer.from(svg2ttf(svgFont, { ts: 0 }).buffer);
}

/**
 * Serialise every tracked custom font as `@font-face` rules with embedded
 * TTF bytes. Returns the joined CSS ready to drop into the SVG's `<style>`
 * block. Empty string when no glyphs were registered.
 */
export function getBuiltEmbeddedFontFaceCss(): string {
  if (builderRegistry.size === 0) return "";
  const rules: string[] = [];
  for (const entry of builderRegistry.values()) {
    const ttfBytes = buildGlyfFontForEntry(entry);
    determinizeFontTimestamps(ttfBytes); // DM-902: strip the build-time stamp
    const b64 = ttfBytes.toString("base64");
    // Emit explicit font-style / font-weight descriptors so the consumer
    // browser matches this @font-face EXACTLY when the `<text>` element
    // requests italic / bold. Without these the rule defaults to
    // `font-style: normal; font-weight: 400` and Chromium synthesizes faux
    // italic / faux bold on top of glyphs whose italic / bold shape is
    // already baked into the custom TTF.
    const styleDesc = entry.italic ? "italic" : "normal";
    rules.push(`@font-face { font-family: "${entry.cssFamily}"; font-style: ${styleDesc}; font-weight: ${entry.weight}; src: url("data:font/ttf;base64,${b64}"); }`);
  }
  return rules.join("\n");
}

/** Test-only: inspect builder state for assertions. */
export function _builderRegistrySize(): number { return builderRegistry.size; }
export function _builderGlyphsFor(instanceKey: string): number {
  return builderRegistry.get(instanceKey)?.glyphs.size ?? 0;
}
