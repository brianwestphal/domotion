/**
 * Text-to-Path Converter
 *
 * Uses fontkit to convert text strings into SVG <path> outlines using
 * the actual macOS system fonts. Glyphs are deduplicated using SVG
 * <defs>/<use> — each unique glyph shape is defined once and referenced
 * everywhere it appears.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { createGlyphHelperFont, isGlyphHelperAvailable, resolveSystemFallbackFonts, resolveInstalledFont } from "./glyph-helper.js";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss, trackGlyphInEmbedFont } from "./embedded-font-builder.js";
import { UNICODE_FONT_PATHS, UNICODE_FONT_RANGES } from "./unicode-font-routing.darwin.generated.js";
import { UNICODE_FONT_PATHS_LINUX, UNICODE_FONT_RANGES_LINUX } from "./unicode-font-routing.linux.generated.js";
import { UNICODE_FONT_FILES_WIN32, UNICODE_FONT_RANGES_WIN32 } from "./unicode-font-routing.win32.generated.js";

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
  /** Glyph-coverage probe. `id === 0` is `.notdef` (no coverage). Both backing
   *  implementations expose it (fontkit's `Font`, the glyph-helper instance), so
   *  it's typed here rather than cast through `any` at each call site (DM-1067). */
  glyphForCodePoint(codePoint: number): { id: number; advanceWidth?: number; codePoints?: number[] };
  /** Native (glyph-helper) instances can pre-warm a batch of glyph-coverage
   *  probes so the per-codepoint walk hits a cache. fontkit instances omit it. */
  warmGlyphs?(codePoints: number[]): void;
  /** Native instances can pre-warm a batch of shaping calls (run-based layout). */
  warmShapes?(texts: string[]): void;
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

// ── Text render mode (DM-652 / DM-655 / DM-839) ──
// `embedded-font` (the DEFAULT, DM-839): the renderer emits `<text>` elements
// against a `@font-face`-declared subset TTF built from the captured glyph
// outlines, addressed by private-use codepoints so the consumer browser does
// zero shaping. `paths`: the renderer emits `<use href="#gN">` references into
// per-glyph `<path>` defs.
//
// Tradeoff: embedded-font hands rasterization to the consumer browser's text
// engine (its own hinting / AA), so output isn't byte-identical across
// browsers — but it's far smaller and faster for text-heavy content (the
// compositor caches the rasterized glyph atlas; WebKit scroll composites that
// ran at 14.7 fps in paths mode jump back toward Chromium's 119 fps). `paths`
// is the per-pixel-faithful mode; opt back into it via `setRenderTextMode`
// (e.g. for visual-regression diffing against the live Chromium paint).
//
// Lifecycle: top-level SVG producers must `clearEmbeddedFonts()` before
// rendering and emit `getEmbeddedFontFaceCss()` into the output `<style>` once
// (single-frame producers do this via `elementTreeToSvg`'s `includeGlyphDefs`
// defs block; multi-frame producers — animator, scroll composer — collect it
// at the top level).
export type RenderTextMode = "paths" | "embedded-font";
let currentRenderTextMode: RenderTextMode = "embedded-font";
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
    const created = fontkit.create(buffer) as unknown;
    if (created == null) return;
    font = created as FontInstance;
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

// macOS system font paths (the `darwin` column of the per-platform path
// tables — see DM-258 / resolveFontSpec below for Linux + Windows). TTC
// collections require picking a sub-font by postscript name — fontkit returns
// a TTCFont wrapper for .ttc files and .getFont(name) extracts the member.
interface FontPath { path: string; postscriptName?: string; extractor?: "fontkit" | "native" }

// DM-1014: pick the LastResort font Chrome actually paints with on this
// platform. On macOS Chrome's CoreText cascade bottoms out at the on-disk
// `/System/Library/Fonts/LastResort.otf` — a 2.5 KB Apple stub with 7
// glyphs whose ENTIRE cmap maps to glyph #4, a single outlined rectangle.
// Empirically that's exactly what Chrome paints for unmapped codepoints on
// macOS, so we use the system file to keep the placeholder shape byte-
// faithful. Tried bundling Unicode's LastResort-HE (Heads-up Edition, 380
// per-block-frame glyphs) under `assets/fonts/` — that DOES paint richer
// per-block frames, but Chrome on macOS doesn't reach for it, so swapping
// it in regressed pixel diffs ~2 pp on the affected fixtures (Egyptian
// Hieroglyphs Ext-A 4.05 % → 6.45 %, CJK Ext-G 3.99 % → 6.06 %, Sutton
// SignWriting 6.35 % → 7.02 %). Kept the bundled font in `assets/fonts/`
// as a future option for non-macOS platforms where Chrome's fontconfig /
// DirectWrite cascades also bottom out at "nothing" — using LR-HE there
// would AT LEAST emit a visible placeholder rather than empty space, even
// if it doesn't match Chrome's per-platform tofu pixel-for-pixel.
const LAST_RESORT_FONT_PATH = process.platform === "darwin"
  ? "/System/Library/Fonts/LastResort.otf"
  : nodePath.resolve(
      nodePath.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "assets", "fonts", "LastResortHE-Regular.ttf",
    );
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
  "pingfang-sc":      { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangSC-Regular", extractor: "native" },
  "pingfang-sc-bold": { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangSC-Medium", extractor: "native" },
  // Per-locale PingFang variants (DM-394). Apple ships the same `hvgl`-only
  // PingFang.ttc with regional faces for Traditional Chinese, Hong Kong, and
  // Macau. Chrome routes by computed `lang`: zh-TW / zh-Hant → TC, zh-HK → HK,
  // zh-MO → MO. There is no `PingFangJP-Regular` postscriptName on macOS;
  // Japanese text routes through `hiragino-jp` (HiraKakuProN) instead.
  "pingfang-tc":      { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangTC-Regular", extractor: "native" },
  "pingfang-tc-bold": { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangTC-Medium", extractor: "native" },
  "pingfang-hk":      { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangHK-Regular", extractor: "native" },
  "pingfang-hk-bold": { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangHK-Medium", extractor: "native" },
  "pingfang-mo":      { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangMO-Regular", extractor: "native" },
  "pingfang-mo-bold": { path: "/System/Library/Fonts/PingFang.ttc", postscriptName: "PingFangMO-Medium", extractor: "native" },
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
  // Hiragino Mincho ProN — the Japanese serif (明朝) family. Routed ONLY when an
  // author NAMES it explicitly (`font-family: "Hiragino Mincho ProN"`), not for
  // the generic `serif` keyword (that stays Songti, DM-333). Unlike Songti it
  // carries the East-Asian OpenType features `trad` / `jp78` / `fwid` / `pwid`,
  // so `font-variant-east-asian: traditional` substitutes the traditional form
  // (国→國) and `full-width` substitutes the full-width Latin forms — neither of
  // which Songti can do. W3 is regular, W6 the bold pair. DM-1117.
  "hiragino-mincho":      { path: "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc", postscriptName: "HiraMinProN-W3" },
  "hiragino-mincho-bold": { path: "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc", postscriptName: "HiraMinProN-W6" },
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
  // The absolute final fallback Chrome reaches when no font in the cascade
  // has a glyph for a codepoint. It contains one "block-frame" glyph per
  // Unicode block (SMP gets stacked horizontal stripes, Egyptian Hieroglyphs
  // gets an empty rectangle, CJK ranges get a hex-numbered tofu, etc.), so
  // painting a codepoint via LastResort matches what Chrome paints for
  // anything otherwise unmappable. DM-998 / DM-999 / DM-1010.
  //
  // DM-1014: bundle Unicode's LastResort-HE (Heads-up Edition) font under
  // `assets/fonts/LastResortHE-Regular.ttf` so we ship the same per-block-
  // frame glyphs Chrome uses, regardless of host OS. The macOS on-disk
  // `/System/Library/Fonts/LastResort.otf` is a 2.5 KB stub with 7 glyphs
  // (every codepoint cmap-maps to glyph #4, a single rectangle-with-?);
  // bundling LR-HE gives us 380 distinct block-frame glyphs. SIL Open Font
  // License 1.1 — `assets/fonts/LICENSE-last-resort-font.txt` ships
  // alongside the binary per the OFL attribution clause.
  "last-resort":     { path: LAST_RESORT_FONT_PATH },
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
  // Source Serif Pro — Adobe's open-source serif, often installed in
  // `/Library/Fonts/` rather than as a base macOS face. Chrome picks it up
  // when CSS specifies `font-family: 'Source Serif Pro'` AND the file is
  // present; otherwise Chrome falls through to the next family in the
  // stack. Domotion mirrors that: when the path doesn't exist on this
  // host, `resolveFont` returns null for the SSP key and the family-chain
  // walks to the next entry (typically `serif` → Times). DM-804.
  "source-serif-pro":              { path: "/Library/Fonts/SourceSerifPro-Regular.ttf" },
  "source-serif-pro-bold":         { path: "/Library/Fonts/SourceSerifPro-Bold.ttf" },
  "source-serif-pro-italic":       { path: "/Library/Fonts/SourceSerifPro-Italic.ttf" },
  "source-serif-pro-bold-italic":  { path: "/Library/Fonts/SourceSerifPro-BoldItalic.ttf" },
  // Playfair Display — a high-contrast display serif (Google Fonts), commonly
  // installed under `/Library/Fonts/` for drop caps / headings. Same
  // present-or-fall-through contract as Source Serif Pro: Chrome on macOS picks
  // it up when CSS names it AND the file is on disk (verified via
  // `CSS.getPlatformFontsForNode` on the `24-deep-initial-letter` drop cap —
  // Chrome paints the `B` from PlayfairDisplay-Regular, with Georgia for the
  // body), otherwise it falls through to the next family (Georgia / serif).
  // When the path is absent, `resolveFont` returns null and the family chain
  // walks on, matching Chrome's fallback on a host without Playfair. DM-1120.
  "playfair-display":              { path: "/Library/Fonts/PlayfairDisplay-Regular.ttf" },
  "playfair-display-bold":         { path: "/Library/Fonts/PlayfairDisplay-Bold.ttf" },
  "playfair-display-italic":       { path: "/Library/Fonts/PlayfairDisplay-Italic.ttf" },
  "playfair-display-bold-italic":  { path: "/Library/Fonts/PlayfairDisplay-BoldItalic.ttf" },
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
  // DM-983: per-Unicode-block routes for codepoints that don't match any
  // hand-coded rule in `darwinFallbackChain` below. Generated from a
  // `CSS.getPlatformFontsForNode` sweep across every block in
  // `../html-test/unicode/*.html` (see `tools/probe-983-genroutes.mjs`).
  // 142 fonts, 319 block routes. Each entry's key is namespaced under
  // `u-...` so it can't collide with a hand-coded key here.
  ...UNICODE_FONT_PATHS,
};

// ── Cross-platform font path discovery (DM-258) ──
//
// FONT_PATHS above is the `darwin` table — its paths and the long
// calibration comments are specific to Chromium-on-macOS's CoreText
// fallback. Linux (fontconfig) and Windows (DirectWrite) ship an entirely
// different font set, so the SAME logical keys (`helvetica`, `times`,
// `courier`, `cjk`, `symbols`, …) resolve to different files there. The
// tables below map those keys per platform; everything downstream of
// `resolveFontSpec` (the weight/slant variant logic, the native-helper route,
// `fontkit.openSync`) is unchanged.
//
// SCOPE NOTE: this is *path discovery only*. The `fallbackFontChain` routing
// — which logical key handles which Unicode block — stays calibrated to
// macOS until per-platform calibration lands (Linux: DM-259, Windows:
// DM-260). So on Linux/Windows the primary families resolve to real fonts
// (no more universal .notdef tofu) but symbol / CJK / RTL block coverage is
// not yet platform-faithful. The point of this layer is only that
// `getFontInstance("helvetica")` returns *a* sans-serif face instead of null.

/**
 * A Linux font entry. `fcMatch` is a fontconfig pattern resolved via
 * `fc-match` — robust across distro path conventions (Debian's
 * `/usr/share/fonts/truetype/...` vs Arch/Fedora layouts). `path` is an
 * optional canonical hint tried first when it exists on disk; when it
 * doesn't, we fall through to `fc-match`. `postscriptName` selects the TTC
 * member for collection files (Noto CJK).
 */
interface LinuxFontPath { fcMatch?: string; path?: string; postscriptName?: string; extractor?: "fontkit" | "native" }

const LIB = "/usr/share/fonts/truetype/liberation";
const FREEFONT = "/usr/share/fonts/truetype/freefont";
const WQY = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc";

// Linux font map — calibrated to what Chromium-on-Linux actually PAINTS in the
// Playwright `*-noble` CI image (DM-259), measured via CDP
// `CSS.getPlatformFontsForNode` (tools/probe-fallbacks-linux.mjs). That image
// has NO DejaVu and NO Noto (except Color Emoji) — the real faces are:
//   sans-serif → Liberation Sans     serif → Liberation Serif
//   monospace  → WenQuanYi Zen Hei Mono   (its fontconfig monospace alias)
//   CJK (Han/Kana/Hangul) → WenQuanYi Zen Hei
//   Arabic → FreeSerif   Devanagari → FreeSans   Thai → Loma   Japanese → IPAGothic
//   symbol/geometric/arrows → Liberation Sans;  dingbats/letterlike/math → FreeSans/FreeSerif
//   emoji → Noto Color Emoji (raster path — doc 15, not a glyph-path key)
// `fc-match` stays the discovery fallback for other distros (Fedora/Arch); the
// canonical paths below short-circuit it in the CI image. NOTE: this baseline
// is the bare Playwright image (option A); if CI later `apt install`s Noto
// (option B), the CJK/symbol routing must be re-probed. See doc 42.
const LINUX_FONT_PATHS: Record<string, LinuxFontPath> = {
  // system-ui → sans (Liberation Sans).
  "sf-pro":          { fcMatch: "Liberation Sans", path: `${LIB}/LiberationSans-Regular.ttf` },
  "sf-pro-italic":   { fcMatch: "Liberation Sans:italic", path: `${LIB}/LiberationSans-Italic.ttf` },
  // sans-serif primary → Liberation Sans (probe: latin-sans).
  "helvetica":              { fcMatch: "Liberation Sans", path: `${LIB}/LiberationSans-Regular.ttf` },
  "helvetica-bold":         { fcMatch: "Liberation Sans:bold", path: `${LIB}/LiberationSans-Bold.ttf` },
  "helvetica-italic":       { fcMatch: "Liberation Sans:italic", path: `${LIB}/LiberationSans-Italic.ttf` },
  "helvetica-bold-italic":  { fcMatch: "Liberation Sans:bold:italic", path: `${LIB}/LiberationSans-BoldItalic.ttf` },
  "arial":                  { fcMatch: "Liberation Sans", path: `${LIB}/LiberationSans-Regular.ttf` },
  "arial-bold":             { fcMatch: "Liberation Sans:bold", path: `${LIB}/LiberationSans-Bold.ttf` },
  "arial-italic":           { fcMatch: "Liberation Sans:italic", path: `${LIB}/LiberationSans-Italic.ttf` },
  "arial-bold-italic":      { fcMatch: "Liberation Sans:bold:italic", path: `${LIB}/LiberationSans-BoldItalic.ttf` },
  "lucida-grande":          { fcMatch: "Liberation Sans", path: `${LIB}/LiberationSans-Regular.ttf` },
  // monospace primary → WenQuanYi Zen Hei Mono (probe: latin-mono — this image's
  // fontconfig resolves the `monospace` generic there, not to Liberation Mono).
  // No separate bold/italic faces in the TTC.
  "courier":              { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "courier-bold":         { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "courier-italic":       { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "courier-bold-italic":  { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "menlo":              { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "menlo-bold":         { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "menlo-italic":       { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "menlo-bold-italic":  { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "monaco":          { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "sf-mono":         { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  "sf-mono-italic":  { fcMatch: "WenQuanYi Zen Hei Mono", path: WQY, postscriptName: "WenQuanYiZenHeiMono" },
  // serif primary → Liberation Serif (probe: latin-serif).
  "times":              { fcMatch: "Liberation Serif", path: `${LIB}/LiberationSerif-Regular.ttf` },
  "times-bold":         { fcMatch: "Liberation Serif:bold", path: `${LIB}/LiberationSerif-Bold.ttf` },
  "times-italic":       { fcMatch: "Liberation Serif:italic", path: `${LIB}/LiberationSerif-Italic.ttf` },
  "times-bold-italic":  { fcMatch: "Liberation Serif:bold:italic", path: `${LIB}/LiberationSerif-BoldItalic.ttf` },
  "times-new-roman":              { fcMatch: "Liberation Serif", path: `${LIB}/LiberationSerif-Regular.ttf` },
  "times-new-roman-bold":         { fcMatch: "Liberation Serif:bold", path: `${LIB}/LiberationSerif-Bold.ttf` },
  "times-new-roman-italic":       { fcMatch: "Liberation Serif:italic", path: `${LIB}/LiberationSerif-Italic.ttf` },
  "times-new-roman-bold-italic":  { fcMatch: "Liberation Serif:bold:italic", path: `${LIB}/LiberationSerif-BoldItalic.ttf` },
  "georgia":             { fcMatch: "Liberation Serif", path: `${LIB}/LiberationSerif-Regular.ttf` },
  "georgia-bold":        { fcMatch: "Liberation Serif:bold", path: `${LIB}/LiberationSerif-Bold.ttf` },
  "georgia-italic":      { fcMatch: "Liberation Serif:italic", path: `${LIB}/LiberationSerif-Italic.ttf` },
  "georgia-bold-italic": { fcMatch: "Liberation Serif:bold:italic", path: `${LIB}/LiberationSerif-BoldItalic.ttf` },
  // FreeFont — Chromium's per-script fallback in this image for several blocks.
  "free-sans":       { fcMatch: "FreeSans", path: `${FREEFONT}/FreeSans.ttf` },
  "free-serif":      { fcMatch: "FreeSerif", path: `${FREEFONT}/FreeSerif.ttf` },
  // FreeFont bold / oblique siblings. Used by the Math-Alphanumeric
  // decomposition fallback (mathAlphaToBase): Chromium-on-Linux paints
  // 𝑎/𝛼/𝐀 by synthesizing from the base Latin/Greek letters in the
  // already-italic FreeSansOblique face (FreeSans's cmap has no U+1D4xx),
  // so when a Math-Alpha codepoint resolves to .notdef across the chain we
  // render the base letter in the matching weight/slant FreeFont file. The
  // distinct key disambiguates the glyph-dedup cache from the upright face.
  // (FreeSans names its slanted face "Oblique"; FreeSerif names it "Italic".)
  "free-sans-bold":         { fcMatch: "FreeSans:bold", path: `${FREEFONT}/FreeSansBold.ttf` },
  "free-sans-italic":       { fcMatch: "FreeSans:italic", path: `${FREEFONT}/FreeSansOblique.ttf` },
  "free-sans-bold-italic":  { fcMatch: "FreeSans:bold:italic", path: `${FREEFONT}/FreeSansBoldOblique.ttf` },
  "free-serif-bold":        { fcMatch: "FreeSerif:bold", path: `${FREEFONT}/FreeSerifBold.ttf` },
  "free-serif-italic":      { fcMatch: "FreeSerif:italic", path: `${FREEFONT}/FreeSerifItalic.ttf` },
  "free-serif-bold-italic": { fcMatch: "FreeSerif:bold:italic", path: `${FREEFONT}/FreeSerifBoldItalic.ttf` },
  // CJK — WenQuanYi Zen Hei (single weight; bold/serif map to the same face).
  // The macOS PingFang/Hiragino/Apple-SD logical keys all collapse here on
  // Linux. `hiragino-jp` → IPAGothic (what Chromium picks for lang=ja).
  "cjk":             { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "cjk-bold":        { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "cjk-serif":       { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "cjk-serif-bold":  { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  // DM-1117: no Hiragino Mincho on Linux — collapse the explicit-name route to
  // the serif CJK face this image ships. The `trad`/`fwid` substitutions won't
  // fire here (WenQuanYi lacks those GSUB features), a known platform gap on the
  // not-yet-calibrated Linux chain; the glyph still resolves.
  "hiragino-mincho":      { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "hiragino-mincho-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-sc":      { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-sc-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-tc":      { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-tc-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-hk":      { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-hk-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-mo":      { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "pingfang-mo-bold": { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "korean":           { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "korean-bold":      { fcMatch: "WenQuanYi Zen Hei", path: WQY, postscriptName: "WenQuanYiZenHei" },
  "hiragino-jp":      { fcMatch: "IPAGothic", path: "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf" },
  "hiragino-jp-bold": { fcMatch: "IPAGothic", path: "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf" },
  // Indic / RTL / Thai — Chromium's lang-fallback faces in this image.
  "thai":            { fcMatch: "Loma", path: "/usr/share/fonts/opentype/tlwg/Loma.otf" },
  "devanagari":      { fcMatch: "FreeSans", path: `${FREEFONT}/FreeSans.ttf` },
  "sf-arabic":       { fcMatch: "FreeSerif", path: `${FREEFONT}/FreeSerif.ttf` },
  "sf-hebrew":       { fcMatch: "Liberation Sans", path: `${LIB}/LiberationSans-Regular.ttf` },
  // Symbol blocks — FreeFont carries the dingbat/letterlike/math glyphs.
  "symbols":         { fcMatch: "FreeSans", path: `${FREEFONT}/FreeSans.ttf` },
  "zapf-dingbats":   { fcMatch: "FreeSans", path: `${FREEFONT}/FreeSans.ttf` },
  "stix-math":       { fcMatch: "FreeSerif", path: `${FREEFONT}/FreeSerif.ttf` },
  // cursive / fantasy — no dedicated face in the image; let fontconfig substitute.
  "snell":           { fcMatch: "cursive" },
  "apple-chancery":  { fcMatch: "cursive" },
  "papyrus":         { fcMatch: "fantasy" },
  // source-serif-pro intentionally omitted — when fontconfig has no match it
  // resolves to a generic, which would mask the "not installed → fall through
  // the family chain" behavior. Returning null lets the chain walk on, same
  // as the macOS `/Library/Fonts/SourceSerifPro-*` absent case.
  // DM-984: per-Unicode-block routes derived from a Chrome CDP sweep of the
  // bare Playwright Docker image. Generated by tools/probe-983-genroutes-linux.mjs
  // from a tools/probe-983-sweep.mjs run inside the same container CI uses.
  // 9 fonts cover 326/330 blocks; keys are namespaced `u-...` so they can't
  // collide with a hand-coded key here. Coverage is dominated by Unifont /
  // Unifont Upper — Chrome's "last resort" pixel-art glyphs for codepoints
  // no covering font has — because the bare image ships a minimal font set.
  ...UNICODE_FONT_PATHS_LINUX,
};

// Windows system fonts live in %WINDIR%\Fonts (almost always C:\Windows\Fonts).
// Paths are stable across Windows 10/11, so unlike Linux we hardcode filenames
// and check existence rather than shelling out. Generic mappings follow
// Chromium-on-Windows defaults (sans → Arial, serif → Times New Roman, mono →
// Courier New); CJK / symbol / math / Indic route to the DirectWrite system
// faces. Exact per-block calibration is DM-260.
const WINDOWS_FONTS_DIR = `${process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows"}\\Fonts`;
function win(file: string, postscriptName?: string): FontPath {
  return { path: `${WINDOWS_FONTS_DIR}\\${file}`, postscriptName };
}
const WIN32_FONT_PATHS: Record<string, FontPath> = {
  "sf-pro":          win("segoeui.ttf"),
  "sf-pro-italic":   win("segoeuii.ttf"),
  "sf-mono":         win("consola.ttf"),
  "sf-mono-italic":  win("consolai.ttf"),
  "helvetica":              win("arial.ttf"),
  "helvetica-bold":         win("arialbd.ttf"),
  "helvetica-italic":       win("ariali.ttf"),
  "helvetica-bold-italic":  win("arialbi.ttf"),
  "arial":                  win("arial.ttf"),
  "arial-bold":             win("arialbd.ttf"),
  "arial-italic":           win("ariali.ttf"),
  "arial-bold-italic":      win("arialbi.ttf"),
  "courier":              win("cour.ttf"),
  "courier-bold":         win("courbd.ttf"),
  "courier-italic":       win("couri.ttf"),
  "courier-bold-italic":  win("courbi.ttf"),
  "menlo":              win("consola.ttf"),
  "menlo-bold":         win("consolab.ttf"),
  "menlo-italic":       win("consolai.ttf"),
  "menlo-bold-italic":  win("consolaz.ttf"),
  "monaco":          win("consola.ttf"),
  "times":              win("times.ttf"),
  "times-bold":         win("timesbd.ttf"),
  "times-italic":       win("timesi.ttf"),
  "times-bold-italic":  win("timesbi.ttf"),
  "times-new-roman":              win("times.ttf"),
  "times-new-roman-bold":         win("timesbd.ttf"),
  "times-new-roman-italic":       win("timesi.ttf"),
  "times-new-roman-bold-italic":  win("timesbi.ttf"),
  "georgia":             win("georgia.ttf"),
  "georgia-bold":        win("georgiab.ttf"),
  "georgia-italic":      win("georgiai.ttf"),
  "georgia-bold-italic": win("georgiaz.ttf"),
  // CJK: Yu Gothic (ja), Microsoft YaHei (zh), Malgun Gothic (ko). The macOS
  // PingFang/Hiragino logical keys map to the closest DirectWrite face.
  "cjk":             win("msyh.ttc", "MicrosoftYaHei"),
  "cjk-bold":        win("msyhbd.ttc", "MicrosoftYaHei-Bold"),
  "cjk-serif":       win("simsun.ttc", "SimSun"),
  "cjk-serif-bold":  win("simsun.ttc", "SimSun"),
  // DM-1117: no Hiragino Mincho on Windows — route the explicit-name request to
  // SimSun (the serif CJK DirectWrite face). SimSun ships `trad`, but the
  // Windows chain isn't calibrated yet; the glyph resolves regardless.
  "hiragino-mincho":      win("simsun.ttc", "SimSun"),
  "hiragino-mincho-bold": win("simsun.ttc", "SimSun"),
  "pingfang-sc":      win("msyh.ttc", "MicrosoftYaHei"),
  "pingfang-sc-bold": win("msyhbd.ttc", "MicrosoftYaHei-Bold"),
  "pingfang-tc":      win("msjh.ttc", "MicrosoftJhengHeiRegular"),
  "pingfang-tc-bold": win("msjhbd.ttc", "MicrosoftJhengHeiBold"),
  "pingfang-hk":      win("msjh.ttc", "MicrosoftJhengHeiRegular"),
  "pingfang-hk-bold": win("msjhbd.ttc", "MicrosoftJhengHeiBold"),
  "pingfang-mo":      win("msjh.ttc", "MicrosoftJhengHeiRegular"),
  "pingfang-mo-bold": win("msjhbd.ttc", "MicrosoftJhengHeiBold"),
  "hiragino-jp":      win("YuGothR.ttc", "YuGothic-Regular"),
  "hiragino-jp-bold": win("YuGothB.ttc", "YuGothic-Bold"),
  "korean":           win("malgun.ttf", "MalgunGothic"),
  "korean-bold":      win("malgunbd.ttf", "MalgunGothicBold"),
  // DM-987: the Leelawadee UI Semilight file is `leeluisl.ttf` (PostScript
  // `LeelawadeeUI-Semilight`) — the previous `LeelaUIsl.ttf` / hyphen-less PS
  // name didn't exist on disk, so this key resolved to null. Verified against
  // C:\Windows\Fonts on a Windows 11 host.
  "thai":            win("leeluisl.ttf", "LeelawadeeUI-Semilight"),
  // Tahoma is what Chromium-on-Windows actually falls back to for Thai under a
  // sans-serif request (painted-font probe, DM-836), so the Thai fallback chain
  // prefers it over Leelawadee UI.
  "tahoma":          win("tahoma.ttf"),
  // DM-987: Nirmala UI ships as the collection `Nirmala.ttc` (members Nirmala
  // UI / Nirmala Text), NOT `Nirmala.ttf` — the old filename failed existsSync
  // so Devanagari (and all Indic via this key) silently fell through on Windows.
  "devanagari":      win("Nirmala.ttc", "NirmalaUI"),
  "sf-arabic":       win("segoeui.ttf"),
  "sf-hebrew":       win("segoeui.ttf"),
  // Segoe UI Symbol covers Geometric Shapes, Misc Symbols, Dingbats, Arrows.
  "symbols":         win("seguisym.ttf"),
  "zapf-dingbats":   win("seguisym.ttf"),
  "lucida-grande":   win("arial.ttf"),
  // Cambria Math is the DirectWrite math-coverage font (Math Alpha block).
  "stix-math":       win("cambria.ttc", "CambriaMath"),
  // Windows cursive/fantasy generics historically resolve to Comic Sans MS /
  // Impact in Chromium; mirror that for path discovery.
  "snell":           win("comic.ttf"),
  "apple-chancery":  win("comic.ttf"),
  "papyrus":         win("impact.ttf"),
  // DM-987: per-Unicode-block routes derived from a Chrome CDP
  // `CSS.getPlatformFontsForNode` sweep on a Windows 11 host (DirectWrite).
  // Generated by tools/probe-983-genroutes-win32.mjs from
  // tests/output/unicode-fonts.win32.json. 34 fonts cover 326 blocks; keys are
  // namespaced `u-...` so they can't collide with a hand-coded key above. The
  // generated entries carry bare filenames, prefixed here via `win()` so they
  // honor %WINDIR%. Coverage is dominated by Segoe UI Historic (ancient
  // scripts), SimSun-ExtB/-ExtG (rare CJK ideographs), Sans Serif Collection,
  // and the per-script UI faces (Ebrima / Gadugi / Yi Baiti / Myanmar / …).
  ...Object.fromEntries(
    Object.entries(UNICODE_FONT_FILES_WIN32).map(([key, e]) => [key, win(e.file, e.postscriptName)]),
  ),
};

// Resolved-path cache, keyed by logical font key. Holds the platform-specific
// FontPath (or null when the key has no mapping / file on this host). The
// fc-match shell-out on Linux is the main thing this avoids repeating.
const resolvedSpecCache = new Map<string, FontPath | null>();

/**
 * Run `fc-match` for a fontconfig pattern and return the resolved file plus
 * its postscript name (for picking the right TTC member). Returns null when
 * fc-match is missing, errors, or resolves to a file that doesn't exist.
 * Only ever called on Linux.
 */
function fcMatch(pattern: string): { path: string; postscriptName?: string } | null {
  try {
    const out = execFileSync("fc-match", ["-f", "%{file}\t%{postscriptname}", pattern], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "") return null;
    const [file, postscriptName] = out.split("\t");
    if (file == null || file === "" || !existsSync(file)) return null;
    return { path: file, postscriptName: postscriptName || undefined };
  } catch {
    return null;
  }
}

function resolveLinuxSpec(key: string): FontPath | null {
  const entry = LINUX_FONT_PATHS[key];
  if (entry == null) return null;
  // Canonical path first when it exists, then fontconfig discovery (entries
  // generated from the per-block sweep — DM-984 — have no `fcMatch` because
  // their absolute path is the answer; only the hand-coded entries carry one).
  if (entry.path != null && existsSync(entry.path)) {
    return { path: entry.path, postscriptName: entry.postscriptName, extractor: entry.extractor };
  }
  if (entry.fcMatch == null) return null;
  const matched = fcMatch(entry.fcMatch);
  if (matched == null) return null;
  return { path: matched.path, postscriptName: entry.postscriptName ?? matched.postscriptName, extractor: entry.extractor };
}

function resolveWin32Spec(key: string): FontPath | null {
  const spec = WIN32_FONT_PATHS[key];
  if (spec == null || !existsSync(spec.path)) return null;
  return spec;
}

/**
 * Resolve a logical font key to a concrete on-disk spec for the current
 * platform (DM-258). On macOS this is the unchanged `FONT_PATHS[key]` lookup —
 * file existence is still handled downstream by `fontkit.openSync` / the
 * glyph helper, preserving the family-chain fall-through for fonts that
 * aren't installed (e.g. Source Serif Pro). On Linux / Windows it consults
 * the per-platform tables above, verifying the file exists (and using
 * `fc-match` discovery on Linux). Results are cached per key.
 */
// DM-1018: dynamic font specs registered at runtime by the CoreText system-
// fallback resolver (`resolveSystemFallbackKeyForCp`). Keyed `sysfb:<psName>`.
// These point at on-disk fonts CTFontCreateForString picked that aren't in the
// static FONT_PATHS table (e.g. Mplus 1p for Kana Supplement). Checked by
// resolveFontSpec before the platform tables so the dynamic key resolves.
const dynamicSystemFontPaths = new Map<string, FontPath>();

/** DM-1018: register a CoreText-resolved on-disk font under a `sysfb:<psName>`
 *  key so getFontInstance / resolveFontSpec can open it. `extractor: native`
 *  routes through the CoreText helper (handles hvgl / GSUB-crashing faces and
 *  the `.notdef` extraction), and the path lets the helper open the exact file
 *  CoreText chose. No-op if already registered. */
function registerDynamicSystemFont(key: string, path: string, postscriptName: string): void {
  if (dynamicSystemFontPaths.has(key)) return;
  dynamicSystemFontPaths.set(key, { path, postscriptName, extractor: "native" });
  resolvedSpecCache.delete(key); // in case a prior null was cached
}

function resolveFontSpec(key: string): FontPath | null {
  if (resolvedSpecCache.has(key)) return resolvedSpecCache.get(key)!;
  let resolved: FontPath | null;
  if (key.startsWith("sysfb:")) {
    resolved = dynamicSystemFontPaths.get(key) ?? null;
  } else switch (process.platform) {
    case "linux": resolved = resolveLinuxSpec(key); break;
    case "win32": resolved = resolveWin32Spec(key); break;
    default:      resolved = FONT_PATHS[key] ?? null; break; // darwin + any other Unix with macOS-style paths
  }
  resolvedSpecCache.set(key, resolved);
  return resolved;
}

// DM-1018: per-codepoint memo of the resolved `sysfb:` key (or null when the
// CoreText cascade falls through to LastResort — Chrome paints its placeholder
// there, handled by the primary-`.notdef` terminal).
const systemFallbackKeyCache = new Map<number, string | null>();

// DM-1018: gate for the per-codepoint CoreText system-fallback resolution.
// Each first-seen uncovered codepoint costs one `CTFontCreateForString`
// subprocess round-trip (memoized after). Worth it for blocks where a real
// system font exists that the sampled per-block table missed (Kana Supplement
// → Mplus 1p). darwin-only; auto-off when the helper binary isn't present.
let _systemFallbackResolutionEnabled = process.platform === "darwin";
/** Test/perf hook to toggle the CoreText per-codepoint fallback resolver. */
export function setSystemFallbackResolution(on: boolean): void { _systemFallbackResolutionEnabled = on; }

/**
 * Resolve the system fallback font for a codepoint the way Chrome-on-macOS
 * does — via CoreText's `CTFontCreateForString` (see `resolveSystemFallbackFonts`
 * in glyph-helper). Registers the resolved on-disk font as a dynamic
 * `sysfb:<postscriptName>` key and returns it, so the chain walker can open it
 * through the normal `getFontInstance` path. Returns null when CoreText
 * resolves to LastResort (keep `last-resort`) or the helper isn't available
 * (non-macOS / unbuilt). darwin-only: Linux/Windows have their own system
 * fallback engines and aren't wired here yet.
 */
function resolveSystemFallbackKeyForCp(cp: number): string | null {
  if (process.platform !== "darwin") return null;
  if (systemFallbackKeyCache.has(cp)) return systemFallbackKeyCache.get(cp)!;
  let key: string | null = null;
  try {
    const resolved = resolveSystemFallbackFonts([cp]).get(cp);
    if (resolved != null && resolved.path !== "") {
      key = `sysfb:${resolved.postscriptName}`;
      registerDynamicSystemFont(key, resolved.path, resolved.postscriptName);
    }
  } catch { key = null; }
  systemFallbackKeyCache.set(cp, key);
  return key;
}

/** Test-only window into the platform path resolver (DM-258). */
export function __resolveFontSpecForTest(key: string): { path: string; postscriptName?: string; extractor?: string } | null {
  return resolveFontSpec(key);
}

/**
 * Test-only: resolve a key against the **darwin** `FONT_PATHS` table directly,
 * independent of `process.platform`. The darwin-chain well-formedness guard
 * (DM-1030) must check the keys `darwinFallbackChain` emits — including the
 * darwin-only `u-...` per-block routes (DM-983) — against the darwin table even
 * when the suite runs on Linux CI; the platform-gated `resolveFontSpec` would
 * otherwise look the darwin keys up in `LINUX_FONT_PATHS` and spuriously fail.
 * Mirrors how the win32 routing guard (DM-987) checks `UNICODE_FONT_FILES_WIN32`
 * directly rather than going through the host resolver.
 */
export function __resolveDarwinFontSpecForTest(key: string): { path: string; postscriptName?: string; extractor?: string } | null {
  return FONT_PATHS[key] ?? null;
}

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

/**
 * Linux fallback chain (DM-259) — calibrated to what Chromium-on-Linux paints
 * in the Playwright `*-noble` CI image, measured via CDP
 * `CSS.getPlatformFontsForNode` (tools/probe-fallbacks-linux.mjs). Returns
 * logical keys that `LINUX_FONT_PATHS` maps to the image's real faces
 * (Liberation / WenQuanYi / FreeFont / Loma / IPAGothic). As on macOS, the
 * caller has already tried the primary font, so what reaches here is the
 * residue the primary lacks. The comment after each branch names the face the
 * probe showed Chromium using for that block.
 */
export function linuxFallbackChain(codepoint: number, primaryKey?: string, _lang?: string): string[] {
  const cp = codepoint;
  // Hebrew — Liberation Sans covers it, so route to the sans key (probe: hebrew
  // → Liberation Sans, i.e. the primary itself when sans-serif).
  if ((cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0xFB1D && cp <= 0xFB4F)) return ["helvetica"];
  // Arabic core + presentation forms — FreeSerif (probe: arabic → FreeSerif).
  if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF)) {
    return ["sf-arabic"]; // → FreeSerif on Linux
  }
  // Devanagari — FreeSans (probe: devanagari → FreeSans).
  if (cp >= 0x0900 && cp <= 0x097F) return ["devanagari"]; // → FreeSans
  // Thai — Loma (probe: thai → Loma).
  if (cp >= 0x0E00 && cp <= 0x0E7F) return ["thai"];
  // Hangul — WenQuanYi Zen Hei (probe: hangul → WenQuanYi).
  if ((cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0x1100 && cp <= 0x11FF)) return ["cjk"];
  // Box Drawing / Block — mono primary keeps the primary (WenQuanYi Zen Hei
  // Mono covers them at cell width); non-mono falls to Liberation Sans, then CJK
  // (probe: box-drawing mono → WQY Mono; box-drawing-sans → Liberation Sans).
  if (cp >= 0x2500 && cp <= 0x259F) {
    const monoPrimary = primaryKey === "courier" || primaryKey === "menlo"
      || primaryKey === "monaco" || primaryKey === "sf-mono";
    return monoPrimary ? [primaryKey!, "cjk"] : ["helvetica", "cjk"];
  }
  // Dingbats — FreeSans (probe: ✂✈❤ → FreeSans).
  if (cp >= 0x2700 && cp <= 0x27BF) return ["free-sans", "free-serif"];
  // Chess pieces — FreeSerif (probe: ♔♚ → FreeSerif).
  if (cp >= 0x2654 && cp <= 0x265F) return ["free-serif", "free-sans"];
  // Diagonal arrows ↗↙ — WenQuanYi (probe: arrows-diag → WenQuanYi); the rest of
  // the Arrows block → Liberation Sans (probe: ←→↑↓↔ → Liberation Sans).
  if (cp === 0x2197 || cp === 0x2199) return ["cjk", "helvetica"];
  if (cp >= 0x2190 && cp <= 0x21FF) return ["helvetica", "free-sans"];
  // Geometric Shapes — Liberation Sans, then WenQuanYi for what it lacks
  // (probe: ▲●◆■□○ → Liberation Sans + WenQuanYi).
  if (cp >= 0x25A0 && cp <= 0x25FF) return ["helvetica", "cjk"];
  // Misc Symbols — Liberation Sans + IPAGothic (probe: ☀☂♠♥♦ → Liberation Sans
  // + IPAGothic).
  if (cp >= 0x2600 && cp <= 0x26FF) return ["helvetica", "hiragino-jp", "free-sans"];
  // Mathematical Alphanumeric — FreeSans + FreeSerif (probe: 𝐀𝒜𝕊 → FreeSans/FreeSerif).
  if (cp >= 0x1D400 && cp <= 0x1D7FF) return ["free-sans", "free-serif"];
  // Superscripts / Subscripts — Liberation Sans + FreeSans (probe: aₙ₁).
  if (cp >= 0x2070 && cp <= 0x209F) return ["helvetica", "free-sans"];
  // Letterlike + Math Operators — FreeSans first, then Liberation Sans (probe:
  // ℝ™ℕℤ → FreeSans + Liberation Sans; ∑∫≠ is covered by the Liberation Sans primary).
  if ((cp >= 0x2100 && cp <= 0x214F) || (cp >= 0x2200 && cp <= 0x22FF)) return ["free-sans", "helvetica"];
  // CJK Han / Kana / CJK Symbols & Punctuation — WenQuanYi Zen Hei (probe:
  // 漢字/あ/ア → WenQuanYi). Japanese-tagged text prefers IPAGothic; left as a
  // refinement (untagged probe resolved to WenQuanYi). DM-259 follow-up.
  if ((cp >= 0x3000 && cp <= 0x303F) || (cp >= 0x3040 && cp <= 0x309F)
    || (cp >= 0x30A0 && cp <= 0x30FF) || (cp >= 0x31F0 && cp <= 0x31FF)
    || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF)
    || (cp >= 0xF900 && cp <= 0xFAFF)) {
    return ["cjk"];
  }
  // Pictographs / Transport residue not caught by the color-emoji raster path
  // (doc 15) — FreeSans as a monochrome last resort.
  if ((cp >= 0x1F300 && cp <= 0x1F5FF) || (cp >= 0x1F680 && cp <= 0x1F6FF)) return ["free-sans"];
  // DM-984: per-Unicode-block fallback derived from a Chrome CDP sweep inside
  // the Playwright Docker container — `CSS.getPlatformFontsForNode` for every
  // block in tools/unicode-fixtures/*.html. Resolved to bare-image paths by
  // tools/probe-983-genroutes-linux.mjs (Unifont / FreeSans / Liberation / etc).
  // Consulted as a LAST resort so the hand-tuned routes above still win where
  // they match.
  const generatedKey = lookupLinuxUnicodeFontRange(codepoint);
  if (generatedKey != null) return [generatedKey];
  return [];
}

/** Binary-search the generated `UNICODE_FONT_RANGES_LINUX` for a codepoint. */
function lookupLinuxUnicodeFontRange(codepoint: number): string | null {
  let lo = 0;
  let hi = UNICODE_FONT_RANGES_LINUX.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = UNICODE_FONT_RANGES_LINUX[mid]!;
    if (codepoint < r[0]) hi = mid - 1;
    else if (codepoint > r[1]) lo = mid + 1;
    else return r[2];
  }
  return null;
}

/**
 * Windows (DirectWrite) per-Unicode-block fallback routing. DM-260 / DM-836.
 *
 * Keys resolve through `WIN32_FONT_PATHS` (DM-258) to real Windows faces:
 * `helvetica`→Arial, `times`→Times New Roman, `sf-mono`/`menlo`→Consolas,
 * `cjk`→Microsoft YaHei, `hiragino-jp`→Yu Gothic, `cjk-serif`→SimSun,
 * `korean`→Malgun Gothic, `sf-arabic`/`sf-hebrew`→Segoe UI, `devanagari`→Nirmala
 * UI, `thai`→Leelawadee UI, `symbols`/`zapf-dingbats`→Segoe UI Symbol,
 * `stix-math`→Cambria Math.
 *
 * Calibration basis (run 26430174100 painted-advance probe):
 * - **Proven from the probe**: Chromium-on-Windows paints the symbol / math /
 *   geometric-shape / box-drawing / arrow codepoints in **Arial itself** (the
 *   sans default covers them — `sans-serif` painted width == Arial's exactly),
 *   not in a dedicated symbol face. So those blocks route to `helvetica` (Arial)
 *   first, with Segoe UI Symbol / Cambria Math only as the residue fallback.
 *   This is the key correction over the previous darwin-fallthrough, which sent
 *   them to macOS faces (Hiragino / Zapf Dingbats / STIX) that look wrong or
 *   don't exist on Windows.
 * - **Painted-font-confirmed (run 26430730227, via `getPlatformFontsForNode`)**:
 *   Han → Microsoft YaHei, Hangul → Malgun Gothic, Thai → Tahoma.
 * - **First cut, pending confirmation**: Arabic / Hebrew → Segoe UI, Devanagari
 *   → Nirmala UI (advance width can't fingerprint these — every such sample
 *   measures one em — and they weren't isolated in the painted-font check yet).
 */
export function win32FallbackChain(codepoint: number, primaryKey?: string, _lang?: string): string[] {
  const cp = codepoint;
  // Hebrew — Segoe UI covers it.
  if ((cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0xFB1D && cp <= 0xFB4F)) return ["sf-hebrew"];
  // Arabic core + presentation forms — Segoe UI.
  if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF)) {
    return ["sf-arabic"];
  }
  // Devanagari — Nirmala UI.
  if (cp >= 0x0900 && cp <= 0x097F) return ["devanagari"];
  // Thai — Tahoma (painted-font probe DM-836 confirms Chromium falls back to
  // Tahoma under sans-serif), Leelawadee UI as a secondary.
  if (cp >= 0x0E00 && cp <= 0x0E7F) return ["tahoma", "thai"];
  // Hangul — Malgun Gothic (painted-font probe confirmed); YaHei last resort.
  if ((cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0x1100 && cp <= 0x11FF)) return ["korean", "cjk"];
  // Math Alphanumeric — Cambria Math carries the whole block; the
  // `mathAlphaToBase` decomposition handles any residue.
  if (cp >= 0x1D400 && cp <= 0x1D7FF) return ["stix-math", "helvetica"];
  // CJK Han / Kana / CJK Symbols & Punctuation. Serif primary → SimSun;
  // Japanese-tagged → Yu Gothic; otherwise Microsoft YaHei.
  if ((cp >= 0x3000 && cp <= 0x303F) || (cp >= 0x3040 && cp <= 0x309F)
    || (cp >= 0x30A0 && cp <= 0x30FF) || (cp >= 0x31F0 && cp <= 0x31FF)
    || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF)
    || (cp >= 0xF900 && cp <= 0xFAFF)) {
    const serifPrimary = primaryKey === "times" || primaryKey === "times-new-roman" || primaryKey === "georgia";
    if (serifPrimary) return ["cjk-serif", "cjk"];
    if (_lang != null && /^ja\b/i.test(_lang)) return ["hiragino-jp", "cjk"];
    return ["cjk"];
  }
  // Box Drawing / Block Elements — mono primary keeps its own cell-width glyphs
  // (Consolas), then Consolas as a safety net; non-mono falls to Arial (the
  // probe paints `─ ┼ ┬` at Arial's width for sans-serif).
  if (cp >= 0x2500 && cp <= 0x259F) {
    const monoPrimary = primaryKey === "courier" || primaryKey === "menlo"
      || primaryKey === "monaco" || primaryKey === "sf-mono";
    return monoPrimary ? [primaryKey!, "sf-mono"] : ["helvetica", "symbols"];
  }
  // Dingbats — Arial lacks most; Segoe UI Symbol covers them.
  if (cp >= 0x2700 && cp <= 0x27BF) return ["symbols"];
  // Geometric Shapes / Misc Symbols / Arrows — Arial covers the common ones
  // (probe: ■ ● ◆ ★ ✒ ← → at Arial's width); Segoe UI Symbol for the residue.
  if ((cp >= 0x2190 && cp <= 0x21FF) || (cp >= 0x25A0 && cp <= 0x25FF) || (cp >= 0x2600 && cp <= 0x26FF)) {
    return ["helvetica", "symbols"];
  }
  // Superscripts / Subscripts, Letterlike, Math Operators — Arial carries the
  // common members (probe: ∑ ∏ ≠ ∫ at Arial's width); Cambria Math for the rest.
  if (cp >= 0x2070 && cp <= 0x209F) return ["helvetica"];
  if ((cp >= 0x2100 && cp <= 0x214F) || (cp >= 0x2200 && cp <= 0x22FF)) return ["helvetica", "stix-math"];
  // Pictographs not caught by the color-emoji raster path — Segoe UI Symbol
  // monochrome as a last resort.
  if ((cp >= 0x1F300 && cp <= 0x1F5FF) || (cp >= 0x1F680 && cp <= 0x1F6FF)) return ["symbols"];
  // DM-987: per-Unicode-block fallback derived from a Chrome CDP sweep on a
  // Windows 11 host — `CSS.getPlatformFontsForNode` for every block in
  // ../html-test/unicode/*.html. Resolved to C:\Windows\Fonts faces by
  // tools/probe-983-genroutes-win32.mjs (Segoe UI Historic for ancient
  // scripts, SimSun-ExtB/-ExtG for rare ideographs, Ebrima / Gadugi / Yi Baiti
  // / Myanmar Text / … for the per-script UI faces). Consulted as a LAST
  // resort so the hand-tuned routes above still win where they match.
  const generatedKey = lookupWin32UnicodeFontRange(codepoint);
  if (generatedKey != null) return [generatedKey];
  return [];
}

/** Binary-search the generated `UNICODE_FONT_RANGES_WIN32` for a codepoint. */
function lookupWin32UnicodeFontRange(codepoint: number): string | null {
  let lo = 0;
  let hi = UNICODE_FONT_RANGES_WIN32.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = UNICODE_FONT_RANGES_WIN32[mid]!;
    if (codepoint < r[0]) hi = mid - 1;
    else if (codepoint > r[1]) lo = mid + 1;
    else return r[2];
  }
  return null;
}

export function fallbackFontChain(codepoint: number, primaryKey?: string, lang?: string): string[] {
  // Platform-aware routing (DM-259 / DM-260). Each platform's Chromium cascades
  // through entirely different faces (CoreText vs fontconfig vs DirectWrite), so
  // each has its own empirically-probed chain.
  if (process.platform === "linux") return linuxFallbackChain(codepoint, primaryKey, lang);
  if (process.platform === "win32") return win32FallbackChain(codepoint, primaryKey, lang);
  return darwinFallbackChain(codepoint, primaryKey, lang);
}

/**
 * Decompose a Mathematical Alphanumeric Symbols codepoint (U+1D400–U+1D7FF)
 * into its base letter / digit plus the implied bold / italic style.
 *
 * Why: Chromium does NOT carry a dedicated glyph for every Math-Alpha
 * codepoint on every platform. On the Linux Playwright image the system math
 * faces (FreeSans / FreeSerif) have no U+1D4xx coverage at all — a probe
 * confirmed `FreeSansOblique` lacks the entire block — so Chromium paints
 * e.g. 𝑎 (U+1D44E) by synthesizing it from the *base* italic letter `a` in
 * the already-oblique face. fontkit returns `.notdef` for the math codepoint
 * for the same reason the cmap lacks it, so without this the renderer drops
 * the glyph to a `<text>` element. When the whole fallback chain comes up
 * empty for a Math-Alpha codepoint we map it back to its base char + style
 * and render that base glyph in the matching weight / slant face — matching
 * what Chromium actually painted. (macOS/Windows are unaffected: STIX Two
 * Math / Cambria Math cover U+1D4xx, so the chain finds the glyph and this
 * path never runs.)
 *
 * Covers the styles that reduce to a bold/italic toggle of a base Latin/Greek
 * letter or digit: bold, italic, bold-italic, the four sans-serif variants,
 * and monospace, plus the Greek symbol variants and the U+210E (ℎ) hole the
 * capture emits for italic lowercase h. The script / fraktur / double-struck
 * styles are distinct typefaces that can't be faithfully synthesized from a
 * base letter, so they return `null` (the caller keeps the pre-existing
 * chain behavior for those).
 *
 * Exported for unit tests.
 */
export function mathAlphaToBase(cp: number): { base: number; bold: boolean; italic: boolean } | null {
  // PLANCK CONSTANT (U+210E): Unicode reuses this for Mathematical Italic
  // small h (the U+1D455 slot is unassigned), and the capture emits it for
  // `<mi>h</mi>`. Decompose it back to an italic `h`.
  if (cp === 0x210e) return { base: 0x68, bold: false, italic: true };
  if (cp < 0x1d400 || cp > 0x1d7ff) return null;

  // Latin alphabet styles. Each is 52 contiguous codepoints (A–Z then a–z),
  // except the styles flagged below that borrow letters from the Letterlike
  // Symbols block (script / fraktur / double-struck) — those are skipped.
  const latin: Array<{ start: number; bold: boolean; italic: boolean } | null> = [
    { start: 0x1d400, bold: true,  italic: false }, // Bold
    { start: 0x1d434, bold: false, italic: true  }, // Italic (small-h hole → U+210E, handled above)
    { start: 0x1d468, bold: true,  italic: true  }, // Bold Italic
    null,                                           // Script
    null,                                           // Bold Script
    null,                                           // Fraktur
    null,                                           // Double-struck
    null,                                           // Bold Fraktur
    { start: 0x1d5a0, bold: false, italic: false }, // Sans-serif
    { start: 0x1d5d4, bold: true,  italic: false }, // Sans-serif Bold
    { start: 0x1d608, bold: false, italic: true  }, // Sans-serif Italic
    { start: 0x1d63c, bold: true,  italic: true  }, // Sans-serif Bold Italic
    { start: 0x1d670, bold: false, italic: false }, // Monospace
  ];
  for (const style of latin) {
    if (style == null) continue;
    const off = cp - style.start;
    if (off < 0 || off > 51) continue;
    const base = off < 26 ? 0x41 + off : 0x61 + (off - 26);
    return { base, bold: style.bold, italic: style.italic };
  }

  // Greek styles. Each block is 58 (0x3A) contiguous codepoints with the same
  // internal layout: 25 uppercase (Α…Ω), ∇, 25 lowercase (α…ω), then 7 symbol
  // variants (∂ ϵ ϑ ϰ ϕ ϱ ϖ). The decomposition is the exact inverse of the
  // capture's mathvariant=italic mapping for the italic block, applied to all
  // five bold/italic/sans Greek styles.
  const greek: Array<{ start: number; bold: boolean; italic: boolean }> = [
    { start: 0x1d6a8, bold: true,  italic: false }, // Bold
    { start: 0x1d6e2, bold: false, italic: true  }, // Italic
    { start: 0x1d71c, bold: true,  italic: true  }, // Bold Italic
    { start: 0x1d756, bold: true,  italic: false }, // Sans-serif Bold
    { start: 0x1d790, bold: true,  italic: true  }, // Sans-serif Bold Italic
  ];
  const greekSymbols = [0x2202, 0x3f5, 0x3d1, 0x3f0, 0x3d5, 0x3f1, 0x3d6]; // ∂ ϵ ϑ ϰ ϕ ϱ ϖ
  for (const style of greek) {
    const off = cp - style.start;
    if (off < 0 || off > 57) continue;
    let base: number;
    if (off <= 24) base = 0x391 + off;            // uppercase Α…Ω
    else if (off === 25) base = 0x2207;            // ∇ nabla
    else if (off <= 50) base = 0x3b1 + (off - 26); // lowercase α…ω
    else base = greekSymbols[off - 51];            // symbol variants
    return { base, bold: style.bold, italic: style.italic };
  }

  // Digit styles (U+1D7CE–U+1D7FF). Double-struck (1D7D8) is a distinct
  // typeface → skipped; the rest reduce to a bold/normal toggle of 0–9.
  const digits: Array<{ start: number; bold: boolean } | null> = [
    { start: 0x1d7ce, bold: true  }, // Bold
    null,                            // Double-struck
    { start: 0x1d7e2, bold: false }, // Sans-serif
    { start: 0x1d7ec, bold: true  }, // Sans-serif Bold
    { start: 0x1d7f6, bold: false }, // Monospace
  ];
  for (const style of digits) {
    if (style == null) continue;
    const off = cp - style.start;
    if (off < 0 || off > 9) continue;
    return { base: 0x30 + off, bold: style.bold, italic: false };
  }

  return null;
}

/** FreeFont sibling key for a given base FreeFont key + bold/italic style. */
function freeFontVariantKey(baseKey: string, bold: boolean, italic: boolean): string {
  if (bold && italic) return `${baseKey}-bold-italic`;
  if (bold) return `${baseKey}-bold`;
  if (italic) return `${baseKey}-italic`;
  return baseKey;
}

/**
 * Math-Alphanumeric decomposition fallback, shared by both run splitters.
 * Call only when NO font in `chain` could render `cp` directly. If `cp` is a
 * synthesizable Math-Alpha symbol, returns the base letter/digit `ch` to
 * render plus the FreeFont sibling key/instance (weight/slant baked into the
 * file, so the resolved outline is already bold/oblique). Returns null when
 * `cp` isn't Math-Alpha or no FreeFont sibling covers the base char — the
 * caller then keeps the pre-existing chain behavior. See mathAlphaToBase.
 */
function decomposeMathAlphaRun(
  cp: number, chain: string[], weight: number, fontSize: number,
): { key: string; font: FontInstance; ch: string } | null {
  const decomp = mathAlphaToBase(cp);
  if (decomp == null) return null;
  for (const candidate of chain) {
    if (candidate !== "free-sans" && candidate !== "free-serif") continue;
    const vKey = freeFontVariantKey(candidate, decomp.bold, decomp.italic);
    const vFont = getFontInstance(vKey, weight, fontSize, 0);
    if (vFont != null && vFont.glyphForCodePoint != null
        && vFont.glyphForCodePoint(decomp.base).id !== 0) {
      return { key: vKey, font: vFont, ch: String.fromCodePoint(decomp.base) };
    }
  }
  return null;
}

/**
 * macOS (CoreText) fallback chain — reverse-engineered from Chromium-on-macOS
 * painted widths (DM-241 / DM-256 / DM-257 / …). Exported so the macOS-
 * calibration unit tests assert it directly: the suite runs on Linux in CI,
 * where `fallbackFontChain` dispatches to `linuxFallbackChain`, so those tests
 * must call this function (not `fallbackFontChain`) to validate macOS routing
 * regardless of the host platform (DM-842).
 */
export function darwinFallbackChain(codepoint: number, primaryKey?: string, lang?: string): string[] {
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
    // DM-1117: author explicitly named Hiragino Mincho ProN — route its own
    // glyphs first so the `trad` / `fwid` / `jp78` East-Asian features land on a
    // font that carries them (Songti doesn't). Falls back to the generic serif
    // CJK then sans CJK for any codepoint Mincho lacks.
    if (primaryKey === "hiragino-mincho") return ["hiragino-mincho", "cjk-serif", "cjk"];
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
  // CJK supplementary planes — Unified Ideographs Extensions B/C/D/E/F/I
  // (U+20000..U+2EBEF), CJK Compatibility Ideographs Supplement
  // (U+2F800..U+2FA1F), Ext G (U+30000..U+3134F) and Ext H
  // (U+31350..U+323AF). On macOS Chrome reaches Apple's PingFang variants
  // (PingFangSC for Ext B/C/D/E/F/G, PingFangHK for Ext H, PingFangTC for
  // the small set of compat-ideographs additions HK lacks). Probed per-
  // codepoint via CSS.getPlatformFontsForNode: U+305D6 → .PingFangSC-Regular,
  // U+3208E → .PingFangHK-Regular. Without this route the codepoints fall
  // through to the DM-983 generated table — which (because Arial Unicode
  // MS / Noto Sans KR don't carry these blocks) maps to fonts with no
  // glyph and the chain ends at `[]`, rendering nothing for what Chrome
  // paints as a real character. DM-1000 / DM-1011 / DM-1012.
  //
  // `pingfang-hk` is tried before `pingfang-sc` because HK has the broadest
  // coverage of the post-Unicode-13 additions (Apple updates HK first for
  // newly-added codepoints); SC catches the older Ext B/C/D/E/F set; `cjk`
  // (HiraginoSansGB) stays as a safety net; LastResort emits Chrome's
  // block-frame placeholder for the residue PingFang lacks.
  if ((codepoint >= 0x20000 && codepoint <= 0x2EBEF)
    || (codepoint >= 0x2F800 && codepoint <= 0x2FA1F)
    || (codepoint >= 0x30000 && codepoint <= 0x323AF)) {
    if (serifPrimary) return ["cjk-serif", "pingfang-hk", "pingfang-sc", "cjk", "last-resort"];
    const localeKey = pingfangKeyForLang(lang);
    if (localeKey === "hiragino-jp") return ["hiragino-jp", "pingfang-hk", "pingfang-sc", "cjk", "last-resort"];
    if (localeKey != null) return [localeKey, "pingfang-hk", "pingfang-sc", "cjk", "last-resort"];
    return ["pingfang-hk", "pingfang-sc", "cjk", "last-resort"];
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
  // DM-925: U+25C8 WHITE DIAMOND CONTAINING SMALL BLACK DIAMOND (◈) —
  // Chrome paints via AppleSDGothicNeo (Korean fallback), not Hiragino
  // Sans GB which has no glyph for it. Probe @18 px: Chrome 15.59 px,
  // AppleSDGothicNeo 15.57 px (match), Apple Symbols 13.91 px (off by
  // 1.68 px). The `korean` key already exists for Hangul routing;
  // reuse it here for this single misc-shapes codepoint.
  if (codepoint === 0x25C8) {
    return ["korean", "symbols"];
  }
  // DM-980: U+2713 CHECK MARK (✓) — Chrome routes to **LucidaGrande**, not
  // Zapf Dingbats. Per-codepoint probe at 32 px sans-serif: Chrome returns
  // "Lucida Grande" as the sole font (paint width 24.45 px); fontkit's
  // LucidaGrande.glyphForCodePoint(0x2713) = id 977, width 24.45 px @ 32 px
  // (exact match). ZapfDingbats also has the glyph at width 24.16 px (close
  // but the shape is visibly thinner — that's the "thinner / different-angle
  // checkmark" the ticket flags). All other Dingbats codepoints (U+2714 ✔,
  // U+2717 ✗, U+2718 ✘, U+271A ✚, U+2730 ✰, …) continue to use Zapf
  // Dingbats — the broad U+2700..27BF route below still catches them.
  if (codepoint === 0x2713) {
    return ["lucida-grande", "zapf-dingbats", "symbols"];
  }
  // DM-979: Double-struck Letterlike Symbols U+2115 ℕ, U+211D ℝ, U+2124 ℤ.
  // Chrome routes these to **Menlo** (per `CSS.getPlatformFontsForNode`
  // probe at 32 px sans-serif: all three return Menlo as the sole font,
  // paint width 19.27 px). fontkit confirms Menlo carries the glyphs at
  // 19.27 px @ 32 px exactly; Apple Symbols also has them but at
  // proportional widths (20-26 px), and the existing `[symbols]` route
  // for the Letterlike block would have used those wider glyphs — but
  // even that wasn't happening because earlier in the dispatch the
  // primary font (Helvetica) gets first crack at these codepoints and
  // PAINTS the plain Latin R / N / Z (Helvetica's cmap maps the
  // Letterlike codepoints to the corresponding ASCII glyph, producing
  // "plain R N Z" — DM-979's observed actual). Pre-empting the chain
  // with Menlo here matches Chrome's paint shape AND width.
  if (codepoint === 0x2115 || codepoint === 0x211D || codepoint === 0x2124) {
    return ["menlo", "symbols"];
  }
  // DM-981: U+2135 ℵ (HEBREW LETTER ALEF, used as transfinite cardinal in
  // Letterlike Symbols) — Chrome routes to Lucida Grande (20.64 px @ 32 px).
  // Helvetica primary has no glyph; the existing `[symbols]` fallback hits
  // Apple Symbols at 19.11 px (close but visibly narrower than Chrome's).
  // LucidaGrande matches exactly.
  if (codepoint === 0x2135) {
    return ["lucida-grande", "symbols"];
  }
  // DM-978: Double-headed arrows U+21D0..U+21D5 (⇐⇑⇒⇓⇔⇕). Chrome's
  // per-codepoint font choice (via `CSS.getPlatformFontsForNode` probe
  // at 32 px sans-serif):
  //   ⇐ U+21D0 → Hiragino Sans (JP), 32.00 px
  //   ⇑ U+21D1 → Apple SD Gothic Neo, 27.69 px  (Hiragino lacks the glyph)
  //   ⇒ U+21D2 → Hiragino Sans (JP), 29.31 px
  //   ⇓ U+21D3 → Apple SD Gothic Neo, 27.69 px  (Hiragino lacks the glyph)
  //   ⇔ U+21D4 → Hiragino Sans (JP), 29.31 px
  //   ⇕ U+21D5 → Menlo, 19.27 px               (both Hiragino + ASDGN lack)
  // fontkit advance widths confirm sub-pixel matches for each.
  // A single chain `["hiragino-jp", "korean", "menlo", "symbols"]` lets the
  // renderer walk per codepoint and pick the first font carrying the glyph
  // — same dispatch as `chain.find(hasGlyph)` everywhere else in the
  // renderer. Replaces the previous "fall through to Apple Symbols"
  // residue that produced thinner / lighter strokes than Chrome paints.
  if (codepoint >= 0x21D0 && codepoint <= 0x21D5) {
    return ["hiragino-jp", "korean", "menlo", "symbols"];
  }
  // DM-981: Single-headed misc arrows U+2194..U+2199 (↔ ↕ ↖ ↗ ↘ ↙) —
  // Chrome's per-codepoint CDP probe at 32 px sans-serif:
  //   ↔ U+2194 → Hiragino Sans (JP), 29.31 px
  //   ↕ U+2195 → Apple SD Gothic Neo,  17.64 px
  //   ↖ U+2196 → Lucida Grande,        32.00 px
  //   ↗ U+2197 → Hiragino Sans (JP),  32.00 px
  //   ↘ U+2198 → Lucida Grande,        32.00 px
  //   ↙ U+2199 → Hiragino Sans (JP),  32.00 px
  // The renderer's chain walker picks the first font carrying the glyph,
  // so a unified `["hiragino-jp", "korean", "lucida-grande", "symbols"]`
  // route matches all six per-codepoint choices (the font Chrome picks for
  // each is the first in the chain that has a non-zero glyph for it).
  // Supersedes the earlier U+2197/U+2199 special case at the same
  // codepoints below — keep this branch first to take precedence.
  if (codepoint >= 0x2194 && codepoint <= 0x2199) {
    return ["hiragino-jp", "korean", "lucida-grande", "symbols"];
  }
  // DM-977: Patterned squares U+25A3..U+25A9 (▣ ▤ ▥ ▦ ▧ ▨ ▩) — Chrome
  // paints via AppleSDGothicNeo at sans-serif primary, NOT Hiragino. The
  // earlier DM-415/DM-429 attempt routed these to AppleSDGothicNeo and
  // reverted citing visible ink mismatch — re-verified the routing here
  // via per-codepoint `CSS.getPlatformFontsForNode` probe (each cp
  // returns "Apple SD Gothic Neo" as the sole font, paint width 27.69 px
  // @32 px) and width-matched with fontkit (27.68 px, sub-pixel match).
  // The visible "denser hatching" is exactly AppleSDGothicNeo's glyph —
  // the prior revert misjudged the ink delta against a different probe
  // size. `korean` is the existing key (same font file as U+25C8 above).
  if (codepoint >= 0x25A3 && codepoint <= 0x25A9) {
    return ["korean", "symbols"];
  }
  // DM-925: Gender symbols (U+2640 ♀, U+2641 ♁, U+2642 ♂) — Chrome
  // routes to **Hiragino Sans (Japanese, HiraginoSans-W3)** per
  // CSS.getPlatformFontsForNode probe, NOT Hiragino Sans GB (Chinese,
  // HiraginoSansGB-W3). The two have meaningfully different glyph
  // shapes for ♂: Japanese has the classic up-right diagonal arrow,
  // Chinese variant has a straight-up arrow. Our `cjk` route resolves
  // to GB and produced the wrong-shape glyph. Switch the chain to
  // prefer the Japanese face (`hiragino-jp`) first.
  if (codepoint >= 0x2640 && codepoint <= 0x2642) {
    return ["hiragino-jp", "cjk", "symbols"];
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
    // DM-988: Chrome's per-codepoint pick varies by primary-font class for
    // these blocks (Geometric Shapes + Misc Symbols). Probed at 18 px:
    //   sans primary: ★ ♥ ♠ ♣ → Hiragino Sans (JP) em-square 18 px
    //   serif primary: ★ → Songti SC (cjk-serif) em-square 18 px,
    //                  ♥ ♠ ♣ → Times New Roman proportional ~10-12 px
    //   mono primary: ★ ♥ ♠ ♣ → Menlo cell-width (~10.84 px @18)
    // The previous unified `["cjk", "hiragino-jp", "symbols"]` chain used
    // HiraginoSansGB (Chinese) first, which paints these glyphs at a
    // visibly larger / differently-shaped em-square than HiraKakuProN
    // (Japanese) — visible diff on `02-text-symbols`'s `.serif` and
    // `.mono` rows where the primary should win. Branch by primary so the
    // chain matches Chrome's per-context pick.
    const monoPrimary = primaryKey === "courier" || primaryKey === "menlo"
      || primaryKey === "monaco" || primaryKey === "sf-mono";
    if (monoPrimary) return [primaryKey!, "menlo", "hiragino-jp", "symbols"];
    if (serifPrimary) return ["cjk-serif", primaryKey ?? "times", "hiragino-jp", "symbols"];
    return ["hiragino-jp", "cjk", "symbols"];
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
  // DM-807: Superscripts and Subscripts block (U+2070-U+209F). The label
  // glyphs `aₙ` / `a₁` use the Latin subscript letters (U+2090-U+209C)
  // and digit subscripts (U+2080-U+2089). STIX Two Math covers digit
  // sub/super-scripts but LACKS the Latin subscript letters (verified by
  // probe — `STIXTwoMath.glyphForCodePoint(0x2099).id === 0`). SF Pro is
  // the macOS font that DOES cover U+2099 and the Latin subscript range
  // (system-ui pulls in SFNS / SF Pro which has glyphs for these); put
  // it first so `aₙ` paints instead of falling through to .notdef tofu.
  if (codepoint >= 0x2070 && codepoint <= 0x209F) {
    return ["sf-pro", "stix-math", "hiragino-jp", "symbols"];
  }
  // General Punctuation overline / Latin-1 macron (U+203E OVERLINE, U+00AF
  // MACRON). Used as MathML over-accents — `<mover accent="true"><mi>x</mi>
  // <mo>‾</mo></mover>` paints x̄. The `math`→Times primary lacks U+203E
  // (.notdef) and this block had no fallback branch, so the accent painted a
  // .notdef tofu box (DM-811's "black blob"). Chrome paints it via Helvetica:
  // the captured `<mo>‾</mo>` advance is 7.33 px @22 px, matching Helvetica's
  // U+203E advance EXACTLY (STIX 11.26 / Apple Symbols 13.77 are both too
  // wide). Apple Symbols stays as the residue fallback. DM-896.
  if (codepoint === 0x203E || codepoint === 0x00AF) {
    return ["helvetica", "symbols"];
  }
  // Letterlike (ℝℕℤℂℚ™), Arrows residue, Math Operators, Misc Technical
  // (⌘ ⌥ ⎘ etc.), Pictographs, Transport. The caller's primary-first check
  // already routes chars Helvetica/Times have (∑∏∫≠≤≥, ™, ●) to the
  // primary; what reaches this fallback is the residue (∀∃∈ ↑↓↔ ⇒⇔ etc.)
  // for which Apple Symbols is the right macOS source. (← → ↗ ↙ branch
  // above to CJK because Hiragino's em-wide glyph matches Chrome and Apple
  // Symbols' is too narrow — DM-296.)
  //
  // DM-959: Misc Technical block (U+2300..U+23FF) added — Chrome paints
  // these via Apple Symbols on macOS (verified empirically for U+2398
  // NEXT PAGE: Chrome advance 14.14 px @24 px, Apple Symbols 14.13 px).
  // Without this route the codepoint fell through to `[]` (no fallback)
  // and the renderer dropped to the primary font, which lacks the glyph
  // entirely and substituted a different symbol shape.
  if ((codepoint >= 0x2100 && codepoint <= 0x214F)
    || (codepoint >= 0x2190 && codepoint <= 0x21FF)
    || (codepoint >= 0x2200 && codepoint <= 0x22FF)
    || (codepoint >= 0x2300 && codepoint <= 0x23FF)
    || (codepoint >= 0x1F300 && codepoint <= 0x1F5FF)
    || (codepoint >= 0x1F680 && codepoint <= 0x1F6FF)) {
    return ["symbols"];
  }
  // DM-983: per-Unicode-block fallback derived from a Chrome CDP sweep —
  // `CSS.getPlatformFontsForNode` for every block in the html-test/unicode
  // fixture set. Probed family names are mapped to on-disk macOS font paths
  // by `tools/probe-983-genroutes.mjs` and serialised into
  // `unicode-font-routing.generated.ts`. Consulted as a LAST resort so all
  // the hand-tuned routes above (which carry per-codepoint width / shape
  // calibration) win for the blocks where Chrome's font choice is already
  // baked in. Adds coverage for scripts / symbol sets that previously fell
  // through to `[]` and rendered as tofu (cuneiform, Egyptian hieroglyphs,
  // most pre-modern scripts, Yi, Vai, Cherokee, Bamum, …).
  // Skip the LastResort tail for codepoints in the broad emoji range —
  // the capture layer attaches a raster `<image>` overlay for those
  // (DM-334) and the renderer expects the chain to end at `[]` so the
  // primary font's `.notdef` rectangle paints behind the overlay. Adding
  // LastResort here would route the emoji into its own font run and
  // trigger the per-codepoint `isEmoji` suppression, which drops the
  // glyph entirely and breaks the expected layout (S, m, i, l, e + the
  // `.notdef` slot).
  const isEmojiCp = (codepoint >= 0x1F300 && codepoint <= 0x1FAFF)
    || (codepoint >= 0x1F1E6 && codepoint <= 0x1F1FF);
  const generatedKey = lookupUnicodeFontRange(codepoint);
  if (generatedKey != null) {
    // DM-1018: the DM-983 per-block generated table assigns ONE font per
    // block, sampled from the first few cells. Many blocks are heterogeneous
    // — e.g. Latin Extended-D (U+A720–A7FF) samples to Helvetica Neue from
    // its leading modifier letters, but Chrome paints most of the block
    // (Egyptological / Insular / phonetic letters at U+A722+) via Noto Sans.
    // When the sampled font lacks a glyph the chain previously went
    // `[sampledFont, symbols, last-resort]` and bottomed out at the
    // LastResort `?` tofu, even though Noto Sans — which Chrome actually
    // reaches for these — has the glyph. Insert `u-noto-sans` (the basic
    // 4.6k-glyph Noto Sans with broad Latin / Greek / Cyrillic / IPA /
    // phonetic coverage) AFTER `symbols` so Apple Symbols stays the
    // preferred fallback for genuine symbol codepoints (Noto Sans lacks
    // those, so it never wins there) but letter codepoints the sampled
    // font missed resolve to Noto Sans instead of tofu. The chain walker
    // picks the first font whose `glyphForCodePoint(cp).id !== 0`, so a
    // `u-noto-sans` that's also the generatedKey or lacks the glyph is a
    // harmless no-op.
    return isEmojiCp
      ? [generatedKey, "symbols", "u-noto-sans"]
      : [generatedKey, "symbols", "u-noto-sans", "last-resort"];
  }
  // No generated-table route matched (rare — the table covers most blocks).
  // Try Noto Sans before LastResort: a codepoint with no block route is
  // usually a letter Chrome resolves via its broad Latin/Greek/Cyrillic
  // cascade, which Noto Sans mirrors. DM-1018.
  if (!isEmojiCp) {
    return ["u-noto-sans", "last-resort"];
  }
  // Final fallback: Apple LastResort.otf paints the block-frame placeholder
  // glyph (one per Unicode block) for every codepoint — matching what
  // Chrome on macOS paints for entirely-unmappable codepoints (Egyptian
  // Hieroglyphs Extended-A, supplementary-plane symbols no system font
  // carries, etc.). Without this the chain ends at `[]` and the renderer
  // drops to a generic placeholder that doesn't match Chrome's per-block
  // frame paint. DM-998 / DM-999 / DM-1010.
  return isEmojiCp ? [] : ["last-resort"];
}

/** Binary-search the generated `UNICODE_FONT_RANGES` for a codepoint. */
function lookupUnicodeFontRange(codepoint: number): string | null {
  let lo = 0;
  let hi = UNICODE_FONT_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = UNICODE_FONT_RANGES[mid]!;
    if (codepoint < r[0]) hi = mid - 1;
    else if (codepoint > r[1]) lo = mid + 1;
    else return r[2];
  }
  return null;
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
  // DM-728: Misc Symbols and Arrows (U+2B??) with default emoji presentation
  // per Unicode emoji-data — Chrome paints these as Apple Color Emoji
  // without needing the U+FE0F variation selector. ⭐ U+2B50 is the
  // common case from `20-deep-font-palette.html`.
  if (cp === 0x2B05 || cp === 0x2B06 || cp === 0x2B07
    || cp === 0x2B1B || cp === 0x2B1C || cp === 0x2B50 || cp === 0x2B55) return true;
  // VS-16 (U+FE0F) after a base emoji codepoint requests color presentation.
  if (nextCp === 0xFE0F && cp >= 0x2600 && cp <= 0x26FF) return true;
  // DM-728: VS-16 also flips Dingbats block (U+2700..U+27BF) codepoints
  // with text-default presentation to color emoji. ❤️ U+2764 + VS-16 in
  // the same fixture was rendering as a small monochrome path glyph
  // because this branch was missing.
  if (nextCp === 0xFE0F && cp >= 0x2700 && cp <= 0x27BF) return true;
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
      || key === "times" || key === "times-new-roman" || key === "georgia"
      || key === "source-serif-pro" || key === "playfair-display") {
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
  if (key === "hiragino-mincho" && weight >= 600) {
    effectiveKey = "hiragino-mincho-bold"; // HiraMinProN-W6. DM-1117.
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

  // Platform-aware path discovery (DM-258): darwin → FONT_PATHS, linux →
  // fc-match / DejaVu / Noto, win32 → C:\Windows\Fonts.
  const spec = resolveFontSpec(effectiveKey);
  if (spec == null) return null;

  // Probe-then-fallback dispatch (DM-887). fontkit is the primary; the native
  // glyph helper (CoreText/macOS DM-385, FreeType/Linux DM-872, DirectWrite/
  // Windows DM-837 — platform-aware as of DM-881) is the FALLBACK when fontkit
  // can't produce outlines for a *helper-eligible* font (`extractor: "native"`,
  // today the macOS PingFang keys; Linux/Windows CFF/CJK keys join once DM-259/
  // DM-260 calibrate their chains). "fontkit can't produce outlines" means it
  // can't open the file (e.g. PingFang, whose font isn't a file on current
  // macOS — CoreText resolves it by name) OR it opens but has no glyf/CFF/CFF2
  // outline table (PingFang's outlines live in the Apple-private `hvgl` table,
  // so fontkit reads its cmap/metrics but every path is empty). The helper
  // resolves by postscriptName (CoreText) or fontPath (FreeType/DirectWrite).
  //
  // The eligibility flag scopes the probe to fonts that might need the helper —
  // pure "any empty outline → helper" detection would mis-route inkless glyphs
  // (space) and color/bitmap fonts that legitimately lack glyf/CFF. When the
  // helper is unavailable, an eligible font with no fontkit outlines returns
  // null and the renderer's chain walks to the next candidate (the pre-DM-385
  // baseline). This is the WHOLE-FONT fallback tier; the per-glyph tier (a font
  // fontkit opens WITH outlines but can't decode a specific glyph) is a
  // follow-up — no current fixture exercises it, and it pairs with DM-259/260.
  const helperEligible = spec.extractor === "native";

  // DM-983: when a font is explicitly marked `extractor: "native"`, prefer the
  // CoreText helper UP FRONT and skip fontkit entirely. Two reasons it's set:
  //   1. The font has no outline tables fontkit can read (PingFang uses the
  //      Apple-private `hvgl` table — `fontkit.openSync` succeeds and the
  //      cmap/metrics are visible, but every glyph path is empty). Pre-DM-983
  //      behaviour: open the font, see no outlines, fall through to the helper.
  //   2. (DM-983) The font HAS outlines fontkit can read for SOME codepoints,
  //      but its GSUB tables crash fontkit's parser on others — verified by
  //      the per-codepoint sweep in `tools/probe-983-genroutes.mjs`. macOS
  //      Sangam MN / a chunk of the Indic Noto fonts trigger
  //      `Builtins_ArrayPrototypeSplice` with "invalid array length" and an
  //      unrecoverable v8 OOM (try/catch can't rescue). Routing through the
  //      helper before fontkit even sees the codepoint avoids the crash.
  if (helperEligible && isGlyphHelperAvailable()) {
    const helper = createGlyphHelperFont({ postscriptName: spec.postscriptName, fontPath: spec.path });
    if (helper != null) {
      const instance = helper as unknown as FontInstance;
      fontInstanceCache.set(cacheKey, instance);
      return instance;
    }
  }

  let opened: any = null;
  try { opened = fontkit.openSync(spec.path); } catch { opened = null; }
  // TTC collections expose .fonts + .getFont(postscriptName). Pick the requested
  // member; fall back to the first sub-font if the requested one is missing
  // (defensive against OS font updates renaming members).
  let font: any = null;
  if (opened != null) {
    font = opened;
    if (opened.fonts != null && Array.isArray(opened.fonts)) {
      font = (spec.postscriptName != null && opened.getFont != null)
        ? (opened.getFont(spec.postscriptName) ?? opened.fonts[0])
        : opened.fonts[0];
    }
  }

  const fontkitHasOutlines = font != null && fontHasOutlineTable(font);
  if (helperEligible && !fontkitHasOutlines && isGlyphHelperAvailable()) {
    const helper = createGlyphHelperFont({ postscriptName: spec.postscriptName, fontPath: spec.path });
    if (helper != null) {
      const instance = helper as unknown as FontInstance;
      fontInstanceCache.set(cacheKey, instance);
      return instance;
    }
  }
  if (font == null) return null; // couldn't open and the helper didn't (or can't) rescue

  const instance = applyVariationAxes(font, weight, fontSize, slant, variationSettings);
  // DM-891: record the exact file this fontkit instance was loaded from, so the
  // per-glyph helper fallback can open the SAME file (glyph ids match) when
  // fontkit returns an empty outline for a glyph it should be able to draw.
  // Only fontkit instances get an entry — helper instances (whole-font tier)
  // and webfonts (no file) deliberately don't, so they never trigger the
  // per-glyph fallback.
  fontSourceMap.set(instance as unknown as object, { path: spec.path, postscriptName: spec.postscriptName });
  fontInstanceCache.set(cacheKey, instance);
  return instance;
}

// Does fontkit have a glyph-outline table it can render from? A font's outlines
// live in `glyf` (TrueType, incl. `gvar` variable), `CFF `/`CFF2` (PostScript).
// PingFang has none of these — its outlines are in the Apple-private `hvgl`
// table — so fontkit reads its cmap/metrics but produces empty paths; that's
// the signal to fall back to the native helper. `font.directory.tables` is the
// reliable presence check: the `font.glyf` / `font['CFF ']` accessors are
// lazily-parsed and read falsy even when the table physically exists. Unknown
// shape → assume fontkit is fine, so we never over-route a readable font.
// Exported for unit testing (not part of the package's public barrel).
export function fontHasOutlineTable(font: { directory?: { tables?: Record<string, unknown> } } | null | undefined): boolean {
  const tables = font?.directory?.tables;
  if (tables == null || typeof tables !== "object") return true;
  return "glyf" in tables || "CFF " in tables || "CFF2" in tables;
}

// ── DM-891: per-glyph helper fallback ──
// The whole-font tier (DM-887, getFontInstance) swaps the entire font to the
// native helper only when fontkit can't open it / it has no outline table. This
// is the finer tier: a font fontkit DID open (has glyf/CFF) but can't decode a
// SPECIFIC glyph's outline (a partial CFF/CJK face). fontkit keeps doing
// shaping/metrics; the helper supplies just that glyph's outline, fetched by
// glyph id from the SAME file (ids match across engines). See docs/51.

type PathCommand = { command: string; args: number[] };

/** Minimal fontkit `Glyph` shape the renderer reads (DM-1067) — keeps `any` off
 *  the exported `commandsFor` signature without depending on fontkit's full type. */
type FontkitGlyph = { id: number; path?: { commands: PathCommand[] }; codePoints?: number[]; advanceWidth?: number };

/** Records which on-disk file each fontkit instance was loaded from (populated
 *  in getFontInstance). Helper instances + webfonts are absent → no fallback. */
const fontSourceMap = new WeakMap<object, { path: string; postscriptName?: string }>();
const helperFontCache = new Map<string, FontInstance | null>();       // path → helper instance | null
const helperOutlineCache = new Map<string, PathCommand[] | null>();   // `${path}#${id}` → commands | null

// High-confidence "this codepoint never paints ink" set: control (Cc), format
// (Cf), line/paragraph/space separators (Zl/Zp/Zs), the invisible math
// operators (Sm but inkless), variation selectors, and tags. fontkit correctly
// returns an empty outline for these, so they must NOT trigger the helper —
// otherwise ordinary text (a narrow no-break space, a bidi control) would spawn
// the helper / trigger the DM-886 download for no reason. Empirically (DM-891),
// every macOS glyph fontkit returns empty for falls in this set, and the helper
// agrees they're empty — so the fallback is inert on macOS by design and only
// fires for a genuinely-undecodable inkable glyph (Linux/Windows CFF/CJK).
const INKLESS_CATEGORY_RE = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]$/u;
export function isLegitimatelyInklessCodepoint(cp: number): boolean {
  let s: string;
  try { s = String.fromCodePoint(cp); } catch { return false; }
  if (INKLESS_CATEGORY_RE.test(s)) return true;
  if (cp >= 0x2061 && cp <= 0x2064) return true;   // invisible math operators
  if (cp >= 0xFE00 && cp <= 0xFE0F) return true;    // variation selectors
  if (cp >= 0xE0100 && cp <= 0xE01EF) return true;  // variation selectors supplement
  if (cp >= 0xE0000 && cp <= 0xE007F) return true;  // tags
  return false;
}

// A glyph is worth probing the helper for only if at least one source codepoint
// is plausibly inkable. Unknown codepoints (decomposed glyphs / ligatures with
// no codePoints array) → conservatively NOT inkable (don't over-fire).
function glyphIsInkable(glyph: { codePoints?: number[] }): boolean {
  const cps = glyph.codePoints;
  if (cps == null || cps.length === 0) return false;
  return !cps.every((cp) => isLegitimatelyInklessCodepoint(cp));
}

/** Fetch glyph `glyphId`'s outline from the native helper opening `srcPath`.
 *  Cached per (path, id) — probed at most once per process. Returns null when
 *  the helper is unavailable / can't open the font / the glyph is empty there
 *  too (i.e. genuinely inkless — leave it empty, no point emitting). */
function helperGlyphOutline(srcPath: string, postscriptName: string | undefined, glyphId: number): PathCommand[] | null {
  const cacheKey = `${srcPath}#${glyphId}`;
  const cached = helperOutlineCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let helper = helperFontCache.get(srcPath);
  if (helper === undefined) {
    helper = (createGlyphHelperFont({ postscriptName, fontPath: srcPath }) as unknown as FontInstance) ?? null;
    helperFontCache.set(srcPath, helper);
  }

  let cmds: PathCommand[] | null = null;
  if (helper != null) {
    try {
      const g = (helper as any).getGlyph(glyphId);
      const c: PathCommand[] = g?.path?.commands ?? [];
      cmds = c.length > 0 ? c : null;
    } catch { cmds = null; }
  }
  helperOutlineCache.set(cacheKey, cmds);
  return cmds;
}

/** The outline commands to emit for a shaped glyph: fontkit's when present,
 *  else the per-glyph helper fallback (DM-891) when the glyph is inkable, the
 *  helper is available, and the font was loaded from a real file. Empty array
 *  when there's genuinely nothing to draw. Exported for unit testing (not in
 *  the package barrel). */
export function commandsFor(glyph: FontkitGlyph | null | undefined, fontKey: string, weight: number, fontSize: number, slant: number): PathCommand[] {
  const cmds: PathCommand[] = glyph?.path?.commands ?? [];
  if (cmds.length > 0) return cmds;
  if (glyph == null || glyph.id === 0) return cmds;       // genuine .notdef
  if (!glyphIsInkable(glyph)) return cmds;                 // legitimately inkless
  if (!isGlyphHelperAvailable()) return cmds;
  // Re-resolve the instance (cache hit) to read the exact file fontkit loaded.
  // variationSettings don't affect the file path, so they're omitted here.
  const inst = getFontInstance(fontKey, weight, fontSize, slant);
  const src = inst != null ? fontSourceMap.get(inst as unknown as object) : undefined;
  if (src == null) return cmds;                            // helper instance / webfont → no fallback
  return helperGlyphOutline(src.path, src.postscriptName, glyph.id) ?? cmds;
}

/** Test-only: clear the per-glyph fallback caches (helper instances + outlines). */
export function __clearGlyphFallbackCaches(): void {
  helperFontCache.clear();
  helperOutlineCache.clear();
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

/** Normalize a computed `font-family` string into its ordered list of lower-cased,
 *  unquoted family names (Chrome's `getComputedStyle().fontFamily` is the full
 *  unresolved comma-separated stack). */
function splitFontFamilyNames(fontFamily: string): string[] {
  return fontFamily.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase());
}

/**
 * Resolve a SINGLE lower-cased family name to its font key, or `null` when the
 * name is unrecognized / a generic keyword Chrome skips / not installed (the
 * caller then moves to the next name in the stack). This is the per-name body of
 * `resolveFontKey`, factored out so both the first-match resolver and the
 * full-stack `resolveFontKeyChain` (DM-1083) share one calibration table. Pure
 * except for the `resolveInstalledFont` dynamic-registration side effect, which
 * is idempotent.
 */
function matchFamilyNameToKey(name: string): string | null {
  if (name === "" || name === "doesnotexist") return null;
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
    // Source Serif Pro (Adobe) — non-base macOS face, often present under
    // `/Library/Fonts/`. Authors target it via `font-family: 'Source Serif Pro'`.
    // When the file isn't installed on this host, `resolveFont` returns null
    // and the chain falls through to the next family. DM-804.
    if (name === "source serif pro" || name === "sourceserifpro") return "source-serif-pro";
    // DM-1120: Playfair Display — explicit-name route to the installed display
    // serif (Chrome resolves it for `font-family: "Playfair Display"` when on
    // disk; we mirror that, falling through to the next family when absent).
    if (name === "playfair display" || name === "playfairdisplay") return "playfair-display";
    // DM-1117: Hiragino Mincho ProN — the Japanese serif (明朝). Only when an
    // author NAMES it (any of the ProN / Pro / ASCII / native spellings); the
    // generic `serif` keyword stays Songti. Routing here gives the East-Asian
    // OpenType features (trad / fwid / jp78) a font that actually carries them.
    if (name === "hiragino mincho pron" || name === "hiragino mincho pro"
      || name === "hiragino mincho" || name === "ヒラギノ明朝 pron"
      || name === "hiraminpron" || name === "hiraminpro") return "hiragino-mincho";
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
    // Arial Unicode MS — the broad-coverage pan-Unicode face many of the
    // html-test unicode fixtures declare as their primary. Recognizing it
    // matters for two reasons (DM-1018): (1) it actually covers a lot of
    // BMP scripts Chrome would paint from it, and (2) for codepoints NO
    // font on the system covers, Chrome paints THIS primary's `.notdef`
    // (an empty rectangle) — see the primary-`.notdef` terminal in
    // splitTextIntoFontRuns. Without recognizing the family the primary
    // fell through to `times`, whose `.notdef` is a different-shaped box.
    if (name === "arial unicode ms" || name === "arialunicodems") return "u-arial-unicode-ms";
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
      || name === "sf pro") return "sf-pro";
    // DM-1127: "SF Pro Text" / "SF Pro Display" are DISTINCT installed faces, not
    // the system variable font. On a host where the user installed Apple's SF Pro
    // package, CoreText resolves these names to their own OTFs (e.g.
    // `/Library/Fonts/SF-Pro-Text-Regular.otf`, postscript `SFProText-Regular`),
    // and Chrome paints from them — those OTFs carry glyphs the system `SFNS.ttf`
    // LACKS (e.g. the two-digit enclosed alphanumerics U+2469–2473 / U+24EB–24F4:
    // SFNS has the single-digit circled numbers but not the double-digit ones).
    // Mapping the name straight to `sf-pro` (SFNS) made those codepoints miss in
    // the primary and fall through to a LATER author family (Arial Unicode MS's
    // full-em circled numbers), painting a visibly larger glyph than Chrome's
    // condensed SF Pro Text one. Probe CoreText first so the named cut resolves to
    // the same OTF Chrome uses; only when the OTF isn't installed do we fall back
    // to the `sf-pro` (SFNS) approximation, whose Text optical size is pinned via
    // `OPTICAL_CUT_OPSZ` (DM-1103) — which is also what Chrome paints there, since
    // an absent OTF means Chrome can't use it either.
    if (name === "sf pro text" || name === "sf pro display") {
      const cut = resolveInstalledFont(name);
      if (cut != null) {
        const key = `sysfb:${cut.postscriptName}`;
        registerDynamicSystemFont(key, cut.path, cut.postscriptName);
        return key;
      }
      return "sf-pro";
    }
    // DM-806: author-named "Hiragino Sans" / "Hiragino Kaku Gothic ProN" /
    // the underlying ヒラギノ角ゴシック native name maps to the JP variant
    // we already ship under the `hiragino-jp` key (HiraKakuProN-W3 /
    // -W6). Without this, the family falls through to `system-ui` →
    // sf-pro, which paints Latin glyphs visibly differently from Hiragino
    // Sans (wider letter spacing on a/c/p — the `niche-text-box-trim`
    // fixture's "ideographic — 日本語テキスト" label exposes this).
    if (name === "hiragino sans" || name === "hiragino kaku gothic pron"
      || name === "hiragino kaku gothic pro" || name === "ヒラギノ角ゴシック"
      || name === "hiragino maru gothic pron") return "hiragino-jp";
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
      || name === "-apple-system") return null;
    // DM-1108: macOS New York optical-size cut "New York Medium" name
    // collision. Unlike SF Pro (one variable file whose cuts are CoreText-only
    // named faces — see OPTICAL_CUT_OPSZ below), New York's optical cuts ship
    // as SEPARATE static OTFs: "New York Small/Medium/Large/Extra Large"
    // (NewYork{Small,Medium,Large,ExtraLarge}-Regular.otf). Chrome paints each
    // CSS-named cut from its dedicated OTF. The Small/Large/Extra Large names
    // are unambiguous, so CoreText's plain family query already returns the
    // right cut. But "New York Medium" collides with the VARIABLE New York
    // font's `Medium` *weight* named-instance (PostScript NewYork-Medium), and
    // CoreText's family query returns that heavier weight instead of the
    // lighter optical cut Chrome paints. Resolve it via the cut's unambiguous
    // PostScript name so we match Chrome. When the cut OTF isn't installed
    // (it's part of Apple's optional "New York" font package, not stock
    // macOS) this returns null and we fall through to the variable font's
    // Medium weight below — which is also what Chrome paints in that case.
    if (name === "new york medium") {
      const cut = resolveInstalledFont("NewYorkMedium-Regular");
      if (cut != null) {
        const key = `sysfb:${cut.postscriptName}`;
        registerDynamicSystemFont(key, cut.path, cut.postscriptName);
        return key;
      }
    }
    // DM-1018: the name isn't one of our calibrated families or a generic
    // keyword — but it may still be a REAL installed font (SF Compact,
    // Mplus 1p, …). Blink's FontFallbackList sets `first_candidate_` to the
    // first family in the stack that actually loads, and draws THAT font's
    // `.notdef` for uncovered codepoints (FontFallbackIterator
    // kFirstCandidateForNotdefGlyph). Probe CoreText (memoized) so an
    // installed-but-uncalibrated primary resolves to itself instead of
    // falling through to the `times` default — which is what makes e.g. the
    // SignWriting fixture paint SF Compact's stripes `.notdef` and the Kana
    // Supplement fixture paint Mplus 1p's blank `.notdef`, matching Chrome.
    // The calibrated families above still win (they carry metric tuning); only
    // genuinely-unrecognized names reach here.
    const installed = resolveInstalledFont(name);
    if (installed != null) {
      const key = `sysfb:${installed.postscriptName}`;
      registerDynamicSystemFont(key, installed.path, installed.postscriptName);
      return key;
    }
  return null;
}

export function resolveFontKey(fontFamily: string): string {
  // Walk the comma-separated stack — Chrome's getComputedStyle returns the
  // unresolved list (e.g. `"DoesNotExist", Georgia, "Times New Roman", serif`)
  // not the matched font. Pick the first name we recognize, mirroring how
  // Chrome falls through the stack until something loads.
  for (const name of splitFontFamilyNames(fontFamily)) {
    const key = matchFamilyNameToKey(name);
    if (key != null) return key;
  }
  // Last-resort fallback when no family in the stack matched. Chrome's
  // ultimate fallback on macOS for an unrecognized name is the user's
  // configured "Standard Font" preference, which defaults to Times.
  return "times";
}

/**
 * DM-1083: the full ORDERED list of resolvable font keys for a computed
 * `font-family` stack — every name Chrome's FontFallbackIterator would try at
 * the `kFontFamily` stage, in CSS order, deduped. `resolveFontKey` returns just
 * `[0]`; the unified per-codepoint resolver walks the whole list so a character
 * the first family lacks can be drawn by a LATER declared family (e.g. the CJK
 * compatibility fixtures whose `"Hiragino Sans","Arial Unicode MS",…` stacks let
 * Chrome paint +90 cells from Arial Unicode MS that a primary-only resolver
 * misses — see the probe in `tools/probe-2f800-facewalk.mjs`). Never includes
 * the `times` last-resort — callers append their own terminal.
 */
export function resolveFontKeyChain(fontFamily: string): string[] {
  const out: string[] = [];
  for (const name of splitFontFamilyNames(fontFamily)) {
    const key = matchFamilyNameToKey(name);
    if (key != null && !out.includes(key)) out.push(key);
  }
  return out;
}

// DM-1103: macOS "optical cut" families. `SFNS.ttf` is one variable font with an
// `opsz` axis (17–96, default 28); CoreText exposes its optical-size cuts as
// named faces. When CSS explicitly names a cut — `"SF Pro Text"` (postScript
// `SFProText-Regular`) — Chrome→CoreText paints from a FIXED opsz instance (the
// Text design, opsz 17 = the axis floor) REGARDLESS of the used size, and does
// not re-apply `font-optical-sizing: auto`'s size-derived opsz on top. fontkit
// only sees the file's default master (opsz 28) and our pipeline sets
// `opsz = font-size`, so an explicit `"SF Pro Text"` headline renders at the
// Display optical size — diacritics (ring/dot above/below) sit ~2–3 px too low
// (the Latin-Extended-Additional fixture, DM-1103). This is Chrome's own
// macOS-system-font handling, not a generic rule (see Chromium-83 "more variable
// font options for the macOS system-ui font"). We honor only the EXPLICITLY
// named cut; the generic `"SF Pro"` / `system-ui` / `-apple-system` path keeps
// `opsz = size`, whose <20→Text / ≥20→Display mapping already matches Chrome.
// The Text opsz was measured against Chrome via CDP `getPlatformFontsForNode` +
// a 4×-DPR glyph probe of the real fixture cell.
const OPTICAL_CUT_OPSZ: Record<string, number> = {
  "sf pro text": 17,
  ".sfnstext": 17,
};

/**
 * The pinned `opsz` for an explicitly-named macOS optical-cut family, or null
 * when the resolved family isn't a named cut (→ keep the `opsz = size` default).
 * Mirrors `resolveFontKey`'s walk: the FIRST name in the stack that resolves to
 * an installed key decides — if that name is a named cut, return its opsz; if
 * it's any other installed face, the cut doesn't apply.
 */
function opticalCutOpszFor(fontFamily: string): number | null {
  for (const name of splitFontFamilyNames(fontFamily)) {
    if (matchFamilyNameToKey(name) == null) continue; // unrecognized — skip, like resolveFontKey
    return name in OPTICAL_CUT_OPSZ ? OPTICAL_CUT_OPSZ[name] : null;
  }
  return null;
}

function resolveFont(fontFamily: string, fontWeight: number, fontSize: number, slant: number = 0, variationSettings?: Record<string, number>): FontInstance | null {
  // DM-1103: pin `opsz` for an explicitly-named optical cut (e.g. "SF Pro
  // Text" → 17) by injecting it as a variation setting — which wins over the
  // `opsz = fontSize` default in `applyVariationAxes`. An author-set
  // `font-variation-settings: "opsz" …` still wins (we don't clobber it).
  const cutOpsz = opticalCutOpszFor(fontFamily);
  if (cutOpsz != null && (variationSettings == null || variationSettings.opsz == null)) {
    variationSettings = { ...(variationSettings ?? {}), opsz: cutOpsz };
  }
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

/**
 * DM-294 / DM-1116: the per-character decision for SYNTHESIZED `font-variant-caps`
 * (the path Chrome takes when the active font lacks the OpenType feature).
 *
 * Mirrors Blink's `OpenTypeCapsSupport`: `SmallCapsIterator` classifies a
 * single-codepoint character that changes when upper-cased as
 * `kSmallCapsUppercaseNeeded` (a lowercase LETTER); EVERYTHING else — uppercase
 * letters, digits, punctuation, symbols — is `kSmallCapsSameCase`.
 * `NeedsSyntheticFont` then gives:
 *   - a lowercase letter the small synthetic font (+ up-casing) when
 *     `lowerScale` is set — i.e. `smcp` / `pcap` (and the lower half of
 *     `all-small-caps` / `all-petite-caps`);
 *   - a same-case char the small synthetic font (NO case change) when
 *     `upperScale` is set — i.e. `c2sc` / `c2pc` / `unic` (and the upper half of
 *     `all-*`). This is the half that was missing: hyphens / colons / other
 *     punctuation rendered full-size in `all-small-caps` / `unicase`.
 *
 * `lowerScale` / `upperScale` are the synthesized multipliers (≈0.7) or `null`
 * when that class isn't being synthesized. Returns the scale to apply (1 = no
 * change) and whether to up-case the glyph. The `upper.length === ch.length`
 * guard keeps multi-char folds (ß→SS) in the same-case branch so per-char scale
 * arrays stay aligned with the shaping text.
 */
export function synthSmallCapsCharScale(
  ch: string,
  lowerScale: number | null,
  upperScale: number | null,
): { scale: number; upcase: boolean } {
  const upper = ch.toUpperCase();
  const isLowerLetter = upper !== ch && upper.length === ch.length;
  if (isLowerLetter && lowerScale != null) return { scale: lowerScale, upcase: true };
  if (!isLowerLetter && upperScale != null) return { scale: upperScale, upcase: false };
  return { scale: 1, upcase: false };
}

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
  const fontKeyChain = resolveFontKeyChain(fontFamily);

  // Split the text into runs by font. Code points that primary lacks (Arabic,
  // CJK, …) get routed to a fallback font. Each run keeps its order; this
  // does NOT do BiDi reordering — that's tracked separately. startIdx/endIdx
  // are UTF-16 code-unit positions into `text` so the multi-font path can
  // slice xOffsets per run (SK-1255).
  // `decomposed` marks runs whose `text` holds Math-Alphanumeric base letters
  // substituted for codepoints no font in the chain could render (see
  // mathAlphaToBase). Those runs render through the run-text / min-x anchored
  // branch — the substituted base char differs from the original astral
  // codepoint at `text[startIdx]`, so the per-char path (which reads `text` by
  // index) can't be used for them.
  interface Run { fontKey: string; font: FontInstance; text: string; startIdx: number; endIdx: number; decomposed?: boolean }
  const runs: Run[] = [];
  {
    let curKey = primaryFontKey;
    let curFontOverride: FontInstance | null = null; // DM-557: per-codepoint webfont variant
    let curDecomposed = false;
    let curText = "";
    let curStart = 0;
    let i = 0;
    while (i < text.length) {
      const cp = text.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      // The char appended to the current run's text. Normally the source char;
      // for a Math-Alpha decomposition it's the substituted base letter/digit.
      // DM-1068: the per-codepoint decision is the shared resolver (primary →
      // webfont variant → chain → system fallback → math-alpha → NFD). This path
      // also keeps `useDecomposed` so a math-alpha / NFD run renders via its text
      // (the substituted base char) rather than the per-char source index.
      const res = resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
      // An UNCOVERED emoji must stay on the glyph-path terminal, NOT take the
      // resolver's system-fallback. Emoji are painted by the rasterGlyph overlay;
      // placing one on a system color font here would split it out of the
      // surrounding text run and break the overlay's advance pinning (the
      // embedded path, which has no overlay, does let the resolver place them).
      const nextCp = i + ch.length < text.length ? text.codePointAt(i + ch.length)! : 0;
      const emojiToTerminal = primaryFont.glyphForCodePoint(cp).id === 0 && isEmojiCodepoint(cp, nextCp);
      let emitCh: string;
      let useKey: string;
      let useFontOverride: FontInstance | null;
      let useDecomposed: boolean;
      if (res.covered && !emojiToTerminal) {
        emitCh = res.emitCh;
        useKey = res.key;
        useFontOverride = res.fontOverride;
        useDecomposed = res.decomposed;
      } else {
        // Glyph-path terminal: nothing covers `cp` (an exotic emoji even Apple
        // Symbols lacks), or `cp` is an emoji kept off the resolver per above.
        // Pin to the LAST chain entry's stable `.notdef` advance so a captured
        // rasterGlyph PNG overlay stays aligned — switching to primary's
        // `.notdef` would shift glyph positions and drift the rest of the line.
        // (For the empty emoji chain the last entry is the primary font, grouping
        // the suppressed-tofu emoji with the surrounding run.) This is the one
        // place the glyph-path terminal differs from the embedded path's
        // primary-`.notdef`; the system-fallback + NFD steps the resolver added
        // are the DM-1068 fidelity fix the glyph-path lacked.
        const chain = fallbackFontChain(cp, primaryFontKey, lang);
        emitCh = ch;
        useKey = chain.length > 0 ? chain[chain.length - 1] : primaryFontKey;
        useFontOverride = null;
        useDecomposed = false;
      }
      // DM-557: a per-codepoint webfont variant is a different FontInstance
      // even when its `useKey` matches `curKey` (both are the primary
      // family's webfont:<key>). Discriminate runs by the (key, override)
      // pair so a Latin-partition run and a Cyrillic-partition run within
      // the same Geist family stay separate even though they share the key.
      const runChanged = useKey !== curKey || useFontOverride !== curFontOverride
        || useDecomposed !== curDecomposed;
      if (runChanged && curText.length > 0) {
        // Variation settings apply to the primary requested font, not to
        // system fallbacks reached for missing glyphs (CJK / emoji / symbols
        // weren't declared by the page's @font-face).
        const fvs = curKey === primaryFontKey ? variationSettings : undefined;
        // DM-1103: for the primary key use the already-resolved `primaryFont`
        // directly — re-resolving via the key would drop the optical-cut `opsz`
        // that `resolveFont` injected from the family name (it's keyed on the
        // family, not the collapsed font key), re-emitting at the wrong cut.
        const f = curFontOverride ?? (curKey === primaryFontKey ? primaryFont : getFontInstance(curKey, weight, fontSize, slant, fvs));
        if (f != null) runs.push({ fontKey: curKey, font: f, text: curText, startIdx: curStart, endIdx: i, decomposed: curDecomposed });
        curText = "";
        curStart = i;
      }
      curKey = useKey;
      curFontOverride = useFontOverride;
      curDecomposed = useDecomposed;
      curText += emitCh;
      i += ch.length;
    }
    if (curText.length > 0) {
      const fvs = curKey === primaryFontKey ? variationSettings : undefined;
      // DM-1103: prefer the resolved `primaryFont` for the primary key so the
      // optical-cut opsz (injected by resolveFont from the family name) survives.
      const f = curFontOverride ?? (curKey === primaryFontKey ? primaryFont : getFontInstance(curKey, weight, fontSize, slant, fvs)) ?? primaryFont;
      runs.push({ fontKey: curKey === primaryFontKey ? primaryFontKey : (f === primaryFont ? primaryFontKey : curKey), font: f, text: curText, startIdx: curStart, endIdx: text.length, decomposed: curDecomposed });
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
  const availableFeatures = primaryFont.availableFeatures ?? [];
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
      // Decomposed Math-Alpha runs render via the run-text branch too: their
      // `text` carries the substituted base letters, which don't line up with
      // the original astral codepoints the per-char branch reads from `text`.
      const isShapingRequired = run.fontKey === "sf-arabic"
        || run.fontKey === "devanagari"
        || run.fontKey === "thai"
        || run.decomposed === true;

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
            // DM-1116: scale uppercase letters, digits, punctuation AND symbols
            // (Blink's `kSmallCapsSameCase`) under c2sc/c2pc/unic — not just
            // letters/digits — so hyphens/colons aren't left full-size in
            // all-small-caps / unicase. See `synthSmallCapsCharScale`.
            const synth = synthSmallCapsCharScale(ch, synthLowerScale, synthUpperScale);
            if (synth.upcase) ch = ch.toUpperCase();
            if (synth.scale !== 1) chScale = Number((runScale * synth.scale).toFixed(5));
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
          const isPua = isPrivateUseCodepoint(cp);
          const isEmoji = isEmojiCodepoint(cp, nextCp);
          const uses: string[] = [];
          let suppressedNotdef = false;
          for (const g of layout.glyphs) {
            const gCmds = commandsFor(g, run.fontKey, weight, fontSize, slant);
            if (gCmds.length === 0) continue;
            // Emoji codepoints are covered by the capture layer's raster
            // <image> overlay (DM-334), so suppress ALL path emission for them
            // — not only the .notdef tofu. On macOS the fallback chain resolves
            // emoji to tofu (id 0), so an id-0-only gate sufficed; on Linux the
            // chain can land a real MONOCHROME glyph (e.g. FreeSans has ✨
            // U+2728), which must still be suppressed or it paints under the
            // color raster. DM-842.
            if (isEmoji) { suppressedNotdef = true; continue; }
            // PUA: suppress only the .notdef tofu; a real icon-font glyph emits.
            if (isPua && g.id === 0) { suppressedNotdef = true; continue; }
            const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, g.id, gCmds);
            uses.push(`<use href="#${defId}" x="0" y="0"/>`);
          }
          if (uses.length > 0) {
            const cssX = Number(xOffsets[i].toFixed(3));
            groups.push(`<g transform="translate(${cssX},0) scale(${chScale},${-chScale})">${uses.join("")}</g>`);
            if (cssX > rightEdge) rightEdge = cssX;
          } else if (isPua && suppressedNotdef) {
            // DM-769: see singleFontMarkup branch for the full rationale.
            // Multi-run text path — the per-char Y-flip scale wrapping is
            // applied here too, so emit a tofu path in font units inside
            // the scale group. The hollow shape is a `<path>` with outer +
            // inner sub-rectangles and `fill-rule="evenodd"` so the
            // wrapping group's `fill="<textColor>"` paints the ring while
            // leaving the inside transparent.
            const cssX = Number(xOffsets[i].toFixed(3));
            const advancePx = nextI < text.length
              ? (xOffsets[nextI] - xOffsets[i])
              : fontSize * 0.6;
            const upem = run.font.unitsPerEm;
            const advanceFu = (advancePx / chScale) * (upem / fontSize);
            const tofuW = Math.max(2, advanceFu * 0.7);
            const tofuH = upem * 0.65;
            const cornerInsetX = (advanceFu - tofuW) / 2;
            const borderFu = Math.max(upem / Math.max(4, fontSize), upem * 0.03);
            const x0 = cornerInsetX;
            const x1 = x0 + tofuW;
            const y0 = 0;
            const y1 = tofuH;
            const ix0 = x0 + borderFu;
            const ix1 = x1 - borderFu;
            const iy0 = y0 + borderFu;
            const iy1 = y1 - borderFu;
            if (ix1 > ix0 && iy1 > iy0) {
              groups.push(`<g transform="translate(${cssX},0) scale(${chScale},${-chScale})"><path d="M${r(x0)} ${r(y0)} L${r(x1)} ${r(y0)} L${r(x1)} ${r(y1)} L${r(x0)} ${r(y1)} Z M${r(ix0)} ${r(iy0)} L${r(ix0)} ${r(iy1)} L${r(ix1)} ${r(iy1)} L${r(ix1)} ${r(iy0)} Z" fill-rule="evenodd"/></g>`);
            } else {
              groups.push(`<g transform="translate(${cssX},0) scale(${chScale},${-chScale})"><rect x="${r(x0)}" y="${r(y0)}" width="${r(tofuW)}" height="${r(tofuH)}"/></g>`);
            }
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
          const glyphCmds = commandsFor(glyph, run.fontKey, weight, fontSize, slant);
          if (glyphCmds.length > 0) {
            const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, glyph.id, glyphCmds);
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
      const glyphCmds = commandsFor(glyph, run.fontKey, weight, fontSize, slant);
      if (glyphCmds.length > 0) {
        const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, glyph.id, glyphCmds);
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
      const dCmds = commandsFor(glyph, fontKey, weight, fontSize, slant);
      if (textIdx < xOffsets.length && dCmds.length > 0 && !skipNotdefHere) {
        const defId = ensureGlyphDef(fontKey, weight, fontSize, slant, glyph.id, dCmds);
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
    const eCmds = commandsFor(glyph, fontKey, weight, fontSize, slant);
    if (eCmds.length > 0 && !skipNotdefHere) {
      const defId = ensureGlyphDef(fontKey, weight, fontSize, slant, glyph.id, eCmds);
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
    } else if (skipNotdefHere) {
      // DM-769: PUA codepoint with no glyph coverage in the host font. The
      // glyph path is suppressed (to avoid painting a giant notdef tofu
      // over surrounding text — DM-490 / DM-500) but Chrome paints a small
      // hollow-rectangle tofu at the codepoint's advance width. Emit a
      // matching tofu so positions like the inline `<span
      // class="ic">&#xe5cd;</span>` rows aren't visually blank. Sized at
      // ~0.7 × advance × ~0.65em centered in the advance, with a 1-device-
      // pixel border thickness. Painted in font-units inside the wrapping
      // `<g transform="scale(sc, -sc)">` (Y-up); the rect at y=0 height=H
      // extends UP from the baseline after the Y-flip.
      //
      // To paint a hollow outline while inheriting the wrapping group's
      // `fill="<textColor>"` (currentColor isn't available here — `fill`
      // is the only color attribute that bubbles down), emit a `<path>`
      // with TWO sub-rectangles and `fill-rule="evenodd"`: the outer rect
      // fills, the inner rect punches a hole. Result is a rectangular
      // ring filled in the text color.
      const tx = usePerChar ? xOffsets![i] / scale : x;
      const advanceFu = pos.xAdvance;
      const tofuW = Math.max(2, advanceFu * 0.7);
      const tofuH = font.unitsPerEm * 0.65;
      const cornerInsetX = (advanceFu - tofuW) / 2;
      // Border thickness in font units: target ~1 device pixel at the
      // active fontSize. `scale = fontSize / unitsPerEm`, so 1 / scale =
      // unitsPerEm / fontSize font units per device pixel. Clamped to a
      // minimum so the border stays visible at very large font sizes.
      const borderFu = Math.max(font.unitsPerEm / Math.max(4, fontSize), font.unitsPerEm * 0.03);
      const x0 = tx + cornerInsetX;
      const x1 = x0 + tofuW;
      const y0 = 0;
      const y1 = tofuH;
      const ix0 = x0 + borderFu;
      const ix1 = x1 - borderFu;
      const iy0 = y0 + borderFu;
      const iy1 = y1 - borderFu;
      if (ix1 > ix0 && iy1 > iy0) {
        uses.push(`<path d="M${r(x0)} ${r(y0)} L${r(x1)} ${r(y0)} L${r(x1)} ${r(y1)} L${r(x0)} ${r(y1)} Z M${r(ix0)} ${r(iy0)} L${r(ix0)} ${r(iy1)} L${r(ix1)} ${r(iy1)} L${r(ix1)} ${r(iy0)} Z" fill-rule="evenodd"/>`);
      } else {
        // Degenerate (very thin advance) — fall back to a solid filled rect.
        uses.push(`<rect x="${r(x0)}" y="${r(y0)}" width="${r(tofuW)}" height="${r(tofuH)}"/>`);
      }
    }
    x += pos.xAdvance;
  }
  return {
    markup: uses.length > 0 ? `<g transform="scale(${sc},${-sc})">${uses.join("")}</g>` : "",
    width: usePerChar ? (xOffsets![xOffsets!.length - 1] + nativeWidth / run.glyphs.length) : (targetWidth ?? nativeWidth),
  };
}

// DM-1026: Unicode blocks whose script uses a COMPLEX shaper (Indic / Khmer /
// Myanmar / SE-Asian Brahmic / the Universal Shaping Engine) — the shapers that,
// like Chrome's HarfBuzz, insert a dotted circle (U+25CC) before an ORPHANED
// combining mark (a mark with no base in its cluster). The generic combining-
// mark blocks (Combining Diacritical Marks 0300–036F, …-Extended 1AB0–1AFF,
// …-Supplement 1DC0–1DFF, …-for-Symbols 20D0–20FF, Half Marks FE20–FE2F) are
// DELIBERATELY ABSENT: those route through the DEFAULT shaper, which paints the
// bare mark with NO dotted circle (so DM-1027's Latin combining marks correctly
// get none). Ranges are inclusive [start, end]. Kept as a flat sorted list — the
// gate only runs for an uncovered category-M codepoint, which is rare.
const COMPLEX_SHAPER_MARK_RANGES: ReadonlyArray<readonly [number, number]> = [
  // BMP Indic / SE-Asian
  [0x0900, 0x097F], [0x0980, 0x09FF], [0x0A00, 0x0A7F], [0x0A80, 0x0AFF],
  [0x0B00, 0x0B7F], [0x0B80, 0x0BFF], [0x0C00, 0x0C7F], [0x0C80, 0x0CFF],
  [0x0D00, 0x0D7F], [0x0D80, 0x0DFF], [0x0E00, 0x0E7F], [0x0E80, 0x0EFF],
  [0x0F00, 0x0FFF], [0x1000, 0x109F], [0x1700, 0x171F], [0x1720, 0x173F],
  [0x1740, 0x175F], [0x1760, 0x177F], [0x1780, 0x17FF], [0x1900, 0x194F],
  [0x1980, 0x19DF], [0x1A00, 0x1A1F], [0x1A20, 0x1AAF], [0x1B00, 0x1B7F],
  [0x1B80, 0x1BBF], [0x1BC0, 0x1BFF], [0x1C00, 0x1C4F], [0x1CD0, 0x1CFF],
  [0xA800, 0xA82F], [0xA880, 0xA8DF], [0xA8E0, 0xA8FF], [0xA900, 0xA92F],
  [0xA930, 0xA95F], [0xA980, 0xA9DF], [0xA9E0, 0xA9FF], [0xAA00, 0xAA5F],
  [0xAA60, 0xAA7F], [0xAA80, 0xAADF], [0xAAE0, 0xAAFF], [0xABC0, 0xABFF],
  // SMP Brahmic (all USE)
  [0x10A00, 0x10A5F], [0x11000, 0x1107F], [0x11080, 0x110CF], [0x110D0, 0x110FF],
  [0x11100, 0x1114F], [0x11150, 0x1117F], [0x11180, 0x111DF], [0x11200, 0x1124F],
  [0x11280, 0x112AF], [0x112B0, 0x112FF], [0x11300, 0x1137F], [0x11380, 0x113FF], [0x11400, 0x1147F],
  [0x11480, 0x114DF], [0x11580, 0x115FF], [0x11600, 0x1165F], [0x11680, 0x116CF],
  [0x11700, 0x1174F], [0x11800, 0x1184F], [0x11900, 0x1195F], [0x119A0, 0x119FF],
  [0x11A00, 0x11A4F], [0x11A50, 0x11AAF], [0x11C00, 0x11C6F], [0x11C70, 0x11CBF],
  [0x11D00, 0x11D5F], [0x11D60, 0x11DAF], [0x11EE0, 0x11EFF], [0x11F00, 0x11F5F],
  // Gurung Khema (16100–1613F) shapes through the Universal Shaping Engine, so
  // Chrome inserts U+25CC before an orphaned mark in this no-font block just as
  // it does for the others above. (Was previously omitted, so its mark cells
  // painted a bare tofu with no leading dotted circle — DM-1100.)
  [0x16100, 0x1613F],
];

export function usesComplexShaperDottedCircle(cp: number): boolean {
  for (const [lo, hi] of COMPLEX_SHAPER_MARK_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// DM-1109: pre-base (LEFT) matras — VOWEL SIGNS the Universal Shaping Engine
// reorders to BEFORE their base. The set is the INTERSECTION of Unicode
// IndicPositionalCategory (UCD 18.0) "Left" placement (all six categories whose
// placement includes a Left component: Left / Top_And_Left / Bottom_And_Left /
// Top_And_Bottom_And_Left / Left_And_Right / Top_And_Left_And_Right) with
// IndicSyllabicCategory = Vowel_Dependent. The Vowel_Dependent filter is
// essential: USE pre-base reordering applies to pre-base VOWELS, not to MEDIAL
// CONSONANTS that merely sit to the left (e.g. Gurung Khema U+1612A/B MEDIAL
// YA/VA, Myanmar U+103C medial ra, Ahom U+1171E) — those are InPC=Left but
// Chrome paints them post-base ("◌ mark"), so flipping them was wrong (it
// regressed the gurung-khema fixture from clean to a 2-region diff before the
// filter was added).
//
// When `insertSyntheticDottedCircles` synthesizes a ◌ base for an orphaned,
// uncovered such matra, Chrome (USE) paints "mark ◌" (☐○), not "◌ mark". Verified
// against Chrome's painted output for the Tulu-Tigalari block: U+113C5 (Left
// vowel) and U+113C7/C8 (Left_And_Right vowels) all paint tofu-then-circle,
// while U+113C9 (Right vowel) paints circle-then-tofu. (Two-part Left_And_Right
// vowels render as a single .notdef tofu on the no-font path, so they reorder
// wholesale like a pure Left matra.) Flat sorted ranges, inclusive [lo, hi];
// only consulted for an already-qualified orphaned uncovered mark, so the linear
// scan is cheap.
const LEFT_REORDER_MATRA_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x93F, 0x93F], [0x94E, 0x94E], [0x9BF, 0x9BF], [0x9C7, 0x9C8],
  [0x9CB, 0x9CC], [0xA3F, 0xA3F], [0xABF, 0xABF], [0xB47, 0xB48],
  [0xB4B, 0xB4C], [0xBC6, 0xBC8], [0xBCA, 0xBCC], [0xD46, 0xD48],
  [0xD4A, 0xD4C], [0xDD9, 0xDDE], [0x1031, 0x1031], [0x1084, 0x1084],
  [0x17BE, 0x17C5], [0x1A19, 0x1A19], [0x1A6E, 0x1A72], [0x1B3E, 0x1B41],
  [0x1BA6, 0x1BA6], [0x1C27, 0x1C29], [0xA9BA, 0xA9BB], [0xAA2F, 0xAA30],
  [0xAAEB, 0xAAEB], [0xAAEE, 0xAAEE], [0x110B1, 0x110B1], [0x1112C, 0x1112C],
  [0x111B4, 0x111B4], [0x111CE, 0x111CE], [0x112E1, 0x112E1], [0x11347, 0x11348],
  [0x1134B, 0x1134C], [0x113C2, 0x113C2], [0x113C5, 0x113C5], [0x113C7, 0x113C8],
  [0x11436, 0x11436], [0x114B1, 0x114B1], [0x114B9, 0x114B9], [0x114BB, 0x114BC],
  [0x114BE, 0x114BE], [0x115B0, 0x115B0], [0x115B8, 0x115BB], [0x116AE, 0x116AE],
  [0x11726, 0x11726], [0x1182D, 0x1182D], [0x11935, 0x11935], [0x11937, 0x11938],
  [0x119D2, 0x119D2], [0x119E4, 0x119E4], [0x11CB1, 0x11CB1], [0x11EF5, 0x11EF5],
  [0x11F3E, 0x11F3F],
];

export function isLeftReorderingMatra(cp: number): boolean {
  for (const [lo, hi] of LEFT_REORDER_MATRA_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// DM-1026: does `cp` resolve to a `.notdef` (no real font in the chain covers
// it)? Mirrors the coverage resolution in `splitTextIntoFontRuns`'s walk —
// primary, then per-codepoint webfont variant, then the static fallback chain,
// then the CoreText system-fallback — but only the "is it covered anywhere"
// question (no Math-Alpha / NFD decomposition, which don't apply to a combining
// mark). Returns true when nothing but `last-resort` (or nothing) covers it.
function codepointResolvesToNotdef(
  cp: number, primaryFont: FontInstance, primaryFontKey: string,
  weight: number, fontSize: number, slant: number,
  variationSettings: Record<string, number> | undefined, lang: string | undefined,
): boolean {
  if (primaryFont.glyphForCodePoint(cp).id !== 0) return false;
  if (primaryFontKey.startsWith("webfont:")) {
    const family = primaryFontKey.slice("webfont:".length);
    const v = pickWebfontVariantForCodepoint(family, weight, fontSize, slant, cp, variationSettings);
    if (v != null && v.glyphForCodePoint(cp).id !== 0) return false;
  }
  for (const candidate of fallbackFontChain(cp, primaryFontKey, lang)) {
    if (candidate === "last-resort") continue;
    const cf = getFontInstance(candidate, weight, fontSize, slant);
    if (cf != null && cf.glyphForCodePoint != null
        && cf.glyphForCodePoint(cp).id !== 0) return false;
  }
  if (_systemFallbackResolutionEnabled) {
    const sysKey = resolveSystemFallbackKeyForCp(cp);
    if (sysKey != null) {
      const sf = getFontInstance(sysKey, weight, fontSize, slant);
      if (sf != null && sf.glyphForCodePoint != null
          && sf.glyphForCodePoint(cp).id !== 0) return false;
    }
  }
  return true;
}

/**
 * DM-1068: the single per-codepoint font decision shared by the glyph-path
 * splitter (`textToPathMarkup`), the embedded-font splitter
 * (`splitTextIntoFontRuns`), and the math fence / radical renderers — previously
 * five drifting copies. Resolves which font + glyph to use for `cp`, trying in
 * order: the primary; a per-codepoint webfont variant (partitioned @font-face —
 * DM-557); the static `fallbackFontChain`; the CoreText system fallback (DM-1018,
 * the CTFontCreateForString font Blink would substitute); a Math-Alphanumeric
 * base-letter decomposition; and a canonical (NFD) decomposition (DM-1020/1021,
 * for CJK compatibility ideographs etc.).
 *
 * `covered` is false ONLY when nothing produced a real glyph — the caller then
 * applies its own terminal, which is the one place the callers legitimately
 * differ: the glyph-path path pins to the LAST chain entry's stable `.notdef`
 * advance (so emoji rasterGlyph overlays stay aligned), while the embedded path
 * renders the PRIMARY font's `.notdef`.
 */
interface FontResolution {
  /** Logical font key (for glyph-def caching / run grouping). */
  key: string;
  /** Concrete instance override (webfont variant / decomposition / system
   *  fallback); null means materialize `key` via `getFontInstance`. */
  fontOverride: FontInstance | null;
  /** Char to emit — the substituted base char for a math-alpha / NFD
   *  decomposition, else the source char. */
  emitCh: string;
  /** True when `emitCh` differs from the source char (decomposition) — the
   *  glyph-path path must then render the run via its text, not the per-char
   *  source index. */
  decomposed: boolean;
  /** True when a font actually covering the glyph (possibly via decomposition)
   *  was found. False → the caller applies its own uncovered terminal. */
  covered: boolean;
}

/**
 * Resolve which font paints `cp` for a run whose primary is `primaryFont`
 * (`primaryFontKey`), given the run's full declared CSS family stack
 * `fontKeyChain` (DM-1083 — the unified Chrome-mirroring loop). Mirrors Blink's
 * FontFallbackIterator order:
 *
 *   0. The primary font's own literal coverage — the common case, fast path.
 *   1. kFontFamily — walk the WHOLE declared family stack in order. For each font
 *      test the literal cmap, then (mirroring HarfBuzz's default-composed
 *      normalizer) the canonical NFD singleton WITHIN THAT SAME FONT. This both
 *      reaches later-declared families a primary-only resolver dropped (e.g. Arial
 *      Unicode MS covers +85 CJK-compat cells via in-font decomposition —
 *      `tools/probe-2f800-facewalk.mjs`) AND confines decomposition to the
 *      declared cascade, so it never over-renders into deep fallback faces Chrome's
 *      cascade can't reach: a whole-`fallbackFontChain` canonical search drew 24
 *      cells Chrome leaves blank; this walk draws 0 (the DM-1080 hazard). A
 *      Latin-only stack stays byte-identical to the old primary-only resolver
 *      (verified: 0 newly-covered / 0 newly-decomposed cells across U+2F800–2FA1F).
 *   2. kSystemFonts — the per-char OS fallback: the calibrated `fallbackFontChain`
 *      table (literal only) then the live CoreText `CTFontCreateForString` (literal
 *      + in-font decomposition, which catches residue like U+2F9B2 whose canonical
 *      456B only a system CJK face covers). Platform-specific (CoreText today;
 *      fontconfig / DirectWrite are roadmap); the rest of the loop is
 *      platform-agnostic.
 *   3. Math-Alphanumeric (NFKD compatibility — a deliberately separate axis).
 *   4. kOutOfLuck — LastResort tofu; caller applies its own uncovered terminal.
 */
function resolveFontForCodepoint(
  cp: number,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
  fontKeyChain: string[],
): FontResolution {
  const ch = String.fromCodePoint(cp);
  const cover = (key: string, fontOverride: FontInstance | null, emitCh = ch, decomposed = false): FontResolution =>
    ({ key, fontOverride, emitCh, decomposed, covered: true });

  // 0. Primary fast-path: literal coverage in the run's primary font.
  if (primaryFont.glyphForCodePoint(cp).id !== 0) return cover(primaryFontKey, null);

  // Canonical NFD singleton (e.g. U+2F800→U+4E3D). null when `cp` has no
  // single-codepoint canonical decomposition — multi-char decompositions are not
  // a font-substitution case here.
  const nfd = ch.normalize("NFD");
  const dcp0 = nfd.codePointAt(0);
  const singleton = (dcp0 != null && dcp0 !== cp && String.fromCodePoint(dcp0) === nfd) ? dcp0 : null;

  // Materialize a chain key to an instance — webfont-partition-aware, and only
  // the primary carries the author's font-variation-settings.
  const instanceFor = (key: string): FontInstance | null => {
    const fvs = key === primaryFontKey ? variationSettings : undefined;
    if (key === primaryFontKey) return primaryFont;
    if (key.startsWith("webfont:")) {
      const family = key.slice("webfont:".length);
      const v = pickWebfontVariantForCodepoint(family, weight, fontSize, slant, cp, variationSettings);
      if (v != null) return v;
    }
    return getFontInstance(key, weight, fontSize, slant, fvs);
  };

  // 1. kFontFamily — walk the declared families (literal, then in-font decomp).
  for (const key of fontKeyChain) {
    const inst = instanceFor(key);
    if (inst == null) continue;
    if (inst.glyphForCodePoint(cp).id !== 0) return cover(key, key === primaryFontKey ? null : inst);
    if (singleton != null && inst.glyphForCodePoint(singleton).id !== 0) {
      return cover(key, key === primaryFontKey ? null : inst, String.fromCodePoint(singleton), true);
    }
  }

  // 2a. kSystemFonts — the calibrated static fallback table (literal only).
  for (const candidate of fallbackFontChain(cp, primaryFontKey, lang)) {
    if (candidate === "last-resort") continue;
    const cf = getFontInstance(candidate, weight, fontSize, slant);
    if (cf != null && cf.glyphForCodePoint(cp).id !== 0) return cover(candidate, null);
  }

  // 2b. kSystemFonts — live CoreText per-char fallback (literal + in-font decomp).
  if (_systemFallbackResolutionEnabled) {
    const sysKey = resolveSystemFallbackKeyForCp(cp);
    if (sysKey != null) {
      const sf = getFontInstance(sysKey, weight, fontSize, slant);
      if (sf != null) {
        if (sf.glyphForCodePoint(cp).id !== 0) return cover(sysKey, null);
        if (singleton != null && sf.glyphForCodePoint(singleton).id !== 0) {
          return cover(sysKey, null, String.fromCodePoint(singleton), true);
        }
      }
    }
  }

  // 3. Math-Alphanumeric decomposition (NFKD compatibility axis).
  const decomp = decomposeMathAlphaRun(cp, fallbackFontChain(cp, primaryFontKey, lang), weight, fontSize);
  if (decomp != null) return cover(decomp.key, decomp.font, decomp.ch, true);

  // 4. kOutOfLuck — nothing covers it; caller applies its own uncovered terminal.
  return { key: primaryFontKey, fontOverride: null, emitCh: ch, decomposed: false, covered: false };
}

/**
 * Test-only window into the per-codepoint font resolution decision (DM-1080 /
 * DM-1081). Resolves `fontFamily` to its primary key + instance the same way the
 * renderer does, then returns the resolution's `{ key, decomposed, covered }`.
 * Lets the unit suite guard the primary-only NFD-decomposition invariant so a
 * future change can't silently re-broaden the canonical-form search back across
 * the whole fallback chain (which over-rendered CJK compatibility ideographs
 * Chrome paints as tofu).
 */
export function __resolveFontForCodepointForTest(
  cp: number,
  fontFamily: string,
  weight = 400,
  fontSize = 32,
  slant = 0,
  lang?: string,
): { key: string; decomposed: boolean; covered: boolean } | null {
  const primaryFontKey = resolveFontKey(fontFamily);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant);
  if (primaryFont == null) return null;
  const r = resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, undefined, lang,
    resolveFontKeyChain(fontFamily));
  return { key: r.key, decomposed: r.decomposed, covered: r.covered };
}

// DM-1126: x-extent of a glyph's ink, in font units. Prefers `glyph.bbox`
// (fontkit supplies it); falls back to scanning the path commands' coordinate
// pairs (the native CoreText glyph-helper leaves `bbox` undefined). Control
// points slightly over-estimate the true curve extent, but that's symmetric
// enough for centering a combining mark over its base. Null when no geometry.
function glyphInkBoundsX(glyph: { bbox?: { minX: number; maxX: number }; path?: { commands: Array<{ args: number[] }> } }): { minX: number; maxX: number } | null {
  const bb = glyph.bbox;
  if (bb != null && Number.isFinite(bb.minX) && Number.isFinite(bb.maxX) && bb.maxX > bb.minX) {
    return { minX: bb.minX, maxX: bb.maxX };
  }
  const cmds = glyph.path?.commands;
  if (cmds == null) return null;
  let minX = Infinity, maxX = -Infinity;
  for (const c of cmds) {
    const a = c.args;
    for (let i = 0; i + 1 < a.length; i += 2) {
      const x = a[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return maxX > minX ? { minX, maxX } : null;
}

// DM-1126: does the primary font's OWN shaping of a lone mark already emit a
// dotted circle? Native-extractor (CoreText/AAT) Indic faces — DevanagariMT, the
// Sangam MN family, etc. — auto-insert the U+25CC for an orphaned combining mark,
// so Domotion already renders them correctly and a synthetic insertion would
// DOUBLE the circle (regressing the standard Indic blocks). fontkit faces like
// Mukta emit just the bare mark and DO need the synthetic ◌. Detect by GID — the
// native glyph-helper leaves `codePoints` empty.
function fontAutoInsertsDottedCircle(primaryFont: FontInstance, ch: string): boolean {
  const circleGid = primaryFont.glyphForCodePoint(0x25CC).id;
  if (circleGid === 0) return false;
  const lone = primaryFont.layout(ch);
  return lone.glyphs.length > 1 || lone.glyphs.some((g) => g.id === circleGid);
}

// DM-1126: the CSS-px shift to center a zero-advance combining mark's ink over
// the synthetic ◌'s ink, replicating HarfBuzz's fallback mark positioning. The
// fontkit-rendered Indic faces (e.g. Mukta) carry their Vedic marks' ink at
// NEGATIVE x (authored to overhang a preceding base) with NO GPOS mark-to-base
// anchor, so the shaper reports xOffset 0 and the raw glyph would paint to the
// circle's left. Aligning ink-centers reproduces the "mark sits on the circle"
// Chrome paints. Returns 0 when geometry is unavailable.
function syntheticMarkCenteringOffsetPx(primaryFont: FontInstance, ch: string, fontSize: number): number {
  // `glyphForCodePoint`'s declared return omits `path`/`bbox`; both backing
  // implementations populate them at runtime (used for the ink-bounds scan).
  const circleGlyph = primaryFont.glyphForCodePoint(0x25CC) as unknown as Parameters<typeof glyphInkBoundsX>[0];
  const circleBounds = glyphInkBoundsX(circleGlyph);
  const markGlyph = primaryFont.layout(ch).glyphs[0];
  const markBounds = markGlyph != null ? glyphInkBoundsX(markGlyph) : null;
  if (circleBounds == null || markBounds == null) return 0;
  const circleCx = (circleBounds.minX + circleBounds.maxX) / 2;
  const markCx = (markBounds.minX + markBounds.maxX) / 2;
  return (circleCx - markCx) * (fontSize / primaryFont.unitsPerEm);
}

// DM-1026: synthesize the dotted circle (U+25CC) Chrome's HarfBuzz inserts
// before an ORPHANED combining mark that NO font covers — e.g. the "no font"
// Brahmic blocks (Soyombo, Zanabazar, Devanagari-Extended, …) where each mark
// cell paints "◌ + .notdef tofu", ~51 px wide, while we previously painted just
// the bare tofu. Returns the input text/xOffsets augmented with a leading U+25CC
// for each qualifying mark; a no-op (returns the inputs) when the text has no
// combining marks. The ◌ is itself covered (Hiragino etc.), so it routes and
// renders through the normal pipeline — only the INSERTION is synthetic.
//
// A mark qualifies when it is (a) Unicode category M, (b) in a complex-shaper
// block (so default-shaper marks like Latin diacritics get NONE — see the range
// table), (c) uncovered by the whole font chain, and (d) orphaned: no base in
// its cluster. Orphan tracking: a base letter (or an already-inserted ◌, which
// becomes the cluster base so consecutive orphaned marks share one ◌) sets
// `clusterHasBase`; whitespace resets it. Covered marks are left untouched — the
// CoreText `shape` path (DM-1028) already inserts their dotted circle, so this
// never double-inserts.
export function insertSyntheticDottedCircles(
  text: string, xOffsets: number[] | undefined,
  fontFamily: string, weight: number, fontSize: number, slant: number,
  variationSettings: Record<string, number> | undefined, lang: string | undefined,
  /** DM-1126: UTF-16 indices (into `text`) of COVERED orphaned marks the capture
   *  layer detected Chrome auto-inserts a U+25CC before. The renderer synthesizes
   *  the circle for these (fontkit fonts don't replicate HarfBuzz's insertion),
   *  shaping "◌"+mark as one cluster and centering the combining mark on the ◌.
   *  The UNCOVERED case stays driven by `codepointResolvesToNotdef` below. */
  dottedCircleMarks?: number[],
): { text: string; xOffsets: number[] | undefined } {
  if (!/\p{M}/u.test(text)) return { text, xOffsets };
  const coveredCircleSet = dottedCircleMarks != null && dottedCircleMarks.length > 0
    ? new Set(dottedCircleMarks) : null;
  const primaryFontKey = resolveFontKey(fontFamily);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings);
  if (primaryFont == null) return { text, xOffsets };

  // Resolve the dotted circle's own advance (CSS px) so the displaced mark can
  // be shifted right by exactly the ◌ we will paint. CRUCIAL: probe the PRIMARY
  // font FIRST — Chrome (and our run-splitter) renders ◌ from the primary when
  // it covers U+25CC, so the ◌'s advance must come from THAT font, not the
  // fallback chain. E.g. Arial Unicode MS gives ◌ a 0.6em (19.2px @32) advance,
  // while the chain's Hiragino gives it a full-width 1em (32px) advance — using
  // the chain would shift the tofu ~13px too far right. Falls back to the chain
  // only when the primary lacks ◌. Computed lazily — only if a mark qualifies.
  let dottedCircleAdvanceCss = -1;
  const resolveDottedCircleAdvance = (): number => {
    if (dottedCircleAdvanceCss >= 0) return dottedCircleAdvanceCss;
    dottedCircleAdvanceCss = 0;
    const advFrom = (cf: FontInstance | null): number | null => {
      const g = cf != null ? cf.glyphForCodePoint(0x25CC) : null;
      if (cf != null && g != null && g.id !== 0) return (g.advanceWidth ?? 0) * (fontSize / cf.unitsPerEm);
      return null;
    };
    const fromPrimary = advFrom(primaryFont);
    if (fromPrimary != null) { dottedCircleAdvanceCss = fromPrimary; return dottedCircleAdvanceCss; }
    for (const cand of fallbackFontChain(0x25CC, primaryFontKey, lang)) {
      if (cand === "last-resort") continue;
      const a = advFrom(getFontInstance(cand, weight, fontSize, slant));
      if (a != null) { dottedCircleAdvanceCss = a; break; }
    }
    return dottedCircleAdvanceCss;
  };

  // DM-1109: the gap before the synthetic ◌ when it follows a reordered LEFT
  // matra. The matra paints as the primary font's `.notdef` tofu (the codepoint
  // is uncovered — that's the gate), and Chrome advances by THAT tofu's width
  // before the ◌, which is wider than the ◌'s own advance (≈1em vs ~0.6em). Use
  // the primary `.notdef` advance; fall back to one em, then to the ◌ advance.
  const resolveMarkTofuAdvance = (cp: number): number => {
    const g = primaryFont.glyphForCodePoint(cp);
    const a = (g?.advanceWidth ?? 0) * (fontSize / primaryFont.unitsPerEm);
    if (a > 0) return a;
    return fontSize > 0 ? fontSize : resolveDottedCircleAdvance();
  };

  let outText = "";
  const outX: number[] = [];
  const haveX = xOffsets != null;
  let changed = false;
  let clusterHasBase = false;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const chLen = cp > 0xFFFF ? 2 : 1;
    const ch = text.slice(i, i + chLen);
    const isMark = /\p{M}/u.test(ch);
    const isWs = chLen === 1 && /\s/.test(ch);
    if (isMark) {
      const orphaned = !clusterHasBase;
      if (orphaned && usesComplexShaperDottedCircle(cp)
          && codepointResolvesToNotdef(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang)) {
        const adv = resolveDottedCircleAdvance();
        const markX = haveX ? (xOffsets![i] ?? 0) : 0;
        if (isLeftReorderingMatra(cp)) {
          // DM-1109: a pre-base (left) matra reorders BEFORE its base under the
          // Universal Shaping Engine, so Chrome paints "mark ◌" (☐○). Emit the
          // mark at the captured cell origin and the ◌ shifted right by the
          // mark tofu's advance (the matra leads, so the ◌ clears its full box).
          for (let k = 0; k < chLen; k++) outX.push(markX);
          outText += ch;
          outText += "◌";
          if (haveX) outX.push(markX + resolveMarkTofuAdvance(cp));
        } else {
          outText += "◌";
          if (haveX) outX.push(markX); // ◌ at the mark's captured cell origin
          // The displaced mark shifts right by the ◌ advance; its units keep that
          // shifted x (one entry per UTF-16 unit, mirroring the capture's layout).
          for (let k = 0; k < chLen; k++) outX.push(haveX ? markX + adv : 0);
          outText += ch;
        }
        clusterHasBase = true; // the inserted ◌ is the cluster base now
        changed = true;
        i += chLen;
        continue;
      }
      if (orphaned && coveredCircleSet != null && coveredCircleSet.has(i)
          && primaryFont.glyphForCodePoint(cp).id !== 0
          && primaryFont.glyphForCodePoint(0x25CC).id !== 0
          && !fontAutoInsertsDottedCircle(primaryFont, ch)) {
        // DM-1126: covered mark Chrome circles (capture-detected) whose fontkit
        // primary won't auto-insert the ◌ (native-extractor Indic faces already
        // insert it — the guard above skips them to avoid a DOUBLE circle).
        // Insert it and anchor the ◌ at the
        // mark's captured cell origin; the combining mark draws onto the circle,
        // re-centered HarfBuzz-style (Mukta's marks have negative-x ink + no
        // GPOS anchor, so the per-char emitter needs the centered x baked in).
        const markX = haveX ? (xOffsets![i] ?? 0) : 0;
        const markCenteredX = markX + syntheticMarkCenteringOffsetPx(primaryFont, ch, fontSize);
        outText += "◌";
        if (haveX) outX.push(markX);
        outText += ch;
        if (haveX) for (let k = 0; k < chLen; k++) outX.push(markCenteredX);
        clusterHasBase = true;
        changed = true;
        i += chLen;
        continue;
      }
      // Non-qualifying mark: pass through unchanged.
    } else if (isWs) {
      clusterHasBase = false;
    } else {
      clusterHasBase = true; // a spacing base char
    }
    outText += ch;
    if (haveX) for (let k = 0; k < chLen; k++) outX.push(xOffsets![i + k] ?? xOffsets![i] ?? 0);
    i += chLen;
  }
  if (!changed) return { text, xOffsets };
  return { text: outText, xOffsets: haveX ? outX : undefined };
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
  fontKeyChain: string[],
): FontRun[] {
  const runs: FontRun[] = [];
  // DM-1033: pre-warm the primary font's coverage cache for every DISTINCT
  // codepoint in `text` in a single helper round-trip. The per-codepoint
  // `glyphForCodePoint(cp).id === 0` coverage probe below otherwise issues one
  // helper round-trip per distinct codepoint (the dominant `glyphs`-query class
  // in the DM-1029 profile — e.g. 233 separate coverage calls for the Arabic
  // fixture). Batching collapses those to one. `warmGlyphs` only exists on the
  // native-helper font instances (PingFang / system-fallback extraction); it's
  // absent on fontkit fonts, where coverage is already in-process and free.
  const warm = primaryFont.warmGlyphs;
  if (warm != null) {
    const distinct = new Set<number>();
    for (const ch of text) distinct.add(ch.codePointAt(0)!);
    warm.call(primaryFont, [...distinct]);
  }
  // DM-1036: batch the FALLBACK-font coverage probes. DM-1033 (above) batched
  // the PRIMARY font's coverage, but the per-codepoint walk below still probes
  // each fallback candidate's `glyphForCodePoint(cp)` one codepoint at a time —
  // one helper round-trip per (native-fallback-font, codepoint). For a run whose
  // characters share a fallback font (a real mixed-script paragraph: an Arabic /
  // Devanagari / CJK span the primary doesn't cover), that's N round-trips where
  // one batched `warmGlyphs` would do. Pre-warm here, mirroring the walk's
  // logic: group the primary-uncovered codepoints by their fallback chain, then
  // for each chain warm the candidates in order with the still-unresolved set,
  // pruning the codepoints each candidate covers (same stop-at-first-cover the
  // walk applies). This only POPULATES the coverage caches the walk reads — it
  // never changes which font the walk picks, so the emitted runs stay
  // byte-identical. Gated to runs with ≥2 distinct uncovered codepoints, so a
  // single-codepoint element (e.g. a one-cell-per-codepoint Unicode-table fixture)
  // skips it entirely — nothing to batch there, and the gate keeps that path's
  // round-trip count unchanged. The win lands on helper-heavy fallback runs and
  // is largest on the spawnSync platforms (~9–16 ms/call) the ticket targets.
  const uncovered: number[] = [];
  {
    const seenCp = new Set<number>();
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (seenCp.has(cp)) continue;
      seenCp.add(cp);
      if (primaryFont.glyphForCodePoint(cp).id !== 0) {
        continue; // primary covers it — no fallback probe happens for this cp
      }
      // A webfont primary first tries a per-codepoint webfont variant before the
      // fallback chain; when the variant covers the cp the chain is never probed,
      // so exclude it here (don't warm fonts the walk won't touch). Variants are
      // webfonts (in-process fontkit), so this probe issues no helper round-trip.
      if (primaryFontKey.startsWith("webfont:")) {
        const family = primaryFontKey.slice("webfont:".length);
        const cpVariant = pickWebfontVariantForCodepoint(family, weight, fontSize, slant, cp, variationSettings);
        if (cpVariant != null && cpVariant.glyphForCodePoint(cp).id !== 0) {
          continue;
        }
      }
      uncovered.push(cp);
    }
  }
  if (uncovered.length >= 2) {
    // Group uncovered codepoints by their fallback chain (codepoints in the same
    // Unicode block share a chain), so each chain's candidates are warmed once
    // over the whole group.
    const byChain = new Map<string, { chain: string[]; cps: number[] }>();
    for (const cp of uncovered) {
      const chain = fallbackFontChain(cp, primaryFontKey, lang);
      if (chain.length === 0) continue;
      const key = chain.join(" ");
      const entry = byChain.get(key);
      if (entry != null) entry.cps.push(cp);
      else byChain.set(key, { chain, cps: [cp] });
    }
    for (const { chain, cps } of byChain.values()) {
      let remaining = cps;
      for (const candidate of chain) {
        if (remaining.length === 0) break;
        const cf = getFontInstance(candidate, weight, fontSize, slant);
        const probe = (cf as { glyphForCodePoint?: (cp: number) => { id: number } } | null)?.glyphForCodePoint;
        if (cf == null || probe == null) continue;
        const cfWarm = cf.warmGlyphs;
        if (cfWarm != null) cfWarm.call(cf, remaining); // one batched round-trip
        // Prune the codepoints this candidate now covers — same stop-at-first-
        // cover the walk applies. These probes hit the cache `warmGlyphs` just
        // filled (or are free in-process for fontkit candidates), so no extra
        // round-trips. Whatever a candidate doesn't cover flows to the next.
        remaining = remaining.filter((cp) => probe.call(cf, cp).id === 0);
      }
    }
  }
  let curKey = primaryFontKey;
  let curFontOverride: FontInstance | null = null;
  let curText = "";
  let curStart = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    // The char appended to the run's text — normally the source char; for a
    // Math-Alpha decomposition the substituted base letter/digit. The run's
    // startIdx/endIdx stay in source-text indices so xOffsets lookups remain
    // aligned; the embedded loop reads the decomposed outline from run.text.
    // DM-1068: the per-codepoint decision (primary → webfont variant → chain →
    // system fallback → math-alpha → NFD) is now the shared resolver. The
    // embedded-font terminal when nothing covers `cp` is the PRIMARY font's
    // `.notdef` (glyph 0) — which is exactly what `covered: false` returns
    // (key=primary / override=null / emitCh=source), preserving DM-1018.
    // (`decomposed` is unused here — the embedded loop always renders run.text.)
    const res = resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
    const emitCh = res.emitCh;
    const useKey = res.key;
    const useFontOverride = res.fontOverride;
    const runChanged = useKey !== curKey || useFontOverride !== curFontOverride;
    if (runChanged && curText.length > 0) {
      const fvs = curKey === primaryFontKey ? variationSettings : undefined;
      // DM-1103: for the primary key use the resolved `primaryFont` directly so
      // the optical-cut opsz (injected by resolveFont from the family name)
      // survives — re-resolving via the collapsed key would lose it.
      const f = curFontOverride ?? (curKey === primaryFontKey ? primaryFont : getFontInstance(curKey, weight, fontSize, slant, fvs));
      if (f != null) runs.push({ fontKey: curKey, font: f, text: curText, startIdx: curStart, endIdx: i, isPrimary: curKey === primaryFontKey && curFontOverride == null });
      curText = "";
      curStart = i;
    }
    curKey = useKey;
    curFontOverride = useFontOverride;
    curText += emitCh;
    i += ch.length;
  }
  if (curText.length > 0) {
    const fvs = curKey === primaryFontKey ? variationSettings : undefined;
    // DM-1103: prefer the resolved `primaryFont` for the primary key (keeps the
    // optical-cut opsz; see above).
    const f = curFontOverride ?? (curKey === primaryFontKey ? primaryFont : getFontInstance(curKey, weight, fontSize, slant, fvs)) ?? primaryFont;
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
  /** DM-914: `-webkit-text-stroke-width` (CSS px). When > 0 each per-run
   *  `<text>` carries `stroke` / `stroke-width` so transparent-fill /
   *  outline-only headlines paint their stroke instead of vanishing. */
  textStrokeWidth?: number,
  textStrokeColor?: string,
  paintOrder?: string,
  /** DM-907: caller-supplied target run width (Chrome's measured glyph
   *  span). When provided AND non-null AND xOffsets are missing (so the
   *  per-glyph anchors come from fontkit advances), scale every glyph's
   *  CSS x by `targetWidth / nativeWidth` so the rendered text spans the
   *  same width Chrome painted — eliminates the asymmetric padding gap
   *  on auto-sized pseudo-element pills where fontkit's width differs
   *  from Chrome's by a few pixels. */
  targetWidth?: number,
): string | null {
  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings);
  if (primaryFont == null) return null;
  const primaryFontKey = resolveFontKey(fontFamily);
  const fontKeyChain = resolveFontKeyChain(fontFamily);
  // DM-1103: the optical-cut opsz `resolveFont` pinned for the primary face,
  // folded into the per-instance embed key below so a cut-pinned run (e.g.
  // "SF Pro Text" → opsz 17) doesn't dedup-collide with a generic SF Pro run
  // that shares the collapsed `sf-pro` key at the same weight/slant.
  const primaryCutOpsz = opticalCutOpszFor(fontFamily);

  const runs = splitTextIntoFontRuns(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
  if (runs.length === 0) return null;

  // Per-run baseline: SVG `<text y=...>` puts the BASELINE at y. Use the
  // captured Chrome `fontBoundingBoxAscent` when provided (matches what
  // Chrome's text engine measured on the original page); else fall back
  // to the primary font's HHEA ascent scaled to fontSize.
  const scale = fontSize / primaryFont.unitsPerEm;
  const baselineAscent = ascentOverride != null ? ascentOverride : Math.round(primaryFont.ascent * scale);
  const baselineY = y + baselineAscent;

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // void: silence "unused" when the helper isn't called below (path varies).
  void esc;
  // DM-907: defer `<text>` emit until we've walked every run, so the
  // total fontkit-measured nativeWidth is known and we can apply the
  // `targetWidth/nativeWidth` scale uniformly. Without that, sites
  // where Chrome's text-shaper measured the glyph run a few pixels
  // wider than fontkit (pseudo-element auto-sized pill labels) end up
  // left-anchored in their captured content rect with the leftover
  // padding stacking on the right — visibly off-centre.
  // DM-938: per-glyph scale carries the synthesized small-caps multiplier
  // (1.0 for native-size glyphs, 0.7 for synthesized cap-shrunk lowercase).
  // Pending segments group consecutive glyphs of the same scale so each
  // emits a single `<text>` with its own `font-size` attribute.
  interface PendingSeg {
    perGlyph: Array<{ pua: string; xCss: number; yCss: number; scale: number }>;
    runCssFamily: string;
    weightAttr: string;
    italicAttr: string;
    fvsAttr: string;
    strokeAttr: string;
  }
  const pending: PendingSeg[] = [];
  let cssX = 0;
  // Track whether per-char xOffsets covered EVERY glyph in EVERY run. If
  // they did, glyph positions are already Chrome-accurate and the
  // targetWidth scale would only introduce drift; skip it.
  let allGlyphsHaveXOffset = xOffsets != null && xOffsets.length > 0;
  // DM-938: synthesized small-caps detection. Mirrors the renderTextAsPath
  // logic (line 2195+). When `font-variant-caps: small-caps` (or any of
  // its peers) maps to an OpenType feature that the resolved font lacks
  // (Helvetica / Arial / SF Pro / Georgia / Times / Menlo on macOS all
  // lack smcp / c2sc / pcap / c2pc / unic), Chrome falls back to
  // SYNTHESIZED small-caps: lowercase chars paint as their uppercase
  // glyph at a smaller font-size (0.7× matches Chromium's
  // kSmallCapsFontSizeMultiplier in blink simple_font_data.cc).
  const SMALL_CAP_SCALE = 0.7;
  const featuresArr = features ?? [];
  const wantSmcp = featuresArr.includes("smcp");
  const wantC2sc = featuresArr.includes("c2sc");
  const wantPcap = featuresArr.includes("pcap");
  const wantC2pc = featuresArr.includes("c2pc");
  const wantUnic = featuresArr.includes("unic");
  // The exact text each run is shaped with, plus its parallel per-source-char
  // scale array. Synthesized small-caps (a `font-variant-caps` feature the
  // resolved font lacks) uppercases lowercase chars so fontkit/CoreText hands
  // back the uppercase glyph at the same position, flipping the scale to 0.7 so
  // the emit step paints it smaller; uppercase chars pass through at synthUpper.
  // Extracted (DM-1037) so the per-run render loop AND the shape pre-warm pass
  // below compute byte-identical shaping text — the pre-warm must key the shape
  // cache on the SAME text the layout() call will, or it wouldn't hit.
  function computeRunShaping(run: FontRun): { shapingText: string; perCharScale: number[] } {
    const availableFeatures = Array.isArray((run.font as { availableFeatures?: string[] }).availableFeatures)
      ? ((run.font as { availableFeatures: string[] }).availableFeatures) : [];
    const fontHas = (f: string) => availableFeatures.includes(f);
    let synthLower = 1; // scale for lowercase letters
    let synthUpper = 1; // scale for same-case chars (upper / digit / punct / symbol)
    if (wantSmcp && !fontHas("smcp")) { synthLower = SMALL_CAP_SCALE; }
    if (wantPcap && !fontHas("pcap")) { synthLower = SMALL_CAP_SCALE; }
    if (wantC2sc && !fontHas("c2sc")) { synthUpper = SMALL_CAP_SCALE; }
    if (wantC2pc && !fontHas("c2pc")) { synthUpper = SMALL_CAP_SCALE; }
    if (wantUnic && !fontHas("unic")) { synthUpper = SMALL_CAP_SCALE; /* lowercase stays 1.0 per CSS Fonts 4 §3.5 */ }
    const doSynth = synthLower !== 1 || synthUpper !== 1;
    const perCharScale: number[] = new Array(run.text.length).fill(1);
    if (!doSynth) return { shapingText: run.text, perCharScale };
    // DM-1116: same per-char rule as the per-glyph path — `synthSmallCapsCharScale`
    // scales same-case chars (upper / digit / punctuation / symbol) under
    // c2sc/c2pc/unic too, not just letters. (`null` = that class isn't synthesized.)
    const lowerScale = synthLower !== 1 ? synthLower : null;
    const upperScale = synthUpper !== 1 ? synthUpper : null;
    let out = "";
    for (let i = 0; i < run.text.length; i++) {
      const ch = run.text[i];
      const synth = synthSmallCapsCharScale(ch, lowerScale, upperScale);
      out += synth.upcase ? ch.toUpperCase() : ch;
      perCharScale[i] = synth.scale;
    }
    return { shapingText: out, perCharScale };
  }

  // DM-1037: batch the per-run `shape` round-trips. The loop below calls
  // run.font.layout(shapingText) once per run; for a native (CoreText/FreeType/
  // DirectWrite) fallback font each such call issues one helper `shape`
  // round-trip (one envelope each, even over the persistent `--serve` channel).
  // Pre-warm here: group the runs' shaping texts by their resolved font
  // instance and issue ONE batched `shape` envelope per instance, priming the
  // per-run-text shape cache the subsequent layout() calls read. This only
  // POPULATES that cache — layout() still independently decides per run whether
  // to USE the shaped result (its fully-covered gate is unchanged) — so the
  // emitted runs stay byte-identical. Native instances expose `warmShapes`;
  // fontkit/webfont instances (in-process, no round-trip) don't, and are
  // skipped. (`getFontInstance` caches by spec, so two runs that resolve to the
  // same font share one instance and batch together.) The win is largest on the
  // spawnSync platforms (~9–16 ms/round-trip) the ticket targets, and on Linux/
  // Windows it also collapses the per-run `shape` queries that the FreeType /
  // DirectWrite helpers reject (CoreText-only) into a single envelope.
  {
    const shapeBatch = new Map<FontInstance, string[]>();
    for (const run of runs) {
      if (run.font.warmShapes == null) continue;
      const { shapingText } = computeRunShaping(run);
      if (shapingText.length === 0) continue;
      const arr = shapeBatch.get(run.font);
      if (arr != null) arr.push(shapingText);
      else shapeBatch.set(run.font, [shapingText]);
    }
    for (const [font, texts] of shapeBatch) {
      font.warmShapes?.(texts);
    }
  }
  for (const run of runs) {
    const runScale = fontSize / run.font.unitsPerEm;
    const { shapingText, perCharScale } = computeRunShaping(run);
    let layout: { glyphs: Array<{ id: number; path: { commands: Array<{ command: string; args: number[] }> }; advanceWidth: number; codePoints?: number[] }>; positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>; clusters?: number[] };
    try {
      layout = features != null && features.length > 0 ? run.font.layout(shapingText, features) : run.font.layout(shapingText);
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
    // DM-1103: the optical-cut opsz is pinned on `run.font` (not in
    // variationSettings), so fold it into the key too — otherwise a cut run and
    // a generic run with the same key/weight/slant would share one TTF.
    const cutTuple = run.isPrimary && primaryCutOpsz != null ? `|cut-opsz=${primaryCutOpsz}` : "";
    const instanceKey = `${run.fontKey}|w=${weight}|s=${slant}${fvsTuple}${cutTuple}`;

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
    interface PerGlyph { pua: string; xCss: number; yCss: number; scale: number }
    const perGlyph: PerGlyph[] = [];
    let runCssFamily: string | null = null;
    let runCursorFontUnits = 0;
    let glyphFailed = false;
    // DM-906 + DM-940: fontkit returns shaped glyphs in VISUAL order for
    // RTL scripts (Arabic, Hebrew) and LOGICAL order for LTR scripts.
    // The xOffsets pipeline keys each glyph to its source logical
    // position, but for mixed-bidi runs an xOffsets-monotonicity check
    // misclassifies (an LTR sub-run within an RTL paragraph carries
    // bracket-mirrored outliers — `(` captured at the rightmost
    // visual-x of the sub-run, `)` at the leftmost — so first > last
    // on the SURROUNDING-spaces run but the inner Latin chars are
    // still LTR-monotonic).
    //
    // Detect direction by asking fontkit: does the first glyph's
    // codepoint match the FIRST logical char of run.text (LTR
    // shaper) or the LAST (RTL shaper)? This is deterministic per
    // run regardless of bidi context — a Latin run gets LTR walking
    // even when surrounded by Hebrew, and a Hebrew run gets RTL
    // walking even when surrounded by Latin.
    let runIsRtl = false;
    if (run.text.length >= 2 && layout.glyphs.length >= 1) {
      const firstGlyphCp = layout.glyphs[0].codePoints?.[0];
      const firstTextCp = run.text.codePointAt(0);
      const lastTextCp = run.text.codePointAt(run.text.length - (run.text.codePointAt(run.text.length - 2)! > 0xFFFF ? 2 : 1));
      if (firstGlyphCp != null && firstGlyphCp === lastTextCp && firstTextCp !== lastTextCp) {
        runIsRtl = true;
      }
    }
    // Walk the shaped glyph stream. For each glyph: convert its cluster's
    // first-codepoint xOffset to a CSS pixel x, OR fall back to the
    // accumulated cursor when no xOffsets are present (or the cluster
    // boundary doesn't have one). Cluster span = sum of per-codepoint
    // UTF-16 lengths in glyph.codePoints (BMP=1, astral=2). When the
    // codePoints array is missing or empty (decomposed glyphs) span=1
    // so the cursor still advances.
    let textIdx = runIsRtl ? run.text.length : 0; // index within run.text
    // DM-1028: when the run was shaped by the CoreText helper, each glyph
    // carries its UTF-16 source cluster index. We anchor each CLUSTER at its
    // captured per-character xOffset and lay the cluster's glyphs out from
    // that single anchor by shaped advance + GPOS offset — so an inserted
    // dotted circle, a reordered conjunct, or a mark stacked over its base
    // all paint at the right place. (The naive per-codepoint path emitted one
    // glyph per source char at xOffset and dropped every inserted/extra glyph
    // and every GPOS offset.) For 1:1 scripts each glyph is its own cluster,
    // so this is identical to the per-char anchoring below.
    const clusters = layout.clusters;
    let clusterAnchorCss = 0;
    let clusterCursorFU = 0;
    let prevCluster = -1;
    for (let i = 0; i < layout.glyphs.length; i++) {
      const glyph = layout.glyphs[i];
      const pos = layout.positions[i];
      // DM-892: route through commandsFor so the DM-891 per-glyph helper
      // fallback applies in embedded mode too — when fontkit decodes an
      // inkable, cmap-covered glyph as empty (a partial CFF/CJK face), the
      // native helper supplies its outline. commandsFor returns fontkit-shaped
      // PathCommand[], which trackGlyphInEmbedFont already converts into the
      // synthesized TTF's glyf, so the helper outline lands in the embedded
      // font with no extra construction. (Inert on macOS, like DM-891: every
      // fontkit-empty glyph here is legitimately inkless and the helper agrees.)
      const cmds = commandsFor(glyph, run.fontKey, weight, fontSize, slant);
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

      let xCss: number;
      let yCss = 0;
      let glyphScale: number;
      if (clusters != null) {
        // CoreText-shaped run: cluster-aware anchoring + GPOS offsets.
        const srcIdx = clusters[i];
        const wholeTextIdx = run.startIdx + srcIdx;
        if (srcIdx !== prevCluster) {
          if (xOffsets != null && xOffsets[wholeTextIdx] != null) {
            clusterAnchorCss = xOffsets[wholeTextIdx];
          } else {
            const runOriginCss = (xOffsets != null && xOffsets[run.startIdx] != null)
              ? xOffsets[run.startIdx] : cssX;
            clusterAnchorCss = runOriginCss + runCursorFontUnits * runScale;
            allGlyphsHaveXOffset = false;
          }
          clusterCursorFU = 0;
          prevCluster = srcIdx;
        }
        // pos.xOffset / yOffset are the GPOS adjustment from the glyph's pen
        // origin (font units, y-up); flip y for SVG's y-down axis.
        xCss = clusterAnchorCss + (clusterCursorFU + pos.xOffset) * runScale;
        yCss = -pos.yOffset * runScale;
        clusterCursorFU += pos.xAdvance;
        glyphScale = perCharScale[srcIdx] ?? 1;
      } else {
        // fontkit-shaped run: per-char xOffset anchoring (unchanged).
        // Glyph x anchor: captured xOffset at the cluster's first char
        // (relative to the whole-text origin), else cumulative fontkit
        // advance from the run start. xOffsets is indexed against `text`
        // (the whole captured string), so we use the run's startIdx +
        // intra-run textIdx to look it up.
        // Compute the cluster's UTF-16 char span (size in run.text).
        const cps = glyph.codePoints;
        let span = 0;
        if (cps != null && cps.length > 0) {
          for (const cp of cps) span += cp > 0xFFFF ? 2 : 1;
        } else {
          span = 1;
        }
        // For RTL runs, textIdx walks backwards: the cluster's first
        // logical char sits at (textIdx - span), so subtract BEFORE lookup
        // so the lookup index lands on the cluster's first char.
        if (runIsRtl) textIdx -= span;
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
          allGlyphsHaveXOffset = false;
        }
        // DM-938: pull the per-source-char scale through to per-glyph. The
        // cluster's first char (textIdx) is where Chrome's painted-position
        // anchor lives; use its scale. For multi-char clusters all chars in
        // the cluster get the same case treatment so the scale is uniform.
        glyphScale = perCharScale[textIdx] ?? 1;
        // For LTR, advance textIdx AFTER lookup. (For RTL we decremented
        // before the lookup so the next iteration's pre-decrement lands on
        // the previous cluster's start.)
        if (!runIsRtl) textIdx += span;
      }
      perGlyph.push({ pua: String.fromCodePoint(placement.puaCodepoint), xCss, yCss, scale: glyphScale });
      runCursorFontUnits += pos.xAdvance;
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

    let strokeAttr = "";
    if (textStrokeWidth != null && textStrokeWidth > 0 && textStrokeColor != null && textStrokeColor !== "") {
      strokeAttr = ` stroke="${textStrokeColor}" stroke-width="${r(textStrokeWidth)}"`;
      if (paintOrder != null && /^\s*stroke(?:\s|$)/.test(paintOrder)) {
        strokeAttr += ` paint-order="stroke fill"`;
      }
    }
    pending.push({ perGlyph, runCssFamily, weightAttr, italicAttr, fvsAttr, strokeAttr });
    cssX += runCursorFontUnits * runScale;
  }

  if (pending.length === 0) return null;
  const segments: string[] = [];

  // DM-907: apply targetWidth scaling now that we know the full
  // fontkit-measured nativeWidth across all runs. cssX after the loop is
  // the cumulative end-of-text x in CSS units (font-unit cursor × scale
  // per run, summed). When targetWidth is provided AND we DIDN'T have
  // per-char xOffsets for every glyph (the per-char case already pins
  // every glyph at Chrome's painted position, so an additional scale
  // would mis-position), scale every glyph's xCss by `targetWidth /
  // cssX`. Otherwise emit unchanged.
  const xScale = (targetWidth != null && targetWidth > 0 && cssX > 0 && !allGlyphsHaveXOffset)
    ? targetWidth / cssX : 1;
  // Position each glyph with the `<text>` `x` positional list — one value
  // per glyph — instead of wrapping each in its own `<tspan>` (DM-841). The
  // explicit per-glyph x is still required: the custom subset TTF carries no
  // GPOS/kern, so without it the consumer browser re-flows from hmtx alone
  // and loses Chrome's kerning (multi-px drift at headline sizes). SVG
  // applies x[i] to the i-th addressable character; our content is one BMP
  // PUA codepoint per glyph (builder assigns U+E000..U+F8FF — single UTF-16
  // unit), so the list aligns 1:1 with the PUA stream. Same pixel-faithful
  // placement, ~2-3x less markup than per-glyph `<tspan>`s.
  for (const p of pending) {
    // DM-938: synthesized small-caps splits the per-glyph stream into
    // runs of consecutive same-scale glyphs. Each run emits its own
    // `<text>` with the matching `font-size` (`fontSize × scale`). When
    // no glyph in this PendingSeg carries a non-1.0 scale, we emit a
    // single `<text>` for the whole segment as before.
    let runStart = 0;
    while (runStart < p.perGlyph.length) {
      const runScale = p.perGlyph[runStart].scale;
      let runEnd = runStart + 1;
      while (runEnd < p.perGlyph.length && p.perGlyph[runEnd].scale === runScale) runEnd++;
      const slice = p.perGlyph.slice(runStart, runEnd);
      const xList = slice.map((g) => r(x + g.xCss * xScale)).join(" ");
      const puaStream = slice.map((g) => g.pua).join("");
      const emitFontSize = r(fontSize * runScale);
      // DM-1028: emit a per-glyph y-list only when a glyph carries a vertical
      // GPOS offset (Brahmic marks stacked above/below their base). The common
      // case (all glyphs on the baseline) keeps the single `y` attribute and
      // the smaller markup.
      const anyY = slice.some((g) => g.yCss !== 0);
      const yAttr = anyY
        ? `y="${slice.map((g) => r(baselineY + g.yCss)).join(" ")}"`
        : `y="${r(baselineY)}"`;
      segments.push(`<text x="${xList}" ${yAttr} font-family="${p.runCssFamily}" font-size="${emitFontSize}"${p.weightAttr}${p.italicAttr}${p.fvsAttr} fill="${fill}"${p.strokeAttr}>${puaStream}</text>`);
      runStart = runEnd;
    }
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
  /** DM-1126: UTF-16 indices (into `text`) of covered orphaned marks the capture
   *  layer detected Chrome auto-circles. Forwarded to `insertSyntheticDottedCircles`. */
  dottedCircleMarks?: number[],
): string | null {
  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // DM-1026 / DM-1126: synthesize the dotted circle Chrome's HarfBuzz inserts
  // before an orphaned complex-shaper combining mark — for UNCOVERED marks
  // (no-font Brahmic blocks, detected here) and for CAPTURE-flagged COVERED marks
  // (`dottedCircleMarks`, e.g. Mukta Vedic). Run once at the funnel so both the
  // embedded-font and glyph-path branches below receive the augmented text +
  // xOffsets. A no-op for text with no combining marks.
  ({ text, xOffsets } = insertSyntheticDottedCircles(
    text, xOffsets, fontFamily, weight, fontSize, slant, variationSettings, lang, dottedCircleMarks));

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
      xOffsets, fontStyle, ascentOverride, features, lang, variationSettings,
      textStrokeWidth, textStrokeColor, paintOrder, targetWidth);
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
    if (paintOrder != null && /^\s*stroke(?:\s|$)/.test(paintOrder)) {
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
/**
 * Measure the right-side-bearing (rsb) of the last non-whitespace glyph in
 * `text` when shaped through fontkit at the given font / size / weight /
 * style. rsb = `advanceWidth − bbox.maxX`, in CSS px (already scaled by
 * `fontSize / unitsPerEm`).
 *
 * Used by the list-marker emit path (DM-790): SVG `<text text-anchor="end">`
 * places the anchor at the last glyph's advance-end, not its visible-right
 * edge. To land the visible right at the target (Chromium's `el.x − 7` per
 * `kCMarkerPaddingPx`), we have to shift the anchor right by `rsb`.
 *
 * Returns 0 when the font isn't resolvable, when shaping fails, when the
 * text is empty / whitespace-only, or when the last glyph has no bbox. The
 * built-in marker path's previous empirical 3 px offset for `.` is now
 * font-metric-derived through this helper too.
 */
export function measureLastGlyphRsb(
  text: string,
  fontSize: number,
  fontFamily: string,
  fontWeight: string | number,
  fontStyle?: string,
): number {
  // Drop trailing whitespace — DM-789 probed that Chrome's SVG renderer
  // collapses / drops trailing whitespace despite `xml:space="preserve"`,
  // so the visible-rightmost glyph is the last NON-space character.
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") return 0;
  const weight = typeof fontWeight === "number" ? fontWeight : (parseInt(fontWeight) || 400);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant);
  if (font == null) return 0;
  let layout;
  try { layout = font.layout(trimmed); } catch { return 0; }
  if (layout.glyphs.length === 0) return 0;
  const lastGlyph = layout.glyphs[layout.glyphs.length - 1] as { advanceWidth: number; bbox?: { maxX?: number } } | undefined;
  if (lastGlyph == null) return 0;
  const bboxMaxX = lastGlyph.bbox?.maxX;
  if (typeof bboxMaxX !== "number") return 0;
  const scale = fontSize / font.unitsPerEm;
  const rsbUnits = lastGlyph.advanceWidth - bboxMaxX;
  return rsbUnits * scale;
}

/**
 * Measure the ink ascent / descent (px above / below the baseline) of `text`
 * shaped through the SAME per-codepoint font resolution `textToPathMarkup`
 * uses (`splitTextIntoFontRuns` → `font.layout`). Returns the extreme glyph
 * ink-bbox edges scaled to px, or null when no rendered glyph has a usable
 * bbox.
 *
 * DM-832: positions MathML token elements (`<mo>` / `<mi>` / `<mn>` /
 * `<mtext>`). Chromium's math token layout
 * (`math_token_layout_algorithm.cc`) sizes each token's border box to its
 * glyph ink — `block_size = ink_ascent + ink_descent + padding` — so the
 * captured element rect top is the painted ink top and `el.height` the ink
 * height. The caller splits that captured box by `inkAscent / (inkAscent +
 * inkDescent)` to place the baseline, landing the glyph ink where Chrome
 * painted it without assuming our glyph's absolute ink size matches Chrome's
 * (it borrows only the ascent:descent ratio). The font-ascent baseline used
 * for ordinary inline text sits several px too low for tall operators (∑ ∫ ∏)
 * and a few px off for letters — the residual vertical drift the
 * `34-mathml-layout` fixture flagged.
 *
 * Crucially the ink is read from the glyph actually rendered — the
 * fallback-routed font, not the primary — so a `math` family that resolves to
 * Times yet paints ∑ from a fallback face still measures the fallback's ink.
 * A prior attempt that measured the primary font's bbox overshot by ~4 px for
 * codepoints that fallback-routed away from it; reusing the shared run
 * splitter keeps the measurement and the emitted glyph on the same font.
 */
export function measureInkMetrics(
  text: string,
  fontSize: number,
  fontFamily: string,
  fontWeight: string | number,
  fontStyle?: string,
  lang?: string,
  variationSettings?: Record<string, number>,
  features?: string[],
): { inkAscent: number; inkDescent: number } | null {
  const weight = typeof fontWeight === "number" ? fontWeight : (parseInt(fontWeight) || 400);
  const slant = slantForStyle(fontStyle);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings);
  if (primaryFont == null) return null;
  const primaryFontKey = resolveFontKey(fontFamily);
  const fontKeyChain = resolveFontKeyChain(fontFamily);
  const runs = splitTextIntoFontRuns(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
  let maxY = -Infinity; // ink top    (font units, y-up)
  let minY = Infinity;  // ink bottom (font units, y-up; negative = below baseline)
  for (const run of runs) {
    const scale = fontSize / run.font.unitsPerEm;
    let layout;
    try {
      layout = features != null && features.length > 0 ? run.font.layout(run.text, features) : run.font.layout(run.text);
    } catch { continue; }
    for (const g of layout.glyphs) {
      // Skip .notdef tofu (id 0) — its placeholder bbox would inflate the ink
      // box, and `textToPathMarkup` suppresses it from emission anyway.
      if (g.id === 0) continue;
      const bbox = (g as { bbox?: { minY: number; maxY: number } }).bbox;
      if (bbox == null || !(bbox.maxY > bbox.minY)) continue;
      const top = bbox.maxY * scale;
      const bot = bbox.minY * scale;
      if (top > maxY) maxY = top;
      if (bot < minY) minY = bot;
    }
  }
  if (maxY === -Infinity) return null;
  return { inkAscent: maxY, inkDescent: -minY };
}

/**
 * The Unicode characters that MathML treats as vertically-stretchy fences /
 * brackets by default (a focused subset of the operator dictionary's
 * `stretchy` entries). Chromium paints these centered on the math axis and
 * stretched to wrap their content, which `renderStretchyFenceGlyph` reproduces
 * by fitting the glyph to the captured `<mo>` box rather than the text
 * baseline. (DM-874)
 */
const STRETCHY_FENCE_CHARS = new Set([
  "(", ")", "[", "]", "{", "}", "|", "‖",
  "⌈", "⌉", "⌊", "⌋", "⟨", "⟩", "⎰", "⎱", "❲", "❳",
]);

/** True when `text` is a single stretchy MathML fence / bracket character. */
export function isStretchyFenceChar(text: string): boolean {
  return STRETCHY_FENCE_CHARS.has(text.trim());
}

/**
 * Render a MathML stretchy fence operator (a `<mo>` whose text is a single
 * bracket / paren / brace) fitted to its captured element box instead of the
 * text baseline. Chromium paints these centered on the math axis and vertically
 * stretched to wrap their content; the `<mo>` element's own
 * `getBoundingClientRect` reflects exactly that painted extent (verified: the
 * box matches the painted ink to <1px), so we map the glyph's ink bbox onto
 * `[boxY, boxY + boxH]` vertically (a non-uniform scale = the stretch) while
 * keeping the natural horizontal scale anchored at the captured x. Placing the
 * fence on the text baseline instead — the previous behavior — landed it
 * several px too low for multi-row content. (DM-874)
 *
 * Returns null (caller falls back to normal baseline text rendering) when the
 * font / glyph can't be resolved or the glyph has no outline.
 */
export function renderStretchyFenceGlyph(
  char: string,
  x: number,
  boxY: number,
  boxH: number,
  fontSize: number,
  fontFamily: string,
  fontWeight: string,
  fill: string,
  fontStyle?: string,
): string | null {
  const ch = char.trim();
  if (ch === "" || boxH <= 0) return null;
  const cp = ch.codePointAt(0)!;
  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);

  // Resolve a font that actually has the fence glyph via the shared per-codepoint
  // resolver (DM-1068). Uncovered → keep the primary (its `.notdef`); the caller
  // falls back to the synthesized path when the layout has no outline.
  const primaryFontKey = resolveFontKey(fontFamily);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant);
  if (primaryFont == null) return null;
  const res = resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, undefined, undefined,
    resolveFontKeyChain(fontFamily));
  const useKey = res.covered ? res.key : primaryFontKey;
  const font = res.covered ? (res.fontOverride ?? getFontInstance(res.key, weight, fontSize, slant) ?? primaryFont) : primaryFont;

  let layout;
  try { layout = font.layout(ch); } catch { return null; }
  const glyph = layout.glyphs[0] as
    { id: number; path: { commands: Array<{ command: string; args: number[] }> }; bbox?: { minX: number; minY: number; maxX: number; maxY: number } } | undefined;
  if (glyph == null || glyph.path.commands.length === 0) return null;
  const bbox = glyph.bbox;
  if (bbox == null || !(bbox.maxY > bbox.minY)) return null;

  const em = font.unitsPerEm;
  const defId = ensureGlyphDef(useKey, weight, fontSize, slant, glyph.id, glyph.path.commands);
  // Horizontal: natural scale, glyph origin anchored at the captured x (same as
  // the per-char baseline path). Vertical: map ink [minY,maxY] (font units,
  // y-up) onto [boxY, boxY+boxH] (SVG y-down) — `sy` is the stretch factor.
  // Scale factors need 5-decimal precision (em is ~1000-2048, so 2dp would be
  // a ~7% size error); the translate keeps `r()`'s 2dp px precision.
  const sx = fontSize / em;
  const sy = boxH / (bbox.maxY - bbox.minY);
  const ty = boxY + sy * bbox.maxY;
  const sxStr = Number(sx.toFixed(5)).toString();
  const syStr = Number((-sy).toFixed(5)).toString();
  return `<g transform="translate(${r(x)},${r(ty)}) scale(${sxStr},${syStr})" fill="${fill}"><use href="#${defId}"/></g>`;
}

/**
 * Render a MathML `<msqrt>` / `<mroot>` radical sign from the actual √ (U+221A)
 * font glyph fitted to the captured radical box, plus the horizontal overbar
 * (vinculum) extended across the radicand. (DM-897)
 *
 * Chromium paints the radical from the math font's glyph, which carries
 * stroke-weight contrast (thin descending stroke → thick rising stroke) and a
 * proper hook — a uniform-stroke synthesized path (the previous approach)
 * couldn't reproduce that look. The radicands in practice are close to the √
 * glyph's natural height, so a near-natural uniform scale fits without the
 * OpenType MATH-table vertical glyph assembly that taller radicals would need.
 *
 * Fit: scale uniformly so the glyph ink height fills the captured box height,
 * anchor the glyph's ink-left at `x` and ink-top at `topY` (so the V tip lands
 * at the box bottom, matching Chrome's painted radical). The glyph's own
 * overbar stub sits at the top; the separately-drawn rule continues it across
 * the radicand to `x + width`. The rule's y is nudged to Chrome's painted
 * vinculum, which sits ~1.5 px below the captured element-box top.
 *
 * Returns null (caller falls back to the synthesized path) when the √ glyph
 * can't be resolved or has no outline.
 */
export function renderRadicalGlyph(
  x: number,
  topY: number,
  height: number,
  width: number,
  fontSize: number,
  fontFamily: string,
  fontWeight: string,
  fill: string,
  fontStyle?: string,
): string | null {
  if (height <= 0 || width <= 0) return null;
  const cp = 0x221A; // √ SQUARE ROOT
  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);

  // Resolve a font that has the √ glyph via the shared per-codepoint resolver
  // (DM-1068). Uncovered → keep the primary; the caller falls back to the
  // synthesized path when the layout has no outline.
  const primaryFontKey = resolveFontKey(fontFamily);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant);
  if (primaryFont == null) return null;
  const res = resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, undefined, undefined,
    resolveFontKeyChain(fontFamily));
  const useKey = res.covered ? res.key : primaryFontKey;
  const font = res.covered ? (res.fontOverride ?? getFontInstance(res.key, weight, fontSize, slant) ?? primaryFont) : primaryFont;

  let layout;
  try { layout = font.layout("√"); } catch { return null; }
  const glyph = layout.glyphs[0] as
    { id: number; path: { commands: Array<{ command: string; args: number[] }> }; bbox?: { minX: number; minY: number; maxX: number; maxY: number } } | undefined;
  if (glyph == null || glyph.path.commands.length === 0) return null;
  const bbox = glyph.bbox;
  if (bbox == null || !(bbox.maxY > bbox.minY) || !(bbox.maxX > bbox.minX)) return null;

  const defId = ensureGlyphDef(useKey, weight, fontSize, slant, glyph.id, glyph.path.commands);
  // The captured element box carries a small clearance above the painted
  // vinculum and below the V tip (Chrome's RadicalVerticalGap + rule), so the
  // radical INK is shorter than `height`. Pixel scan of the 22 px fixture put
  // the top clearance at ~1.5 px (≈7% of the box) and the bottom at ~0.5 px
  // (≈2%); expressing them as fractions keeps the fit correct across sizes.
  // Fit the glyph ink to that inset box, uniform scale to preserve the √'s
  // natural aspect (a non-uniform stretch would distort the stroke weights).
  const topInset = height * 0.07;
  const botInset = height * 0.02;
  const inkH = height - topInset - botInset;
  const s = inkH / (bbox.maxY - bbox.minY);
  // Anchor ink-left at x (translateX offsets the glyph origin so bbox.minX
  // lands at x) and ink-top at `topY + topInset` (translateY maps bbox.maxY
  // there under the -s vertical flip, same convention as the fence path).
  const overbarY = topY + topInset;
  const tx = x - bbox.minX * s;
  const ty = overbarY + s * bbox.maxY;
  const sStr = Number(s.toFixed(5)).toString();
  const negS = Number((-s).toFixed(5)).toString();
  const glyphMarkup = `<g transform="translate(${r(tx)},${r(ty)}) scale(${sStr},${negS})" fill="${fill}"><use href="#${defId}"/></g>`;

  // Overbar (vinculum): continue the glyph's top stub across the radicand to
  // the radical's right edge, at the SAME y the glyph ink-top was anchored to
  // so the stub and the extension form one continuous rule (a y mismatch here
  // is what showed up as a doubled overbar line). 1 px matches the default
  // rule thickness.
  const glyphRight = x + (bbox.maxX - bbox.minX) * s;
  const overbarRight = x + width;
  let overbar = "";
  if (overbarRight > glyphRight) {
    overbar = `<rect x="${r(glyphRight)}" y="${r(overbarY)}" width="${r(overbarRight - glyphRight)}" height="1" fill="${fill}"/>`;
  }
  return glyphMarkup + overbar;
}

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
