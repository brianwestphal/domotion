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
  layout(text: string, features?: string[]): {
    glyphs: Array<{ id: number; path: { commands: Array<{ command: string; args: number[] }> }; advanceWidth: number }>;
    positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  };
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition: number;
  underlineThickness: number;
  /** Available OpenType feature tags (e.g. ['liga', 'kern', 'smcp']). Used by
   *  the synthesized-small-caps path to detect when smcp is missing. */
  availableFeatures?: string[];
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
  localFontAliasRegistry.clear();
}

/**
 * `@font-face { src: local(...) }` aliases. Maps a CSS family name (e.g.
 * `"TestSerif"`) to a resolved on-disk font key (e.g. `"georgia"`). When the
 * page declares an `@font-face` with all-`local()` sources, capture.ts walks
 * the local() list and registers the first recognized system font name here
 * — so the renderer's `resolveFontKey` can route the otherwise-unknown CSS
 * family to the correct sibling-file group, picking up weight/italic dispatch
 * from `getFontInstance` automatically (Georgia Bold for weight=700, Georgia
 * Italic for italic, etc.). DM-303.
 */
const localFontAliasRegistry = new Map<string, string>();
export function registerLocalFontAlias(family: string, resolvedKey: string): void {
  const key = family.toLowerCase().replace(/^["']|["']$/g, "").trim();
  if (key === "" || resolvedKey === "") return;
  localFontAliasRegistry.set(key, resolvedKey);
}

/**
 * Pick the closest matching registered variant for the given family +
 * weight/style, then drive any variation axes the file exposes (so a single
 * variable webfont — Inter Variable, Roboto Flex, Recursive — can serve
 * multiple weights / sizes / slants from one buffer instead of substituting
 * the registered base instance for every request).
 *
 * Used internally by `getFontInstance` for `webfont:<name>` keys; italic
 * match dominates the score so italic+regular beats upright+italic-mismatch.
 */
function pickWebfontVariant(family: string, weight: number, fontSize: number, slant: number): FontInstance | null {
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
  if (best == null) return null;
  return applyVariationAxes(best.font, weight, fontSize, slant);
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
  // Chrome on macOS resolves the CSS `monospace` generic keyword to Courier
  // (per Blink's third_party/blink/renderer/platform/fonts/mac
  // font_cache_mac.mm — kMonospaceFamily → kCourier), NOT SF Mono or Menlo.
  // SF Mono is ~3% wider than Courier at the same em size and has a 2px
  // taller ascent at 13px (rounded), so substituting it for `monospace`
  // misaligns `<code>` baselines against the surrounding sans-serif text.
  // Courier.ttc is a collection: weight × slant variants picked by
  // postscriptName in getFontInstance.
  "courier":              { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier" },
  "courier-bold":         { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier-Bold" },
  "courier-italic":       { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier-Oblique" },
  "courier-bold-italic":  { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier-BoldOblique" },
  // Author-named monospace families. Menlo and Monaco both ship as system
  // fonts with their own metrics — different from Courier and SF Mono — so
  // when an author explicitly requests them we should honor that rather than
  // substitute one mono for another.
  "menlo":              { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-Regular" },
  "menlo-bold":         { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-Bold" },
  "menlo-italic":       { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-Italic" },
  "menlo-bold-italic":  { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-BoldItalic" },
  "monaco":          { path: "/System/Library/Fonts/Monaco.ttf" },
  // Chrome on macOS uses Geeza Pro for the Arabic block, NOT SF Arabic. SF
  // Arabic glyphs are wider (~29.7px for بحرم at 16px) while Geeza Pro
  // matches Chrome's painted width (~27.6px) — DM-270 probe. SF Arabic was
  // designed for Apple system UI and isn't what Chrome's CoreText fallback
  // picks for `Times` body text.
  "sf-arabic":       { path: "/System/Library/Fonts/GeezaPro.ttc", postscriptName: "GeezaPro" },
  "sf-hebrew":       { path: "/System/Library/Fonts/SFHebrew.ttf" },
  // Hiragino Sans GB ships W3 (regular) and W6 (bold) as separate sub-fonts in
  // the same TTC; the file doesn't expose a usable wght axis (DM-256), so the
  // bold variant is selected by postscriptName at the spec level — same
  // pattern as helvetica/times/georgia. The advance widths are identical
  // between W3/W6 (24px @24px font-size for em-square glyphs) but the stem
  // thickness differs, so headings using cjk-block fallback chars (← → ▲ ☀)
  // need W6 to match Chrome's painted weight.
  "cjk":             { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", postscriptName: "HiraginoSansGB-W3" },
  "cjk-bold":        { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", postscriptName: "HiraginoSansGB-W6" },
  "thai":            { path: "/System/Library/Fonts/ThonburiUI.ttc", postscriptName: ".ThonburiUI-Regular" },
  "devanagari":      { path: "/System/Library/Fonts/Kohinoor.ttc", postscriptName: "KohinoorDevanagari-Regular" },
  "symbols":         { path: "/System/Library/Fonts/Apple Symbols.ttf" },
  // Chrome on macOS routes Dingbats (U+2700-27BF: ✂✈✏✔✘✚✦❄❤❶ etc.) to
  // Zapf Dingbats, NOT Apple Symbols. Apple Symbols' glyphs at the same
  // codepoints exist but have different (narrower, often slightly different
  // shape) widths — verified empirically per DM-241 follow-up: every dingbat
  // tested matched Zapf Dingbats' natural advance, none matched Apple Symbols'.
  "zapf-dingbats":   { path: "/System/Library/Fonts/ZapfDingbats.ttf" },
  // Mathematical Alphanumeric Symbols (U+1D400-1D7FF: 𝐀 𝒜 𝕊 𝟬 𝔄 𝛼 etc.)
  // — Chrome paints these via STIX Two Math, the math-coverage font Apple
  // ships in Supplemental. Verified empirically (DM-257): every Math Alpha
  // char tested matched STIXTwoMath's natural advance to within 0.05px,
  // while Apple Symbols and Helvetica lack these glyphs entirely (would
  // render as .notdef tofu).
  "stix-math":       { path: "/System/Library/Fonts/Supplemental/STIXTwoMath.otf" },
  // Chrome on macOS resolves the CSS `sans-serif` generic keyword to
  // Helvetica (per Blink's third_party/blink/renderer/platform/fonts/mac
  // font_cache_mac.mm). This is critical for fidelity — SF Pro has different
  // glyph shapes and metrics, so substituting it for `sans-serif` produces
  // visible drift on every page that uses the default. Helvetica.ttc is a
  // collection: pick weight × slant variants by postscriptName in
  // getFontInstance.
  "helvetica":              { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica" },
  "helvetica-bold":         { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-Bold" },
  "helvetica-italic":       { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-Oblique" },
  "helvetica-bold-italic":  { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-BoldOblique" },
  // Arial ships as separate weight/style files in macOS Supplemental.
  "arial":                  { path: "/System/Library/Fonts/Supplemental/Arial.ttf" },
  "arial-bold":             { path: "/System/Library/Fonts/Supplemental/Arial Bold.ttf" },
  "arial-italic":           { path: "/System/Library/Fonts/Supplemental/Arial Italic.ttf" },
  "arial-bold-italic":      { path: "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf" },
  // Generic serif (font-family: serif / ui-serif, "Times New Roman", "Georgia").
  // Times is what Chrome on macOS resolves the bare `<body>`/`<h1>` default to
  // when no font-family is set — UA stylesheet anchors `<body>` at Times, so
  // we need bold + italic + bold-italic siblings to render `<h1>`/`<strong>`/
  // `<em>` in serif content faithfully (DM-269).
  "times":              { path: "/System/Library/Fonts/Supplemental/Times New Roman.ttf" },
  "times-bold":         { path: "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf" },
  "times-italic":       { path: "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf" },
  "times-bold-italic":  { path: "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf" },
  "georgia":             { path: "/System/Library/Fonts/Supplemental/Georgia.ttf" },
  "georgia-bold":        { path: "/System/Library/Fonts/Supplemental/Georgia Bold.ttf" },
  "georgia-italic":      { path: "/System/Library/Fonts/Supplemental/Georgia Italic.ttf" },
  "georgia-bold-italic": { path: "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf" },
  // Generic cursive — Chrome on macOS resolves `cursive` to Snell Roundhand.
  "snell":           { path: "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc", postscriptName: "SnellRoundhand" },
};

/**
 * Ordered list of fallback font keys to try when the primary font lacks a
 * glyph for `codepoint`. Caller iterates the chain and picks the first font
 * whose `glyphForCodePoint(cp).id !== 0`. Returns an empty array when no
 * fallback is needed (caller should keep using primary).
 *
 * Order matches Chrome's macOS CoreText fallback per Unicode block, verified
 * empirically by probing Chrome's painted width vs each candidate font's
 * natural advance (DM-241 follow-up audit). Apple Symbols stays as the final
 * safety net so we never end up with a .notdef tofu — better to draw a
 * slightly-wrong glyph than nothing.
 */
export function fallbackFontChain(codepoint: number): string[] {
  // Hebrew (U+0590..05FF) + presentation forms (U+FB1D..FB4F).
  if ((codepoint >= 0x0590 && codepoint <= 0x05FF)
    || (codepoint >= 0xFB1D && codepoint <= 0xFB4F)) {
    return ["sf-hebrew"];
  }
  // Arabic core block + presentation forms A and B.
  if ((codepoint >= 0x0600 && codepoint <= 0x06FF)
    || (codepoint >= 0xFB50 && codepoint <= 0xFDFF)
    || (codepoint >= 0xFE70 && codepoint <= 0xFEFF)) {
    return ["sf-arabic"];
  }
  // Devanagari (U+0900..097F).
  if (codepoint >= 0x0900 && codepoint <= 0x097F) return ["devanagari"];
  // Thai (U+0E00..0E7F).
  if (codepoint >= 0x0E00 && codepoint <= 0x0E7F) return ["thai"];
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
    return ["cjk"];
  }
  // Box Drawing / Block Elements → Menlo. Apple Symbols' versions are
  // proportional (~6.98px @13px) and don't fill a Courier monospace cell
  // (~7.80px), leaving visible gaps in ASCII-art tables. Menlo's are
  // designed at full monospace cell width (~7.83px @13px). DM-241.
  if (codepoint >= 0x2500 && codepoint <= 0x259F) return ["menlo"];
  // Dingbats → Zapf Dingbats. macOS Chrome paints ✂✈✏✔✘✚✦❄❤❶ via Zapf
  // Dingbats; Apple Symbols has the same codepoints but at different (often
  // narrower) widths — empirical match shows Chrome consistently picks Zapf.
  if (codepoint >= 0x2700 && codepoint <= 0x27BF) return ["zapf-dingbats", "symbols"];
  // Geometric Shapes (▲△▽★☆♀♂…) and Misc Symbols (☀☁☂♠♥♦…) — Chrome on
  // macOS paints many of these at the CJK em-square width (16px @16px font-
  // size) via Hiragino Sans GB, NOT Apple Symbols (which has them at
  // proportional 9-14px). Try CJK first; fall through to Apple Symbols for
  // the chars Hiragino lacks (☘ ☑ ◇ etc.). DM-256.
  if ((codepoint >= 0x25A0 && codepoint <= 0x25FF)
    || (codepoint >= 0x2600 && codepoint <= 0x26FF)) {
    return ["cjk", "symbols"];
  }
  // Arrows: most of the Arrows block (↑↓↔↦⇒⇔ …) routes to Apple Symbols
  // below, but ← → ↗ ↙ are the four codepoints Hiragino W6 has at the CJK
  // em-square width (24px @24px) which is what Chrome paints — Apple
  // Symbols has them at 15-17px, rendering visibly thinner. Other Hiragino-
  // covered arrows (↑↓↖↘) Hiragino paints at 24px but Chrome paints at
  // 17.34/21.98 (a different fallback we haven't pinned down), so they
  // stay on Apple Symbols rather than over-correcting. DM-296.
  if (codepoint === 0x2190 || codepoint === 0x2192
      || codepoint === 0x2197 || codepoint === 0x2199) {
    return ["cjk", "symbols"];
  }
  // Mathematical Alphanumeric Symbols (𝐀 𝒜 𝕊 𝟬 𝔄 𝛼 etc.) — Chrome paints
  // via STIX Two Math (the system math-coverage font); Apple Symbols
  // and Hiragino lack these glyphs entirely. DM-257.
  if (codepoint >= 0x1D400 && codepoint <= 0x1D7FF) {
    return ["stix-math", "symbols"];
  }
  // Letterlike (ℝℕℤℂℚ™), Arrows residue, Math Operators, Pictographs, Transport.
  // The caller's primary-first check already routes chars Helvetica/Times
  // have (∑∏∫≠≤≥, ™, ●) to the primary; what reaches this fallback is the
  // residue (∀∃∈ ↑↓↔ ⇒⇔ etc.) for which Apple Symbols is the right macOS
  // source. (← → ↗ ↙ branch above to CJK because Hiragino's em-wide glyph
  // matches Chrome and Apple Symbols' is too narrow — DM-296.)
  if ((codepoint >= 0x2100 && codepoint <= 0x214F)
    || (codepoint >= 0x2190 && codepoint <= 0x21FF)
    || (codepoint >= 0x2200 && codepoint <= 0x22FF)
    || (codepoint >= 0x1F300 && codepoint <= 0x1F5FF)
    || (codepoint >= 0x1F680 && codepoint <= 0x1F6FF)) {
    return ["symbols"];
  }
  return [];
}

/** @deprecated Single-key wrapper for back-compat — prefer `fallbackFontChain`. */
export function fallbackFontKey(codepoint: number): string | null {
  const chain = fallbackFontChain(codepoint);
  return chain.length > 0 ? chain[0] : null;
}

function getFontInstance(key: string, weight: number, fontSize: number, slant: number = 0): FontInstance | null {
  // Webfont keys (`webfont:<lowercased family>`) resolve through the runtime
  // registry rather than the on-disk FONT_PATHS table.
  if (key.startsWith("webfont:")) {
    return pickWebfontVariant(key.slice("webfont:".length), weight, fontSize, slant);
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
  }
  // Helvetica/Arial/Courier/Menlo/Times/Georgia don't expose a variable wght
  // axis — pick the right sub-font (or sibling file) based on weight × slant.
  // Boundary at 600 matches CSS font-weight: bold (700) and the typical
  // "semibold or above is bold" rule Chrome uses when an exact weight isn't
  // installed. Times/Georgia ship four sibling files (regular/bold/italic/
  // bold-italic) for headings + emphasis in serif content (DM-269).
  if (key === "helvetica" || key === "arial" || key === "courier" || key === "menlo"
      || key === "times" || key === "georgia") {
    const isBold = weight >= 600;
    const isItalic = slant !== 0;
    if (isBold && isItalic) effectiveKey = `${key}-bold-italic`;
    else if (isBold) effectiveKey = `${key}-bold`;
    else if (isItalic) effectiveKey = `${key}-italic`;
  }
  // CJK has only regular + bold variants (no italic); pick W6 for bold contexts
  // so fallback characters in headings (← → ▲ ☀) inherit the heading weight.
  if (key === "cjk" && weight >= 600) {
    effectiveKey = "cjk-bold";
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
    const instance = applyVariationAxes(font, weight, fontSize, slant);
    fontInstanceCache.set(cacheKey, instance);
    return instance;
  } catch {
    return null;
  }
}

/**
 * Drive a variable font's exposed variation axes from the requested CSS
 * weight / font-size / slant:
 *
 *   - `wght` ← `weight` (CSS numeric weight, 100-900)
 *   - `opsz` ← `fontSize` (px) when the font exposes the axis
 *   - `slnt` ← `slant` when non-zero AND the axis exists (SF Pro / Recursive
 *     synthesize italic/oblique from this; ignored otherwise)
 *
 * Returns the original font when the file isn't variable or `getVariation`
 * is missing. Some fonts (Hiragino Sans GB) expose `getVariation` but lack
 * the required `fvar`/`gvar`/`CFF2` tables, so the call is wrapped in
 * try/catch — failure falls back to the unvariated font rather than
 * cascading up.
 *
 * Used by both the system-installed font path (`getFontInstance`) and the
 * runtime webfont path (`pickWebfontVariant`) so variable webfonts like
 * Inter Variable or Roboto Flex render at the requested weight/size instead
 * of always producing the registered base instance.
 */
function applyVariationAxes(font: any, weight: number, fontSize: number, slant: number): FontInstance {
  if (font.variationAxes == null || Object.keys(font.variationAxes).length === 0 || font.getVariation == null) {
    return font;
  }
  const axes: Record<string, number> = {};
  if (font.variationAxes.wght != null) axes.wght = weight;
  if (font.variationAxes.opsz != null) axes.opsz = fontSize;
  if (slant !== 0 && font.variationAxes.slnt != null) axes.slnt = slant;
  if (Object.keys(axes).length === 0) return font;
  let v: FontInstance;
  try {
    v = font.getVariation(axes);
  } catch {
    return font;
  }
  // Fontkit's WOFF2 variation path returns an instance whose internal stream
  // doesn't expose the parent's tables — accessing `unitsPerEm` /
  // `layout(...)` throws "Cannot read properties of undefined". Probe for
  // that and fall back to the original font when the variation is broken.
  // For TTF/OTF parents the probe succeeds and we use the variation as-is.
  try {
    if ((v as any).unitsPerEm == null) return font;
  } catch {
    return font;
  }
  return v;
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
    // `@font-face { src: local(...) }` alias — the page declared an
    // @font-face whose first source resolves to a system font we already know
    // about (Georgia / Menlo / Times / etc.). The captured alias gives us the
    // resolved key directly; getFontInstance then dispatches to the right
    // sibling file (georgia-bold, georgia-italic, …) per weight/style. DM-303.
    if (localFontAliasRegistry.has(name)) return localFontAliasRegistry.get(name)!;
    // Chrome on macOS resolves the CSS `monospace` generic to Courier (per
    // Blink's font_cache_mac.mm — kMonospaceFamily → kCourier). For author-
    // named monospaces we map to whatever the author asked for if we have
    // it on disk; SF Mono is only used when explicitly requested. Consolas
    // isn't installed on macOS — Chrome falls back to Times metrics there,
    // but for fidelity-of-intent we route it to Courier.
    //
    // `ui-monospace` is NOT recognized by Chrome on macOS (DM-269 probe:
    // painted T width = 9.77, q = 8.0 — same as Times, not Courier or SF
    // Mono). Chrome falls through to the standard-font default (Times). It
    // intentionally falls through here so the last-resort `times` mapping
    // at the bottom catches it.
    if (name === "monospace" || name === "courier" || name === "courier new"
      || name === "consolas") return "courier";
    if (name === "menlo") return "menlo";
    if (name === "monaco") return "monaco";
    if (name === "sf mono" || name === "sfmono-regular" || name === "sf-mono") return "sf-mono";
    if (name === "serif" || name === "ui-serif" || name === "times" || name === "times new roman") return "times";
    if (name === "georgia") return "georgia";
    if (name === "cursive" || name === "snell roundhand" || name === "brush script mt" || name === "apple chancery") return "snell";
    // Chrome on macOS resolves `sans-serif`, `helvetica`, and `helvetica neue`
    // to Helvetica (Blink: font_cache_mac.mm + font_fallback_list.cc — the
    // generic `sans-serif` keyword is hardcoded to Helvetica on macOS, not
    // SF Pro). Matching this exactly is critical: SF Pro has different
    // glyph shapes (notably the `1`, `R`, `g`) and ~2% wider metrics than
    // Helvetica at the same em size, so substituting it produces visible
    // drift on every page that uses the default sans-serif.
    if (name === "sans-serif" || name === "ui-sans-serif" || name === "helvetica"
      || name === "helvetica neue") return "helvetica";
    if (name === "arial") return "arial";
    // system-ui / -apple-system / BlinkMacSystemFont / "SF Pro" → SF Pro.
    // These keywords mean "the platform UI font", which on modern macOS is
    // San Francisco.
    if (name === "system-ui" || name === "-apple-system" || name === "blinkmacsystemfont"
      || name === "sf pro" || name === "sf pro text" || name === "sf pro display") return "sf-pro";
    // Other generic keywords Chrome on macOS does NOT recognize as system
    // fonts: `ui-monospace`, `ui-rounded`, `fantasy`, `math`, `emoji`,
    // `fangsong`. Chrome treats them as missing and walks past them to the
    // next name in the stack. Only when nothing else matches does Chrome
    // fall through to the standard-font default (Times). DM-269 probe
    // confirmed bare `ui-monospace` paints with Times metrics (q=8.0,
    // T=9.77), but `ui-monospace, Menlo, monospace` paints in Menlo —
    // proving Chrome doesn't pin these keywords, it skips them. We must do
    // the same: `continue` past them so the rest of the stack (Menlo,
    // Consolas, monospace, …) gets a chance to match. The last-resort
    // `times` at the bottom of this function catches the no-match case.
    // (DM-302: textarea code editor used `font: ui-monospace, Menlo, …`
    // and we wrongly pinned to Times, painting code in a serif face.)
    if (name === "ui-monospace" || name === "ui-rounded"
      || name === "fantasy" || name === "math" || name === "emoji" || name === "fangsong") continue;
  }
  // Last-resort fallback when no family in the stack matched. Chrome's
  // ultimate fallback on macOS for an unrecognized name is the user's
  // configured "Standard Font" preference, which defaults to Times.
  return "times";
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
  /**
   * OpenType feature tags to enable for shaping (e.g. ['smcp'] for
   * `font-variant: small-caps`). Threaded through to every fontkit
   * `font.layout()` call so single-char and multi-char shaping both pick the
   * substituted glyph. Empty / undefined means default shaping. (DM-294)
   */
  features?: string[],
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
      // Primary-first: many of the chars `fallbackFontChain` routes (∑ ∏ ≠ ●
      // ™ ←) are present in the requested primary font (Helvetica/Times/SF
      // Pro) at metrics that match Chrome's painted width. Use primary
      // whenever it has the glyph; only walk the fallback chain otherwise.
      let useKey = primaryFontKey;
      if ((primaryFont as any).glyphForCodePoint(cp).id === 0) {
        // Walk the chain in order, pick the first font that actually has
        // the glyph. If nothing in the chain has it (e.g. an exotic emoji
        // that even Apple Symbols lacks), fall through to the LAST chain
        // entry anyway — its .notdef has a stable advance the rasterGlyph
        // overlay can pin a captured emoji PNG against, where switching
        // to primary's .notdef would shift glyph positions and drift the
        // rest of the line.
        const chain = fallbackFontChain(cp);
        let picked: string | null = null;
        for (const candidate of chain) {
          const cf = getFontInstance(candidate, weight, fontSize, slant);
          if (cf != null && (cf as any).glyphForCodePoint != null
              && (cf as any).glyphForCodePoint(cp).id !== 0) {
            picked = candidate;
            break;
          }
        }
        useKey = picked ?? (chain.length > 0 ? chain[chain.length - 1] : primaryFontKey);
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
  // Synthesized small-caps detection (DM-294). When `font-variant: small-caps`
  // resolves to the OpenType `smcp` feature but the active font lacks `smcp`
  // (Helvetica, Arial, SF Pro, Georgia, Times — all the body fonts we hit on
  // macOS), Chrome falls back to *synthesized* small-caps: lowercase letters
  // are rendered as uppercase glyphs at a smaller font size while uppercase
  // letters stay full size. Empirically the scale Chromium uses on Helvetica
  // at 16px is 11/16 ≈ 0.6875; at 32px it's 22/32 = 0.6875; at 20px it's
  // 14/20 = 0.700. We approximate with a flat 0.7 — the per-char xOffsets
  // already encode Chrome's painted positions, so the only thing we choose
  // is the glyph (uppercase vs lowercase) and its scale; small width drift
  // per glyph is acceptable.
  const smcpRequested = features != null && features.includes("smcp");
  const primaryHasSmcp = smcpRequested
    && Array.isArray((primaryFont as any).availableFeatures)
    && (primaryFont as any).availableFeatures.includes("smcp");
  const synthSmallCaps = smcpRequested && !primaryHasSmcp;
  // Single-run, primary-font path keeps the existing fast path with xOffsets
  // support and per-char fidelity. Multi-run path falls back to native advances.
  // When synthesizing small-caps we need per-char rendering at variable scales,
  // so we route around singleFontMarkup which emits one fixed-scale group.
  if (runs.length === 1 && runs[0].fontKey === primaryFontKey && !synthSmallCaps) {
    return singleFontMarkup(runs[0].font, runs[0].fontKey, runs[0].text, weight, fontSize, slant, targetWidth, xOffsets, features);
  }

  // Content with captured per-char xOffsets. Primary runs and non-shaping
  // fallback runs (CJK, hiragana/katakana via cjk, Hebrew, symbols, Menlo)
  // anchor each glyph at its captured x to preserve subpixel positioning
  // (SK-1234) AND honor per-char layout decisions Chrome made that fontkit's
  // native advances would miss (notably ruby-align: space-around distributing
  // a single rt char to fill its base column — DM-239). Shaping-required
  // fallbacks (Arabic, Devanagari, Thai) still go through font.layout(runText)
  // as a unit so contextual joining (init/medi/fina), cluster reordering
  // (Devanagari i-matra), and ligature substitution (क्ष) survive — fontkit's
  // shaping for these scripts agrees with Chromium's HarfBuzz to within ~1px
  // (SK-1237 investigation).
  if (xOffsets != null && xOffsets.length === text.length) {
    const groups: string[] = [];
    let rightEdge = 0;
    for (const run of runs) {
      const runScale = fontSize / run.font.unitsPerEm;
      const sc = Number(runScale.toFixed(5));
      const isShapingRequired = run.fontKey === "sf-arabic"
        || run.fontKey === "devanagari"
        || run.fontKey === "thai";

      if (!isShapingRequired) {
        // Per-char anchoring — primary runs and any fallback that's 1:1 char→
        // glyph (no shaping reordering or contextual joining). Each codepoint
        // shapes individually; placement uses the captured xOffset so we
        // inherit Chrome's spacing decisions including ruby column-fitting.
        // When `synthSmallCaps` is on (DM-294), lowercase letters are
        // upper-cased and rendered at the small-cap scale so we match Chrome's
        // painted glyphs for fonts that don't carry an `smcp` feature.
        const SMALL_CAP_SCALE = 0.7;
        const smallCapScVal = Number((runScale * SMALL_CAP_SCALE).toFixed(5));
        let i = run.startIdx;
        while (i < run.endIdx) {
          const cp = text.codePointAt(i)!;
          let ch = String.fromCodePoint(cp);
          let chScale = sc;
          if (synthSmallCaps) {
            const upper = ch.toUpperCase();
            if (upper !== ch && upper.length === ch.length) {
              ch = upper;
              chScale = smallCapScVal;
            }
          }
          const layout = features != null && features.length > 0 && !synthSmallCaps
            ? run.font.layout(ch, features)
            : run.font.layout(ch);
          const uses: string[] = [];
          for (const g of layout.glyphs) {
            if (g.path.commands.length > 0) {
              const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, g.id, g.path.commands);
              uses.push(`<use href="#${defId}" x="0" y="0"/>`);
            }
          }
          if (uses.length > 0) {
            const cssX = Number(xOffsets[i].toFixed(3));
            groups.push(`<g transform="translate(${cssX},0) scale(${chScale},${-chScale})">${uses.join("")}</g>`);
            if (cssX > rightEdge) rightEdge = cssX;
          }
          i += ch.length;
        }
      } else {
        // Shaping fallback — shape the whole run together. Anchor at the
        // visual-leftmost captured x: for LTR that's xOffsets[startIdx], for
        // RTL that's xOffsets[endIdx-1] (last logical char paints leftmost).
        // Math.min covers both directions and any embedded BiDi.
        let runMinX = Infinity;
        for (let i = run.startIdx; i < run.endIdx; i++) {
          if (xOffsets[i] < runMinX) runMinX = xOffsets[i];
        }
        const layout = features != null && features.length > 0
          ? run.font.layout(run.text, features)
          : run.font.layout(run.text);
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
    const layout = features != null && features.length > 0
      ? run.font.layout(run.text, features)
      : run.font.layout(run.text);
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
  features?: string[],
): TextPathResult {
  const scale = fontSize / font.unitsPerEm;
  const run = features != null && features.length > 0
    ? font.layout(text, features)
    : font.layout(text);
  let totalAdvance = 0;
  for (const pos of run.positions) totalAdvance += pos.xAdvance;
  const nativeWidth = totalAdvance * scale;
  const xScale = (targetWidth != null && targetWidth > 0 && nativeWidth > 0)
    ? targetWidth / nativeWidth : 1;
  // When xOffsets are provided but the layout's glyph count doesn't match the
  // text length (Helvetica's `liga` feature collapsed `fi` / `fl` into single
  // glyphs etc.), the per-char anchoring path can't run — without it we lose
  // Chrome's justify-driven space widths and the rendered line collapses to
  // unjustified spacing. (DM-287). Re-shape per-char to bypass ligatures so
  // each codepoint maps 1:1 to a glyph and per-char xOffsets line up.
  if (xOffsets != null && xOffsets.length !== run.glyphs.length) {
    const sc = Number(scale.toFixed(5));
    const uses: string[] = [];
    let i = 0;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      const isHigh = code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length;
      const step = isHigh ? 2 : 1;
      const ch = text.slice(i, i + step);
      const cl = font.layout(ch);
      for (let gi = 0; gi < cl.glyphs.length; gi++) {
        const glyph = cl.glyphs[gi];
        const pos = cl.positions[gi];
        if (glyph.path.commands.length > 0) {
          const defId = ensureGlyphDef(fontKey, weight, fontSize, slant, glyph.id, glyph.path.commands);
          const tx = xOffsets[i] / scale + pos.xOffset;
          const ty = -pos.yOffset;
          uses.push(`<use href="#${defId}" x="${r(tx)}" y="${r(ty)}"/>`);
        }
      }
      i += step;
    }
    return {
      markup: uses.length > 0 ? `<g transform="scale(${sc},${-sc})">${uses.join("")}</g>` : "",
      width: xOffsets[xOffsets.length - 1] + nativeWidth / Math.max(1, text.length),
    };
  }
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
  /**
   * Captured `canvas.measureText().fontBoundingBoxAscent` (px) — distance
   * from line-box top to baseline as Chrome will paint it. Overrides the
   * fontkit-derived ascent below, which is HHEA-based and disagrees with
   * Chrome on macOS for Helvetica/Arial/Times/Georgia/Menlo/Courier (Chrome
   * uses winAscent there). Per-font metric-selection rules are fragile to
   * derive but trivial to read from the browser. See SK-1267 / DM-237.
   */
  ascentOverride?: number,
  /**
   * OpenType feature tags forwarded to fontkit (e.g. ['smcp'] when CSS
   * `font-variant: small-caps` is in effect on this run). DM-294.
   */
  features?: string[],
): string | null {
  const result = textToPathMarkup(text, fontSize, fontFamily, fontWeight, targetWidth, xOffsets, fontStyle, features);
  if (result == null || result.markup === "") return null;

  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant);
  if (font == null) return null;

  const scale = fontSize / font.unitsPerEm;
  // Use the captured fontBoundingBoxAscent when available — that's the exact
  // value Chrome used to position the baseline within the line box. fontkit's
  // font.ascent (HHEA) is the right answer for SF Pro / SF Mono (where HHEA
  // = winAscent) but ~5 px too small at fontSize=32 for Helvetica and other
  // legacy MS fonts on macOS, where Chrome reads winAscent.
  const ascent = ascentOverride != null ? ascentOverride : Math.round(font.ascent * scale);
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
