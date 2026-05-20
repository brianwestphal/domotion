/**
 * Text-to-Path Converter
 *
 * Uses fontkit to convert text strings into SVG <path> outlines using
 * the actual macOS system fonts. Glyphs are deduplicated using SVG
 * <defs>/<use> — each unique glyph shape is defined once and referenced
 * everywhere it appears.
 */

import * as fontkit from "fontkit";
import { createCoretextFont, isCoretextHelperAvailable } from "./coretext.js";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss, trackGlyphInEmbedFont } from "./embedded-font-builder.js";

interface FontInstance {
  layout(text: string, features?: string[]): {
    glyphs: Array<{ id: number; path: { commands: Array<{ command: string; args: number[] }> }; advanceWidth: number; codePoints?: number[] }>;
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
interface WebfontVariant { weight: number; italic: boolean; font: FontInstance; unicodeRange?: Array<[number, number]>; buffer?: Buffer }
const webfontRegistry = new Map<string, WebfontVariant[]>();

// ── DM-652: opt-in embedded-font render mode ──
// When enabled, the text renderer emits `<text>` elements with a CSS
// `font-family` pointing at a `@font-face`-declared subset font, instead
// of the default `<use href="#gN">` glyph references. The default
// (`"paths"`) is unchanged and preserves Chromium-faithful per-pixel
// output. The embedded-font mode trades pixel fidelity (each browser's
// text engine applies its own hinting / kerning / subpixel positioning)
// for WebKit perf — text-heavy scroll composites that ran at 14.7 fps
// in WebKit (paths mode) jump back toward Chromium's 119 fps because the
// engine caches the rasterized glyph atlas at the compositor layer.
export type RenderTextMode = "paths" | "embedded-font";
let currentRenderTextMode: RenderTextMode = "paths";
export function setRenderTextMode(mode: RenderTextMode): void { currentRenderTextMode = mode; }
export function getRenderTextMode(): RenderTextMode { return currentRenderTextMode; }

/**
 * Per-render-pass tracker for fonts that text emission asked us to embed.
 * Keyed by a stable string identifier per (fontPath × postscriptName) so
 * the same font referenced from multiple text runs collapses to one
 * `@font-face` declaration. `getEmbeddedFontFaceCss()` reads the source
 * bytes for each entry and emits one rule per font.
 */
interface EmbeddedFontEntry {
  /** CSS family name the renderer assigns to this entry — references it from `<text font-family="…">`. */
  cssFamily: string;
  /** Source TTF/OTF/WOFF bytes ready to base64-encode into the `data:` URI. */
  buffer: Buffer;
  /** MIME type for the data URI — `font/ttf`, `font/otf`, `font/woff2`, etc. */
  mime: string;
}
const embeddedFonts = new Map<string, EmbeddedFontEntry>();
let embeddedFontIdCounter = 0;

export function clearEmbeddedFonts(): void {
  embeddedFonts.clear();
  embeddedFontIdCounter = 0;
  clearEmbeddedFontBuilder();
}

/**
 * Read the source bytes for a registered or system font and return them
 * paired with a content type that matches the on-disk container. WOFF2
 * webfonts arrive at the capture pipeline already-decompressed to raw
 * TTF/OTF bytes (capture.ts/loadWebfont), so the data we have is what we
 * embed — we don't re-compress to WOFF2 even though we have wawoff2
 * available, to keep the MVP path simple. File-size optimisation via
 * compression is a follow-up.
 */
function fontBufferAndMime(buffer: Buffer): { buffer: Buffer; mime: string } {
  if (buffer.length >= 4) {
    const sig = buffer.subarray(0, 4).toString("hex");
    if (sig === "774f4632") return { buffer, mime: "font/woff2" };  // 'wOF2'
    if (sig === "774f4646") return { buffer, mime: "font/woff" };   // 'wOFF'
    if (sig === "4f54544f") return { buffer, mime: "font/otf" };    // 'OTTO'
    if (sig === "74746366") return { buffer, mime: "font/collection" }; // 'ttcf'
  }
  return { buffer, mime: "font/ttf" };
}

/**
 * Register a font for embedding under a renderer-assigned CSS family
 * name. Idempotent on (key) — the same key returns the same css family
 * across calls so multiple text runs over the same font collapse to one
 * `@font-face` block.
 */
function registerEmbeddedFont(key: string, buffer: Buffer): string {
  const existing = embeddedFonts.get(key);
  if (existing != null) return existing.cssFamily;
  const cssFamily = `dmf${embeddedFontIdCounter++}`;
  const { buffer: outBuf, mime } = fontBufferAndMime(buffer);
  embeddedFonts.set(key, { cssFamily, buffer: outBuf, mime });
  return cssFamily;
}

/**
 * Emit one `@font-face` rule per font the embedded-font path registered
 * during this render pass. Returns the CSS to inject into the SVG's
 * `<style>` block (or `<defs><style>`). Empty string when no fonts were
 * registered (e.g. `renderText: "paths"`).
 */
export function getEmbeddedFontFaceCss(): string {
  // DM-655: the registerEmbeddedFont(...) path that emitted whole webfont
  // buffers is gone — every embedded font now goes through the custom-TTF
  // builder. Keep the legacy `embeddedFonts` map drained-and-ignored for
  // a release so any in-flight callers don't crash on the missing path;
  // delete the legacy map entirely once nothing references it.
  return getBuiltEmbeddedFontFaceCss();
}

/**
 * Open a webfont buffer with fontkit and register it under the given family
 * name (case-insensitive). `weight` is a CSS numeric weight (100-900); 400
 * when omitted. `style` is "normal" / "italic" / "oblique"; treated as italic
 * for any non-normal value.
 *
 * `unicodeRange` mirrors the `@font-face { unicode-range: ... }` descriptor as
 * a list of inclusive `[from, to]` codepoint intervals. Google-Fonts-style
 * partitioning declares the same `(family, weight)` pair across multiple
 * `@font-face` rules, each with a distinct `unicode-range` (Latin, Latin Ext,
 * Cyrillic, Greek, Vietnamese, …). Without honoring the descriptor,
 * `pickWebfontVariant` may return the Cyrillic-only partition for a Latin
 * text run — the run lays out as .notdef tofu (DM-517).
 *
 * Buffers must be decompressed already — fontkit's `create()` reads TTF/OTF
 * directly. WOFF2/WOFF bytes are decompressed in `loadWebfont()` (capture.ts)
 * before they reach this function.
 */
export function registerWebfont(family: string, weight: number, style: string, buffer: Buffer, unicodeRange?: Array<[number, number]>): void {
  const key = family.toLowerCase().replace(/^["']|["']$/g, "");
  let font: FontInstance;
  try {
    font = fontkit.create(buffer) as any;
  } catch {
    return; // unparseable — silently skip; capture-side warning happens elsewhere
  }
  const italic = style != null && style !== "" && style.toLowerCase() !== "normal";
  const list = webfontRegistry.get(key) ?? [];
  // DM-652: retain the raw buffer so embedded-font mode can `@font-face`
  // it as a `data:` URI without re-reading from disk (webfonts have no
  // on-disk source path — they came down from a CDN during capture).
  list.push({ weight, italic, font, unicodeRange, buffer });
  webfontRegistry.set(key, list);
}

/** True iff `cp` falls in any of the inclusive `[from, to]` intervals. */
export function unicodeRangeCovers(ranges: Array<[number, number]> | undefined, cp: number): boolean {
  if (ranges == null) return true; // no range = U+0..U+10FFFF (CSS default)
  for (const [from, to] of ranges) {
    if (cp >= from && cp <= to) return true;
  }
  return false;
}

/**
 * DM-557: codepoint-aware variant pick for partitioned webfonts. Filters
 * registered variants by whether their `unicode-range` covers `codepoint`
 * (per CSS Fonts 4 §11.5 — a partition only declares it can shape glyphs
 * within its declared range), then scores by (italic, weight) like
 * `pickWebfontVariant`. Returns null when no registered variant covers the
 * codepoint — the caller is expected to walk the system fallback chain in
 * that case.
 *
 * Used by the run-splitter in `textToPathMarkup` to route per-codepoint
 * within a Google-Fonts-style partitioned family (Geist@400 split across
 * Latin/Latin-Ext/Cyrillic/etc.). Without this, the Latin-biased
 * `pickWebfontVariant` is the single primary font for the whole text and
 * codepoints outside its range fall straight to system fonts — losing the
 * matching Cyrillic/Greek/Latin-Ext partition that's registered but
 * unselected.
 */
export function pickWebfontVariantForCodepoint(family: string, weight: number, fontSize: number, slant: number, codepoint: number, variationSettings?: Record<string, number>): FontInstance | null {
  const variants = webfontRegistry.get(family.toLowerCase());
  if (variants == null || variants.length === 0) return null;
  const wantItalic = slant !== 0;
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    if (!unicodeRangeCovers(v.unicodeRange, codepoint)) continue;
    const styleMismatch = v.italic === wantItalic ? 0 : 1000;
    const score = styleMismatch + Math.abs(v.weight - weight);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  if (best == null) return null;
  return applyVariationAxes(best.font, weight, fontSize, slant, variationSettings);
}

/**
 * Test-only: return metadata for the variant `pickWebfontVariant` would
 * choose, without resolving variation axes / returning a FontInstance. Lets
 * unit tests verify scoring (weight, italic, unicode-range) without needing
 * to introspect glyph paths.
 */
export function __pickWebfontVariantMetaForTest(family: string, weight: number, italic: boolean): { weight: number; italic: boolean; unicodeRange?: Array<[number, number]> } | null {
  const variants = webfontRegistry.get(family.toLowerCase());
  if (variants == null || variants.length === 0) return null;
  const LATIN_PROBE = 0x0041;
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    const styleMismatch = v.italic === italic ? 0 : 1000;
    const rangeMismatch = unicodeRangeCovers(v.unicodeRange, LATIN_PROBE) ? 0 : 2000;
    const score = styleMismatch + rangeMismatch + Math.abs(v.weight - weight);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  if (best == null) return null;
  return { weight: best.weight, italic: best.italic, unicodeRange: best.unicodeRange };
}

/** Test-only meta variant for `pickWebfontVariantForCodepoint` (DM-557). */
export function __pickWebfontVariantMetaForCodepointForTest(family: string, weight: number, italic: boolean, codepoint: number): { weight: number; italic: boolean; unicodeRange?: Array<[number, number]> } | null {
  const variants = webfontRegistry.get(family.toLowerCase());
  if (variants == null || variants.length === 0) return null;
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    if (!unicodeRangeCovers(v.unicodeRange, codepoint)) continue;
    const styleMismatch = v.italic === italic ? 0 : 1000;
    const score = styleMismatch + Math.abs(v.weight - weight);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  if (best == null) return null;
  return { weight: best.weight, italic: best.italic, unicodeRange: best.unicodeRange };
}

/** Drop all registered webfonts. Call at the start of a fresh capture run. */
export function clearWebfonts(): void {
  webfontRegistry.clear();
  localFontAliasRegistry.clear();
}

/**
 * `@font-face { src: local(...) }` aliases. Maps a CSS family name (e.g.
 * `"TestSerif"`) to one or more resolved on-disk font keys per declared
 * (weight, style) variant. When the page declares an `@font-face` with
 * all-`local()` sources, capture.ts walks the local() list and registers the
 * first recognized system font name here, paired with the @font-face's own
 * `font-weight` / `font-style` descriptors — so the renderer can score the
 * declared variants like a webfont would (DM-360).
 *
 * Without per-variant tracking, a request for `bold + italic` against a family
 * that declared only `regular`, `italic`, and `bold` (no bold-italic) would
 * incorrectly resolve to Georgia Bold Italic on disk; Chrome instead picks the
 * closest declared variant (italic 400) and synthesizes from there. DM-303 /
 * DM-360.
 */
interface LocalFontAliasVariant { weight: number; italic: boolean; baseKey: string }
const localFontAliasRegistry = new Map<string, LocalFontAliasVariant[]>();
export function registerLocalFontAlias(family: string, resolvedKey: string, weight: number = 400, italic: boolean = false): void {
  const key = family.toLowerCase().replace(/^["']|["']$/g, "").trim();
  if (key === "" || resolvedKey === "") return;
  const list = localFontAliasRegistry.get(key) ?? [];
  list.push({ weight, italic, baseKey: resolvedKey });
  localFontAliasRegistry.set(key, list);
}

/** Pick the declared (weight, style) variant closest to the requested combo —
 * mirrors `pickWebfontVariant` scoring (italic match dominates). Returns the
 * matched variant's resolved base key (e.g. `"georgia"`), or null when no
 * variants are registered for the family. */
function pickLocalFontAliasVariant(family: string, weight: number, italic: boolean): LocalFontAliasVariant | null {
  const variants = localFontAliasRegistry.get(family);
  if (variants == null || variants.length === 0) return null;
  let best: LocalFontAliasVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    const styleMismatch = v.italic === italic ? 0 : 1000;
    const score = styleMismatch + Math.abs(v.weight - weight);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  return best;
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
function pickWebfontVariant(family: string, weight: number, fontSize: number, slant: number, variationSettings?: Record<string, number>): FontInstance | null {
  const variants = webfontRegistry.get(family);
  if (variants == null || variants.length === 0) return null;
  const wantItalic = slant !== 0;
  // Tertiary preference: when multiple variants tie on (italic, weight) the
  // one whose `unicode-range` covers Basic Latin (U+0020..U+007F) wins. Google-
  // Fonts-style partitioning registers e.g. Geist@400 across 3 woff2 files
  // (Cyrillic, Latin Ext, Latin Basic) — without this, the first registered
  // partition wins regardless of whether it has glyphs for the rendered text,
  // and Latin runs lay out as .notdef tofu (DM-517).
  //
  // We can't yet route per-codepoint (would require run-splitting upstream),
  // so we bias toward the partition that covers the overwhelmingly common
  // case: Latin text. Variants with no `unicode-range` declared (CSS default
  // covers everything) match here trivially, so non-partitioned fonts are
  // unaffected.
  const LATIN_PROBE = 0x0041; // 'A'
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    const styleMismatch = v.italic === wantItalic ? 0 : 1000;
    // Range mismatch must outweigh italic mismatch: rendering tofu (no glyph)
    // is far worse than rendering upright glyphs for an italic request, where
    // the renderer can fall back to synthesized italic via `slant`.
    const rangeMismatch = unicodeRangeCovers(v.unicodeRange, LATIN_PROBE) ? 0 : 2000;
    const score = styleMismatch + rangeMismatch + Math.abs(v.weight - weight);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  if (best == null) return null;
  return applyVariationAxes(best.font, weight, fontSize, slant, variationSettings);
}

/**
 * DM-652: pick a registered webfont variant and return both the FontInstance
 * (for metric computation) AND the original buffer (for `@font-face`
 * embedding). Mirrors `pickWebfontVariant`'s scoring so embedded-mode
 * selection lines up with the path-mode selection a paths-mode capture
 * would have used. Returns null when the family isn't registered or the
 * matched variant has no retained buffer.
 */
function pickWebfontVariantWithBuffer(family: string, weight: number, slant: number): { variant: WebfontVariant; buffer: Buffer } | null {
  const variants = webfontRegistry.get(family);
  if (variants == null || variants.length === 0) return null;
  const wantItalic = slant !== 0;
  const LATIN_PROBE = 0x0041;
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    if (v.buffer == null) continue;
    const styleMismatch = v.italic === wantItalic ? 0 : 1000;
    const rangeMismatch = unicodeRangeCovers(v.unicodeRange, LATIN_PROBE) ? 0 : 2000;
    const score = styleMismatch + rangeMismatch + Math.abs(v.weight - weight);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  if (best == null || best.buffer == null) return null;
  return { variant: best, buffer: best.buffer };
}

/**
 * DM-652: resolve the first font in a CSS font-family stack that's
 * registered as a webfont with a retained buffer. Returns the lowercased
 * key suitable for `webfontRegistry.get`, or null when no name in the
 * stack matches a registered webfont (e.g. all generic / system fallbacks).
 */
function firstWebfontFamilyInStack(fontFamily: string): string | null {
  const names = fontFamily.split(",").map((n) => n.trim().replace(/^["']|["']$/g, "").toLowerCase());
  for (const n of names) {
    if (webfontRegistry.has(n)) return n;
  }
  return null;
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
interface FontPath { path: string; postscriptName?: string; extractor?: "fontkit" | "coretext" }
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
  //
  // PingFang SC: what Chrome on macOS actually paints unmarked Han ideographs
  // (漢 字 北 京 東 明 日 …) through, NOT HiraginoSansGB. Verified via CDP
  // `CSS.getPlatformFontsForNode` against the 02-text-ruby fixture: every Han
  // codepoint resolves to "蘋方-簡" (PingFang SC). PingFang stores its outlines
  // in Apple's proprietary `hvgl` table — fontkit's outline parser doesn't
  // read that, so we route extraction through the CoreText helper
  // (`tools/macos-glyph-extractor/`). HiraginoSansGB stays as the secondary
  // route via `cjk` for any glyph PingFang lacks. DM-382 / DM-364 / DM-385 /
  // DM-388.
  "pingfang-sc":      { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangSC-Regular", extractor: "coretext" },
  "pingfang-sc-bold": { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangSC-Medium", extractor: "coretext" },
  // Per-locale PingFang variants (DM-394). Apple ships the same `hvgl`-only
  // PingFang.ttc with regional faces for Traditional Chinese, Hong Kong, and
  // Macau. Chrome routes by computed `lang`: zh-TW / zh-Hant → TC, zh-HK → HK,
  // zh-MO → MO. There is no `PingFangJP-Regular` postscriptName on macOS;
  // Japanese text routes through `hiragino-jp` (HiraKakuProN) instead.
  "pingfang-tc":      { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangTC-Regular", extractor: "coretext" },
  "pingfang-tc-bold": { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangTC-Medium", extractor: "coretext" },
  "pingfang-hk":      { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangHK-Regular", extractor: "coretext" },
  "pingfang-hk-bold": { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangHK-Medium", extractor: "coretext" },
  "pingfang-mo":      { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangMO-Regular", extractor: "coretext" },
  "pingfang-mo-bold": { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangMO-Medium", extractor: "coretext" },
  "cjk":             { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", postscriptName: "HiraginoSansGB-W3" },
  "cjk-bold":        { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", postscriptName: "HiraginoSansGB-W6" },
  // Songti SC Light (postscriptName STSongti-SC-Light) is what Chrome on
  // macOS picks for CJK chars when the primary is a SERIF family
  // (`font-family: serif` / `Times` / `ui-serif` / `fangsong` / `math` /
  // bare UA default body). Empirical pixel probe at 16px against `font-
  // family: serif` rendering "你好世界" shows STSongti-SC-Light produces
  // a 100.000% pixel match — neither HiraginoSansGB-W3 (90.20%) nor
  // Songti SC Regular (90.23%) matches. DM-333. Same em-square advance
  // (16px @16px) as the sans-serif `cjk` route, so layout is unaffected;
  // only the visible glyph shape (stroke contrast / Mincho-style shapes)
  // changes when the primary is serif.
  "cjk-serif":       { path: "/System/Library/Fonts/Supplemental/Songti.ttc", postscriptName: "STSongti-SC-Light" },
  "cjk-serif-bold":  { path: "/System/Library/Fonts/Supplemental/Songti.ttc", postscriptName: "STSongti-SC-Bold" },
  // Hiragino Sans (the Japanese family, not GB) covers a much wider set of
  // Geometric Shapes and Misc Symbols at em-square width — ◉◌◐◑ ☀☁☂☃ etc. —
  // that the GB family lacks. Chrome on macOS routes these chars here when
  // the primary Helvetica/Times/etc. doesn't have them and HiraginoSansGB
  // doesn't either, painting at 18px em-square; Apple Symbols' versions are
  // proportional 11-15px so falling all the way through to "symbols" left
  // them visibly narrower than Chrome (DM-324 / DM-326). The TTC ships W3..W9
  // sub-fonts; W3 is the regular weight, W6 is the bold pair to match the
  // existing cjk → cjk-bold weight swap.
  "hiragino-jp":      { path: "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", postscriptName: "HiraKakuProN-W3" },
  "hiragino-jp-bold": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", postscriptName: "HiraKakuProN-W6" },
  // Korean Hangul (U+AC00..D7AF Syllables, U+1100..11FF Jamo). Chrome on
  // macOS paints Hangul via Apple SD Gothic Neo — neither Hiragino Sans GB
  // (the `cjk` chain) nor PingFang SC includes Hangul codepoints, so a
  // missing dedicated route leaves Korean text as tofu boxes. DM-691.
  "korean":           { path: "/System/Library/Fonts/AppleSDGothicNeo.ttc", postscriptName: "AppleSDGothicNeo-Regular" },
  "korean-bold":      { path: "/System/Library/Fonts/AppleSDGothicNeo.ttc", postscriptName: "AppleSDGothicNeo-Bold" },
  "thai":            { path: "/System/Library/Fonts/ThonburiUI.ttc", postscriptName: ".ThonburiUI-Regular" },
  "devanagari":      { path: "/System/Library/Fonts/Kohinoor.ttc", postscriptName: "KohinoorDevanagari-Regular" },
  "symbols":         { path: "/System/Library/Fonts/Apple Symbols.ttf" },
  // Chrome on macOS routes a handful of arrow codepoints (↑ ↓) to LucidaGrande
  // rather than Apple Symbols — Apple Symbols' ↑ ↓ are 9.86/10.28px wide
  // @22px while LucidaGrande's are 14.19/14.19px, and Chrome's captured
  // bounding box matches LucidaGrande to within 0.01px. DM-369. Other arrows
  // (↔ ⇒ ⇔ etc.) stay on Apple Symbols because LucidaGrande lacks those
  // glyphs.
  "lucida-grande":   { path: "/System/Library/Fonts/LucidaGrande.ttc", postscriptName: "LucidaGrande" },
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
  // Generic serif. Chrome on macOS resolves `font-family: serif`, bare
  // `Times`, `ui-serif`, and the UA-default body/h1 (when no font-family is
  // set) to Apple's `Times.ttc` — NOT to Times New Roman. The two faces have
  // identical advance widths for every glyph tested (so layout is unchanged)
  // but visibly different outlines: Apple Times has bolder em-dash / en-dash
  // bars (H=185 units in Bold vs TNR's 122) and slightly taller caps. The
  // h1 default font-weight: bold made the em-dash mismatch the most visible
  // case (DM-330). Author-named "Times New Roman" still routes to the
  // separate `times-new-roman*` keys below so explicit requests are honored.
  "times":              { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-Roman" },
  "times-bold":         { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-Bold" },
  "times-italic":       { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-Italic" },
  "times-bold-italic":  { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-BoldItalic" },
  // Times New Roman (the Microsoft face shipped in Supplemental on macOS) is
  // what Chrome picks when CSS specifies `font-family: "Times New Roman"`
  // explicitly — same advance metrics as Apple's Times above but a thinner
  // em-dash / en-dash and shorter caps.
  "times-new-roman":              { path: "/System/Library/Fonts/Supplemental/Times New Roman.ttf" },
  "times-new-roman-bold":         { path: "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf" },
  "times-new-roman-italic":       { path: "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf" },
  "times-new-roman-bold-italic":  { path: "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf" },
  "georgia":             { path: "/System/Library/Fonts/Supplemental/Georgia.ttf" },
  "georgia-bold":        { path: "/System/Library/Fonts/Supplemental/Georgia Bold.ttf" },
  "georgia-italic":      { path: "/System/Library/Fonts/Supplemental/Georgia Italic.ttf" },
  "georgia-bold-italic": { path: "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf" },
  // Generic cursive — Chrome on macOS resolves `cursive` to Apple Chancery
  // (NOT Snell Roundhand). Empirical probe at 16px on the sample "The quick
  // brown fox jumps over the lazy dog": Chrome cursive = 290.08px, Apple
  // Chancery = 290.08px, Snell Roundhand = 263.84px. SnellRoundhand stays in
  // FONT_PATHS for `font-family: "Snell Roundhand"` author requests.
  "snell":           { path: "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc", postscriptName: "SnellRoundhand" },
  "apple-chancery":  { path: "/System/Library/Fonts/Supplemental/Apple Chancery.ttf" },
  // Generic fantasy — Chrome on macOS resolves `fantasy` to Papyrus.
  // Empirical probe at 16px: Chrome fantasy = 313.94px, Papyrus = 313.94px,
  // Impact = 286.03px (a common other "fantasy" candidate, but not what
  // Chrome picks). Papyrus.ttc ships W3 + Condensed sub-fonts; the default
  // (no postscriptName) picks the Regular member.
  "papyrus":         { path: "/System/Library/Fonts/Supplemental/Papyrus.ttc", postscriptName: "Papyrus" },
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
/**
 * Pick the PingFang regional variant key (or `hiragino-jp` for Japanese)
 * that matches the element's computed `lang`. Returns null when the lang
 * is empty / unknown — caller should fall through to the default `pingfang-sc`
 * route in that case. DM-394.
 *
 * Matches BCP-47 language tags: the primary subtag wins, with a Han-script
 * subtag (`Hans` / `Hant`) overriding region for the simplified-vs-traditional
 * split. Examples:
 *   "zh-TW"           → pingfang-tc
 *   "zh-Hant"         → pingfang-tc
 *   "zh-Hant-HK"      → pingfang-hk (region is more specific than script)
 *   "zh-HK"           → pingfang-hk
 *   "zh-MO"           → pingfang-mo
 *   "zh-CN" / "zh-Hans" / "zh" / "" → null (caller picks pingfang-sc)
 *   "ja" / "ja-JP"    → hiragino-jp (PingFang has no JP subfont on macOS)
 */
export function pingfangKeyForLang(lang: string | undefined): string | null {
  if (lang == null || lang === "") return null;
  const lower = lang.toLowerCase();
  // Japanese: not a PingFang variant — Apple's PingFang.ttc has no PingFangJP
  // postscriptName. Route Japanese Han through Hiragino Kaku (HiraKakuProN).
  if (lower === "ja" || lower.startsWith("ja-")) return "hiragino-jp";
  // Match `zh-*` (or any tag that opts into a Chinese region/script).
  if (lower !== "zh" && !lower.startsWith("zh-") && !lower.includes("-zh-")) return null;
  // Region subtags win over script subtags when both appear (zh-Hant-HK = HK).
  if (lower.includes("-hk")) return "pingfang-hk";
  if (lower.includes("-mo")) return "pingfang-mo";
  if (lower.includes("-tw")) return "pingfang-tc";
  if (lower.includes("-cn") || lower.includes("-sg")) return null; // SC default
  if (lower.includes("hant")) return "pingfang-tc";
  if (lower.includes("hans")) return null; // SC default
  return null;
}

export function fallbackFontChain(codepoint: number, primaryKey?: string, lang?: string): string[] {
  // When the primary family is a serif (Apple Times / Times New Roman /
  // Georgia, or fangsong/math/serif/ui-serif which all resolve to `times`),
  // CJK fallback should produce SERIF CJK glyphs (Songti SC Light) instead
  // of the default sans-serif Hiragino Sans GB. DM-333. The check is just
  // the resolved key — `times` includes serif/fangsong/math/ui-serif/UA-
  // default since they all collapse to that key in `resolveFontKey`.
  const serifPrimary = primaryKey === "times" || primaryKey === "times-new-roman" || primaryKey === "georgia";
  // Hebrew (U+0590..05FF) + presentation forms (U+FB1D..FB4F).
  // sf-hebrew before lucida-grande as a probe: SFHebrew layouts "שלום עולם"
  // at 68.62px @16px while LucidaGrande layouts at 75.85px. Captured xs from
  // Chrome's `font-family: sans-serif` paint in 02-text-bidi land at 63.766
  // for ש's ink-left, suggesting a run width around 75 (closer to LucidaGrande
  // — Chrome's Helvetica → Hebrew CoreText fallback). Track DM-347 follow-up.
  if ((codepoint >= 0x0590 && codepoint <= 0x05FF)
    || (codepoint >= 0xFB1D && codepoint <= 0xFB4F)) {
    return ["lucida-grande", "sf-hebrew"];
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
  // Hangul (Korean) — Syllables + Jamo. Route to Apple SD Gothic Neo FIRST
  // because Hiragino Sans GB and PingFang SC don't carry Hangul codepoints;
  // without this branch Korean text falls all the way through to tofu
  // boxes. Keep `cjk` as a final fallback for the rare codepoint Apple SD
  // Gothic Neo lacks. DM-691.
  if ((codepoint >= 0xAC00 && codepoint <= 0xD7AF)
    || (codepoint >= 0x1100 && codepoint <= 0x11FF)) {
    return ["korean", "cjk"];
  }
  // CJK: Unified Ideographs + Ext A, Hiragana, Katakana (+ phonetic exts),
  // CJK Symbols & Punctuation. Hangul is handled above.
  if ((codepoint >= 0x3000 && codepoint <= 0x303F)
    || (codepoint >= 0x3040 && codepoint <= 0x309F)
    || (codepoint >= 0x30A0 && codepoint <= 0x30FF)
    || (codepoint >= 0x31F0 && codepoint <= 0x31FF)
    || (codepoint >= 0x3400 && codepoint <= 0x4DBF)
    || (codepoint >= 0x4E00 && codepoint <= 0x9FFF)
    || (codepoint >= 0xF900 && codepoint <= 0xFAFF)) {
    // Serif primary → SERIF CJK font first (DM-333). Keep `cjk`
    // (HiraginoSansGB) as a secondary so chars Songti SC Light lacks (a
    // small set in the rare extension blocks) still resolve.
    // For sans-serif primary, route Han Unified Ideographs (and Ext A) through
    // PingFang SC via CoreText first — that's what Chrome actually paints
    // (DM-382). The `cjk` HiraginoSansGB chain stays as the fallback for
    // any codepoint PingFang lacks AND for the Hiragana/Katakana/Hangul/
    // CJK Symbols ranges where Hiragino is what Chrome picks. Bold scope is
    // resolved at `getFontInstance` time: weight ≥ 600 → pingfang-sc-bold.
    if (serifPrimary) return ["cjk-serif", "cjk"];
    const isHan = (codepoint >= 0x4E00 && codepoint <= 0x9FFF)
        || (codepoint >= 0x3400 && codepoint <= 0x4DBF)
        || (codepoint >= 0xF900 && codepoint <= 0xFAFF);
    if (!isHan) return ["cjk"];
    // For Han: prefer the lang-matching PingFang variant (or hiragino-jp for
    // Japanese) when lang is set, otherwise fall through to PingFang SC. The
    // bare `cjk` (HiraginoSansGB) stays as the safety net for any glyph
    // PingFang lacks in the rare extension blocks.
    const localeKey = pingfangKeyForLang(lang);
    if (localeKey === "hiragino-jp") return ["hiragino-jp", "cjk"];
    if (localeKey != null) return [localeKey, "pingfang-sc", "cjk"];
    return ["pingfang-sc", "cjk"];
  }
  // Box Drawing / Block Elements (U+2500..U+259F).
  //
  // When the primary font is MONOSPACE (Courier / Menlo / Monaco / SF Mono),
  // route box-drawing chars to the SAME primary font (with Menlo as a
  // safety net for chars the primary lacks). Chrome paints these chars at
  // monospace cell width — empirically Courier @13px paints `─ │ ┌ ┬ ┼ …`
  // all at 7.827 px, matching `M` / `a` to the sub-px — so the ASCII-art
  // box in `02-text-preformatted.html`'s `<pre>` aligns cleanly. Routing
  // mono primaries through Hiragino's em-wide glyphs (16 px @ 13 px font
  // = 1.23 em) overran the cell and broke the box alignment (DM-780).
  //
  // For non-monospace primaries (Helvetica / Arial / SF Pro body text)
  // Chrome's CoreText fallback for missing box-drawing glyphs lands in
  // Hiragino — those em-wide glyphs are what Chrome actually paints, and
  // they connect seamlessly because the surrounding text isn't on a fixed
  // cell grid anyway. The Helvetica/Menlo split that DM-442 fixed (some
  // box chars in Helvetica, others falling through to Menlo's narrower
  // glyphs and breaking corner joins) is exactly what we want to avoid
  // here too. Menlo stays as the final safety net.
  if (codepoint >= 0x2500 && codepoint <= 0x259F) {
    const monoPrimary = primaryKey === "courier" || primaryKey === "menlo"
      || primaryKey === "monaco" || primaryKey === "sf-mono";
    if (monoPrimary) return [primaryKey, "menlo", "hiragino-jp"];
    return ["hiragino-jp", "menlo"];
  }
  // Dingbats → Zapf Dingbats. macOS Chrome paints ✂✈✏✔✘✚✦❄❤❶ via Zapf
  // Dingbats; Apple Symbols has the same codepoints but at different (often
  // narrower) widths — empirical match shows Chrome consistently picks Zapf.
  if (codepoint >= 0x2700 && codepoint <= 0x27BF) return ["zapf-dingbats", "symbols"];
  // Geometric Shapes (▲△▽★☆♀♂…) and Misc Symbols (☀☁☂♠♥♦…) — Chrome on
  // macOS paints many of these at the CJK em-square width (16px @16px font-
  // size) via Hiragino Sans GB, NOT Apple Symbols (which has them at
  // proportional 9-14px). Try CJK first; fall through to Apple Symbols for
  // the chars Hiragino lacks (☘ ☑ ◇ etc.). DM-256. Insert Japanese Hiragino
  // Sans (HiraKakuProN-W3) between cjk-GB and Apple Symbols — it covers
  // ◉◌◐◑ (DM-324) and ☀☁☂☃ (DM-326) at em-square width when GB doesn't,
  // matching Chrome's 18px paint instead of falling through to Apple
  // Symbols' narrower 11-15px advance.
  // Within Geometric Shapes, the small filled / outline primitives that
  // LucidaGrande carries at narrow proportional advance — ■ □ ● ○ ◆ ◇ —
  // are what Chrome's CoreText cascade for `font-family: sans-serif`
  // (Helvetica) actually picks for those individual codepoints, NOT the
  // CJK/Hiragino em-square glyph that the rest of the block uses. Probed
  // against captured xOffsets in 02-text-symbols (DM-349):
  //   ■ □ : LucidaGrande 9.76px @18px (Hiragino paints 18px → 8px too wide)
  //   ● ○ : LucidaGrande 10.41px @18px (Hiragino 18px too wide)
  //   ◆   : LucidaGrande 13.01px @18px
  //   ◇   : LucidaGrande 11.07px @18px
  // Everything else in 0x25A0..25FF (▲▽◉◌◐◑★…) Chrome paints at em-square
  // via Hiragino — keep those on the existing chain.
  // DM-415 / DM-429: tried routing patterned squares (U+25A3..A8 + U+25C8)
  // to AppleSDGothicNeo and SF NS for the open-shape primitives, but the
  // painted-ink size came out larger than Chrome's actual paint despite the
  // advance widths matching — Chrome uses a font with smaller-ink-in-wider-
  // advance for these. Reverted; the LucidaGrande route remains the closest
  // visible match in our available font set. Tracked further in DM-429.
  if (codepoint === 0x25A0 || codepoint === 0x25A1
    || codepoint === 0x25CF || codepoint === 0x25CB
    || codepoint === 0x25C6 || codepoint === 0x25C7) {
    return ["lucida-grande", "symbols"];
  }
  // Chess pieces ♔..♟ (U+2654..U+265F) — Chrome routes these through Menlo,
  // not Apple Symbols. Verified via CDP CSS.getPlatformFontsForNode at 22px
  // sans-serif: Chrome reports the font as "Menlo" and the captured advance
  // (13.234px @22px) matches Menlo's 13.245px exactly, while Apple Symbols
  // paints them at 17.188/17.284 — ~4px too wide, causing ♚ to overlap ♔
  // in domotion's render. (DM-380)
  if (codepoint >= 0x2654 && codepoint <= 0x265F) {
    return ["menlo", "symbols"];
  }
  if ((codepoint >= 0x25A0 && codepoint <= 0x25FF)
    || (codepoint >= 0x2600 && codepoint <= 0x26FF)) {
    return ["cjk", "hiragino-jp", "symbols"];
  }
  // Arrows: most of the Arrows block (↔↦⇒⇔ …) routes to Apple Symbols
  // below, but specific codepoints split off:
  //   ← → ↗ ↙  — Hiragino W6 at the CJK em-square width (24px @24px), which
  //              is what Chrome paints; Apple Symbols has them at 15-17px,
  //              rendering visibly thinner (DM-296).
  //   ↑ ↓     — LucidaGrande at 14.19px @22px, which matches Chrome's
  //              captured bounding box; Apple Symbols paints them at
  //              9.86/10.28px and Hiragino paints at 22/24px, both wrong
  //              (DM-369).
  // ← → ↑ ↓ — Lucida Grande at every size (12 → 32 px), per CDP
  // `CSS.getPlatformFontsForNode` (DM-405). The painted glyph is the
  // chunkier LucidaGrande arrow; CJK Hiragino's thin outline visibly
  // diverges (DM-296 reverted by DM-405).
  if (codepoint === 0x2190 || codepoint === 0x2192
      || codepoint === 0x2191 || codepoint === 0x2193) {
    return ["lucida-grande", "symbols"];
  }
  // ↗ ↙ — Lucida Grande LACKS these codepoints (verified via fontkit
  // `glyphForCodePoint(0x2197).id === 0` on the system .ttc, all four
  // faces). The earlier consolidation onto "lucida-grande" silently fell
  // through to Apple Symbols at ~10 px advance — visibly half the width
  // Chrome paints (16 px at 16 px font). Hiragino Sans GB has them at
  // em-width (adv=1000 / em=1000 → 16 px), matching Chrome's painted
  // advance. (DM-441.)
  if (codepoint === 0x2197 || codepoint === 0x2199) {
    return ["cjk", "hiragino-jp", "symbols"];
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

/**
 * Codepoints Chrome on macOS paints via the color-emoji font (Apple Color
 * Emoji), regardless of any path-font's coverage. Mirrors the predicate in
 * `src/dom-to-svg.ts` (CAPTURE_SCRIPT's `needsRaster`) so the path pipeline
 * can skip emitting the .notdef tofu rectangle for these codepoints — the
 * raster <image> overlay added by the capture layer already covers the
 * visible glyph, and emitting the tofu underneath produces a visible
 * black rectangle around the edges of the emoji where the raster has
 * sub-pixel transparency. (DM-334.)
 */
/**
 * Codepoints in the Unicode Private Use Areas — these are author-assigned
 * (typically icon-font) glyphs. When the host system fonts don't cover the
 * codepoint, fontkit returns a `.notdef` tofu (a striated rectangle). We
 * suppress that emission rather than paint the tofu — a missing icon should
 * read as "nothing" not as a glyph-shaped black blob over surrounding text
 * (apple.com country dropdown checkmark covering the leading 'P' of
 * 'Philippines' — DM-490 / DM-500).
 */
function isPrivateUseCodepoint(cp: number): boolean {
  // BMP PUA
  if (cp >= 0xE000 && cp <= 0xF8FF) return true;
  // Supplementary PUA-A
  if (cp >= 0xF0000 && cp <= 0xFFFFD) return true;
  // Supplementary PUA-B
  if (cp >= 0x100000 && cp <= 0x10FFFD) return true;
  return false;
}

function isEmojiCodepoint(cp: number, nextCp: number): boolean {
  // Misc Symbols block (U+2600..26FF) chars with default emoji presentation.
  if (cp === 0x2614 || cp === 0x2615 || (cp >= 0x2648 && cp <= 0x2653)
    || cp === 0x267F || cp === 0x2693 || cp === 0x26A1 || cp === 0x26AA || cp === 0x26AB
    || cp === 0x26BD || cp === 0x26BE || cp === 0x26C4 || cp === 0x26C5 || cp === 0x26CE
    || cp === 0x26D4 || cp === 0x26EA || cp === 0x26F2 || cp === 0x26F3 || cp === 0x26F5
    || cp === 0x26FA || cp === 0x26FD) return true;
  // Dingbats Chrome routes to Apple Color Emoji (✨ ❌ ❎ ❓ ❔ ❕ ❗ ➕ ➖ ➗ ➡ ➰ ➿ etc.).
  if (cp === 0x2728 || cp === 0x2753 || cp === 0x2754 || cp === 0x2755 || cp === 0x2757
    || cp === 0x274C || cp === 0x274E || cp === 0x2795 || cp === 0x2796 || cp === 0x2797
    || cp === 0x27A1 || cp === 0x27B0 || cp === 0x27BF) return true;
  // VS-16 (U+FE0F) after a base emoji codepoint requests color presentation.
  if (nextCp === 0xFE0F && cp >= 0x2600 && cp <= 0x26FF) return true;
  // Regional-indicator flags (pairs are joined into country flag emoji).
  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return true;
  // Main emoji blocks: Misc Symbols & Pictographs, Emoticons, Transport,
  // Alchemical, Supplemental Symbols, Pictographs Extended-A/B.
  if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;
  return false;
}

function getFontInstance(key: string, weight: number, fontSize: number, slant: number = 0, variationSettings?: Record<string, number>): FontInstance | null {
  // Webfont keys (`webfont:<lowercased family>`) resolve through the runtime
  // registry rather than the on-disk FONT_PATHS table.
  if (key.startsWith("webfont:")) {
    return pickWebfontVariant(key.slice("webfont:".length), weight, fontSize, slant, variationSettings);
  }
  // `localalias:<family>` — the family was declared via @font-face local() and
  // we tracked one or more declared (weight, italic) variants pointing at base
  // FONT_PATHS keys. Pick the closest declared variant and use ITS weight /
  // italic to drive the sibling-file selection below — NOT the requested
  // weight/italic — so Chrome's "no bold-italic declared → use italic 400"
  // behavior is preserved instead of silently substituting the on-disk
  // bold-italic sibling. DM-360.
  if (key.startsWith("localalias:")) {
    const family = key.slice("localalias:".length);
    const variant = pickLocalFontAliasVariant(family, weight, slant !== 0);
    if (variant == null) return null;
    return getFontInstance(variant.baseKey, variant.weight, fontSize, variant.italic ? slant : 0, variationSettings);
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
      || key === "times" || key === "times-new-roman" || key === "georgia") {
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
  if (key === "cjk-serif" && weight >= 600) {
    effectiveKey = "cjk-serif-bold";
  }
  if (key === "hiragino-jp" && weight >= 600) {
    effectiveKey = "hiragino-jp-bold";
  }
  // Apple SD Gothic Neo (Hangul). DM-691.
  if (key === "korean" && weight >= 600) {
    effectiveKey = "korean-bold";
  }
  // PingFang ships separate weight subfonts in PingFang.ttc — Regular for
  // body weight, Medium for semibold+. No italic. Same pattern across all
  // regional variants (SC / TC / HK / MO).
  if ((key === "pingfang-sc" || key === "pingfang-tc"
       || key === "pingfang-hk" || key === "pingfang-mo")
      && weight >= 600) {
    effectiveKey = `${key}-bold`;
  }
  // DM-578: include author-set variation settings in the cache key so two
  // elements requesting the same (key, weight, size, slant) but with different
  // axis overrides don't share a single cached instance.
  const fvsKey = variationSettings != null
    ? Object.keys(variationSettings).sort().map((t) => `${t}=${variationSettings[t]}`).join(",")
    : "";
  const cacheKey = `${effectiveKey}-${weight}-${fontSize}-${slant}-${fvsKey}`;
  if (fontInstanceCache.has(cacheKey)) return fontInstanceCache.get(cacheKey)!;

  const spec = FONT_PATHS[effectiveKey];
  if (spec == null) return null;

  // CoreText-extractor route: route to the macOS Swift helper (DM-385 / DM-388).
  // When the helper isn't present (non-darwin host, dev hasn't built it,
  // DOMOTION_DISABLE_HELPER set), fall through to fontkit — the renderer's
  // chain logic skips fontkit-empty paths and walks to the next candidate
  // (`cjk` / HiraginoSansGB for the PingFang case), preserving the pre-DM-385
  // baseline.
  if (spec.extractor === "coretext" && isCoretextHelperAvailable()) {
    const coretextFont = createCoretextFont({ postscriptName: spec.postscriptName, fontPath: spec.path });
    if (coretextFont != null) {
      const instance = coretextFont as unknown as FontInstance;
      fontInstanceCache.set(cacheKey, instance);
      return instance;
    }
  }
  if (spec.extractor === "coretext") return null;

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
    const instance = applyVariationAxes(font, weight, fontSize, slant, variationSettings);
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
function applyVariationAxes(font: any, weight: number, fontSize: number, slant: number, variationSettings?: Record<string, number>): FontInstance {
  if (font.variationAxes == null || Object.keys(font.variationAxes).length === 0 || font.getVariation == null) {
    return font;
  }
  const axes: Record<string, number> = {};
  if (font.variationAxes.wght != null) axes.wght = weight;
  if (font.variationAxes.opsz != null) axes.opsz = fontSize;
  if (slant !== 0 && font.variationAxes.slnt != null) axes.slnt = slant;
  // DM-578: author-set `font-variation-settings` wins over the CSS-weight /
  // font-size-derived defaults. Skip axes the font doesn't expose — fontkit
  // would otherwise reject the variation entirely on an unknown tag.
  if (variationSettings != null) {
    for (const tag of Object.keys(variationSettings)) {
      if (font.variationAxes[tag] != null) axes[tag] = variationSettings[tag];
    }
  }
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
    // `@font-face { src: local(...) }` alias — the page declared one or more
    // @font-face rules whose first local() source resolves to a system font
    // we already know about (Georgia / Menlo / Times / etc.). Return a
    // `localalias:` prefixed key so getFontInstance can score the requested
    // weight/italic against the registered variants — important when the page
    // declared regular + italic + bold but NOT bold-italic (DM-360 / DM-303).
    if (localFontAliasRegistry.has(name)) return `localalias:${name}`;
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
    // `Times New Roman` resolves to the Microsoft TNR face (separate file from
    // Apple's Times.ttc); bare `Times` / `serif` / `ui-serif` / the UA default
    // resolve to Apple Times (DM-330). The two have identical metrics but
    // visibly different em-dash glyphs in bold weights.
    if (name === "times new roman") return "times-new-roman";
    if (name === "serif" || name === "ui-serif" || name === "times") return "times";
    if (name === "georgia") return "georgia";
    // Chrome on macOS resolves the CSS `cursive` generic keyword to Apple
    // Chancery (per the empirical probe — bare `cursive` paints at exactly
    // Apple Chancery's advance, NOT Snell Roundhand's, on macOS Sonoma+).
    // Author-named "Snell Roundhand" / "Brush Script MT" still get their
    // explicit families.
    if (name === "cursive" || name === "apple chancery") return "apple-chancery";
    if (name === "snell roundhand" || name === "brush script mt") return "snell";
    // Chrome on macOS resolves the CSS `fantasy` generic to Papyrus
    // (empirical probe: 313.94px = Papyrus's exact advance on the sample).
    if (name === "fantasy" || name === "papyrus") return "papyrus";
    // Chrome on macOS resolves `sans-serif`, `helvetica`, and `helvetica neue`
    // to Helvetica (Blink: font_cache_mac.mm + font_fallback_list.cc — the
    // generic `sans-serif` keyword is hardcoded to Helvetica on macOS, not
    // SF Pro). Matching this exactly is critical: SF Pro has different
    // glyph shapes (notably the `1`, `R`, `g`) and ~2% wider metrics than
    // Helvetica at the same em size, so substituting it produces visible
    // drift on every page that uses the default sans-serif.
    if (name === "sans-serif" || name === "helvetica"
      || name === "helvetica neue") return "helvetica";
    if (name === "arial") return "arial";
    // system-ui / BlinkMacSystemFont / "SF Pro" → SF Pro.
    // These keywords mean "the platform UI font", which on modern macOS is
    // San Francisco. NOTE: `-apple-system` is INTENTIONALLY excluded —
    // empirical probe (DM-291) on the current Chromium build shows bare
    // `-apple-system` resolves to the UA standard font (Times, 35.98px on
    // the "greet" sample at 18px) rather than SF Pro (42.20px), and as a
    // first family in a stack like `-apple-system, sans-serif` Chrome falls
    // through to `sans-serif` → Helvetica (41.03px). Mapping it to SF Pro
    // here paints the Latin glyphs ~3% wider than Chrome on every test that
    // uses the historically-canonical -apple-system stack, including the
    // text-mixed-script feature fixture's "greet" / "Hello" runs which
    // jammed against the adjacent Arabic/CJK glyphs because SF Pro's "t"
    // and "o" advances are ~1px wider than Helvetica's at 18px. Let
    // `-apple-system` fall through via the `continue` clause below.
    if (name === "system-ui" || name === "blinkmacsystemfont"
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
    if (name === "ui-monospace" || name === "ui-rounded" || name === "ui-sans-serif"
      || name === "math" || name === "emoji" || name === "fangsong"
      || name === "-apple-system") continue;
  }
  // Last-resort fallback when no family in the stack matched. Chrome's
  // ultimate fallback on macOS for an unrecognized name is the user's
  // configured "Standard Font" preference, which defaults to Times.
  return "times";
}

function resolveFont(fontFamily: string, fontWeight: number, fontSize: number, slant: number = 0, variationSettings?: Record<string, number>): FontInstance | null {
  return getFontInstance(resolveFontKey(fontFamily), fontWeight, fontSize, slant, variationSettings);
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
  /** BCP-47 language tag from the element's computed `lang` attribute. Routes
   *  Han fallbacks to the matching PingFang regional variant — `zh-TW` / `zh-Hant`
   *  → PingFang TC, `zh-HK` → PingFang HK, `zh-MO` → PingFang MO, `ja` →
   *  Hiragino Kaku, otherwise PingFang SC. (DM-394) */
  lang?: string,
  /** Author-set `font-variation-settings` axis overrides for variable webfonts
   *  (e.g. `{ opsz: 30, wght: 450 }` from framer.com's body P). Wins over the
   *  CSS-weight / font-size-derived defaults. DM-578. */
  variationSettings?: Record<string, number>,
): TextPathResult | null {
  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings);
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
    let curFontOverride: FontInstance | null = null; // DM-557: per-codepoint webfont variant
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
      let useFontOverride: FontInstance | null = null;
      if ((primaryFont as any).glyphForCodePoint(cp).id === 0) {
        // DM-557: for a partitioned webfont family (Geist split across
        // Latin / Latin-Ext / Cyrillic / etc. by `unicode-range`), the
        // Latin-biased `pickWebfontVariant` returns the Latin partition as
        // primary. Codepoints outside that partition's range have no glyph
        // in the primary, but they MAY be covered by another registered
        // variant of the same family. Try a codepoint-aware variant lookup
        // BEFORE walking the system fallback chain — picking the matching
        // partition matches Chrome's @font-face cascade and preserves the
        // family's typographic identity instead of falling to a body system
        // font.
        if (primaryFontKey.startsWith("webfont:")) {
          const family = primaryFontKey.slice("webfont:".length);
          const cpVariant = pickWebfontVariantForCodepoint(family, weight, fontSize, slant, cp, variationSettings);
          if (cpVariant != null && (cpVariant as any).glyphForCodePoint(cp).id !== 0) {
            // Use the codepoint-aware variant. Keep `useKey` = primary so the
            // run discriminator still groups with primary at the key level;
            // the font instance override propagates through the run grouping
            // below to give this codepoint its own (or coalesced) run.
            useFontOverride = cpVariant;
          }
        }
        if (useFontOverride == null) {
          // Walk the chain in order, pick the first font that actually has
          // the glyph. If nothing in the chain has it (e.g. an exotic emoji
          // that even Apple Symbols lacks), fall through to the LAST chain
          // entry anyway — its .notdef has a stable advance the rasterGlyph
          // overlay can pin a captured emoji PNG against, where switching
          // to primary's .notdef would shift glyph positions and drift the
          // rest of the line.
          const chain = fallbackFontChain(cp, primaryFontKey, lang);
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
      }
      // DM-557: a per-codepoint webfont variant is a different FontInstance
      // even when its `useKey` matches `curKey` (both are the primary
      // family's webfont:<key>). Discriminate runs by the (key, override)
      // pair so a Latin-partition run and a Cyrillic-partition run within
      // the same Geist family stay separate even though they share the key.
      const runChanged = useKey !== curKey || useFontOverride !== curFontOverride;
      if (runChanged && curText.length > 0) {
        // Variation settings apply to the primary requested font, not to
        // system fallbacks reached for missing glyphs (CJK / emoji / symbols
        // weren't declared by the page's @font-face).
        const fvs = curKey === primaryFontKey ? variationSettings : undefined;
        const f = curFontOverride ?? getFontInstance(curKey, weight, fontSize, slant, fvs);
        if (f != null) runs.push({ fontKey: curKey, font: f, text: curText, startIdx: curStart, endIdx: i });
        curText = "";
        curStart = i;
      }
      curKey = useKey;
      curFontOverride = useFontOverride;
      curText += ch;
      i += ch.length;
    }
    if (curText.length > 0) {
      const fvs = curKey === primaryFontKey ? variationSettings : undefined;
      const f = curFontOverride ?? getFontInstance(curKey, weight, fontSize, slant, fvs) ?? primaryFont;
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
  // Synthesis covers all six font-variant-caps modes (DM-294 + DM-444):
  //   small-caps      → smcp                (lowercase → small-cap scale)
  //   all-small-caps  → smcp + c2sc         (lowercase + uppercase → small-cap scale)
  //   petite-caps     → pcap                (lowercase → petite-cap scale)
  //   all-petite-caps → pcap + c2pc         (lowercase + uppercase → petite-cap scale)
  //   unicase         → unic                (uppercase → small-cap scale; lowercase → small-cap)
  //   titling-caps    → titl                (no synthesis fallback; rely on OT feature or no-op)
  // The body-text fonts on macOS (Helvetica / Arial / SF Pro / Georgia /
  // Times / Menlo) lack pcap, c2pc, c2sc, unic, and titl entirely, so the
  // synthesis path runs whenever any of these is requested.
  const features_ = features ?? [];
  const wantSmcp   = features_.includes("smcp");
  const wantC2sc   = features_.includes("c2sc");
  const wantPcap   = features_.includes("pcap");
  const wantC2pc   = features_.includes("c2pc");
  const wantUnic   = features_.includes("unic");
  const availableFeatures = Array.isArray((primaryFont as any).availableFeatures)
    ? ((primaryFont as any).availableFeatures as string[]) : [];
  const hasFeature = (f: string) => availableFeatures.includes(f);
  // Determine the synthesized scale for lowercase / uppercase letters under
  // each variant. `null` means do not transform (keep native glyph at 1.0).
  // Chromium uses a single synthesis multiplier for ALL caps variants:
  // `kSmallCapsFontSizeMultiplier = 0.7f` in
  // third_party/blink/renderer/platform/fonts/simple_font_data.cc. Per CSS
  // Fonts 4 §7.4, petite-caps falls back to small-caps when the font lacks
  // pcap / c2pc, and Chrome uses the same 0.7 scale for the synthesized
  // form (no separate kPetiteCapsFontSizeMultiplier exists). Our macOS body
  // fonts (Helvetica/Arial/SF Pro/Georgia/Times/Menlo) ship neither pcap
  // nor c2pc, so the petite path always synthesizes at 0.7 to match Chrome's
  // painted output. (DM-444 follow-up.)
  const SMALL_CAP_SCALE = 0.7;
  let synthLowerScale: number | null = null;
  let synthUpperScale: number | null = null;
  if (wantSmcp && !hasFeature("smcp")) synthLowerScale = SMALL_CAP_SCALE;
  if (wantC2sc && !hasFeature("c2sc")) synthUpperScale = SMALL_CAP_SCALE;
  if (wantPcap && !hasFeature("pcap")) synthLowerScale = SMALL_CAP_SCALE;
  if (wantC2pc && !hasFeature("c2pc")) synthUpperScale = SMALL_CAP_SCALE;
  if (wantUnic && !hasFeature("unic")) {
    // unicase synthesis per CSS Fonts 4 §3.5: "display lowercase letters in
    // their usual lowercase glyphs and uppercase letters in their
    // small-capitals form". So lowercase stays NORMAL; only uppercase
    // shrinks. The previous code set both scales to 0.7 + the up-casing
    // branch ran on lowercase too, producing all-small-caps output
    // instead of the mixed-case unicase appearance Chrome paints.
    synthLowerScale = null;
    synthUpperScale = SMALL_CAP_SCALE;
  }
  const synthSmallCaps = synthLowerScale != null || synthUpperScale != null;
  const smcpRequested = wantSmcp;
  void smcpRequested;
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
        // When `synthSmallCaps` is on (DM-294 + DM-444), case-fold and
        // re-scale glyphs per the variant-caps spec. Lowercase letters are
        // up-cased and rendered at synthLowerScale; uppercase letters
        // (under c2sc / c2pc / unic) are rendered at synthUpperScale. The
        // fonts on macOS we hit here all lack the OT features for these
        // variants, so synthesis is the path Chrome takes too.
        let i = run.startIdx;
        while (i < run.endIdx) {
          const cp = text.codePointAt(i)!;
          let ch = String.fromCodePoint(cp);
          let chScale = sc;
          if (synthSmallCaps) {
            const upper = ch.toUpperCase();
            const isLower = upper !== ch && upper.length === ch.length;
            const isUpper = !isLower && ch.toLowerCase() !== ch && ch.toLowerCase().length === ch.length;
            // DM-700: per CSS Fonts 4 §7.4, `all-small-caps` ALSO scales
            // digits to small-cap height ("small caps are also applied to
            // numerals…"). Synthesize that here when the c2sc branch is
            // active. Use the c2sc scale (synthUpperScale) for digits since
            // Chrome treats digits the same as upper for all-small-caps,
            // not the lowercase smcp scale.
            const isDigit = ch.length === 1 && ch >= "0" && ch <= "9";
            if (isLower && synthLowerScale != null) {
              ch = upper;
              chScale = Number((runScale * synthLowerScale).toFixed(5));
            } else if (isUpper && synthUpperScale != null) {
              chScale = Number((runScale * synthUpperScale).toFixed(5));
            } else if (isDigit && synthUpperScale != null) {
              chScale = Number((runScale * synthUpperScale).toFixed(5));
            }
          }
          const layout = features != null && features.length > 0 && !synthSmallCaps
            ? run.font.layout(ch, features)
            : run.font.layout(ch);
          // For emoji codepoints whose layout returns a .notdef tofu (id=0,
          // hollow rectangle outline), suppress path emission. The capture
          // layer attached a raster <image> overlay that fills the visual;
          // emitting the tofu underneath leaves visible black edges around
          // the emoji where the raster's sub-pixel transparency exposes the
          // tofu's outline. (DM-334.)
          const nextI = i + ch.length;
          const nextCp = nextI < text.length ? text.codePointAt(nextI)! : 0;
          const skipNotdef = isEmojiCodepoint(cp, nextCp) || isPrivateUseCodepoint(cp);
          const uses: string[] = [];
          for (const g of layout.glyphs) {
            if (g.path.commands.length > 0 && !(skipNotdef && g.id === 0)) {
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
  // text length (Helvetica's `liga` feature collapsed `fi`/`fl` into single
  // glyphs, Apple Chancery's `Th`/`th` ligatures, etc.), the simple per-char
  // anchoring path can't run. (DM-287 / DM-331). Use the layout's actual
  // glyph stream — which includes any ligatures the font fired — and anchor
  // each glyph cluster at its FIRST codepoint's xOffset. Chrome paints
  // ligature glyphs at the position of the cluster's first char, so this
  // matches Chrome both for justified text (DM-287, fi/fl) and for
  // stylistic-ligature fonts where the per-char glyphs differ visibly from
  // the ligature glyph (DM-331, Apple Chancery's connected Th/th forms).
  if (xOffsets != null && xOffsets.length !== run.glyphs.length) {
    const sc = Number(scale.toFixed(5));
    const uses: string[] = [];
    let textIdx = 0;
    for (let gi = 0; gi < run.glyphs.length; gi++) {
      const glyph = run.glyphs[gi];
      const pos = run.positions[gi];
      const skipNotdefHere = glyph.id === 0 && glyph.codePoints != null && glyph.codePoints.length > 0
        && glyph.codePoints.every((cp: number) => isPrivateUseCodepoint(cp));
      if (textIdx < xOffsets.length && glyph.path.commands.length > 0 && !skipNotdefHere) {
        const defId = ensureGlyphDef(fontKey, weight, fontSize, slant, glyph.id, glyph.path.commands);
        const tx = xOffsets[textIdx] / scale + pos.xOffset;
        const ty = -pos.yOffset;
        uses.push(`<use href="#${defId}" x="${r(tx)}" y="${r(ty)}"/>`);
      }
      // Advance the text-index cursor by the cluster's char span: each BMP
      // codepoint in the cluster consumes 1 text index, each astral codepoint
      // consumes 2 (surrogate pair). Empty codePoints (decomposed glyphs)
      // count as 1 to keep the cursor moving — good enough for the Latin
      // ligature cases we hit; Arabic/Devanagari/Thai re-ordering goes
      // through the multi-font run path, not here.
      const cps = glyph.codePoints;
      let span = 0;
      if (cps != null && cps.length > 0) {
        for (const cp of cps) span += cp > 0xFFFF ? 2 : 1;
      } else {
        span = 1;
      }
      textIdx += span;
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
    const skipNotdefHere = glyph.id === 0 && glyph.codePoints != null && glyph.codePoints.length > 0
      && glyph.codePoints.every((cp: number) => isPrivateUseCodepoint(cp));
    if (glyph.path.commands.length > 0 && !skipNotdefHere) {
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

// DM-655: split text into per-codepoint font runs the same way
// textToPathMarkup does — primary font first, fall back to per-codepoint
// webfont partitions, then the system fallback chain. Shared between the
// glyph-path emission path (textToPathMarkup) and the embedded-font path
// (renderTextAsEmbedded) so both make the SAME per-codepoint font
// decisions. Returns one run per consecutive same-font segment.
interface FontRun { fontKey: string; font: FontInstance; text: string; startIdx: number; endIdx: number; isPrimary: boolean }
function splitTextIntoFontRuns(
  text: string,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
): FontRun[] {
  const runs: FontRun[] = [];
  let curKey = primaryFontKey;
  let curFontOverride: FontInstance | null = null;
  let curText = "";
  let curStart = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    let useKey = primaryFontKey;
    let useFontOverride: FontInstance | null = null;
    if ((primaryFont as any).glyphForCodePoint(cp).id === 0) {
      if (primaryFontKey.startsWith("webfont:")) {
        const family = primaryFontKey.slice("webfont:".length);
        const cpVariant = pickWebfontVariantForCodepoint(family, weight, fontSize, slant, cp, variationSettings);
        if (cpVariant != null && (cpVariant as any).glyphForCodePoint(cp).id !== 0) {
          useFontOverride = cpVariant;
        }
      }
      if (useFontOverride == null) {
        const chain = fallbackFontChain(cp, primaryFontKey, lang);
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
    }
    const runChanged = useKey !== curKey || useFontOverride !== curFontOverride;
    if (runChanged && curText.length > 0) {
      const fvs = curKey === primaryFontKey ? variationSettings : undefined;
      const f = curFontOverride ?? getFontInstance(curKey, weight, fontSize, slant, fvs);
      if (f != null) runs.push({ fontKey: curKey, font: f, text: curText, startIdx: curStart, endIdx: i, isPrimary: curKey === primaryFontKey && curFontOverride == null });
      curText = "";
      curStart = i;
    }
    curKey = useKey;
    curFontOverride = useFontOverride;
    curText += ch;
    i += ch.length;
  }
  if (curText.length > 0) {
    const fvs = curKey === primaryFontKey ? variationSettings : undefined;
    const f = curFontOverride ?? getFontInstance(curKey, weight, fontSize, slant, fvs) ?? primaryFont;
    runs.push({ fontKey: curKey, font: f, text: curText, startIdx: curStart, endIdx: text.length, isPrimary: curKey === primaryFontKey && curFontOverride == null });
  }
  return runs;
}

/**
 * DM-655: emit text as `<text>` elements backed by custom-built TTFs that
 * contain just the shaped glyphs the run uses. Mirrors textToPathMarkup's
 * per-codepoint run splitting, then for each run runs fontkit's
 * `font.layout()` to get the shaped glyph stream, registers each shaped
 * glyph in the embedded-font-builder, and emits `<text>` with a synthetic
 * PUA codepoint string. The consumer browser performs ZERO shaping — each
 * PUA codepoint maps via cmap to one pre-shaped glyph outline. So Arabic
 * init/medi/fina, Devanagari clusters, fi/ffi ligatures, and contextual
 * substitutions all survive across the embedded round-trip because we
 * shape capture-side and bake the result into glyph IDs.
 *
 * Positioning: each font run becomes one `<text>` at `x + xOffsets[runStart]`
 * (or accumulated CSS x when xOffsets aren't available). The browser then
 * places glyphs WITHIN each `<text>` using the embedded font's hmtx —
 * which carries fontkit's shaped advance widths — so intra-run kerning
 * and cluster spacing matches what Chrome painted.
 *
 * Returns null when the run can't be rendered (resolveFont failed, a glyph
 * outline is missing, or the PUA-A block ran out). The caller falls
 * through to paths-mode emission in that case.
 */
function renderTextAsEmbedded(
  text: string,
  x: number,
  y: number,
  fontSize: number,
  fontFamily: string,
  fontWeight: string,
  fill: string,
  xOffsets: number[] | undefined,
  fontStyle: string | undefined,
  ascentOverride: number | undefined,
  features: string[] | undefined,
  lang: string | undefined,
  variationSettings: Record<string, number> | undefined,
): string | null {
  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings);
  if (primaryFont == null) return null;
  const primaryFontKey = resolveFontKey(fontFamily);

  const runs = splitTextIntoFontRuns(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang);
  if (runs.length === 0) return null;

  // Per-run baseline: SVG `<text y=...>` puts the BASELINE at y. Use the
  // captured Chrome `fontBoundingBoxAscent` when provided (matches what
  // Chrome's text engine measured on the original page); else fall back
  // to the primary font's HHEA ascent scaled to fontSize.
  const scale = fontSize / primaryFont.unitsPerEm;
  const baselineAscent = ascentOverride != null ? ascentOverride : Math.round(primaryFont.ascent * scale);
  const baselineY = y + baselineAscent;

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const segments: string[] = [];
  let cssX = 0;
  for (const run of runs) {
    const runScale = fontSize / run.font.unitsPerEm;
    let layout: { glyphs: Array<{ id: number; path: { commands: Array<{ command: string; args: number[] }> }; advanceWidth: number; codePoints?: number[] }>; positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }> };
    try {
      layout = features != null && features.length > 0 ? run.font.layout(run.text, features) : run.font.layout(run.text);
    } catch {
      return null;
    }

    // Per-instance key: a stable identifier for (resolved font, axes). Two
    // text runs that resolve to the same font at the same axis values share
    // one custom TTF; runs at a different `wght`/`opsz` get their own TTF
    // because the baked glyph outlines differ.
    const fvsTuple = run.isPrimary && variationSettings != null
      ? "|" + Object.keys(variationSettings).sort().map((k) => `${k}=${variationSettings[k]}`).join(",")
      : "";
    const instanceKey = `${run.fontKey}|w=${weight}|s=${slant}${fvsTuple}`;

    // Ascent/descent are font-wide metrics that drive baseline placement
    // when the consumer browser lays out our PUA codepoints. Use the run
    // font's own metrics so glyphs from this run sit on their natural
    // baseline (matching what Chrome would render with the original font).
    const runAscent = run.font.ascent;
    const runDescent = run.font.descent;

    // Resolve cssFamily + PUA codepoints for every shaped glyph in this
    // run. We also need each glyph's anchor x in CSS pixels so we can
    // emit one `<tspan x="...">` per glyph — without explicit per-glyph
    // x the consumer browser would re-flow each glyph using the embedded
    // font's hmtx alone, losing the GPOS kerning the original font
    // applied (very visible at headline sizes — 110px `<h1>` accumulates
    // multi-pixel drift across a 12-glyph run). We anchor at the captured
    // xOffsets where available (Chrome's actual paint position, subpixel-
    // accurate); else use fontkit's shaped advances cumulatively.
    interface PerGlyph { pua: string; xCss: number }
    const perGlyph: PerGlyph[] = [];
    let runCssFamily: string | null = null;
    let runCursorFontUnits = 0;
    let glyphFailed = false;
    // Walk the shaped glyph stream. For each glyph: convert its cluster's
    // first-codepoint xOffset to a CSS pixel x, OR fall back to the
    // accumulated cursor when no xOffsets are present (or the cluster
    // boundary doesn't have one). Cluster span = sum of per-codepoint
    // UTF-16 lengths in glyph.codePoints (BMP=1, astral=2). When the
    // codePoints array is missing or empty (decomposed glyphs) span=1
    // so the cursor still advances.
    let textIdx = 0; // index within run.text
    for (let i = 0; i < layout.glyphs.length; i++) {
      const glyph = layout.glyphs[i];
      const pos = layout.positions[i];
      const cmds = glyph.path?.commands ?? [];
      const placement = trackGlyphInEmbedFont(
        instanceKey, run.font.unitsPerEm, runAscent, runDescent,
        glyph.id, cmds, glyph.advanceWidth,
        // Tag the custom-TTF entry with the variant we resolved. The `@font-face`
        // rule then carries matching `font-style: italic` / `font-weight: N`
        // descriptors so Chromium consumes the SVG's `font-style="italic"` /
        // `font-weight=N` attributes as an EXACT match — no faux-italic /
        // faux-bold synthesised on top of glyphs whose slant / weight is
        // already baked in.
        { italic: slant !== 0, weight },
      );
      if (placement == null) { glyphFailed = true; break; }
      if (runCssFamily == null) runCssFamily = placement.cssFamily;
      // Glyph x anchor: captured xOffset at the cluster's first char
      // (relative to the whole-text origin), else cumulative fontkit
      // advance from the run start. xOffsets is indexed against `text`
      // (the whole captured string), so we use the run's startIdx +
      // intra-run textIdx to look it up.
      let xCss: number;
      const wholeTextIdx = run.startIdx + textIdx;
      if (xOffsets != null && xOffsets[wholeTextIdx] != null) {
        xCss = xOffsets[wholeTextIdx];
      } else {
        // Cursor sits in font units; convert to CSS using the run's scale.
        // Anchored at run.startIdx + 0 if xOffsets exists for the run's
        // first char (so subsequent glyphs in the run remain run-relative
        // when xOffsets gap mid-run).
        const runOriginCss = (xOffsets != null && xOffsets[run.startIdx] != null)
          ? xOffsets[run.startIdx] : cssX;
        xCss = runOriginCss + runCursorFontUnits * runScale;
      }
      perGlyph.push({ pua: String.fromCodePoint(placement.puaCodepoint), xCss });
      runCursorFontUnits += pos.xAdvance;
      // Advance textIdx by the cluster's char span.
      const cps = glyph.codePoints;
      let span = 0;
      if (cps != null && cps.length > 0) {
        for (const cp of cps) span += cp > 0xFFFF ? 2 : 1;
      } else {
        span = 1;
      }
      textIdx += span;
    }
    if (glyphFailed || perGlyph.length === 0 || runCssFamily == null) return null;

    // Emit captured weight / style / variation-settings on the `<text>` —
    // not the picked variant's @font-face descriptors. For a variable
    // webfont registered as `font-weight: 100 900`, parseWeightDescriptor
    // collapses the range to 100; emitting that as the run's weight would
    // render hairline. The captured fontWeight comes straight from the
    // page's computed style.
    //
    // FVS forwarding is now redundant for the embedded-font path (the
    // glyph outlines are already baked at the captured axis values in
    // trackGlyphInEmbedFont above), but keep it on the element anyway —
    // costs nothing and helps when the custom TTF is opened by a tool
    // that does honor variation tables.
    const italicAttr = (fontStyle != null && fontStyle !== "" && fontStyle.toLowerCase() !== "normal")
      ? ` font-style="${esc(fontStyle)}"` : "";
    const weightAttr = weight !== 400 ? ` font-weight="${weight}"` : "";
    const fvsAttr = (variationSettings != null && Object.keys(variationSettings).length > 0)
      ? ` style="font-variation-settings: ${Object.entries(variationSettings).map(([k, v]) => `'${k}' ${v}`).join(", ")}"` : "";

    // Build one <tspan x=...> per shaped glyph. We rely on per-glyph x
    // rather than letting the consumer browser advance within the run
    // because the custom TTF has no GPOS — emitting xOffsets explicitly
    // makes the consumer pixel-faithful to Chrome's captured paint.
    const tspans = perGlyph.map((g) => `<tspan x="${r(x + g.xCss)}">${g.pua}</tspan>`).join("");
    segments.push(`<text y="${r(baselineY)}" font-family="${runCssFamily}" font-size="${r(fontSize)}"${weightAttr}${italicAttr}${fvsAttr} fill="${fill}">${tspans}</text>`);
    cssX += runCursorFontUnits * runScale;
  }

  if (segments.length === 0) return null;

  // Accessibility: wrap the per-font `<text>` segments in a labeled <g>
  // so screen readers + Find-In-Page see the ORIGINAL text. The visible
  // glyph stream is PUA codepoints, which AT would otherwise read as
  // garbage. The aria-label / <title> carry the human-readable form.
  return `<g role="img" aria-label="${esc(text)}"><title>${esc(text)}</title>${segments.join("")}</g>`;
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
  /** BCP-47 language tag for locale-aware Han fallback variant routing
   *  (PingFang TC / HK / MO, or Hiragino Kaku for `ja`). DM-394. */
  lang?: string,
  /** Author-set `font-variation-settings` axis overrides. DM-578. */
  variationSettings?: Record<string, number>,
  /** DM-719: `-webkit-text-stroke-width` (px). When > 0, the emitted text
   *  group gets a `stroke` attribute so each glyph paints with an outline. */
  textStrokeWidth?: number,
  /** DM-719: `-webkit-text-stroke-color`. Required when `textStrokeWidth > 0`. */
  textStrokeColor?: string,
  /** DM-719: `paint-order` (e.g. "stroke fill"). When `stroke fill`, the
   *  stroke paints UNDER the fill so half the stroke is covered, eliminating
   *  the chunky fill-on-stroke look at large widths. */
  paintOrder?: string,
): string | null {
  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // DM-652: opt-in embedded-font path. When `setRenderTextMode("embedded-font")`
  // is active AND we hold a webfont buffer that matches the requested
  // (family, weight, italic), bypass glyph-path emission and emit a single
  // `<text>` element instead. The browser's native text engine then
  // rasters the run, caches the glyph atlas at the compositor layer, and
  // skips the per-frame path-rasterization cost that bottlenecks WebKit
  // on text-heavy scroll composites (DM-651: 14.7 fps → ~Chromium parity).
  //
  // Falls through to paths mode in two cases:
  //   1. No webfont in the family stack has a retained buffer — system
  //      fonts (SF Pro / Helvetica / etc.) aren't embeddable from this
  //      path yet, so they keep using `<use href="#gN">`.
  //   2. `textToPathMarkup` would have returned null below (unrenderable).
  //
  // Positioning: a single `<text x= y=>` lets the browser shape natively.
  // We don't pass the captured `xOffsets` — they're fontkit-shaped
  // positions, and forwarding them as per-glyph `<tspan dx=>` would defeat
  // the engine's atlas cache. Acceptable per the opt-in tradeoff: some
  // sub-pixel kerning drift vs. Chromium-shaped output.
  if (currentRenderTextMode === "embedded-font") {
    // DM-655: emit `<text>` against a custom-built TTF that contains the
    // exact shaped glyphs Chrome painted with — webfont or system font,
    // variable-axis instance included. The renderTextAsEmbedded path
    // mirrors textToPathMarkup's per-codepoint font-resolution so
    // partitioned webfonts (Geist split across Latin/Cyrillic), fallback-
    // chain runs (Helvetica → Apple Symbols), and primary-only runs all
    // get the SAME font decision the path-mode renderer would have made.
    // Returns null to fall through to glyph-path emission when the run
    // can't be embedded (font failed to resolve, layout threw, PUA-A
    // exhausted, etc.) — paths-mode is the safe always-correct fallback.
    const embedded = renderTextAsEmbedded(text, x, y, fontSize, fontFamily, fontWeight, fill,
      xOffsets, fontStyle, ascentOverride, features, lang, variationSettings);
    if (embedded != null) return embedded;
  }

  const result = textToPathMarkup(text, fontSize, fontFamily, fontWeight, targetWidth, xOffsets, fontStyle, features, lang, variationSettings);
  if (result == null || result.markup === "") return null;

  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings);
  if (font == null) return null;

  const scale = fontSize / font.unitsPerEm;
  // Use the captured fontBoundingBoxAscent when available — that's the exact
  // value Chrome used to position the baseline within the line box. fontkit's
  // font.ascent (HHEA) is the right answer for SF Pro / SF Mono (where HHEA
  // = winAscent) but ~5 px too small at fontSize=32 for Helvetica and other
  // legacy MS fonts on macOS, where Chrome reads winAscent.
  const ascent = ascentOverride != null ? ascentOverride : Math.round(font.ascent * scale);
  const baselineY = y + ascent;

  // DM-719: -webkit-text-stroke. Glyphs paint inside inner
  // `<g transform="scale(s,-s)">` groups where s = fontSize/unitsPerEm — a
  // tiny number (≈ 0.03 at 64px on a 2048-UPEM font). SVG strokes scale
  // with the transform, so a literal `stroke-width="2"` on the outer group
  // would render at 2 × 0.03 ≈ 0.06 user units. `vector-effect:
  // non-scaling-stroke` must be set on the actual graphics element, not a
  // parent (it doesn't inherit through `<use>` consistently). Instead,
  // pre-multiply the stroke width by the inverse scale so the post-
  // transform paint matches the requested CSS width.
  let strokeAttr = "";
  if (textStrokeWidth != null && textStrokeWidth > 0 && textStrokeColor != null && textStrokeColor !== "") {
    const inverseScale = font.unitsPerEm / fontSize;
    const swInEm = textStrokeWidth * inverseScale;
    strokeAttr = ` stroke="${textStrokeColor}" stroke-width="${r(swInEm)}"`;
    if (paintOrder != null && /\bstroke\b\s+\bfill\b/.test(paintOrder)) {
      strokeAttr += ` paint-order="stroke fill"`;
    }
  }
  return `<g transform="translate(${r(x)},${r(baselineY)})" fill="${fill}"${strokeAttr} role="img" aria-label="${esc(text)}"><title>${esc(text)}</title>${result.markup}</g>`;
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
  /** CSS `text-decoration-thickness` — when set to a length value (e.g. "5px"),
   *  overrides the auto thickness. Pass `undefined` or `auto` to use the auto
   *  rule. DM-431. */
  thicknessOverride?: string,
  /** CSS `text-underline-offset` — when set to a length value, adds this much
   *  EXTRA distance below the baseline (on top of the auto offset). DM-431. */
  underlineOffsetCss?: string,
): DecorationMetrics {
  const weight = typeof fontWeight === "number" ? fontWeight : (parseInt(fontWeight) || 400);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant);
  // Chromium's text-decoration auto rules (verified vs source — see below):
  //   thickness = max(1, fontSize / 10)             [text_decoration_info.cc:ComputeDecorationThickness]
  //   underline_gap = max(1, ceil(thickness / 2))   [text_decoration_offset.cc:ComputeUnderlineOffsetAuto]
  //   line_through = 2 * FloatAscent / 3 - thickness / 2   [text_decoration_info.cc]
  //
  // BUT: our SVG output is rasterized by Chrome'\\'s SVG painter at consume
  // time, which uses a different sub-pixel grid + AA distribution than the
  // HTML text painter that produced the reference PNG (the DM-418 SVG-vs-
  // HTML rasterization gap). Emitting the source-verified sub-pixel values
  // (thickness 1.6 + offset 1 for 16 px) measurably regresses the visual
  // diff vs Chrome'\\'s HTML output by ~10-30% per fixture compared to the
  // integer-rounded empirical formulas below — the empirical values were
  // tuned to compensate for the rasterization mismatch.
  //
  // Empirical rule: thickness = max(1, ceil(fontSize / 20)). Auto underline
  // gap = 1.5 * thickness (puts SVG stroke center half-pixel below an
  // integer pixel boundary so 1px strokes paint a single solid row at small
  // sizes). Empirically derived via `scripts/probe-text-decorations.mjs`
  // against rendered Helvetica from 12-32 px. DM-398 / DM-431.
  const autoThicknessPx = Math.max(1, Math.ceil(fontSize / 20));
  let thicknessPx = autoThicknessPx;
  if (thicknessOverride != null && thicknessOverride !== "" && thicknessOverride !== "auto" && thicknessOverride !== "from-font") {
    const explicit = parseFloat(thicknessOverride);
    if (!isNaN(explicit) && explicit > 0) thicknessPx = explicit;
  }
  let extraUnderlineOffset = 0;
  if (underlineOffsetCss != null && underlineOffsetCss !== "" && underlineOffsetCss !== "auto") {
    const v = parseFloat(underlineOffsetCss);
    if (!isNaN(v)) extraUnderlineOffset = v;
  }
  const underlineOffsetY = 1.5 * thicknessPx + extraUnderlineOffset;
  const underlineThickness = thicknessPx;
  // Empirical strike: stroke top sits at `round(baseline) - round(fontSize / 3)`
  // (probed at 14 / 22 / 32 px sans-serif / Times / Menlo). The Chromium-
  // source formula `2 * FloatAscent / 3 - thickness / 2` produces values
  // ~1.5 px lower (Chromium uses HHEA ascent ~0.77 of em, vs the empirical
  // 1/3 of em rule). The empirical formula matches Chrome'\\'s SVG-rasterized
  // output better despite differing from the source HTML rule. DM-398.
  const strikeoutOffsetY = Math.round(fontSize / 3) + thicknessPx * 0.5;
  const strikeoutThickness = thicknessPx;
  // Chromium paints overline with stroke top at the em-box top — i.e.
  // `round(baseline) - fontSize`. fontkit's HHEA ascent (used previously)
  // sits ~3 px below this on Helvetica because Chrome uses winAscent for
  // legacy MS-style fonts on macOS. DM-398.
  const overlineOffsetY = fontSize - thicknessPx * 0.5;
  if (font == null) {
    return {
      underlineOffsetY, underlineThickness,
      strikeoutOffsetY, strikeoutThickness,
      overlineOffsetY, overlineThickness: thicknessPx,
    };
  }
  return {
    underlineOffsetY, underlineThickness,
    strikeoutOffsetY, strikeoutThickness,
    overlineOffsetY, overlineThickness: underlineThickness,
  };
}

/**
 * Compute X-range gaps where the underline rect [decorationCenterY - thickness/2,
 * decorationCenterY + thickness/2] crosses glyph ink for `text` rendered in
 * the given font. Returns gaps in the text's local coordinate system (X=0 at
 * the run's anchor — caller adds segX to translate). Used to honor
 * `text-decoration-skip-ink: auto` on solid / double underlines, matching
 * Chromium's `decoration_line_painter.cc::ComputeUnderlineSkipFromIntercepts`.
 *
 * Algorithm: shape via fontkit, walk each glyph's path, flatten quadratic /
 * cubic Beziers to short polylines, find segment-vs-horizontal-line
 * intersections at the rect's top and bottom Y. Per glyph, the gap spans
 * `[minIntersectX - pad, maxIntersectX + pad]` where pad = 0.5 * thickness
 * (matches Chromium's `kIntersectionExtension`).
 *
 * `decorationCenterYRel` is in baseline-relative screen coords (positive =
 * below baseline). Returns `[]` when font isn't resolvable, no glyphs cross
 * the rect, or shaping throws. (DM-446.)
 */
export function computeSkipInkGaps(
  text: string,
  fontSize: number, fontFamily: string, fontWeight: string | number, fontStyle?: string,
  decorationCenterYRel: number = 0,
  decorationThickness: number = 1,
  features?: string[],
  /** Chromium-measured run width — when set, intercepts are scaled to match
   *  so gaps line up with the painted glyph positions even when fontkit's
   *  layout disagrees with HarfBuzz at sub-px scale. */
  targetWidth?: number,
): Array<[number, number]> {
  const weight = typeof fontWeight === "number" ? fontWeight : (parseInt(fontWeight) || 400);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant);
  if (font == null) return [];
  let layout;
  try { layout = font.layout(text, features); } catch { return []; }
  const scale = fontSize / font.unitsPerEm;
  const yTop = decorationCenterYRel - decorationThickness / 2;
  const yBot = decorationCenterYRel + decorationThickness / 2;
  const pad = Math.max(0.5, decorationThickness * 0.5);
  const rawGaps: Array<[number, number]> = [];
  let xCursor = 0;
  for (let i = 0; i < layout.glyphs.length; i++) {
    const glyph = layout.glyphs[i];
    const pos = layout.positions[i];
    const glyphX = xCursor + (pos.xOffset || 0) * scale;
    const range = glyphPathIntercepts(glyph.path, glyphX, scale, yTop, yBot);
    if (range != null) rawGaps.push([range.minX - pad, range.maxX + pad]);
    xCursor += pos.xAdvance * scale;
  }
  if (rawGaps.length === 0) return [];
  if (targetWidth != null && xCursor > 0.5 && Math.abs(xCursor - targetWidth) > 0.5) {
    const factor = targetWidth / xCursor;
    for (const g of rawGaps) { g[0] *= factor; g[1] *= factor; }
  }
  return mergeGaps(rawGaps);
}

function mergeGaps(gaps: Array<[number, number]>): Array<[number, number]> {
  gaps.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const g of gaps) {
    const top = out[out.length - 1];
    if (top != null && g[0] <= top[1]) top[1] = Math.max(top[1], g[1]);
    else out.push([g[0], g[1]]);
  }
  return out;
}

interface IPt { x: number; y: number }

function glyphPathIntercepts(
  path: { commands: Array<{ command: string; args: number[] }> },
  glyphX: number, scale: number,
  yTop: number, yBot: number,
): { minX: number; maxX: number } | null {
  // fontkit y is up-positive in glyph space; screen y is down-positive. We
  // express screen y relative to baseline so screenY = -fy * scale and yTop /
  // yBot come in as baseline-relative (positive = below baseline).
  let prev: IPt | null = null;
  let subStart: IPt | null = null;
  let minX = Infinity;
  let maxX = -Infinity;
  function pt(fx: number, fy: number): IPt {
    return { x: glyphX + fx * scale, y: -fy * scale };
  }
  function update(x: number) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  function segCheck(a: IPt, b: IPt) {
    const ymin = Math.min(a.y, b.y);
    const ymax = Math.max(a.y, b.y);
    if (ymax < yTop || ymin > yBot) return;
    if (a.y >= yTop && a.y <= yBot) update(a.x);
    if (b.y >= yTop && b.y <= yBot) update(b.x);
    const dy = b.y - a.y;
    if (Math.abs(dy) > 1e-9) {
      const dx = b.x - a.x;
      const t1 = (yTop - a.y) / dy;
      if (t1 > 0 && t1 < 1) update(a.x + t1 * dx);
      const t2 = (yBot - a.y) / dy;
      if (t2 > 0 && t2 < 1) update(a.x + t2 * dx);
    }
  }
  function quadAt(p0: IPt, p1: IPt, p2: IPt, t: number): IPt {
    const u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
             y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
  }
  function cubAt(p0: IPt, p1: IPt, p2: IPt, p3: IPt, t: number): IPt {
    const u = 1 - t;
    return { x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
             y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y };
  }
  function flattenQuad(p0: IPt, p1: IPt, p2: IPt) {
    const STEPS = 8;
    let last = p0;
    for (let i = 1; i <= STEPS; i++) {
      const cur = quadAt(p0, p1, p2, i / STEPS);
      segCheck(last, cur);
      last = cur;
    }
  }
  function flattenCubic(p0: IPt, p1: IPt, p2: IPt, p3: IPt) {
    const STEPS = 12;
    let last = p0;
    for (let i = 1; i <= STEPS; i++) {
      const cur = cubAt(p0, p1, p2, p3, i / STEPS);
      segCheck(last, cur);
      last = cur;
    }
  }
  for (const cmd of path.commands) {
    const a = cmd.args;
    switch (cmd.command) {
      case "moveTo": {
        const p = pt(a[0], a[1]);
        prev = p;
        subStart = p;
        break;
      }
      case "lineTo": {
        const p = pt(a[0], a[1]);
        if (prev) segCheck(prev, p);
        prev = p;
        break;
      }
      case "quadraticCurveTo": {
        const c1 = pt(a[0], a[1]);
        const p = pt(a[2], a[3]);
        if (prev) flattenQuad(prev, c1, p);
        prev = p;
        break;
      }
      case "bezierCurveTo": {
        const c1 = pt(a[0], a[1]);
        const c2 = pt(a[2], a[3]);
        const p = pt(a[4], a[5]);
        if (prev) flattenCubic(prev, c1, c2, p);
        prev = p;
        break;
      }
      case "closePath": {
        if (prev != null && subStart != null) segCheck(prev, subStart);
        prev = subStart;
        break;
      }
    }
  }
  if (minX === Infinity) return null;
  return { minX, maxX };
}

function r(n: number): string { return Number(n.toFixed(2)).toString(); }
