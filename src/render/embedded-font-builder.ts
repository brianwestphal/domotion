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

// opentype.js ships no type declarations; declare the minimal surface we
// use so callers stay strict-typed at the boundary.
import opentype from "opentype.js";

interface OpenTypeGlyph {
  name: string;
  unicode?: number;
  advanceWidth: number;
}
interface OpenTypePath {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  curveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  close(): void;
}
interface OpenTypeNamespace {
  Font: new (opts: {
    familyName: string;
    styleName: string;
    unitsPerEm: number;
    ascender: number;
    descender: number;
    glyphs: OpenTypeGlyph[];
  }) => { toArrayBuffer(): ArrayBuffer };
  Glyph: new (opts: { name: string; unicode?: number; advanceWidth: number; path: OpenTypePath }) => OpenTypeGlyph;
  Path: new () => OpenTypePath;
}
const ot = opentype as unknown as OpenTypeNamespace;

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
  /** Shaped-glyph-id → opentype.js Glyph (built lazily as glyphs are seen). */
  glyphs: Map<number, OpenTypeGlyph>;
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
  variant: { italic: boolean; weight: number } = { italic: false, weight: 400 },
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

  const otPath = new ot.Path();
  for (const cmd of pathCommands) {
    switch (cmd.command) {
      case "moveTo":           otPath.moveTo(cmd.args[0], cmd.args[1]); break;
      case "lineTo":           otPath.lineTo(cmd.args[0], cmd.args[1]); break;
      case "quadraticCurveTo": otPath.quadraticCurveTo(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3]); break;
      case "bezierCurveTo":    otPath.curveTo(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3], cmd.args[4], cmd.args[5]); break;
      case "closePath":        otPath.close(); break;
    }
  }
  entry.glyphs.set(glyphId, new ot.Glyph({
    name: `g${glyphId}`,
    unicode: pua,
    advanceWidth,
    path: otPath,
  }));
  return { cssFamily: entry.cssFamily, puaCodepoint: pua };
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
    // Glyph 0 must be .notdef per OpenType spec — opentype.js enforces this
    // by adding the first glyph as .notdef. Provide an empty .notdef so any
    // codepoint the consumer might query that we DIDN'T embed (shouldn't
    // happen in practice since we emit only PUA codepoints we registered)
    // renders as a zero-width invisible glyph rather than tofu.
    const notdef = new ot.Glyph({
      name: ".notdef",
      unicode: 0,
      advanceWidth: Math.round(entry.unitsPerEm / 2),
      path: new ot.Path(),
    });
    const allGlyphs: OpenTypeGlyph[] = [notdef, ...entry.glyphs.values()];
    const font = new ot.Font({
      familyName: entry.cssFamily,
      styleName: "Regular",
      unitsPerEm: entry.unitsPerEm,
      ascender: entry.ascender,
      descender: entry.descender,
      glyphs: allGlyphs,
    });
    const ttfBytes = Buffer.from(font.toArrayBuffer());
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
