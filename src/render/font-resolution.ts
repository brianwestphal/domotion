/**
 * Font-resolution subsystem, extracted from text-to-path.ts (DM-1305 / DM-1307,
 * option 1). Owns the FontInstance interface + instance cache, the platform
 * FONT_PATHS / LINUX / WIN32 path tables and key->path resolvers, the per-script
 * fallback chains (darwin/linux/win32 + dispatcher), the webfont + embedded-font
 * registries, glyph-command extraction, and the render-text-mode switch. This is
 * the lower layer; text-to-path.ts (shaping/markup) imports from here. Verbatim
 * lift -- behaviour-identical; the broad html-test/unicode CI sweep is the proof.
 */
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
import { makeHarfbuzzShapingInstance } from "./harfbuzz-shaper.js";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss, trackGlyphInEmbedFont } from "./embedded-font-builder.js";
import { UNICODE_FONT_PATHS, UNICODE_FONT_RANGES } from "./unicode-font-routing.darwin.generated.js";
import { UNICODE_FONT_PATHS_LINUX, UNICODE_FONT_RANGES_LINUX } from "./unicode-font-routing.linux.generated.js";
import { UNICODE_FONT_PATHS_NOTO_LINUX, UNICODE_FONT_RANGES_NOTO_LINUX } from "./unicode-font-routing.noto-linux.generated.js";
import { UNICODE_FONT_FILES_WIN32, UNICODE_FONT_RANGES_WIN32 } from "./unicode-font-routing.win32.generated.js";
// Unicode-classification predicates (mathAlphaToBase, isRtlScriptCodepoint, isStretchyFenceChar, complex-shaper / matra / rtl ranges, …) moved to ./unicode-classification.ts (DM-1305).
import { mathAlphaToBase, isLegitimatelyInklessCodepoint, usesDedicatedShaper, isTrimmableCjkPunct, complexShaperBaseMarkDecomposition, isStrippableOrphanIgnorable, usesComplexShaperDottedCircle, isLeftReorderingMatra, isRtlScriptCodepoint } from "./unicode-classification.js";
export { mathAlphaToBase, isLegitimatelyInklessCodepoint, isTrimmableCjkPunct, complexShaperBaseMarkDecomposition, isStrippableOrphanIgnorable, usesComplexShaperDottedCircle, isLeftReorderingMatra, isStretchyFenceChar } from "./unicode-classification.js"; // re-export for text-to-path.test.ts + text.ts

export interface FontInstance {
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
// at the top level). The `paths`-mode glyph registry (`getGlyphDefs()`) shares
// this exact per-generation lifecycle, so producers call `clearGlyphDefs()`
// alongside `clearEmbeddedFonts()` — otherwise the module-global glyph map
// accumulates across renders and back-to-back generations emit prior glyphs as
// dead `<defs>` bloat (DM-1338).
export type RenderTextMode = "paths" | "embedded-font";
export let currentRenderTextMode: RenderTextMode = "embedded-font";
export function setRenderTextMode(mode: RenderTextMode): void { currentRenderTextMode = mode; }
export function getRenderTextMode(): RenderTextMode { return currentRenderTextMode; }
/**
 * Run `fn` with the module-global render-text mode set to `mode`, restoring the
 * prior value afterward — even if `fn` throws. `currentRenderTextMode` is a
 * PROCESS-GLOBAL, so a caller that flips it with a bare `setRenderTextMode` and
 * forgets to restore leaks the mode into every later render in the same process.
 * Prefer this save/restore wrapper for a scoped change (mirrors
 * `withSystemFallbackResolution`, DM-1350 / DM-1435). Synchronous: the mode only
 * needs to hold for `fn`'s synchronous render.
 */
export function withRenderTextMode<T>(mode: RenderTextMode, fn: () => T): T {
  const prev = currentRenderTextMode;
  currentRenderTextMode = mode;
  try {
    return fn();
  } finally {
    currentRenderTextMode = prev;
  }
}

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
 * Reset ALL generation-scoped render caches together — the embedded-font subset
 * builder (`clearEmbeddedFonts`) AND the paths-mode glyph-defs registry
 * (`clearGlyphDefs`). Every multi-pass producer (capture, scroll composer)
 * starts a fresh generation by clearing both; calling them piecemeal is the
 * footgun that caused the DM-1338 stale-glyph-defs bug, so this bundles them so
 * a caller can't clear a partial set. Does NOT touch the webfont registry
 * (`clearWebfonts`) — that's session-scoped (user-registered fonts persist
 * across generations). DM-1435.
 */
export function resetGeneration(): void {
  clearEmbeddedFonts();
  clearGlyphDefs();
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
export const ITALIC_SLNT = -9.99;
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
  // DM-1189 / DM-1199 / DM-1196 / DM-1183: the REAL Helvetica Neue, distinct
  // from Helvetica.ttc above (and from the mislabeled generated `u-helvetica-
  // neue` key, which also points at Helvetica.ttc). On an SF-Pro / system-ui
  // primary, Blink's CoreText fallback resolves a cluster of letterlike / math /
  // archaic-Latin / Cyrillic codepoints the primary lacks (ℓ ℮ ŉ Ѫ Ƣ ∕) to THIS
  // face — BEFORE it reaches the declared `sans-serif`→Helvetica generic — so the
  // glyphs differ from what Domotion's declared-family walk picks. Routed in
  // resolveFontForCodepoint for the sf-pro primary case.
  "helvetica-neue":             { path: "/System/Library/Fonts/HelveticaNeue.ttc", postscriptName: "HelveticaNeue" },
  "helvetica-neue-bold":        { path: "/System/Library/Fonts/HelveticaNeue.ttc", postscriptName: "HelveticaNeue-Bold" },
  "helvetica-neue-italic":      { path: "/System/Library/Fonts/HelveticaNeue.ttc", postscriptName: "HelveticaNeue-Italic" },
  "helvetica-neue-bold-italic": { path: "/System/Library/Fonts/HelveticaNeue.ttc", postscriptName: "HelveticaNeue-BoldItalic" },
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
// DM-1404: mainstream desktop-Linux Noto install locations (fonts-noto-core /
// fonts-noto-cjk). Used by the Noto profile overlay below.
const NOTO = "/usr/share/fonts/truetype/noto";
const NOTO_CJK = "/usr/share/fonts/opentype/noto";

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
  // DM-1404: per-block routes for the desktop-Linux Noto profile, keys
  // namespaced `un-...` (vs the bare `u-...`) so the two never collide. Their
  // absolute paths only exist on a Noto host, so they no-op on the bare image
  // (resolveLinuxSpec checks existence). Emitted by `linuxNotoFallbackChain`
  // when `linuxFontProfile() === "noto"`.
  ...UNICODE_FONT_PATHS_NOTO_LINUX,
};

// DM-1404: desktop-Linux **Noto profile** primary-key overlay. The bare
// LINUX_FONT_PATHS above is calibrated to the Playwright `*-noble` image
// (Liberation sans/serif + WenQuanYi mono/CJK). A mainstream desktop-Linux host
// with the Noto family installed resolves the generic primaries to Noto instead
// — verified in the calibration env (tools/calibrate-linux-noto-profile.sh):
// `fc-match sans-serif/serif/monospace` → Noto Sans / Noto Serif / Noto Mono,
// and untagged CJK → NotoSansCJK (jp member). `resolveLinuxSpec` consults this
// overlay FIRST when `linuxFontProfile() === "noto"`; only keys that DIFFER from
// the bare table need entries. Per-block fallback for everything else flows
// through `UNICODE_FONT_PATHS_NOTO_LINUX` (the generated `un-...` table).
const LINUX_FONT_PATHS_NOTO: Record<string, LinuxFontPath> = (() => {
  const sans = (s: string): LinuxFontPath => ({ path: `${NOTO}/NotoSans-${s}.ttf` });
  const serif = (s: string): LinuxFontPath => ({ path: `${NOTO}/NotoSerif-${s}.ttf` });
  const mono: LinuxFontPath = { path: `${NOTO}/NotoMono-Regular.ttf` }; // fontconfig `monospace` pick; single weight
  const cjk: LinuxFontPath = { path: `${NOTO_CJK}/NotoSansCJK-Regular.ttc`, postscriptName: "NotoSansCJKjp-Regular" };
  const cjkBold: LinuxFontPath = { path: `${NOTO_CJK}/NotoSansCJK-Bold.ttc`, postscriptName: "NotoSansCJKjp-Bold" };
  const cjkSerif: LinuxFontPath = { path: `${NOTO_CJK}/NotoSerifCJK-Regular.ttc`, postscriptName: "NotoSerifCJKjp-Regular" };
  const t: Record<string, LinuxFontPath> = {};
  // sans-serif primaries → Noto Sans (Regular/Bold/Italic/BoldItalic).
  for (const k of ["sf-pro", "helvetica", "arial", "lucida-grande"]) {
    t[k] = sans("Regular"); t[`${k}-bold`] = sans("Bold");
    t[`${k}-italic`] = sans("Italic"); t[`${k}-bold-italic`] = sans("BoldItalic");
  }
  t["sf-pro-italic"] = sans("Italic");
  // serif primaries → Noto Serif.
  for (const k of ["times", "times-new-roman", "georgia"]) {
    t[k] = serif("Regular"); t[`${k}-bold`] = serif("Bold");
    t[`${k}-italic`] = serif("Italic"); t[`${k}-bold-italic`] = serif("BoldItalic");
  }
  // monospace primaries → Noto Mono (single weight — no italic/bold faces, like
  // the bare profile's WenQuanYi Mono collapse).
  for (const k of ["courier", "menlo", "monaco", "sf-mono"]) {
    t[k] = mono; t[`${k}-bold`] = mono; t[`${k}-italic`] = mono; t[`${k}-bold-italic`] = mono;
  }
  // CJK logical keys (used when CSS names a CJK family directly, e.g. PingFang
  // SC → `cjk`, Hiragino → `hiragino-jp`, Apple SD Gothic → `korean`).
  for (const k of ["cjk", "korean", "hiragino-jp", "hiragino-gb", "hiragino-sans"]) t[k] = cjk;
  t["cjk-bold"] = cjkBold;
  t["cjk-serif"] = cjkSerif;
  // FreeFont logical keys (bare profile's symbol/letterlike/math routes) → Noto Sans/Serif.
  t["free-sans"] = sans("Regular"); t["free-serif"] = serif("Regular");
  return t;
})();

// DM-1404: which Linux font profile is active — the bare Playwright-image set
// or a mainstream desktop Noto install. Detection follows fontconfig's ACTUAL
// pick for a Han codepoint (U+4E00): that is exactly what Chromium-on-this-host
// paints (both go through fontconfig), so the static routing matches Chromium by
// construction. Noto desktop → NotoSansCJK; bare image → WenQuanYi → "bare".
// `DOMOTION_LINUX_FONT_PROFILE=noto|bare` forces it (CI baseline agreement / tests).
// Memoized; `__resetLinuxFontProfileForTest()` clears it.
let _linuxFontProfile: "noto" | "bare" | null = null;
function linuxFontProfile(): "noto" | "bare" {
  if (_linuxFontProfile != null) return _linuxFontProfile;
  const forced = process.env.DOMOTION_LINUX_FONT_PROFILE;
  if (forced === "noto" || forced === "bare") return (_linuxFontProfile = forced);
  const m = fcMatch("sans-serif:charset=4e00");
  return (_linuxFontProfile = (m != null && /noto/i.test(m.path)) ? "noto" : "bare");
}
/** Test-only: clear the memoized Linux font profile (DM-1404). */
export function __resetLinuxFontProfileForTest(): void { _linuxFontProfile = null; }
/** Test-only: read the detected Linux font profile (DM-1404). */
export function __linuxFontProfileForTest(): "noto" | "bare" { return linuxFontProfile(); }

// Windows system fonts live in %WINDIR%\Fonts (almost always C:\Windows\Fonts).
// Paths are stable across Windows 10/11, so unlike Linux we hardcode filenames
// and check existence rather than shelling out. Generic mappings follow
// Chromium-on-Windows defaults (sans → Arial, serif → Times New Roman, mono →
// Courier New); CJK / symbol / math / Indic route to the DirectWrite system
// faces. Exact per-block calibration is DM-260.
const WINDOWS_FONTS_DIR = `${process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows"}\\Fonts`;
export function win(file: string, postscriptName?: string): FontPath {
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
  // DM-1404: on a desktop Noto host, the primary-key overlay wins for the keys
  // that differ from the bare image (sans/serif/mono primaries + CJK). Only when
  // the overlay's on-disk file actually exists; otherwise fall through so a host
  // with a partial Noto install still resolves via the bare table / fc-match.
  if (linuxFontProfile() === "noto") {
    const noto = LINUX_FONT_PATHS_NOTO[key];
    if (noto != null && noto.path != null && existsSync(noto.path)) {
      return { path: noto.path, postscriptName: noto.postscriptName, extractor: noto.extractor };
    }
  }
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
function registerDynamicSystemFont(
  key: string, path: string, postscriptName: string,
  extractor: "fontkit" | "native" = "native",
): void {
  if (dynamicSystemFontPaths.has(key)) return;
  dynamicSystemFontPaths.set(key, { path, postscriptName, extractor });
  resolvedSpecCache.delete(key); // in case a prior null was cached
}

export function resolveFontSpec(key: string): FontPath | null {
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

// DM-1018: gate for the per-codepoint live system-fallback resolution. Each
// first-seen uncovered codepoint costs one resolver round-trip (memoized after).
// Worth it for blocks where a real system font exists that the sampled per-block
// table missed (macOS: Kana Supplement → Mplus 1p; Linux: any covering face the
// generated table's block-level route lacks at the codepoint level).
//
// macOS: CoreText `CTFontCreateForString` (always on; auto-off when the helper
// binary isn't present).
//
// Linux: fontconfig `fc-match :charset` (DM-1403). Default-ON as of DM-1416 —
// calibrated against Chromium-on-noble paint (tools/scratch probe-1416), which
// proved every fc-match-vs-Chromium divergence is harmless: non-covering picks
// are rejected by the coverage guard (→ tofu, matching Chromium), covered picks
// duplicate the static chain (so the resolver never fires there), and the only
// "glyph where Chromium tofus" cases are orphaned variation selectors already
// stripped upstream by `stripOrphanedDefaultIgnorables` (DM-1158). Set
// `DOMOTION_SYSTEM_FALLBACK=0` to force it off (e.g. to reproduce the pre-flip
// bare-table baseline).
//
// Windows: DirectWrite `IDWriteFontFallback::MapCharacters` via the win32 glyph
// helper (DM-1403), default-on as of DM-1424 (set `DOMOTION_SYSTEM_FALLBACK=0` to
// force off). Calibrated against Chromium-on-Windows paint on the desktop Win11
// VM (tools/probe-1424-win32-mapchars-vs-chromium.mjs + probe-1424-refine.mts):
// of 4,899 sampled codepoints, every MapCharacters-vs-Chromium divergence is on a
// codepoint the static win32 chain already owns (resolver never fires there), so
// 0 sampled codepoints move under the flip. When the resolver DOES fire (a cp the
// static table misses) it calls the exact DirectWrite system-fallback API Chromium
// uses (`FontFallback::MapCharacters`, font_fallback_win.cc) with the helper's
// HasCharacter coverage guard — so it can only paint Chromium's own covering face
// or correctly tofu. See docs/80.
let _systemFallbackResolutionEnabled =
  process.platform === "darwin"
  || (process.platform === "linux" && process.env.DOMOTION_SYSTEM_FALLBACK !== "0")
  || (process.platform === "win32" && process.env.DOMOTION_SYSTEM_FALLBACK !== "0");
/**
 * Test/perf hook to toggle the CoreText per-codepoint fallback resolver. This is
 * a PROCESS-GLOBAL: a caller that flips it without restoring silently changes
 * the fallback behavior of every later render in the same process. For a
 * temporary toggle around one render, prefer `withSystemFallbackResolution()`
 * (guaranteed save/restore) over a bare `set` (DM-1350).
 */
export function setSystemFallbackResolution(on: boolean): void { _systemFallbackResolutionEnabled = on; }
/** Read the current process-global toggle (so callers can save/restore it). */
export function getSystemFallbackResolution(): boolean { return _systemFallbackResolutionEnabled; }
/**
 * Run `fn` with the CoreText per-codepoint fallback resolver toggled to `on`,
 * restoring the prior value afterward — even if `fn` throws. Use this instead of
 * a bare `setSystemFallbackResolution(...)` for a temporary toggle so the change
 * can't leak into the next render in the same process (DM-1350). Synchronous:
 * scopes a synchronous render — the resolver runs during synchronous text
 * emission, so the toggle only needs to hold for `fn`'s synchronous duration.
 */
export function withSystemFallbackResolution<T>(on: boolean, fn: () => T): T {
  const prev = _systemFallbackResolutionEnabled;
  _systemFallbackResolutionEnabled = on;
  try {
    return fn();
  } finally {
    _systemFallbackResolutionEnabled = prev;
  }
}

/**
 * Resolve the system fallback font for a codepoint the way the browser does,
 * per platform: macOS via CoreText `CTFontCreateForString` (the native
 * `resolveSystemFallbackFonts` helper); Linux via fontconfig `fc-match :charset`
 * (DM-1403/DM-1416). Registers the resolved on-disk font as a dynamic
 * `sysfb:<postscriptName>` key and returns it, so the chain walker can open it
 * through the normal `getFontInstance` path. Returns null when the platform
 * engine resolves to LastResort / a non-covering default (keep `last-resort`),
 * or the backend isn't available. Windows uses DirectWrite
 * `IDWriteFontFallback::MapCharacters` via the win32 helper (DM-1403, calibrated +
 * default-on in DM-1424).
 */
function resolveSystemFallbackKeyForCp(cp: number): string | null {
  if (systemFallbackKeyCache.has(cp)) return systemFallbackKeyCache.get(cp)!;
  let key: string | null = null;
  try {
    if (process.platform === "darwin") {
      // CoreText CTFontCreateForString via the native helper (always on).
      const resolved = resolveSystemFallbackFonts([cp]).get(cp);
      if (resolved != null && resolved.path !== "") {
        key = `sysfb:${resolved.postscriptName}`;
        registerDynamicSystemFont(key, resolved.path, resolved.postscriptName);
      }
    } else if (process.platform === "linux") {
      // DM-1403/DM-1416: fontconfig live fallback for Linux, default-on (gated
      // by `_systemFallbackResolutionEnabled`, which honors DOMOTION_SYSTEM_FALLBACK=0).
      // Calibrated against Chromium-on-noble paint — see the flag comment above
      // and docs/80.
      key = resolveLinuxSystemFallbackKeyForCp(cp);
    } else if (process.platform === "win32") {
      // DM-1403: DirectWrite IDWriteFontFallback::MapCharacters via the win32
      // glyph helper. The helper speaks the same platform-agnostic "fallback"
      // protocol as the macOS CoreText helper, so `resolveSystemFallbackFonts`
      // drives it directly; register the substitute face as a `sysfb:` key with
      // the native (helper) extractor, like darwin. The helper's HasCharacter
      // coverage guard reports found:false for a non-covering pick, so a face only
      // registers when it actually covers `cp`. Default-on (DM-1424); the flag
      // honors DOMOTION_SYSTEM_FALLBACK=0.
      const resolved = resolveSystemFallbackFonts([cp]).get(cp);
      if (resolved != null && resolved.path !== "") {
        key = `sysfb:${resolved.postscriptName}`;
        registerDynamicSystemFont(key, resolved.path, resolved.postscriptName);
      }
    }
  } catch { key = null; }
  systemFallbackKeyCache.set(cp, key);
  return key;
}

/**
 * DM-1403: fontconfig live system-fallback for a codepoint the static Linux
 * table (`LINUX_FONT_PATHS`) misses — the analogue of the darwin CoreText
 * resolver. `fc-match :charset=<hex>` returns the best-priority installed font
 * whose charset covers `cp`; register it as a `sysfb:` key (fontkit-extracted,
 * like the rest of the Linux chain) so the chain walker opens it through the
 * normal path. Returns null when fontconfig finds nothing (→ the codepoint
 * falls through to LastResort tofu, unchanged from before).
 *
 * DM-1416 (coverage guard): `fc-match :charset` ALWAYS returns a font — when
 * nothing actually covers `cp` it returns fontconfig's default face (e.g. it
 * returns WenQuanYi Zen Hei for U+17000 Tangut, which WenQuanYi does not
 * contain). The empirical Chromium-on-noble calibration (tools/scratch
 * probe-1416) showed this is by far the dominant divergence between fc-match's
 * pick and Chromium's painted family: ~91% of divergences are exactly this
 * non-covering default, and the chain walker already drops them to tofu — which
 * matches Chromium, since Chromium also tofus those codepoints. So we verify the
 * matched font genuinely covers `cp` (`glyphForCodePoint(cp).id !== 0`) before
 * registering it; a non-covering pick returns null (→ tofu, as before) rather
 * than registering a face that would only be rejected downstream. Net effect:
 * the resolver registers ONLY covering faces (doc 80, calibration step 3).
 */
function resolveLinuxSystemFallbackKeyForCp(cp: number): string | null {
  const matched = fcMatch(`:charset=${cp.toString(16)}`);
  if (matched == null) return null;
  // Coverage guard (DM-1416): fc-match returns a default even when nothing
  // covers cp; only register a face that actually has a glyph for it.
  if (!fontFileCoversCodepoint(matched.path, matched.postscriptName, cp)) return null;
  const name = matched.postscriptName ?? matched.path.split("/").pop() ?? "fallback";
  const key = `sysfb:${name}`;
  registerDynamicSystemFont(key, matched.path, matched.postscriptName ?? name, "fontkit");
  return key;
}

// DM-1416: does the on-disk font at `path` (TTC member `postscriptName`) contain
// a real glyph for `cp`? Used by the Linux live system-fallback resolver to
// reject fc-match's non-covering default picks. Mirrors the TTC member-selection
// logic in `getFontInstance`. Cheap + cached: fontkit memoizes opened files, and
// resolver results are memoized per codepoint by the caller.
function fontFileCoversCodepoint(path: string, postscriptName: string | undefined, cp: number): boolean {
  try {
    const opened: any = fontkit.openSync(path);
    let font: any = opened;
    if (opened != null && Array.isArray(opened.fonts)) {
      font = (postscriptName != null && opened.getFont != null)
        ? (opened.getFont(postscriptName) ?? opened.fonts[0])
        : opened.fonts[0];
    }
    return font != null && typeof font.glyphForCodePoint === "function"
      && font.glyphForCodePoint(cp).id !== 0;
  } catch {
    return false;
  }
}

/** Test-only: drive the per-codepoint live system-fallback resolver directly
 *  (DM-1403). Honors the platform routing + the `DOMOTION_SYSTEM_FALLBACK`
 *  opt-in, so a Linux/Docker probe can confirm fontconfig resolution end to end. */
export function __resolveSystemFallbackKeyForCpForTest(cp: number): string | null {
  return resolveSystemFallbackKeyForCp(cp);
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
 * Shared Unicode script-block boundaries for the platform fallback chains.
 *
 * `darwinFallbackChain` / `linuxFallbackChain` / `win32FallbackChain` are three
 * parallel routers over the SAME Unicode ranges; only the font KEY chosen per
 * block legitimately differs per platform (CoreText vs fontconfig vs
 * DirectWrite). The boundaries themselves used to be copy-pasted into all three
 * — so they could silently drift apart, and the range (not the key) is what
 * decides which script a codepoint routes as, making any drift a cross-platform
 * correctness bug. Defining each block ONCE here keeps the three chains in
 * lockstep on WHERE a script starts/ends while leaving each free to pick its
 * own per-block keys. Granularity is the individual Unicode block so the darwin
 * chain (which groups several blocks into one branch) can compose them; every
 * range below is byte-for-byte the boundary the chains previously inlined.
 */
const isHebrewBlock = (cp: number): boolean =>
  (cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0xFB1D && cp <= 0xFB4F);
const isArabicBlock = (cp: number): boolean =>
  (cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF);
const isDevanagariBlock = (cp: number): boolean => cp >= 0x0900 && cp <= 0x097F;
const isThaiBlock = (cp: number): boolean => cp >= 0x0E00 && cp <= 0x0E7F;
const isHangulBlock = (cp: number): boolean =>
  (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0x1100 && cp <= 0x11FF);
// CJK in the BMP: Symbols & Punctuation, Hiragana, Katakana (+ phonetic exts),
// Unified Ideographs + Ext A, and Compatibility Ideographs. (Hangul is its own
// block above; the supplementary-plane CJK extensions are darwin-only.)
const isCjkBmpBlock = (cp: number): boolean =>
  (cp >= 0x3000 && cp <= 0x303F) || (cp >= 0x3040 && cp <= 0x309F)
  || (cp >= 0x30A0 && cp <= 0x30FF) || (cp >= 0x31F0 && cp <= 0x31FF)
  || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF)
  || (cp >= 0xF900 && cp <= 0xFAFF);
const isBoxDrawingBlock = (cp: number): boolean => cp >= 0x2500 && cp <= 0x259F;
const isDingbatsBlock = (cp: number): boolean => cp >= 0x2700 && cp <= 0x27BF;
const isMathAlphanumericBlock = (cp: number): boolean => cp >= 0x1D400 && cp <= 0x1D7FF;
const isSuperSubscriptBlock = (cp: number): boolean => cp >= 0x2070 && cp <= 0x209F;
const isLetterlikeBlock = (cp: number): boolean => cp >= 0x2100 && cp <= 0x214F;
const isMathOperatorsBlock = (cp: number): boolean => cp >= 0x2200 && cp <= 0x22FF;
// Pictograph residue not caught by the color-emoji raster path (doc 15):
// Misc Symbols & Pictographs + Transport & Map Symbols.
const isPictographResidueBlock = (cp: number): boolean =>
  (cp >= 0x1F300 && cp <= 0x1F5FF) || (cp >= 0x1F680 && cp <= 0x1F6FF);

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
  // DM-1404: on a mainstream desktop Noto host, route through the Noto-calibrated
  // per-block table instead of the bare image's WenQuanYi/FreeFont routes.
  if (linuxFontProfile() === "noto") return linuxNotoFallbackChain(codepoint);
  const cp = codepoint;
  // Hebrew — Liberation Sans covers it, so route to the sans key (probe: hebrew
  // → Liberation Sans, i.e. the primary itself when sans-serif).
  if (isHebrewBlock(cp)) return ["helvetica"];
  // Arabic core + presentation forms — FreeSerif (probe: arabic → FreeSerif).
  if (isArabicBlock(cp)) {
    return ["sf-arabic"]; // → FreeSerif on Linux
  }
  // Devanagari — FreeSans (probe: devanagari → FreeSans).
  if (isDevanagariBlock(cp)) return ["devanagari"]; // → FreeSans
  // Thai — Loma (probe: thai → Loma).
  if (isThaiBlock(cp)) return ["thai"];
  // Hangul — WenQuanYi Zen Hei (probe: hangul → WenQuanYi).
  if (isHangulBlock(cp)) return ["cjk"];
  // Box Drawing / Block — mono primary keeps the primary (WenQuanYi Zen Hei
  // Mono covers them at cell width); non-mono falls to Liberation Sans, then CJK
  // (probe: box-drawing mono → WQY Mono; box-drawing-sans → Liberation Sans).
  if (isBoxDrawingBlock(cp)) {
    const monoPrimary = primaryKey === "courier" || primaryKey === "menlo"
      || primaryKey === "monaco" || primaryKey === "sf-mono";
    return monoPrimary ? [primaryKey!, "cjk"] : ["helvetica", "cjk"];
  }
  // Dingbats — FreeSans (probe: ✂✈❤ → FreeSans).
  if (isDingbatsBlock(cp)) return ["free-sans", "free-serif"];
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
  if (isMathAlphanumericBlock(cp)) return ["free-sans", "free-serif"];
  // Superscripts / Subscripts — Liberation Sans + FreeSans (probe: aₙ₁).
  if (isSuperSubscriptBlock(cp)) return ["helvetica", "free-sans"];
  // Letterlike + Math Operators — FreeSans first, then Liberation Sans (probe:
  // ℝ™ℕℤ → FreeSans + Liberation Sans; ∑∫≠ is covered by the Liberation Sans primary).
  if (isLetterlikeBlock(cp) || isMathOperatorsBlock(cp)) return ["free-sans", "helvetica"];
  // CJK Han / Kana / CJK Symbols & Punctuation — WenQuanYi Zen Hei (probe:
  // 漢字/あ/ア → WenQuanYi). Japanese-tagged text prefers IPAGothic; left as a
  // refinement (untagged probe resolved to WenQuanYi). DM-259 follow-up.
  if (isCjkBmpBlock(cp)) {
    return ["cjk"];
  }
  // Pictographs / Transport residue not caught by the color-emoji raster path
  // (doc 15) — FreeSans as a monochrome last resort.
  if (isPictographResidueBlock(cp)) return ["free-sans"];
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
/**
 * Binary-search a sorted `[start, end, key]` range table for the key whose range
 * contains `codepoint`, or null. Shared by the per-platform generated
 * unicode-font-range lookups below (they differ only by the table). DM-1434.
 */
function binarySearchRange(
  table: ReadonlyArray<readonly [number, number, string]>,
  codepoint: number,
): string | null {
  let lo = 0;
  let hi = table.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = table[mid]!;
    if (codepoint < r[0]) hi = mid - 1;
    else if (codepoint > r[1]) lo = mid + 1;
    else return r[2];
  }
  return null;
}

function lookupLinuxUnicodeFontRange(codepoint: number): string | null {
  return binarySearchRange(UNICODE_FONT_RANGES_LINUX, codepoint);
}

/**
 * DM-1404: Linux fallback chain for the desktop **Noto profile**. The generated
 * `UNICODE_FONT_RANGES_NOTO_LINUX` table is the full per-block calibration of
 * what Chromium-on-a-Noto-desktop paints (one face per block), so — unlike the
 * bare chain's hand-tuned WenQuanYi/FreeFont routes — the Noto chain just
 * consults that table. The caller has already tried the primary; the DM-1416
 * live `fc-match :charset` resolver is the net after this for any per-codepoint
 * miss the block-level route lacks. Keys are the generated `un-...` ones.
 */
function linuxNotoFallbackChain(codepoint: number): string[] {
  const key = lookupNotoLinuxUnicodeFontRange(codepoint);
  return key != null ? [key] : [];
}

/** Binary-search the generated `UNICODE_FONT_RANGES_NOTO_LINUX` for a codepoint. */
function lookupNotoLinuxUnicodeFontRange(codepoint: number): string | null {
  return binarySearchRange(UNICODE_FONT_RANGES_NOTO_LINUX, codepoint);
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
export function win32FallbackChain(codepoint: number, primaryKey?: string, lang?: string): string[] {
  const cp = codepoint;
  // Hebrew — Segoe UI covers it.
  if (isHebrewBlock(cp)) return ["sf-hebrew"];
  // Arabic core + presentation forms — Segoe UI.
  if (isArabicBlock(cp)) {
    return ["sf-arabic"];
  }
  // Devanagari — Nirmala UI.
  if (isDevanagariBlock(cp)) return ["devanagari"];
  // Thai — Tahoma (painted-font probe DM-836 confirms Chromium falls back to
  // Tahoma under sans-serif), Leelawadee UI as a secondary.
  if (isThaiBlock(cp)) return ["tahoma", "thai"];
  // Hangul — Malgun Gothic (painted-font probe confirmed); YaHei last resort.
  if (isHangulBlock(cp)) return ["korean", "cjk"];
  // Math Alphanumeric — Cambria Math carries the whole block; the
  // `mathAlphaToBase` decomposition handles any residue.
  if (isMathAlphanumericBlock(cp)) return ["stix-math", "helvetica"];
  // CJK Han / Kana / CJK Symbols & Punctuation. Serif primary → SimSun;
  // Japanese-tagged → Yu Gothic; otherwise Microsoft YaHei.
  if (isCjkBmpBlock(cp)) {
    const serifPrimary = primaryKey === "times" || primaryKey === "times-new-roman" || primaryKey === "georgia";
    if (serifPrimary) return ["cjk-serif", "cjk"];
    if (lang != null && /^ja\b/i.test(lang)) return ["hiragino-jp", "cjk"];
    return ["cjk"];
  }
  // Box Drawing / Block Elements — mono primary keeps its own cell-width glyphs
  // (Consolas), then Consolas as a safety net; non-mono falls to Arial (the
  // probe paints `─ ┼ ┬` at Arial's width for sans-serif).
  if (isBoxDrawingBlock(cp)) {
    const monoPrimary = primaryKey === "courier" || primaryKey === "menlo"
      || primaryKey === "monaco" || primaryKey === "sf-mono";
    return monoPrimary ? [primaryKey!, "sf-mono"] : ["helvetica", "symbols"];
  }
  // Dingbats — Arial lacks most; Segoe UI Symbol covers them.
  if (isDingbatsBlock(cp)) return ["symbols"];
  // Geometric Shapes / Misc Symbols / Arrows — Arial covers the common ones
  // (probe: ■ ● ◆ ★ ✒ ← → at Arial's width); Segoe UI Symbol for the residue.
  if ((cp >= 0x2190 && cp <= 0x21FF) || (cp >= 0x25A0 && cp <= 0x25FF) || (cp >= 0x2600 && cp <= 0x26FF)) {
    return ["helvetica", "symbols"];
  }
  // Superscripts / Subscripts, Letterlike, Math Operators — Arial carries the
  // common members (probe: ∑ ∏ ≠ ∫ at Arial's width); Cambria Math for the rest.
  if (isSuperSubscriptBlock(cp)) return ["helvetica"];
  if (isLetterlikeBlock(cp) || isMathOperatorsBlock(cp)) return ["helvetica", "stix-math"];
  // Pictographs not caught by the color-emoji raster path — Segoe UI Symbol
  // monochrome as a last resort.
  if (isPictographResidueBlock(cp)) return ["symbols"];
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
  return binarySearchRange(UNICODE_FONT_RANGES_WIN32, codepoint);
}

export function fallbackFontChain(codepoint: number, primaryKey?: string, lang?: string): string[] {
  // Platform-aware routing (DM-259 / DM-260). Each platform's Chromium cascades
  // through entirely different faces (CoreText vs fontconfig vs DirectWrite), so
  // each has its own empirically-probed chain.
  if (process.platform === "linux") return linuxFallbackChain(codepoint, primaryKey, lang);
  if (process.platform === "win32") return win32FallbackChain(codepoint, primaryKey, lang);
  return darwinFallbackChain(codepoint, primaryKey, lang);
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
  if (isHebrewBlock(codepoint)) {
    return ["lucida-grande", "sf-hebrew"];
  }
  // Arabic core block + presentation forms A and B.
  if (isArabicBlock(codepoint)) {
    return ["sf-arabic"];
  }
  // Devanagari (U+0900..097F).
  if (isDevanagariBlock(codepoint)) return ["devanagari"];
  // Thai (U+0E00..0E7F).
  if (isThaiBlock(codepoint)) return ["thai"];
  // Hangul (Korean) — Syllables + Jamo. Route to Apple SD Gothic Neo FIRST
  // because Hiragino Sans GB and PingFang SC don't carry Hangul codepoints;
  // without this branch Korean text falls all the way through to tofu
  // boxes. Keep `cjk` as a final fallback for the rare codepoint Apple SD
  // Gothic Neo lacks. DM-691.
  if (isHangulBlock(codepoint)) {
    return ["korean", "cjk"];
  }
  // CJK: Unified Ideographs + Ext A, Hiragana, Katakana (+ phonetic exts),
  // CJK Symbols & Punctuation. Hangul is handled above.
  if (isCjkBmpBlock(codepoint)) {
    // DM-1174: U+302A–U+302F are combining CJK/Hangul tone marks that Hiragino
    // Sans GB (our `cjk`) does NOT carry. Chrome falls to Arial Unicode MS, which
    // has them AND U+25CC, and lays the orphaned `◌ + mark` cluster as a SPACING
    // glyph to the RIGHT of the dotted circle (verified against Chrome's painted
    // output). Without an Arial-Unicode fallback the chain finds no coverage and
    // the orphaned mark drops to the per-char centering path, which stacked the
    // mark ON the ◌ — the "soccer ball". Routing them here lets the DM-1215
    // dotted-circle HarfBuzz path resolve coverage and reproduce Chrome's spacing
    // layout. (`cjk` stays first so a future Hiragino that gains them still wins.)
    if (codepoint >= 0x302A && codepoint <= 0x302F) return ["cjk", "u-arial-unicode-ms"];
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
  if (isBoxDrawingBlock(codepoint)) {
    const monoPrimary = primaryKey === "courier" || primaryKey === "menlo"
      || primaryKey === "monaco" || primaryKey === "sf-mono";
    if (monoPrimary) return [primaryKey, "menlo", "hiragino-jp"];
    return ["hiragino-jp", "menlo"];
  }
  // Dingbats → Zapf Dingbats. macOS Chrome paints ✂✈✏✔✘✚✦❄❤❶ via Zapf
  // Dingbats; Apple Symbols has the same codepoints but at different (often
  // narrower) widths — empirical match shows Chrome consistently picks Zapf.
  if (isDingbatsBlock(codepoint)) return ["zapf-dingbats", "symbols"];
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
  if (isMathAlphanumericBlock(codepoint)) {
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
  if (isSuperSubscriptBlock(codepoint)) {
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
  // DM-1203: U+2215 DIVISION SLASH is an exception inside the math-operators
  // range below. On an SF-Pro / system-ui primary (which lacks it) Chrome
  // resolves it to Helvetica Neue via CTFontCreateForString, NOT Apple Symbols
  // — Apple Symbols' slash sits higher and farther right than Chrome's painted
  // glyph. Returning [] here drops it through to the CoreText system fallback
  // (`resolveSystemFallbackKeyForCp`), which runs the same CTFontCreateForString
  // and lands on the identical Helvetica Neue glyph. (The neighbouring division
  // operators ∕-adjacent that Apple Symbols DOES match stay on the symbols rule.)
  if (codepoint === 0x2215) return [];
  if (isLetterlikeBlock(codepoint)
    || (codepoint >= 0x2190 && codepoint <= 0x21FF)   // Arrows residue
    || isMathOperatorsBlock(codepoint)
    || (codepoint >= 0x2300 && codepoint <= 0x23FF)   // Misc Technical
    || isPictographResidueBlock(codepoint)) {
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
  return binarySearchRange(UNICODE_FONT_RANGES, codepoint);
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
export function isPrivateUseCodepoint(cp: number): boolean {
  // BMP PUA
  if (cp >= 0xE000 && cp <= 0xF8FF) return true;
  // Supplementary PUA-A
  if (cp >= 0xF0000 && cp <= 0xFFFFD) return true;
  // Supplementary PUA-B
  if (cp >= 0x100000 && cp <= 0x10FFFD) return true;
  return false;
}

export function isEmojiCodepoint(cp: number, nextCp: number): boolean {
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

export function getFontInstance(key: string, weight: number, fontSize: number, slant: number = 0, variationSettings?: Record<string, number>): FontInstance | null {
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
  if (key === "helvetica" || key === "helvetica-neue" || key === "arial" || key === "courier" || key === "menlo"
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

export type PathCommand = { command: string; args: number[] };

/** Minimal fontkit `Glyph` shape the renderer reads (DM-1067) — keeps `any` off
 *  the exported `commandsFor` signature without depending on fontkit's full type. */
type FontkitGlyph = { id: number; path?: { commands: PathCommand[] }; codePoints?: number[]; advanceWidth?: number };

/** Records which on-disk file each fontkit instance was loaded from (populated
 *  in getFontInstance). Helper instances + webfonts are absent → no fallback. */
const fontSourceMap = new WeakMap<object, { path: string; postscriptName?: string }>();
const helperFontCache = new Map<string, FontInstance | null>();       // path → helper instance | null
const helperOutlineCache = new Map<string, PathCommand[] | null>();   // `${path}#${id}` → commands | null


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
    // DM-1189 / DM-1199 / DM-1196 / DM-1183: `Helvetica Neue` is its OWN face,
    // NOT plain Helvetica. Verified with Chrome's `getPlatformFontsForNode`:
    // `font-family: 'Helvetica Neue'` paints from Helvetica Neue (HelveticaNeue.ttc),
    // while `sans-serif`/`Helvetica` paint from Helvetica (Helvetica.ttc). The two
    // differ (e.g. the bold U+212E ℮, the script U+2113 ℓ, archaic Latin/Cyrillic),
    // so collapsing them lost those glyphs. Map it to its own key.
    if (name === "helvetica neue" || name === "helveticaneue") return "helvetica-neue";
    // Chrome on macOS resolves the generic `sans-serif` keyword (and a literal
    // `Helvetica`) to Helvetica (Blink: font_cache_mac.mm + font_fallback_list.cc
    // — the generic is hardcoded to Helvetica on macOS, not SF Pro). Matching this
    // exactly is critical: SF Pro has different glyph shapes (notably the `1`, `R`,
    // `g`) and ~2% wider metrics than Helvetica at the same em size, so substituting
    // it produces visible drift on every page that uses the default sans-serif.
    if (name === "sans-serif" || name === "helvetica") return "helvetica";
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
        // DM-1267: extract via fontkit (not the default native CoreText helper)
        // so the OTF's GSUB survives — `font-feature-settings` (e.g. Apple's
        // `sup.footnote { "numr" }` footnote superscripts, mapped to `sups`) needs
        // the feature lookups, which the native per-glyph extractor strips. SF Pro
        // Text/Display are clean OTFs fontkit reads cleanly (no hvgl / GSUB-crash).
        registerDynamicSystemFont(key, cut.path, cut.postscriptName, "fontkit");
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
export function opticalCutOpszFor(fontFamily: string): number | null {
  for (const name of splitFontFamilyNames(fontFamily)) {
    if (matchFamilyNameToKey(name) == null) continue; // unrecognized — skip, like resolveFontKey
    return name in OPTICAL_CUT_OPSZ ? OPTICAL_CUT_OPSZ[name] : null;
  }
  return null;
}

export function resolveFont(fontFamily: string, fontWeight: number, fontSize: number, slant: number = 0, variationSettings?: Record<string, number>): FontInstance | null {
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

export function ensureGlyphDef(
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

/**
 * Count of glyph defs registered so far. Paired with `getGlyphDefsSince` to emit
 * ONLY the glyphs a bounded region of a render produced. The animator's typing
 * overlay (DM-1557) renders glyph paths late — after the frames it's layered
 * onto were already rendered — and must splice just its own glyph defs into the
 * top-level `<defs>` without re-emitting (and thus duplicating the ids of) the
 * frames' glyphs. Snapshot the count before rendering the overlay, then emit
 * `getGlyphDefsSince(snapshot)`.
 */
export function glyphDefCount(): number {
  return glyphDefs.size;
}

/**
 * SVG `<path>` defs registered AFTER the `startCount`-th (i.e. those with
 * insertion index ≥ `startCount`). The registry is append-only between
 * `clearGlyphDefs()` calls and ids are assigned sequentially, so slicing the
 * insertion-ordered values by count returns exactly the newly-added defs. See
 * `glyphDefCount`.
 */
export function getGlyphDefsSince(startCount: number): string {
  return [...glyphDefs.values()].slice(startCount).join("");
}

/**
 * Clear the `paths`-mode glyph registry. Producers call this once per top-level
 * generation, alongside `clearEmbeddedFonts()` (DM-1338), so the module-global
 * `<path id="gN">` defs don't accumulate across back-to-back renders. No-op in
 * the default `embedded-font` mode, where the registry is never populated.
 */
export function clearGlyphDefs(): void {
  glyphDefs.clear();
  glyphKeyToId.clear();
  glyphIdCounter = 0;
}

/**
 * Roll the registry back to a `glyphDefCount()` snapshot — dropping every def
 * registered after it and resetting the id counter. A producer that emits a
 * BOUNDED region's glyph defs and wants to leave the registry exactly as it
 * found it uses this (DM-1557: the animator emits its typing-overlay glyphs into
 * the top-level `<defs>`, then restores, so a second `generateAnimatedSvg` call
 * in the same process re-assigns the SAME ids — byte-stable output — instead of
 * drifting the global counter). No-op when `count` is at or past the current
 * count.
 */
export function truncateGlyphDefs(count: number): void {
  if (glyphIdCounter <= count) return;
  for (let i = count; i < glyphIdCounter; i++) glyphDefs.delete(`g${i}`);
  for (const [k, v] of glyphKeyToId) {
    if (parseInt(v.slice(1), 10) >= count) glyphKeyToId.delete(k);
  }
  glyphIdCounter = count;
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

export function resolveDottedCircleHbRun(
  markCp: number,
  primaryFont: FontInstance, primaryFontKey: string,
  weight: number, fontSize: number, slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined, fontKeyChain: string[],
): { key: string; font: FontInstance } | null {
  // DM-1215 + DM-1197: do NOT reroute marks belonging to a DEDICATED HarfBuzz
  // shaper (Indic / Thai-Lao / Tibetan / Myanmar / Khmer / Arabic / Hebrew /
  // Hangul). harfbuzzjs's dedicated-shaper output can itself diverge from Chrome's
  // paint (the same reason DM-1197 excludes `DEDICATED_SHAPER_RANGES`), so routing
  // their orphaned marks through HarfBuzz regressed sinhala / lao / tibetan /
  // myanmar (CI-verified).
  //
  // DM-1160: Vedic Extensions marks (U+1CD0–1CFF) are NOT in a dedicated-shaper
  // range and were previously excluded here on the assumption CoreText already
  // matched Chrome. It does not — the orphaned vedic marks (rendered on a ◌ via
  // Mukta, which both Chrome and we use) sat ~1–2px off Chrome's HarfBuzz GPOS
  // placement. Routing them through HarfBuzz+Mukta (same engine + font as Chrome)
  // makes the `1CD0-1CFF-vedic-extensions` fixture pixel-clean; the
  // devanagari / sinhala / tibetan / brahmi / devanagari-extended fixtures stay
  // green (they're caught by `usesDedicatedShaper`, untouched by this change).
  if (usesDedicatedShaper(markCp)) return null;
  const r = resolveFontForCodepoint(markCp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
  if (!r.covered) return null;
  const markKey = r.key;
  const markFont = r.fontOverride ?? (markKey === primaryFontKey ? primaryFont : getFontInstance(markKey, weight, fontSize, slant));
  if (markFont == null) return null;
  if (markFont.glyphForCodePoint(0x25CC).id === 0) return null; // ◌ must come from the mark's font, like Chrome
  const path = resolveFontSpec(markKey)?.path;
  if (path == null || path === "") return null;
  const hbInst = makeHarfbuzzShapingInstance(markFont, path);
  if (hbInst === markFont) return null; // HarfBuzz couldn't open the file
  return { key: markKey, font: hbInst };
}

const HALT_INFO_CACHE = new Map<string, { halved: boolean; xOffset: number }>();
export function haltInfoFor(font: FontInstance, fontKey: string, cp: number): { halved: boolean; xOffset: number } {
  const key = `${fontKey}|${cp}`;
  const hit = HALT_INFO_CACHE.get(key);
  if (hit !== undefined) return hit;
  let info = { halved: false, xOffset: 0 };
  try {
    const ch = String.fromCodePoint(cp);
    const def = font.layout(ch);
    const halt = font.layout(ch, ["halt"]);
    if (def.positions.length === 1 && halt.positions.length === 1
        && def.glyphs[0]?.id === halt.glyphs[0]?.id) {
      const dAdv = def.positions[0].xAdvance;
      const hAdv = halt.positions[0].xAdvance;
      // `halt` must genuinely narrow this glyph (it has a half-width alternate)
      // while keeping the SAME outline (pure GPOS) — otherwise it isn't the
      // fullwidth-punctuation trim case and we leave the glyph alone.
      if (hAdv > 0 && dAdv > 0 && hAdv <= dAdv * 0.6) {
        info = { halved: true, xOffset: halt.positions[0].xOffset };
      }
    }
  } catch { /* leave default (not halt-able) */ }
  HALT_INFO_CACHE.set(key, info);
  return info;
}


// Ink x-extent (font units) of a glyph from its outline commands. Used as the
// fallback opening-vs-closing classifier when a font instance can't report its
// `halt` adjustment.
export function glyphInkXRange(glyph: { path?: { commands: Array<{ command: string; args: number[] }> } }): { min: number; max: number } | null {
  const cmds = glyph.path?.commands;
  if (cmds == null || cmds.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const c of cmds) {
    const a = c.args;
    // Path command args interleave (x, y); x is at every even index.
    for (let k = 0; k < a.length; k += 2) {
      const xv = a[k];
      if (xv < min) min = xv;
      if (xv > max) max = xv;
    }
  }
  if (!isFinite(min) || !isFinite(max)) return null;
  return { min, max };
}

export function codepointResolvesToNotdef(
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
export function resolveFontForCodepoint(
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

  // DM-1197: complex-script letters with a canonical base+mark NFD (e.g. Kaithi
  // U+110AB VA) shape DIFFERENTLY in Chrome (HarfBuzz decomposes + GPOS-positions
  // the nukta) than in Domotion's macOS CoreText helper (recomposes to the
  // precomposed glyph, mark in the wrong place). When the primary font covers the
  // decomposed pieces, route THIS run's shaping through real HarfBuzz (harfbuzzjs)
  // so the output matches Chrome. The run text stays the SOURCE char (HarfBuzz
  // decomposes internally, like Chrome), keeping clusters / xOffsets aligned;
  // `decomposed: true` routes the glyph-path emitter to its run-shaping branch.
  // Must precede the literal fast-path, which would otherwise lock in the
  // CoreText-shaped precomposed glyph. Falls through when the font has no on-disk
  // file HarfBuzz can open or the primary doesn't cover every piece.
  const csDecomp = complexShaperBaseMarkDecomposition(cp);
  if (csDecomp != null) {
    const dcps = [...csDecomp].map((c) => c.codePointAt(0)!);
    if (dcps.every((d) => primaryFont.glyphForCodePoint(d).id !== 0)) {
      const hbPath = resolveFontSpec(primaryFontKey)?.path;
      if (hbPath != null && hbPath !== "") {
        const hbInst = makeHarfbuzzShapingInstance(primaryFont, hbPath);
        if (hbInst !== primaryFont) return cover(primaryFontKey, hbInst, ch, true);
      }
    }
  }

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
export function fontAutoInsertsDottedCircle(primaryFont: FontInstance, ch: string): boolean {
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
export function syntheticMarkCenteringOffsetPx(primaryFont: FontInstance, ch: string, fontSize: number): number {
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


export interface FontRun { fontKey: string; font: FontInstance; text: string; startIdx: number; endIdx: number; isPrimary: boolean }
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

export function mergeGaps(gaps: Array<[number, number]>): Array<[number, number]> {
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

export function glyphPathIntercepts(
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

/** Two-decimal SVG coordinate formatter for glyph-path geometry (math radical /
 *  stretchy-fence markup). Named distinctly from the one-decimal `r` in
 *  `format.ts` so the precision is explicit at the call site (DM-1340). */
export function r2(n: number): string { return Number(n.toFixed(2)).toString(); }

