/**
 * Text-to-Path Converter
 *
 * Uses fontkit to convert text strings into SVG <path> outlines using
 * the actual macOS system fonts. Glyphs are deduplicated using SVG
 * <defs>/<use> — each unique glyph shape is defined once and referenced
 * everywhere it appears.
 */

import * as fontkit from "fontkit";

interface FontInstance {
  layout(text: string): {
    glyphs: Array<{ id: number; path: { commands: Array<{ command: string; args: number[] }> }; advanceWidth: number }>;
    positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  };
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition: number;
  underlineThickness: number;
  "OS/2"?: { yStrikeoutPosition?: number; yStrikeoutSize?: number };
}

const fontInstanceCache = new Map<string, FontInstance>();

// Webfont registry. Populated per capture by `discoverAndRegisterWebfonts`
// in capture.ts after the page's `document.fonts.ready` resolves. Keys are
// lower-cased family names (matching `resolveFontKey`'s normalization). Each
// family can have multiple registered variants (different weights / italic).
//
// Resolution policy: when the author's font-family stack matches a registered
// family, we pick the variant whose (weight, style) is closest to the request.
// This sidesteps the system-font fallback in `getFontInstance` entirely —
// webfont glyphs come from the loaded buffer, not from disk.
interface WebfontVariant { weight: number; italic: boolean; font: FontInstance }
const webfontRegistry = new Map<string, WebfontVariant[]>();

/**
 * Open a webfont buffer with fontkit and register it under the given family
 * name (case-insensitive). `weight` is a CSS numeric weight (100-900); 400
 * when omitted. `style` is "normal" / "italic" / "oblique"; treated as italic
 * for any non-normal value.
 *
 * Buffers must be decompressed already — fontkit's `create()` reads TTF/OTF
 * directly. WOFF2/WOFF bytes are decompressed in `loadWebfont()` (capture.ts)
 * before they reach this function.
 */
export function registerWebfont(family: string, weight: number, style: string, buffer: Buffer): void {
  const key = family.toLowerCase().replace(/^["']|["']$/g, "");
  let font: FontInstance;
  try {
    font = fontkit.create(buffer) as any;
  } catch {
    return; // unparseable — silently skip; capture-side warning happens elsewhere
  }
  const italic = style != null && style !== "" && style.toLowerCase() !== "normal";
  const list = webfontRegistry.get(key) ?? [];
  list.push({ weight, italic, font });
  webfontRegistry.set(key, list);
}

/** Drop all registered webfonts. Call at the start of a fresh capture run. */
export function clearWebfonts(): void {
  webfontRegistry.clear();
}

/**
 * Pick the closest matching registered variant for the given family +
 * weight/style. Used internally by `getFontInstance` for `webfont:<name>`
 * keys; italic match dominates the score so italic+regular beats
 * upright+italic-mismatch.
 */
function pickWebfontVariant(family: string, weight: number, slant: number): FontInstance | null {
  const variants = webfontRegistry.get(family);
  if (variants == null || variants.length === 0) return null;
  const wantItalic = slant !== 0;
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    const styleMismatch = v.italic === wantItalic ? 0 : 1000;
    const score = styleMismatch + Math.abs(v.weight - weight);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  return best?.font ?? null;
}

/**
 * Italic slant for SF Pro's `slnt` variation axis. SF Pro supports slnt ∈
 * roughly [-10, 0] and exposes no separate italic family, so we drive the
 * axis directly when CSS font-style is italic/oblique. Matches Chrome's
 * synthesis of italic from the variable font. Used as a cache-key component
 * so italic and upright glyphs dedupe separately. See SK-1105.
 */
const ITALIC_SLNT = -9.99;
function slantForStyle(style: string | undefined): number {
  if (style == null) return 0;
  const s = style.toLowerCase();
  return (s === "italic" || s.startsWith("oblique")) ? ITALIC_SLNT : 0;
}

// macOS system font paths. TTC collections require picking a sub-font by
// postscript name — fontkit returns a TTCFont wrapper for .ttc files and
// .getFont(name) extracts the member.
interface FontPath { path: string; postscriptName?: string }
const FONT_PATHS: Record<string, FontPath> = {
  "sf-pro":          { path: "/System/Library/Fonts/SFNS.ttf" },
  // SF Pro ships its italic as a sibling file, not as a variable `slnt` axis
  // on SFNS.ttf — so for CSS font-style:italic / oblique we switch to this
  // font instead of trying to drive a nonexistent axis. See SK-1105.
  "sf-pro-italic":   { path: "/System/Library/Fonts/SFNSItalic.ttf" },
  "sf-mono":         { path: "/System/Library/Fonts/SFNSMono.ttf" },
  "sf-mono-italic":  { path: "/System/Library/Fonts/SFNSMonoItalic.ttf" },
  "sf-arabic":       { path: "/System/Library/Fonts/SFArabic.ttf" },
  "sf-hebrew":       { path: "/System/Library/Fonts/SFHebrew.ttf" },
  "cjk":             { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", postscriptName: "HiraginoSansGB-W3" },
  "thai":            { path: "/System/Library/Fonts/ThonburiUI.ttc", postscriptName: ".ThonburiUI-Regular" },
  "devanagari":      { path: "/System/Library/Fonts/Kohinoor.ttc", postscriptName: "KohinoorDevanagari-Regular" },
  "symbols":         { path: "/System/Library/Fonts/Apple Symbols.ttf" },
  // Generic serif (font-family: serif / ui-serif, "Times New Roman", "Georgia").
  "times":           { path: "/System/Library/Fonts/Supplemental/Times New Roman.ttf" },
  "times-italic":    { path: "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf" },
  "georgia":         { path: "/System/Library/Fonts/Supplemental/Georgia.ttf" },
  "georgia-italic":  { path: "/System/Library/Fonts/Supplemental/Georgia Italic.ttf" },
  // Generic cursive — Chrome on macOS resolves `cursive` to Snell Roundhand.
  "snell":           { path: "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc", postscriptName: "SnellRoundhand" },
};

/**
 * Map a Unicode code point to a fallback font key when the primary SF Pro
 * font lacks a glyph for it. Returns null when the primary font is expected
 * to have the glyph (Latin, basic punctuation, etc.).
 */
export function fallbackFontKey(codepoint: number): string | null {
  // Hebrew (U+0590..05FF) + presentation forms (U+FB1D..FB4F).
  if ((codepoint >= 0x0590 && codepoint <= 0x05FF)
    || (codepoint >= 0xFB1D && codepoint <= 0xFB4F)) {
    return "sf-hebrew";
  }
  // Arabic core block + presentation forms A and B.
  if ((codepoint >= 0x0600 && codepoint <= 0x06FF)
    || (codepoint >= 0xFB50 && codepoint <= 0xFDFF)
    || (codepoint >= 0xFE70 && codepoint <= 0xFEFF)) {
    return "sf-arabic";
  }
  // Devanagari (U+0900..097F).
  if (codepoint >= 0x0900 && codepoint <= 0x097F) return "devanagari";
  // Thai (U+0E00..0E7F).
  if (codepoint >= 0x0E00 && codepoint <= 0x0E7F) return "thai";
  // CJK: Unified Ideographs + Ext A, Hiragana, Katakana (+ phonetic exts),
  // Hangul Syllables + Jamo, CJK Symbols & Punctuation.
  if ((codepoint >= 0x3000 && codepoint <= 0x303F)
    || (codepoint >= 0x3040 && codepoint <= 0x309F)
    || (codepoint >= 0x30A0 && codepoint <= 0x30FF)
    || (codepoint >= 0x31F0 && codepoint <= 0x31FF)
    || (codepoint >= 0x3400 && codepoint <= 0x4DBF)
    || (codepoint >= 0x4E00 && codepoint <= 0x9FFF)
    || (codepoint >= 0xAC00 && codepoint <= 0xD7AF)
    || (codepoint >= 0x1100 && codepoint <= 0x11FF)
    || (codepoint >= 0xF900 && codepoint <= 0xFAFF)) {
    return "cjk";
  }
  // Misc Symbols, Dingbats, Geometric Shapes, Arrows — common monochrome
  // symbol blocks covered by Apple Symbols. Color-emoji blocks (1F300+)
  // are included too, though fontkit will skip glyphs without outlines.
  // Letterlike Symbols (ℝ ℕ ℤ ℂ ℚ etc., 2100-214F) and Mathematical
  // Alphanumeric Symbols (𝒜 𝒷 𝒞 𝕊 etc., 1D400-1D7FF) are also covered by
  // Apple Symbols; without these the math test renders them as .notdef boxes.
  if ((codepoint >= 0x2100 && codepoint <= 0x214F)
    || (codepoint >= 0x2190 && codepoint <= 0x21FF)
    || (codepoint >= 0x2200 && codepoint <= 0x22FF)
    || (codepoint >= 0x25A0 && codepoint <= 0x25FF)
    || (codepoint >= 0x2600 && codepoint <= 0x26FF)
    || (codepoint >= 0x2700 && codepoint <= 0x27BF)
    || (codepoint >= 0x1D400 && codepoint <= 0x1D7FF)
    || (codepoint >= 0x1F300 && codepoint <= 0x1F5FF)
    || (codepoint >= 0x1F680 && codepoint <= 0x1F6FF)) {
    return "symbols";
  }
  return null;
}

function getFontInstance(key: string, weight: number, fontSize: number, slant: number = 0): FontInstance | null {
  // Webfont keys (`webfont:<lowercased family>`) resolve through the runtime
  // registry rather than the on-disk FONT_PATHS table.
  if (key.startsWith("webfont:")) {
    return pickWebfontVariant(key.slice("webfont:".length), weight, slant);
  }
  // SF Pro / SF Mono ship their italics as separate .ttf files rather than
  // exposing a `slnt` variable-axis on the upright file, so route italic
  // requests at the spec level instead of trying to drive an axis. Fallback
  // fonts (sf-arabic / cjk / thai / devanagari / symbols) have no italic
  // sibling — the slnt argument is quietly ignored there.
  let effectiveKey = key;
  if (slant !== 0) {
    if (key === "sf-pro") effectiveKey = "sf-pro-italic";
    else if (key === "sf-mono") effectiveKey = "sf-mono-italic";
    else if (key === "times") effectiveKey = "times-italic";
    else if (key === "georgia") effectiveKey = "georgia-italic";
  }
  const cacheKey = `${effectiveKey}-${weight}-${fontSize}-${slant}`;
  if (fontInstanceCache.has(cacheKey)) return fontInstanceCache.get(cacheKey)!;

  const spec = FONT_PATHS[effectiveKey];
  if (spec == null) return null;

  try {
    const opened = fontkit.openSync(spec.path) as any;
    // TTC collections expose .fonts + .getFont(postscriptName). Pick the
    // requested member; fall back to the first sub-font if the requested
    // one is missing (defensive against OS font updates renaming members).
    let font = opened;
    if (opened.fonts != null && Array.isArray(opened.fonts)) {
      if (spec.postscriptName != null && opened.getFont != null) {
        font = opened.getFont(spec.postscriptName) ?? opened.fonts[0];
      } else {
        font = opened.fonts[0];
      }
    }
    // Some fonts (e.g. Hiragino Sans GB) expose getVariation but lack the
    // required fvar/gvar/CFF2 tables, so actually calling it throws. Guard
    // with a per-call try so we fall back to the non-variation font rather
    // than failing the whole fallback chain.
    let instance: FontInstance = font;
    if (font.variationAxes != null && Object.keys(font.variationAxes).length > 0 && font.getVariation != null) {
      const axes: Record<string, number> = { wght: weight };
      if (font.variationAxes?.opsz != null) axes.opsz = fontSize;
      // SF Pro's slnt axis drives italic/oblique synthesis; harmless when a
      // font doesn't expose it (the `slnt` key is just ignored).
      if (slant !== 0 && font.variationAxes?.slnt != null) axes.slnt = slant;
      try { instance = font.getVariation(axes); } catch { instance = font; }
    }
    fontInstanceCache.set(cacheKey, instance);
    return instance;
  } catch {
    return null;
  }
}

export function resolveFontKey(fontFamily: string): string {
  // Walk the comma-separated stack — Chrome's getComputedStyle returns the
  // unresolved list (e.g. `"DoesNotExist", Georgia, "Times New Roman", serif`)
  // not the matched font. Pick the first name we recognize, mirroring how
  // Chrome falls through the stack until something loads.
  const names = fontFamily.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase());
  for (const name of names) {
    if (name === "" || name === "doesnotexist") continue;
    // Registered webfonts win — the page declared this family AND we hold
    // its bytes. `getFontInstance` dispatches the webfont: prefix to the
    // runtime registry instead of the on-disk FONT_PATHS table.
    if (webfontRegistry.has(name)) return `webfont:${name}`;
    if (name.includes("mono") || name.includes("menlo") || name.includes("courier") || name.includes("consolas")) return "sf-mono";
    if (name === "serif" || name === "ui-serif" || name === "times" || name === "times new roman") return "times";
    if (name === "georgia") return "georgia";
    if (name === "cursive" || name === "snell roundhand" || name === "brush script mt" || name === "apple chancery") return "snell";
    // sans-serif / system-ui / ui-sans-serif / ui-rounded / fantasy / math /
    // emoji / fangsong / any explicit sans family → SF Pro. Math / emoji
    // glyphs that SF Pro lacks fall through to per-codepoint fallback.
    if (name === "sans-serif" || name === "system-ui" || name === "ui-sans-serif"
      || name === "ui-rounded" || name === "fantasy" || name === "math"
      || name === "emoji" || name === "fangsong"
      || name === "helvetica" || name === "arial" || name === "sf pro" || name === "-apple-system") return "sf-pro";
  }
  return "sf-pro";
}

function resolveFont(fontFamily: string, fontWeight: number, fontSize: number, slant: number = 0): FontInstance | null {
  return getFontInstance(resolveFontKey(fontFamily), fontWeight, fontSize, slant);
}

// ── Glyph Registry (for <defs>/<use> deduplication) ──

/** Stores unique glyph path definitions. Uses short sequential IDs for compact output. */
const glyphDefs = new Map<string, string>();
const glyphKeyToId = new Map<string, string>();
let glyphIdCounter = 0;

function ensureGlyphDef(
  fontKey: string, weight: number, fontSize: number, slant: number,
  glyphId: number, commands: Array<{ command: string; args: number[] }>,
): string {
  const key = `${fontKey}-${weight}-${fontSize}-${slant}-${glyphId}`;
  const existing = glyphKeyToId.get(key);
  if (existing != null) return existing;

  // Short sequential ID for compact output
  const defId = `g${glyphIdCounter++}`;
  glyphKeyToId.set(key, defId);

  // Convert glyph commands to SVG path data at font-unit scale.
  // Use integer coordinates (font units are integers) and shorthand commands.
  let d = "";
  let prevX = 0, prevY = 0;
  for (const cmd of commands) {
    const a = cmd.args;
    switch (cmd.command) {
      case "moveTo": d += `M${a[0]} ${a[1]}`; prevX = a[0]; prevY = a[1]; break;
      case "lineTo":
        if (a[1] === prevY) { d += `H${a[0]}`; }
        else if (a[0] === prevX) { d += `V${a[1]}`; }
        else { d += `L${a[0]} ${a[1]}`; }
        prevX = a[0]; prevY = a[1];
        break;
      case "quadraticCurveTo": d += `Q${a[0]} ${a[1]} ${a[2]} ${a[3]}`; prevX = a[2]; prevY = a[3]; break;
      case "bezierCurveTo": d += `C${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} ${a[5]}`; prevX = a[4]; prevY = a[5]; break;
      case "closePath": d += "Z"; break;
    }
  }

  glyphDefs.set(defId, `<path id="${defId}" d="${d}"/>`);
  return defId;
}

/**
 * Get all glyph <defs> accumulated so far. Call this once when building the final SVG.
 * Returns SVG markup to place inside a <defs> block.
 */
export function getGlyphDefs(): string {
  return [...glyphDefs.values()].join("");
}

/** Clear the glyph registry (call between independent SVG generations). */
export function clearGlyphDefs(): void {
  glyphDefs.clear();
  glyphKeyToId.clear();
  glyphIdCounter = 0;
}

// ── Text Rendering ──

export interface TextPathResult {
  /** SVG markup: <use> references for each glyph */
  markup: string;
  /** Actual rendered width in CSS pixels */
  width: number;
}

/**
 * Convert a text string to SVG markup using <use> references to glyph defs.
 *
 * Positioning modes (in order of preference):
 *   1. xOffsets (per-char x in CSS pixels, relative to text origin) — used
 *      when the capture layer measured each character's actual rect.left.
 *      This eliminates per-character drift because glyph placement matches
 *      exactly what the browser painted (including kerning, letter-spacing,
 *      optical-size effects, etc.).
 *   2. targetWidth — scales native fontkit advances uniformly so the total
 *      width matches Chrome. Good for single-line text where per-char drift
 *      is small. Kept as a fallback for inputs/textarea values (no per-char
 *      rect data) and legacy callers.
 *   3. Native fontkit advances — if neither is provided.
 */
export function textToPathMarkup(
  text: string,
  fontSize: number,
  fontFamily: string,
  fontWeight: string,
  targetWidth?: number,
  /** CSS-pixel x offsets per visible char, relative to the text origin. */
  xOffsets?: number[],
  /** CSS font-style ('italic' / 'oblique' / 'normal'). Drives SF Pro's slnt. */
  fontStyle?: string,
): TextPathResult | null {
  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant);
  if (primaryFont == null) return null;

  const primaryFontKey = resolveFontKey(fontFamily);

  // Split the text into runs by font. Code points that primary lacks (Arabic,
  // CJK, …) get routed to a fallback font. Each run keeps its order; this
  // does NOT do BiDi reordering — that's tracked separately. startIdx/endIdx
  // are UTF-16 code-unit positions into `text` so the multi-font path can
  // slice xOffsets per run (SK-1255).
  interface Run { fontKey: string; font: FontInstance; text: string; startIdx: number; endIdx: number }
  const runs: Run[] = [];
  {
    let curKey = primaryFontKey;
    let curText = "";
    let curStart = 0;
    let i = 0;
    while (i < text.length) {
      const cp = text.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const fbKey = fallbackFontKey(cp);
      // `fallbackFontKey` routes whole Unicode blocks (arrows, math operators,
      // dingbats…) to Apple Symbols, but SF Pro itself has many of those
      // glyphs and Apple Symbols's versions are visibly narrower. Only fall
      // back when the primary font actually lacks the glyph (gid 0 = .notdef).
      let useKey = fbKey ?? primaryFontKey;
      if (fbKey != null && (primaryFont as any).glyphForCodePoint(cp).id !== 0) {
        useKey = primaryFontKey;
      }
      if (useKey !== curKey && curText.length > 0) {
        const f = getFontInstance(curKey, weight, fontSize, slant);
        if (f != null) runs.push({ fontKey: curKey, font: f, text: curText, startIdx: curStart, endIdx: i });
        curText = "";
        curStart = i;
      }
      curKey = useKey;
      curText += ch;
      i += ch.length;
    }
    if (curText.length > 0) {
      const f = getFontInstance(curKey, weight, fontSize, slant) ?? primaryFont;
      runs.push({ fontKey: curKey === primaryFontKey ? primaryFontKey : (f === primaryFont ? primaryFontKey : curKey), font: f, text: curText, startIdx: curStart, endIdx: text.length });
    }
  }
  // Single-run, primary-font path keeps the existing fast path with xOffsets
  // support and per-char fidelity. Multi-run path falls back to native advances.
  if (runs.length === 1 && runs[0].fontKey === primaryFontKey) {
    return singleFontMarkup(runs[0].font, runs[0].fontKey, runs[0].text, weight, fontSize, slant, targetWidth, xOffsets);
  }

  // Mixed-font content with captured per-char xOffsets. Latin/primary runs
  // anchor each glyph at its captured x to preserve subpixel positioning
  // (SK-1234). Fallback-font runs (Arabic, Devanagari, Thai, …) are shaped
  // as a unit via font.layout(runText) so contextual joining (init/medi/fina),
  // cluster reordering (Devanagari i-matra), and ligature substitution (क्ष)
  // survive — fontkit's shaping for these scripts agrees with Chromium's
  // HarfBuzz to within ~1px (SK-1237 investigation), so anchoring the run at
  // its visual-leftmost xOffset and laying out with native cumulative
  // advances produces the right glyphs at the right positions.
  const hasMultipleFontRuns = runs.length > 1;
  if (hasMultipleFontRuns && xOffsets != null && xOffsets.length === text.length) {
    const groups: string[] = [];
    let rightEdge = 0;
    for (const run of runs) {
      const runScale = fontSize / run.font.unitsPerEm;
      const sc = Number(runScale.toFixed(5));

      if (run.fontKey === primaryFontKey) {
        // Primary-font run inside mixed line — keep SK-1234 per-char anchoring.
        let i = run.startIdx;
        while (i < run.endIdx) {
          const cp = text.codePointAt(i)!;
          const ch = String.fromCodePoint(cp);
          const layout = run.font.layout(ch);
          const uses: string[] = [];
          for (const g of layout.glyphs) {
            if (g.path.commands.length > 0) {
              const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, g.id, g.path.commands);
              uses.push(`<use href="#${defId}" x="0" y="0"/>`);
            }
          }
          if (uses.length > 0) {
            const cssX = Number(xOffsets[i].toFixed(3));
            groups.push(`<g transform="translate(${cssX},0) scale(${sc},${-sc})">${uses.join("")}</g>`);
            if (cssX > rightEdge) rightEdge = cssX;
          }
          i += ch.length;
        }
      } else {
        // Fallback-font run — shape the whole run together. Anchor at the
        // visual-leftmost captured x: for LTR that's xOffsets[startIdx], for
        // RTL that's xOffsets[endIdx-1] (last logical char paints leftmost).
        // Math.min covers both directions and any embedded BiDi.
        let runMinX = Infinity;
        for (let i = run.startIdx; i < run.endIdx; i++) {
          if (xOffsets[i] < runMinX) runMinX = xOffsets[i];
        }
        const layout = run.font.layout(run.text);
        const uses: string[] = [];
        let runFontUnits = 0;
        for (let gi = 0; gi < layout.glyphs.length; gi++) {
          const glyph = layout.glyphs[gi];
          const pos = layout.positions[gi];
          if (glyph.path.commands.length > 0) {
            const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, glyph.id, glyph.path.commands);
            const tx = runFontUnits + pos.xOffset;
            const ty = -pos.yOffset;
            uses.push(`<use href="#${defId}" x="${r(tx)}" y="${r(ty)}"/>`);
          }
          runFontUnits += pos.xAdvance;
        }
        if (uses.length > 0) {
          const cssX = Number(runMinX.toFixed(3));
          groups.push(`<g transform="translate(${cssX},0) scale(${sc},${-sc})">${uses.join("")}</g>`);
          const runRight = runMinX + runFontUnits * runScale;
          if (runRight > rightEdge) rightEdge = runRight;
        }
      }
    }
    return { markup: groups.join(""), width: rightEdge };
  }

  // Multi-font path: emit one <g scale> per run, each at its accumulated CSS-x.
  const groups: string[] = [];
  let xCss = 0;
  for (const run of runs) {
    const runScale = fontSize / run.font.unitsPerEm;
    const layout = run.font.layout(run.text);
    const uses: string[] = [];
    let runX = 0;
    for (let i = 0; i < layout.glyphs.length; i++) {
      const glyph = layout.glyphs[i];
      const pos = layout.positions[i];
      if (glyph.path.commands.length > 0) {
        const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, glyph.id, glyph.path.commands);
        const tx = runX + pos.xOffset;
        const ty = -pos.yOffset;
        uses.push(`<use href="#${defId}" x="${r(tx)}" y="${r(ty)}"/>`);
      }
      runX += pos.xAdvance;
    }
    if (uses.length > 0) {
      const sc = Number(runScale.toFixed(5));
      groups.push(`<g transform="translate(${r(xCss)},0) scale(${sc},${-sc})">${uses.join("")}</g>`);
    }
    xCss += runX * runScale;
  }
  return {
    markup: groups.length > 0 ? groups.join("") : "",
    width: xCss,
  };
}

/** Original single-font path (unchanged behavior — preserves xOffsets / targetWidth). */
function singleFontMarkup(
  font: FontInstance,
  fontKey: string,
  text: string,
  weight: number,
  fontSize: number,
  slant: number,
  targetWidth?: number,
  xOffsets?: number[],
): TextPathResult {
  const scale = fontSize / font.unitsPerEm;
  const run = font.layout(text);
  let totalAdvance = 0;
  for (const pos of run.positions) totalAdvance += pos.xAdvance;
  const nativeWidth = totalAdvance * scale;
  const xScale = (targetWidth != null && targetWidth > 0 && nativeWidth > 0)
    ? targetWidth / nativeWidth : 1;
  const usePerChar = xOffsets != null && xOffsets.length === run.glyphs.length;
  const sc = Number(scale.toFixed(5));
  const uses: string[] = [];
  let x = 0;
  for (let i = 0; i < run.glyphs.length; i++) {
    const glyph = run.glyphs[i];
    const pos = run.positions[i];
    if (glyph.path.commands.length > 0) {
      const defId = ensureGlyphDef(fontKey, weight, fontSize, slant, glyph.id, glyph.path.commands);
      let tx: number;
      if (usePerChar) {
        // Use the fractional CSS x straight from getBoundingClientRect — do
        // NOT round to integer pixels (SK-1234). Chromium uses subpixel
        // positioning (positions can be at any fraction like 24.7188px),
        // and rounding accumulates drift across a line of text — a 43-char
        // body line averages ~10px of cumulative drift just from rounding.
        // SVG honors fractional coordinates natively; rasterization is the
        // SVG renderer's concern. Convert CSS pixels → font units by
        // dividing by `scale`. pos.xOffset (the font's per-glyph subpixel
        // offset, in font units) is added in font-unit space.
        tx = xOffsets![i] / scale + pos.xOffset;
      } else {
        tx = (x + pos.xOffset) * xScale;
      }
      const ty = -pos.yOffset;
      uses.push(`<use href="#${defId}" x="${r(tx)}" y="${r(ty)}"/>`);
    }
    x += pos.xAdvance;
  }
  return {
    markup: uses.length > 0 ? `<g transform="scale(${sc},${-sc})">${uses.join("")}</g>` : "",
    width: usePerChar ? (xOffsets![xOffsets!.length - 1] + nativeWidth / run.glyphs.length) : (targetWidth ?? nativeWidth),
  };
}

/**
 * Render text as SVG markup using path outlines with <defs>/<use> deduplication.
 * Returns a <g> element containing <use> references, positioned at (x, y) top.
 */
export function renderTextAsPath(
  text: string,
  x: number,
  y: number,
  fontSize: number,
  fontFamily: string,
  fontWeight: string,
  fill: string,
  _clipPath?: string,
  /** Chrome's measured text width — used to scale glyph positions for accurate layout */
  targetWidth?: number,
  /** Per-char x offsets relative to this text's origin (CSS pixels). */
  xOffsets?: number[],
  /** CSS font-style; 'italic' / 'oblique' activate SF Pro's slnt axis. */
  fontStyle?: string,
): string | null {
  const result = textToPathMarkup(text, fontSize, fontFamily, fontWeight, targetWidth, xOffsets, fontStyle);
  if (result == null || result.markup === "") return null;

  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant);
  if (font == null) return null;

  const scale = fontSize / font.unitsPerEm;
  // Round the ascent to whole pixels to match Chromium's metric quantization
  // (SK-1234). canvas.measureText().fontBoundingBoxAscent for SF Pro returns
  // round(ascent_in_px), e.g. 14 for fontSize=14 (precise float would be
  // 13.535) and 23 for fontSize=24. The text baseline Chromium paints sits
  // at line_box_top + leading/2 + rounded_ascent, so our SVG glyphs need to
  // use the same rounded ascent value or they end up ~0.5px too high or low.
  const ascent = Math.round(font.ascent * scale);
  const baselineY = y + ascent;

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  return `<g transform="translate(${r(x)},${r(baselineY)})" fill="${fill}" role="img" aria-label="${esc(text)}"><title>${esc(text)}</title>${result.markup}</g>`;
}

/**
 * Check if text-to-path conversion is available for a font family.
 */
export function isTextToPathAvailable(fontFamily: string): boolean {
  return resolveFont(fontFamily, 400, 14) != null;
}

export interface DecorationMetrics {
  /** Underline stroke center, px below baseline (positive = below). */
  underlineOffsetY: number;
  underlineThickness: number;
  /** Line-through stroke center, px above baseline (positive = above). */
  strikeoutOffsetY: number;
  strikeoutThickness: number;
  /** Overline stroke center, px above baseline (positive = above). */
  overlineOffsetY: number;
  overlineThickness: number;
}

/**
 * Resolve text-decoration line placement from the font's actual `post`/`OS/2`
 * tables (SK-1236). Chromium uses these same metric tables, so reading them
 * directly tightens decoration alignment vs the previous fontSize-fraction
 * approximation — most visible on SF Mono (underline ~0.75px higher than the
 * generic 15%-of-fontSize estimate) and on large-fontSize text.
 *
 * Returns offsets in px from the baseline (sign convention noted on each
 * field). Falls back to the legacy 15%/30%/95% approximations when the font
 * fails to resolve.
 */
export function getDecorationMetrics(
  fontFamily: string, fontSize: number, fontWeight: string | number, fontStyle?: string,
): DecorationMetrics {
  const weight = typeof fontWeight === "number" ? fontWeight : (parseInt(fontWeight) || 400);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant);
  if (font == null) {
    return {
      underlineOffsetY: fontSize * 0.15, underlineThickness: Math.max(1, Math.round(fontSize / 14)),
      strikeoutOffsetY: fontSize * 0.30, strikeoutThickness: Math.max(1, Math.round(fontSize / 14)),
      overlineOffsetY: fontSize * 0.95,  overlineThickness: Math.max(1, Math.round(fontSize / 14)),
    };
  }
  const scale = fontSize / font.unitsPerEm;
  // post.underlinePosition is the suggested center of the underline stroke,
  // in font units, with negative = below baseline. Negate to get a positive
  // distance below the baseline in screen px (y grows downward).
  const underlineOffsetY = -font.underlinePosition * scale;
  const underlineThickness = Math.max(1, font.underlineThickness * scale);
  const os2 = font["OS/2"];
  const strikeRawPos = os2?.yStrikeoutPosition ?? Math.round(font.unitsPerEm * 0.30);
  const strikeRawSize = os2?.yStrikeoutSize ?? font.underlineThickness;
  const strikeoutOffsetY = strikeRawPos * scale;
  const strikeoutThickness = Math.max(1, strikeRawSize * scale);
  // No standard overline metric — Chromium paints just above the ascent,
  // about underlineThickness/2 above the cap. ascent * scale matches what
  // Chromium does within ~0.5px on body text.
  const overlineOffsetY = font.ascent * scale;
  return {
    underlineOffsetY, underlineThickness,
    strikeoutOffsetY, strikeoutThickness,
    overlineOffsetY, overlineThickness: underlineThickness,
  };
}

function r(n: number): string { return Number(n.toFixed(2)).toString(); }
