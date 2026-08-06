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
import { hostPlatform } from "./host-platform.js";
import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { createGlyphHelperFont, isGlyphHelperAvailable, resolveSystemFallbackFonts, resolveInstalledFont, resolveFcFallbackFonts, resolveSystemUiFamily, resolveFaceTraitBold, resolveFamilyStyleMatch, resolveLinuxFamilyMatch, clearGlyphHelperCodepointMemos, type LinuxFamilyMatch } from "./glyph-helper.js";
import { win32FamilySuffixAdjustment } from "./win32-family-suffix.js";
import { faceHasTrakAndStat, installHarfbuzzShaping, makeHarfbuzzShapeFallback, makeHarfbuzzShapingInstance, registerHbBufferSource } from "./harfbuzz-shaper.js";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss, restoreEmbeddedFonts, snapshotEmbeddedFonts, trackGlyphInEmbedFont } from "./embedded-font-builder.js";
import type { EmbeddedFontSnapshot } from "./embedded-font-builder.js";
// Speculative-composition rollback (see `snapshotGeneration` below): re-exported
// here so the render barrel's font surface stays one import for consumers.
export { restoreEmbeddedFonts, snapshotEmbeddedFonts } from "./embedded-font-builder.js";
export type { EmbeddedFontSnapshot } from "./embedded-font-builder.js";
import { UNICODE_FONT_PATHS, UNICODE_FONT_RANGES } from "./unicode-font-routing.darwin.generated.js";
import { UNICODE_FONT_PATHS_LINUX, UNICODE_FONT_RANGES_LINUX } from "./unicode-font-routing.linux.generated.js";
import { UNICODE_FONT_PATHS_NOTO_LINUX, UNICODE_FONT_RANGES_NOTO_LINUX } from "./unicode-font-routing.noto-linux.generated.js";
import { UNICODE_FONT_FILES_WIN32, UNICODE_FONT_RANGES_WIN32 } from "./unicode-font-routing.win32.generated.js";
// Blink's hardcoded Windows per-script fallback stage, transcribed from
// `platform/fonts/win/font_fallback_win.cc` + `font_cache_skia_win.cc` (DM-1864).
import { blinkWinFallbackLocale, blinkWinHardcodedFamilies, winFallbackPriorityForTextRun } from "./win-font-fallback.js";
export * from "./win-font-fallback.js";
// Unicode-classification predicates (mathAlphaToBase, isRtlScriptCodepoint, isStretchyFenceChar, complex-shaper / matra / rtl ranges, …) moved to ./unicode-classification.ts (DM-1305).
import { mathAlphaToBase, isLegitimatelyInklessCodepoint, usesDedicatedShaper, usesHarfbuzzShaping, isTrimmableCjkPunct, complexShaperBaseMarkDecomposition, nfdBaseMarkDecomposition, isStrippableOrphanIgnorable, usesComplexShaperDottedCircle, isLeftReorderingMatra, isRtlScriptCodepoint, isIdeographicCp } from "./unicode-classification.js";
export { mathAlphaToBase, isLegitimatelyInklessCodepoint, isTrimmableCjkPunct, complexShaperBaseMarkDecomposition, nfdBaseMarkDecomposition, isStrippableOrphanIgnorable, usesComplexShaperDottedCircle, isLeftReorderingMatra, isStretchyFenceChar } from "./unicode-classification.js"; // re-export for text-to-path.test.ts + text.ts

/**
 * The three per-variant constants Blink's WEBFONT synthetic-bold rule reads.
 * All three are properties of the registered `@font-face` variant, not of the
 * run — the requested weight is the only per-run input, and it is the argument
 * to `webfontSyntheticBold`.
 */
export interface WebfontSynthesisFace {
  /** The `@font-face` `font-weight` DESCRIPTOR as selection capabilities
   *  `[min, max]`, or null when the descriptor is auto/absent. Null does NOT
   *  mean "no capabilities": an auto descriptor SELECTS as exactly normal
   *  weight `[400, 400]`, so the distinction only changes whether the
   *  variable-axis exemption below is allowed to fire. */
  declaredWeightCaps: readonly [number, number] | null;
  /** The buffer's own `wght` fvar axis maximum, or null when the buffer
   *  exposes no `wght` axis (a static face). */
  wghtAxisMax: number | null;
  /** Whether the BASE buffer declares itself bold — Skia's
   *  `SkTypeface::isBold()`, i.e. the face's own style weight ≥ 600. */
  baseIsBold: boolean;
}

export interface FontInstance {
  /**
   * DM-1894: `script`/`language`/`direction` mirror fontkit's own signature, and
   * `direction` is the one that matters — Blink passes direction into the shaper
   * explicitly (`HarfBuzzShaper::Shape(font, direction, …)`) rather than letting
   * it be inferred from content, because inference reads an RTL stretch inside an
   * otherwise-LTR run as left-to-right. Callers that shape a single-script
   * segment should pass it; omitting it preserves the previous infer-it behavior.
   */
  layout(text: string, features?: string[], script?: string, language?: string, direction?: "ltr" | "rtl"): {
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
  /** fontkit's CMAP membership test. Present on fontkit-backed instances and
   *  absent on the native-helper ones, which is why `fontCoversCp` falls back.
   *  Answers a DIFFERENT question from `glyphForCodePoint` — see `fontCoversCp`. */
  hasGlyphForCodePoint?(codePoint: number): boolean;
  /** Native (glyph-helper) instances can pre-warm a batch of glyph-coverage
   *  probes so the per-codepoint walk hits a cache. fontkit instances omit it. */
  warmGlyphs?(codePoints: number[]): void;
  /** Native instances can pre-warm a batch of shaping calls (run-based layout). */
  warmShapes?(texts: string[]): void;
  /** The resolved STATIC face's natural weight (`OS/2.usWeightClass`), populated
   *  for fontkit instances in `getFontInstance`. Drives the embedded-mode
   *  faux-bold decision (DM-1693): when the requested weight exceeds this by a
   *  wide margin and no weight axis was baked, Chrome emboldens the face, so we
   *  bake the same dilation into the embedded outline. Absent on native-helper
   *  / webfont instances → those never trigger synthetic bold (safe default). */
  naturalWeight?: number;
  /** True when this instance baked the requested weight into a variable `wght`
   *  axis — its outline is ALREADY at the requested weight, so no faux-bold. */
  hasWeightAxis?: boolean;
  /**
   * DM-1880: whether the face DECLARES ITSELF bold, as a flag rather than as a
   * weight number.
   *
   * macOS's synthetic-bold rule asks CoreText's `kCTFontTraitBold` symbolic
   * trait (`mac/font_cache_mac.mm:424-427`), not a numeric weight, and the two
   * genuinely disagree — substituting `usWeightClass >= 600` for the trait
   * measurably regressed a fixture. So the flag travels rather than being
   * inferred.
   *
   * Two sources, one per extractor, because they are the same fact recorded in
   * two places: OS/2 `fsSelection` bit 5 for a fontkit-opened face (the file's
   * own BOLD bit, which is what CoreText derives its trait from), and the
   * CoreText trait itself for a helper-backed one. Undefined when neither is
   * readable, and callers fall back to the weight comparison.
   */
  faceIsBoldTrait?: boolean;
  /** Set on instances resolved through the `@font-face` webfont registry, and
   *  ONLY there. Carries the three per-variant constants Blink's webfont
   *  synthetic-bold rule reads — see `webfontSyntheticBold`, which is a
   *  DIFFERENT rule from the per-platform system-font predicates and must not
   *  be conflated with them. */
  webfontFace?: WebfontSynthesisFace;
  /** DM-1964: the `@font-face` file's own bytes, on instances resolved through
   *  the webfont registry and ONLY there. A webfont is never written to disk,
   *  so `shapingFaceFor` (which resolves a font key to a FILE) has nothing to
   *  return for it and every HarfBuzz reroute declined — silently keeping
   *  fontkit's enable-only shaping, which drops `font-feature-settings` disables
   *  outright. `hb.Blob` takes an ArrayBuffer, so the bytes are all the shaper
   *  needed; `registerHbBufferSource` turns them into a source it can open. */
  webfontBuffer?: Buffer;
  /** The resolved face's `post.italicAngle` in degrees (0 for an upright face,
   *  negative for a right-leaning italic). Drives the embedded-mode faux-italic
   *  decision (DM-1695): when italic is requested but the resolved face is
   *  upright and no `slnt` axis carried the slant, Chrome synthesizes an oblique,
   *  so we bake the same shear into the embedded outline. Absent on
   *  native-helper / webfont instances → those never trigger synthetic italic.
   *  Named to avoid colliding with fontkit's read-only `italicAngle` getter. */
  resolvedItalicAngle?: number;
  /** True when this instance baked the slant into a variable `slnt` axis — its
   *  outline is ALREADY slanted, so no faux-italic. */
  hasSlantAxis?: boolean;
  /** True when `getFontInstance` deliberately routed a slant request to the
   *  family's own italic/oblique sibling face. That routing decision is a
   *  stronger signal than `resolvedItalicAngle`, because some faces ship a
   *  `post.italicAngle` of 0 despite a genuinely slanted outline — on macOS,
   *  `Helvetica-LightOblique` and `HelveticaNeue-BoldItalic` both do, while
   *  their outlines lean the same ~12° as their correctly-tagged siblings.
   *  Trusting the angle alone there sheared an already-oblique face a second
   *  time in embedded-font mode. */
  isRoutedItalicCut?: boolean;
  /** PostScript name of the face fontkit actually OPENED (`Helvetica-Bold`,
   *  `HiraginoSans-W7`, `.SFNS-Regular`). fontkit exposes it on every `Font`,
   *  including the member a `.ttc` collection resolved to; native-helper and
   *  webfont instances leave it undefined, and `getFontSourceInfo().postscriptName`
   *  (the name the path table asked for) is the fallback there.
   *
   *  Typed here so the conformance oracle can name the face the renderer would
   *  really emit — a face's identity is exactly what it compares against
   *  Chrome's `CSS.getPlatformFontsForNode`, and reading it through a cast would
   *  put the one load-bearing field of that comparison outside the type system. */
  postscriptName?: string;
  /** The PostScript name CoreText reports for the variation-instantiated clone
   *  this instance represents, when the macOS helper path applied a non-default
   *  axis location (`resolveDarwinAxisLocation`). Chrome names such faces with
   *  the coordinates baked in (`.SFDevanagari-Regular_opsz110000_wght` — hex
   *  16.16), so the conformance oracle must prefer this over `postscriptName`
   *  or it compares an instance against a base face and reports a mismatch that
   *  is purely a naming gap. Composed by `coreTextVariationInstanceName` FROM
   *  THE COORDINATES ACTUALLY APPLIED — never copied from `postscriptName` —
   *  so a genuine axis divergence still surfaces as a name difference.
   *  Undefined off the darwin helper path and when the face stays at its
   *  file-default location (no clone — Blink's `axes_reconfigured` guard). */
  instantiatedPostscriptName?: string;
}

/** Glyph id for a codepoint, tolerating a null return from `glyphForCodePoint`.
 *  The interface types that non-null, but a fontkit instance can hand back null
 *  for an unmapped codepoint (color-font / missing-script codepoints on
 *  Linux/Windows — DM-1712), and every `glyphForCodePoint(cp).id` read would
 *  otherwise crash the whole fixture render. Null coalesces to 0 (.notdef /
 *  uncovered), which is what the coverage checks already treat as "not covered". */
export function glyphIdForCp(font: FontInstance, cp: number): number {
  const g = font.glyphForCodePoint(cp);
  return g == null ? 0 : g.id;
}

/**
 * Does this font COVER `cp` — i.e. does its cmap map the codepoint?
 *
 * Distinct from `glyphIdForCp(font, cp) !== 0`, and the difference is not
 * academic. That test asks whether a Glyph OBJECT can be constructed, which is
 * an outline question; coverage is a cmap question. The two diverge on a
 * bitmap-only color font, and Blink asks the cmap one — `FontContainsCharacter`
 * and the fallback iterator's has-a-glyph test both consult the character map,
 * not the outline tables.
 *
 * Measured on Linux (DM-1986), `NotoColorEmoji.ttf` — CBDT/CBLC, with no `glyf`
 * and no `CFF`:
 *
 *     characterSet includes U+1F600      true
 *     hasGlyphForCodePoint(U+1F600)      true
 *     glyphForCodePoint(U+1F600)         undefined
 *     layout("😀")                        throws
 *
 * So every emoji-presentation codepoint failed the coverage check against the
 * one font on the system that actually covers it, and the resolver discarded a
 * correct answer — Chrome paints Noto Color Emoji, we fell through to the
 * primary. The check was accidentally testing "can fontkit build an outline",
 * which for a colour bitmap font is always no.
 *
 * Falls back to the id test when the instance exposes no `hasGlyphForCodePoint`
 * (the native-helper instances), so nothing that works today changes behaviour.
 */
export function fontCoversCp(font: FontInstance, cp: number): boolean {
  const has = font.hasGlyphForCodePoint;
  if (typeof has === "function") {
    try { if (has.call(font, cp) === true) return true; } catch { /* fall through to the id test */ }
  }
  // Deliberately NOT routed through the local cmap bitset. This function serves
  // faces the PLATFORM nominated (`sysfb:`), and for those the mapping from
  // CoreText's name to a physical sfnt member is exactly what `FontSourceInfo`
  // documents as unreliable — a container reports 268 named instances against
  // 32 physical members. Measured: routing this site through the bitset moved
  // one conformance row from `agree-exact` to `agree-tofu`, while the same
  // bitset agreed with the helper on 11,988 of 11,988 static-chain pairs. The
  // walk's candidates are OUR keys resolved through OUR path tables, so their
  // face index is trustworthy; a CoreText nomination's is not.
  return glyphIdForCp(font, cp) !== 0;
}

/**
 * Coverage bitsets for HELPER-BACKED faces, so the commonest query in the
 * resolver stops being IPC.
 *
 * ## Why this is worth a cache
 *
 * A native face has no `hasGlyphForCodePoint`, so every "does this font cover
 * this codepoint" goes to the helper. Measured over a 4,000-codepoint stride:
 * **0.67 such probes per codepoint on macOS and 4.43 on Windows**, where they
 * are 28% and 74% of the resolver's entire cost.
 *
 * The work behind one is a cmap lookup on an already-open font. Captured off
 * the wire, a single probe is a 223-byte request answered by **1,704 bytes** —
 * `{"id":184,"advance":1000,"bbox":{…},"d":"M 461.6 821.3 Q …"}` — because the
 * `glyphs` query returns the outline. The caller wants `!== 0` and discards the
 * rest.
 *
 * Coverage is a property of the FILE, so it can be read once locally instead:
 *
 *     PingFang (CJK)  58.3 MB file, 34,550 codepoints, 49 ms to read
 *     Helvetica        2.3 MB file,  2,068 codepoints,  0 ms to read
 *     …either way a 136 KB bitset, and 0.004 µs per lookup
 *
 * 136 KB is FIXED — a bitset over the whole codepoint space — so a huge CJK
 * face costs no more than a Latin one. Against a 0.31 ms round trip the lookup
 * is ~77,000× cheaper.
 *
 * ## Why the key is (file, face index) and not the instance
 *
 * The cmap does not vary with `wght` / `opsz` / any axis — variations change
 * outlines, not which characters exist. So every instance of a face shares one
 * bitset, which collapses the key space to something a process can hold.
 *
 * ## When it declines to answer
 *
 * Returns null — and the caller falls back to the helper — whenever the face
 * cannot be honestly identified in the file:
 *
 *  - no recorded source path;
 *  - `faceIndex` null, which `FontSourceInfo` documents as "the PostScript name
 *    is not among the file's physical members". CoreText enumerates a
 *    container's NAMED INSTANCES (PingFangUI.ttc reports 268) while fontkit
 *    sees its 32 physical members, so a CoreText face can have no member of
 *    that name at all. Reading member 0 there would answer for a face nobody
 *    asked about — different scripts in the same container have different
 *    cmaps, so that is a wrong answer, not an approximation;
 *  - the file will not open, or the member has no readable character set.
 *
 * Deliberately NOT applied to fontkit-backed instances: those already answer
 * `hasGlyphForCodePoint` in-process above, and their `glyphIdForCp` asks a
 * different question (can an outline be built) that a cmap bitset would silently
 * change — the DM-1986 divergence, in reverse.
 */
const coverageBitsets = new Map<string, Uint8Array | null>();

function nativeFaceCoversCp(font: FontInstance, cp: number): boolean | null {
  // Only helper-backed faces: a fontkit instance answered above.
  if (typeof font.hasGlyphForCodePoint === "function") return null;
  const src = getFontSourceInfo(font);
  if (src == null || src.path === "" || src.faceIndex == null) return null;
  const key = `${src.path}|${src.faceIndex}`;
  let bits = coverageBitsets.get(key);
  if (bits === undefined) {
    bits = buildCoverageBitset(src.path, src.faceIndex);
    coverageBitsets.set(key, bits);
  }
  if (bits == null) return null;
  return (bits[cp >> 3] & (1 << (cp & 7))) !== 0;
}

function buildCoverageBitset(path: string, faceIndex: number): Uint8Array | null {
  try {
    const opened = fontkit.openSync(path);
    // A collection exposes `fonts`; `faceIndex` is the PHYSICAL member index,
    // which is what the array is ordered by.
    const collection = (opened as unknown as { fonts?: unknown[] }).fonts;
    const face = Array.isArray(collection) ? collection[faceIndex] : opened;
    const cps = (face as unknown as { characterSet?: number[] } | undefined)?.characterSet;
    if (!Array.isArray(cps) || cps.length === 0) return null;
    const bits = new Uint8Array(0x110000 >> 3);
    for (const c of cps) {
      if (c >= 0 && c <= 0x10ffff) bits[c >> 3] |= 1 << (c & 7);
    }
    return bits;
  } catch {
    return null;
  }
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
interface WebfontVariant {
  weight: number;
  italic: boolean;
  font: FontInstance;
  unicodeRange?: Array<[number, number]>;
  buffer?: Buffer;
  /** The `@font-face` `font-stretch` DESCRIPTOR as selection capabilities
   *  `[min, max]` (a single value is `[v, v]`), per Blink's
   *  `FontFace::GetFontSelectionCapabilities` (`core/css/font_face.cc:666-…`,
   *  identical at tag 147.0.7727.15 and rev 7d859f27). Undefined = descriptor
   *  auto/absent, which SELECTS as normal width `[100, 100]`
   *  (`RangeSetFromAuto`) and INSTANCES against the font's own wdth axis
   *  range. */
  stretch?: readonly [number, number];
  /** The `@font-face` `font-weight` DESCRIPTOR as selection capabilities
   *  `[min, max]`, per the same `FontFace::GetFontSelectionCapabilities`
   *  rule (`core/css/font_face.cc:860-930`, rev 7d859f27): `normal` is
   *  `[400, 400]`, `bold` is `[700, 700]`, a single number is `[v, v]`, a
   *  two-value range has decreasing endpoints swapped. Undefined =
   *  descriptor auto/absent, which SELECTS as normal weight `[400, 400]`
   *  (`RangeSetFromAuto`) and INSTANCES against the font's own wght axis
   *  range. The legacy `weight` field above remains the scoring scalar for
   *  report rows; selection and instancing consult THIS. */
  weightCaps?: readonly [number, number];
  /** Snapshot of the three per-variant constants Blink's webfont
   *  synthetic-bold rule reads (see `webfontSyntheticBold`). Computed once at
   *  registration from the opened buffer, because all three are properties of
   *  the FACE, not of the run. */
  synthesisFace?: WebfontSynthesisFace;
}
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
 *
 * `stretch` is the raw `@font-face { font-stretch: ... }` descriptor value
 * ("condensed", "75%", "50% 100%"); omitted/"auto"/unparseable registers the
 * variant with auto capabilities. See `parseFontStretchDescriptor`.
 *
 * `weightDesc` is the raw `@font-face { font-weight: ... }` descriptor value
 * ("bold", "700", "300 500"); omitted/"auto"/unparseable registers the
 * variant with auto weight capabilities. The scalar `weight` parameter stays
 * as the legacy pre-collapsed number (the capture side's
 * `parseWeightDescriptor`) for report rows; selection and instancing use the
 * descriptor capabilities. See `parseFontWeightDescriptor`.
 */
export function registerWebfont(family: string, weight: number, style: string, buffer: Buffer, unicodeRange?: Array<[number, number]>, stretch?: string, weightDesc?: string): void {
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
  const stretchCaps = parseFontStretchDescriptor(stretch);
  const weightCaps = parseFontWeightDescriptor(weightDesc);
  // DM-652: retain the raw buffer so embedded-font mode can `@font-face`
  // it as a `data:` URI without re-reading from disk (webfonts have no
  // on-disk source path — they came down from a CDN during capture).
  list.push({ weight, italic, font, unicodeRange, buffer,
    ...(stretchCaps != null ? { stretch: stretchCaps } : {}),
    ...(weightCaps != null ? { weightCaps } : {}),
    synthesisFace: buildWebfontSynthesisFace(font, weightCaps) });
  webfontRegistry.set(key, list);
}

/** The CSS `font-stretch` keyword → percentage table, transcribed from Blink's
 *  width constants (`platform/fonts/font_selection_types.h:221-246`, identical
 *  at tag 147.0.7727.15 and rev 7d859f27). */
const FONT_STRETCH_KEYWORDS: Readonly<Record<string, number>> = {
  "ultra-condensed": 50, "extra-condensed": 62.5, "condensed": 75, "semi-condensed": 87.5,
  "normal": 100,
  "semi-expanded": 112.5, "expanded": 125, "extra-expanded": 150, "ultra-expanded": 200,
};

/**
 * Parse an `@font-face` `font-stretch` DESCRIPTOR value into selection
 * capabilities `[min, max]`, or undefined for auto/absent/unparseable.
 *
 * Transcribed from `FontFace::GetFontSelectionCapabilities`
 * (`core/css/font_face.cc:666-…`, identical at tag 147.0.7727.15 and rev
 * 7d859f27): a keyword maps to its width constant as a single-value range; a
 * single percentage is `[v, v]`; two percentages are a range with the
 * endpoints SWAPPED when decreasing ("User agents must swap the computed value
 * of the startpoint and endpoint of the range in order to forbid decreasing
 * ranges", css-fonts-4). `auto` (and anything unparseable, which Blink's
 * parser would have rejected before it reached the descriptor) yields
 * undefined — normal-width capabilities flagged as set-from-auto, meaning the
 * INSTANCING clamp falls back to the font's own wdth axis range.
 */
export function parseFontStretchDescriptor(value: string | undefined): readonly [number, number] | undefined {
  if (value == null) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "auto") return undefined;
  const kw = FONT_STRETCH_KEYWORDS[v];
  if (kw != null) return [kw, kw];
  const m = /^([\d.]+)%(?:\s+([\d.]+)%)?$/.exec(v);
  if (m == null) return undefined;
  const a = parseFloat(m[1]);
  if (!Number.isFinite(a) || a < 0) return undefined;
  if (m[2] == null) return [a, a];
  const b = parseFloat(m[2]);
  if (!Number.isFinite(b) || b < 0) return undefined;
  return a < b ? [a, b] : [b, a];
}

/**
 * Parse an `@font-face` `font-weight` DESCRIPTOR value into selection
 * capabilities `[min, max]`, or undefined for auto/absent/unparseable.
 *
 * Transcribed from the weight section of `FontFace::GetFontSelectionCapabilities`
 * (`core/css/font_face.cc:860-930`, rev 7d859f27, checkout of 2026-06-27):
 * `normal` is `[400, 400]`, `bold` is `[700, 700]` (both set-explicitly — they
 * PIN the wght instancing, unlike auto); a single number in `[1, 1000]` is
 * `[v, v]`; a two-value range with both endpoints in `[1, 1000]` has decreasing
 * endpoints swapped ("User agents must swap the computed value of the
 * startpoint and endpoint of the range in order to forbid decreasing ranges",
 * css-fonts-4). `auto`, an absent descriptor, and anything out of range or
 * unparseable (Blink's parser rejects those before they are stored; its
 * defensive `return normal_capabilities` branches leave the weight range's
 * default `kSetFromAuto` type in place) yield undefined — normal-weight
 * capabilities flagged as set-from-auto, meaning selection scores the face as
 * exactly weight 400 and the INSTANCING clamp falls back to the font's own
 * wght axis range.
 */
export function parseFontWeightDescriptor(value: string | undefined): readonly [number, number] | undefined {
  if (value == null) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "auto") return undefined;
  if (v === "normal") return [400, 400];
  if (v === "bold") return [700, 700];
  const m = /^([\d.]+)(?:\s+([\d.]+))?$/.exec(v);
  if (m == null) return undefined;
  const a = parseFloat(m[1]);
  if (!Number.isFinite(a) || a < 1 || a > 1000) return undefined;
  if (m[2] == null) return [a, a];
  const b = parseFloat(m[2]);
  if (!Number.isFinite(b) || b < 1 || b > 1000) return undefined;
  return a < b ? [a, b] : [b, a];
}

/** Blink's `kBoldThreshold` — the weight at or above which a run counts as a
 *  bold REQUEST (`platform/fonts/font_selection_types.h:182`, rev 7d859f27).
 *  600, not 700, and not the 500 the macOS SYSTEM-font rule uses. */
const BLINK_BOLD_THRESHOLD = 600;
/** Blink's `kNormalWeightValue` (`font_selection_types.h:201`, rev 7d859f27). */
const BLINK_NORMAL_WEIGHT = 400;

/**
 * Whether Chrome paints a WEBFONT run synthetic-bold. This is a different rule
 * from the per-platform system-font predicates in `text-to-path.ts`, and it is
 * platform-INDEPENDENT: it lives entirely in the CSS/webfont layer, which Blink
 * compiles once for every platform.
 *
 * The rule is composed from two places (both verified byte-identical between
 * the local checkout at rev 7d859f27 and Chromium tag 147.0.7727.15, the
 * version Playwright pins — only palette-array plumbing differs in the second
 * file, well away from these lines):
 *
 *  1. `CSSSegmentedFontFace::GetFontData` (`core/css/css_segmented_font_face.cc:
 *     116-119`) decides the `bold` flag handed down:
 *
 *         requested_font_description.SetSyntheticBold(
 *             font_selection_capabilities_.weight.maximum < kBoldThreshold &&
 *             font_selection_request.weight >= kBoldThreshold &&
 *             font_description.SyntheticBoldAllowed());
 *
 *     Note what the first term reads: the `@font-face` font-weight DESCRIPTOR
 *     capabilities, NOT the font's axis range. An absent/auto descriptor is
 *     `[400, 400]` (`core/css/font_face.cc:669-672` builds `normal_capabilities`
 *     and the auto branch at 870-873 keeps it, flagged `kSetFromAuto`), so an
 *     auto-descriptor face is a bold-synthesis CANDIDATE for every request
 *     ≥ 600 — including a variable face whose axis reaches 900.
 *
 *  2. `FontCustomPlatformData::GetFontPlatformData`
 *     (`platform/fonts/font_custom_platform_data.cc:129-154, 289-293`) starts
 *     from `synthetic_bold = bold` and exempts exactly one case — a VARIABLE
 *     face (`kVariableTrueType` / `kVariableCFF2`) whose weight capabilities
 *     were set FROM AUTO and which exposes a valid `wght` axis:
 *
 *         bool has_bold_variations = wght_range.maximum > kNormalWeightValue;
 *         synthetic_bold = bold && !has_bold_variations &&
 *                          selection_request.weight >= kBoldThreshold;
 *
 *     …and finally gates the whole thing on the buffer's own boldness:
 *
 *         synthetic_bold && !base_typeface_->isBold()
 *
 *     `SkTypeface::isBold()` is `onGetFontStyle().weight() >= kSemiBold_Weight`
 *     (600) — Skia `src/core/SkTypeface.cpp:491-493`, `include/core/SkFontStyle.h:25`,
 *     rev ebf5052.
 *
 * The DECLARED-descriptor branch never reaches the exemption, which is the
 * whole point: a variable face declared `font-weight: 400` pins wght = 400 AND
 * paints emboldened, where the same file with no descriptor instances wght = 700
 * and paints plain.
 *
 * `SyntheticBoldAllowed()` (`font-synthesis-weight: auto`) is not modeled: the
 * `font-synthesis` property is not captured at all today, so every run is
 * treated as allowing synthesis — the same assumption the system-font faux-bold
 * seam already makes.
 */
/**
 * Snapshot the three per-variant constants `webfontSyntheticBold` needs, at
 * registration time, from the buffer fontkit just opened.
 *
 * `wghtAxisMax` is quantized onto the FontSelectionValue quarter grid (16.16
 * fixed point with two fractional bits, `platform/fonts/font_selection_types.h:
 * 40-105`) because that is what Blink's `FontSelectionValue(wght_parameters->max)`
 * does before comparing it to `kNormalWeightValue`; it is null when the buffer
 * has no `wght` axis, or when the axis range is degenerate (Blink's
 * `wght_range.IsValid()` guard — an invalid range skips the exemption block
 * entirely, leaving `synthetic_bold = bold`).
 *
 * `baseIsBold` mirrors `SkTypeface::isBold()` on the base typeface: the face's
 * own declared style weight ≥ 600. `OS/2.usWeightClass` is where that weight
 * comes from for a font opened from a buffer.
 */
function buildWebfontSynthesisFace(font: FontInstance, weightCaps: readonly [number, number] | undefined): WebfontSynthesisFace {
  const f = font as unknown as {
    variationAxes?: Record<string, { min?: number; max?: number }>;
    "OS/2"?: { usWeightClass?: number };
  };
  const wght = f.variationAxes?.wght;
  const rawMin = wght?.min, rawMax = wght?.max;
  const quantize = (x: number): number => Math.trunc(x * 4) / 4;
  const wghtAxisMax = wght != null && typeof rawMax === "number" && typeof rawMin === "number" && rawMin <= rawMax
    ? quantize(rawMax)
    : null;
  const usWeight = f["OS/2"]?.usWeightClass;
  return {
    declaredWeightCaps: weightCaps ?? null,
    wghtAxisMax,
    baseIsBold: typeof usWeight === "number" && usWeight >= BLINK_BOLD_THRESHOLD,
  };
}

export function webfontSyntheticBold(face: WebfontSynthesisFace, requestedWeight: number): boolean {
  // `capabilities.weight` for the matched face: the declared descriptor range,
  // or normal weight when the descriptor is auto/absent.
  const caps = face.declaredWeightCaps ?? [BLINK_NORMAL_WEIGHT, BLINK_NORMAL_WEIGHT];
  const bold = caps[1] < BLINK_BOLD_THRESHOLD && requestedWeight >= BLINK_BOLD_THRESHOLD;
  if (!bold) return false;
  // The auto-descriptor variable-face exemption. Only reachable when the
  // descriptor is auto (`IsRangeSetFromAuto()`) AND the buffer exposes a wght
  // axis — a declared descriptor keeps `synthetic_bold = bold` untouched.
  if (face.declaredWeightCaps == null && face.wghtAxisMax != null
      && face.wghtAxisMax > BLINK_NORMAL_WEIGHT) {
    return false;
  }
  return !face.baseIsBold;
}

/** True iff `cp` falls in any of the inclusive `[from, to]` intervals. */
export function unicodeRangeCovers(ranges: Array<[number, number]> | undefined, cp: number): boolean {
  if (ranges == null) return true; // no range = U+0..U+10FFFF (CSS default)
  for (const [from, to] of ranges) {
    if (cp >= from && cp <= to) return true;
  }
  return false;
}

/** A variant's stretch SELECTION capabilities: the declared descriptor range,
 *  or normal width `[100, 100]` when the descriptor is auto/absent — Blink's
 *  `FontFace::GetFontSelectionCapabilities` selects an auto face as exactly
 *  normal width (`core/css/font_face.cc:666-…`, tag 147.0.7727.15). */
function variantStretchCaps(v: WebfontVariant): readonly [number, number] {
  return v.stretch ?? [100, 100];
}

/** The union of the family's stretch capabilities — Blink's
 *  `capabilities_bounds_`, built across every face of the segmented family and
 *  consulted by the off-side thresholds below. */
function webfontStretchBounds(variants: WebfontVariant[]): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const v of variants) {
    const [lo, hi] = variantStretchCaps(v);
    if (lo < min) min = lo;
    if (hi > max) max = hi;
  }
  return { min, max };
}

/**
 * Distance from a stretch request to a variant's capabilities, transcribed
 * from `FontSelectionAlgorithm::StretchDistance`
 * (`platform/fonts/font_selection_algorithm.cc:30-52`, byte-identical at tag
 * 147.0.7727.15 and rev 7d859f27):
 *
 *   - a range containing the request is distance 0;
 *   - a request above normal (100) prefers wider faces: a face entirely above
 *     the request scores its gap, a face entirely below scores from
 *     `max(request, bounds.max)` — pushing too-narrow faces behind every
 *     too-wide one;
 *   - a request at/below normal mirrors that, preferring narrower faces.
 *
 * Checked BEFORE style and weight, which is Blink's
 * `IsBetterMatchForRequest` order (stretch, then style, then weight).
 */
function webfontStretchDistance(
  caps: readonly [number, number], request: number, bounds: { min: number; max: number },
): number {
  const [lo, hi] = caps;
  if (request >= lo && request <= hi) return 0;
  if (request > 100) {
    if (lo > request) return lo - request;
    // hi < request
    return Math.max(request, bounds.max) - hi;
  }
  if (hi < request) return request - hi;
  // lo > request
  return lo - Math.min(request, bounds.min);
}

/** A variant's weight SELECTION capabilities: the declared `font-weight`
 *  descriptor range, or normal weight `[400, 400]` when the descriptor is
 *  auto/absent — Blink's `FontFace::GetFontSelectionCapabilities` selects an
 *  auto face as exactly normal weight (`core/css/font_face.cc:871-874`, rev
 *  7d859f27). */
function variantWeightCaps(v: WebfontVariant): readonly [number, number] {
  return v.weightCaps ?? [400, 400];
}

/** The union of the family's weight capabilities — the weight component of
 *  Blink's `capabilities_bounds_`, consulted by `webfontWeightDistance`'s
 *  off-side thresholds. */
function webfontWeightBounds(variants: WebfontVariant[]): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const v of variants) {
    const [lo, hi] = variantWeightCaps(v);
    if (lo < min) min = lo;
    if (hi > max) max = hi;
  }
  return { min, max };
}

/**
 * Distance from a weight request to a variant's capabilities, transcribed from
 * `FontSelectionAlgorithm::WeightDistance`
 * (`platform/fonts/font_selection_algorithm.cc:98-135`, rev 7d859f27, checkout
 * of 2026-06-27):
 *
 *   - a range containing the request is distance 0;
 *   - a request in the `[400, 500]` search band prefers, in order: the nearest
 *     face at/under 500 above the request, then faces below the request
 *     (scored from the 500 threshold down), then faces above 500 (scored from
 *     `min(request, bounds.min)`);
 *   - a request under 400 prefers lighter faces — a face entirely below scores
 *     its gap, a face entirely above scores from `min(request, bounds.min)`;
 *   - a request over 500 mirrors that, preferring bolder faces (a too-light
 *     face scores from `max(request, bounds.max)`).
 *
 * Checked AFTER stretch and style, which is Blink's `IsBetterMatchForRequest`
 * order. With CSS weights confined to `[1, 1000]` every branch stays under
 * 1000 (= `WEBFONT_STYLE_MISMATCH`), so style keeps strict priority.
 */
function webfontWeightDistance(
  caps: readonly [number, number], request: number, bounds: { min: number; max: number },
): number {
  const [lo, hi] = caps;
  if (request >= lo && request <= hi) return 0;
  // kLowerWeightSearchThreshold = 400, kUpperWeightSearchThreshold = 500
  // (`platform/fonts/font_selection_types.h:215-219`, rev 7d859f27).
  if (request >= 400 && request <= 500) {
    if (lo > request && lo <= 500) return lo - request;
    if (hi < request) return 500 - hi;
    // lo > 500
    return lo - Math.min(request, bounds.min);
  }
  if (request < 400) {
    if (hi < request) return request - hi;
    // lo > request
    return lo - Math.min(request, bounds.min);
  }
  // request > 500
  if (lo > request) return lo - request;
  // hi < request
  return Math.max(request, bounds.max) - hi;
}

/**
 * Domotion-specific tie-break UNDER `webfontWeightDistance`: the legacy
 * per-variant scalar weight (for `@font-face`-sourced variants the collapsed
 * descriptor; for resource-path variants the font's own OS/2 weight), scaled
 * so it can only separate variants whose Blink weight distances TIE. The
 * resource-discovery path (fonts found only via network requests, no
 * parseable CSS) registers every face with auto capabilities — all of them
 * select as `[400, 400]`, so without this a bold run would take whichever
 * face registered first. Blink's distances live on the FontSelectionValue
 * quarter grid (minimum nonzero step 0.25); |Δweight| ≤ 999 × 1e-4 < 0.1
 * stays strictly below it.
 */
const WEBFONT_WEIGHT_TIEBREAK_SCALE = 1e-4;

/** The composed weight term for the variant pickers: Blink's WeightDistance
 *  over the descriptor capabilities, plus the sub-quarter legacy tie-break. */
function webfontWeightScore(v: WebfontVariant, request: number, bounds: { min: number; max: number }): number {
  return webfontWeightDistance(variantWeightCaps(v), request, bounds)
    + Math.abs(v.weight - request) * WEBFONT_WEIGHT_TIEBREAK_SCALE;
}

// Score-composition scales. The hierarchy is: unicode-range coverage (a
// Domotion-specific tofu-avoidance bias, see pickWebfontVariant) dominates
// stretch, stretch dominates style, style dominates weight — the last three
// being Blink's `IsBetterMatchForRequest` order. Stretch distances reach 150
// (a [50,50] face against bounds.max 200), so ×1e4 keeps every stretch step
// above the style+weight budget (≤1800) and below the range penalty.
const WEBFONT_RANGE_MISMATCH = 1e7;
const WEBFONT_STRETCH_SCALE = 1e4;
const WEBFONT_STYLE_MISMATCH = 1000;

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
export function pickWebfontVariantForCodepoint(family: string, weight: number, fontSize: number, slant: number, codepoint: number, variationSettings?: Record<string, number>,
  /** CSS `font-stretch` percentage — a SELECTION axis (checked before style
   *  and weight, Blink's `IsBetterMatchForRequest` order) and the `wdth`-axis
   *  request for a variable webfont (see `applyVariationAxes`). */
  stretch: number = 100,
): FontInstance | null {
  const variants = webfontRegistry.get(family.toLowerCase());
  if (variants == null || variants.length === 0) return null;
  const wantItalic = slant !== 0;
  const bounds = webfontStretchBounds(variants);
  const weightBounds = webfontWeightBounds(variants);
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    if (!unicodeRangeCovers(v.unicodeRange, codepoint)) continue;
    const stretchDist = webfontStretchDistance(variantStretchCaps(v), stretch, bounds);
    const styleMismatch = v.italic === wantItalic ? 0 : WEBFONT_STYLE_MISMATCH;
    const score = stretchDist * WEBFONT_STRETCH_SCALE + styleMismatch
      + webfontWeightScore(v, weight, weightBounds);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  if (best == null) return null;
  return tagWebfontInstance(applyVariationAxes(best.font, weight, fontSize, slant, variationSettings, stretch,
    { wdthCapabilities: best.stretch ?? null, wdthAlways: true, wghtCapabilities: best.weightCaps ?? null }), best);
}

/**
 * Stamp the matched variant's synthetic-bold face constants onto the instance
 * the renderer will use, so the faux-bold seam can tell a webfont run from a
 * system-font one (the two obey DIFFERENT Blink rules) without threading the
 * registry through.
 *
 * Mutation is safe here because every field is a per-variant CONSTANT: each
 * `registerWebfont` call opens its own fontkit `Font`, so no two variants share
 * an instance, and re-picking the same variant at another weight writes the
 * same values back.
 */
function tagWebfontInstance(instance: FontInstance, variant: WebfontVariant): FontInstance {
  if (variant.synthesisFace != null) instance.webfontFace = variant.synthesisFace;
  // DM-1964: carry the file's bytes so the HarfBuzz reroutes can open the face.
  if (variant.buffer != null) instance.webfontBuffer = variant.buffer;
  return instance;
}

/**
 * Test-only: return metadata for the variant `pickWebfontVariant` would
 * choose, without resolving variation axes / returning a FontInstance. Lets
 * unit tests verify scoring (weight, italic, unicode-range) without needing
 * to introspect glyph paths.
 */
export function __pickWebfontVariantMetaForTest(family: string, weight: number, italic: boolean, stretch: number = 100): { weight: number; italic: boolean; unicodeRange?: Array<[number, number]>; stretch?: readonly [number, number]; weightCaps?: readonly [number, number] } | null {
  const variants = webfontRegistry.get(family.toLowerCase());
  if (variants == null || variants.length === 0) return null;
  const bounds = webfontStretchBounds(variants);
  const weightBounds = webfontWeightBounds(variants);
  const LATIN_PROBE = 0x0041;
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    const stretchDist = webfontStretchDistance(variantStretchCaps(v), stretch, bounds);
    const styleMismatch = v.italic === italic ? 0 : WEBFONT_STYLE_MISMATCH;
    const rangeMismatch = unicodeRangeCovers(v.unicodeRange, LATIN_PROBE) ? 0 : WEBFONT_RANGE_MISMATCH;
    const score = rangeMismatch + stretchDist * WEBFONT_STRETCH_SCALE + styleMismatch
      + webfontWeightScore(v, weight, weightBounds);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  if (best == null) return null;
  return { weight: best.weight, italic: best.italic, unicodeRange: best.unicodeRange, stretch: best.stretch, weightCaps: best.weightCaps };
}

/** Test-only meta variant for `pickWebfontVariantForCodepoint` (DM-557). */
export function __pickWebfontVariantMetaForCodepointForTest(family: string, weight: number, italic: boolean, codepoint: number, stretch: number = 100): { weight: number; italic: boolean; unicodeRange?: Array<[number, number]>; stretch?: readonly [number, number]; weightCaps?: readonly [number, number] } | null {
  const variants = webfontRegistry.get(family.toLowerCase());
  if (variants == null || variants.length === 0) return null;
  const bounds = webfontStretchBounds(variants);
  const weightBounds = webfontWeightBounds(variants);
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    if (!unicodeRangeCovers(v.unicodeRange, codepoint)) continue;
    const stretchDist = webfontStretchDistance(variantStretchCaps(v), stretch, bounds);
    const styleMismatch = v.italic === italic ? 0 : WEBFONT_STYLE_MISMATCH;
    const score = stretchDist * WEBFONT_STRETCH_SCALE + styleMismatch
      + webfontWeightScore(v, weight, weightBounds);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  if (best == null) return null;
  return { weight: best.weight, italic: best.italic, unicodeRange: best.unicodeRange, stretch: best.stretch, weightCaps: best.weightCaps };
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
  // Normalize IDENTICALLY to the lookup side (the `resolveFontKey` tokenizer:
  // trim → strip boundary quotes → lowercase). A different order (e.g. strip
  // quotes before trimming) leaves interior quotes on a whitespace-padded name,
  // so the alias registers under a key `matchFamilyNameToKey` never looks up and
  // local-font resolution silently misses (DM-1597).
  const key = family.trim().replace(/^["']|["']$/g, "").toLowerCase();
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
 * Test-only: the variant `pickLocalFontAliasVariant` would choose for a
 * `(family, weight, italic)` request, without touching real fonts. Mirrors
 * `__pickWebfontVariantMetaForTest` so the local-alias scoring (italic dominates
 * weight) can be unit-tested on any platform (DM-1597).
 */
export function __pickLocalFontAliasVariantForTest(family: string, weight: number, italic: boolean): LocalFontAliasVariant | null {
  const key = family.trim().replace(/^["']|["']$/g, "").toLowerCase();
  return pickLocalFontAliasVariant(key, weight, italic);
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
function pickWebfontVariant(family: string, weight: number, fontSize: number, slant: number, variationSettings?: Record<string, number>,
  /** CSS `font-stretch` percentage. A SELECTION axis — scored against each
   *  variant's `font-stretch` DESCRIPTOR capabilities before style and weight
   *  (Blink's `IsBetterMatchForRequest` order) — and the `wdth`-axis request
   *  for a variable webfont, clamped to the matched variant's descriptor
   *  capabilities when one is declared, else to the font's own wdth range
   *  (`FontCustomPlatformData::GetFontPlatformData`,
   *  `font_custom_platform_data.cc:155-169`, tag 147.0.7727.15). */
  stretch: number = 100,
): FontInstance | null {
  const variants = webfontRegistry.get(family);
  if (variants == null || variants.length === 0) return null;
  const wantItalic = slant !== 0;
  const bounds = webfontStretchBounds(variants);
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
  const weightBounds = webfontWeightBounds(variants);
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    const stretchDist = webfontStretchDistance(variantStretchCaps(v), stretch, bounds);
    const styleMismatch = v.italic === wantItalic ? 0 : WEBFONT_STYLE_MISMATCH;
    // Range mismatch must outweigh every other axis: rendering tofu (no glyph)
    // is far worse than rendering upright glyphs for an italic request, where
    // the renderer can fall back to synthesized italic via `slant`.
    const rangeMismatch = unicodeRangeCovers(v.unicodeRange, LATIN_PROBE) ? 0 : WEBFONT_RANGE_MISMATCH;
    const score = rangeMismatch + stretchDist * WEBFONT_STRETCH_SCALE + styleMismatch
      + webfontWeightScore(v, weight, weightBounds);
    if (score < bestScore) { bestScore = score; best = v; }
  }
  if (best == null) return null;
  return tagWebfontInstance(applyVariationAxes(best.font, weight, fontSize, slant, variationSettings, stretch,
    { wdthCapabilities: best.stretch ?? null, wdthAlways: true, wghtCapabilities: best.weightCaps ?? null }), best);
}

/**
 * DM-652: pick a registered webfont variant and return both the FontInstance
 * (for metric computation) AND the original buffer (for `@font-face`
 * embedding). Mirrors `pickWebfontVariant`'s scoring so embedded-mode
 * selection lines up with the path-mode selection a paths-mode capture
 * would have used. Returns null when the family isn't registered or the
 * matched variant has no retained buffer.
 */
function pickWebfontVariantWithBuffer(family: string, weight: number, slant: number, stretch: number = 100): { variant: WebfontVariant; buffer: Buffer } | null {
  const variants = webfontRegistry.get(family);
  if (variants == null || variants.length === 0) return null;
  const wantItalic = slant !== 0;
  const bounds = webfontStretchBounds(variants);
  const weightBounds = webfontWeightBounds(variants);
  const LATIN_PROBE = 0x0041;
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    if (v.buffer == null) continue;
    const stretchDist = webfontStretchDistance(variantStretchCaps(v), stretch, bounds);
    const styleMismatch = v.italic === wantItalic ? 0 : WEBFONT_STYLE_MISMATCH;
    const rangeMismatch = unicodeRangeCovers(v.unicodeRange, LATIN_PROBE) ? 0 : WEBFONT_RANGE_MISMATCH;
    const score = rangeMismatch + stretchDist * WEBFONT_STRETCH_SCALE + styleMismatch
      + webfontWeightScore(v, weight, weightBounds);
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
interface FontPath {
  path: string;
  postscriptName?: string;
  extractor?: "fontkit" | "native";
  /** DM-1721: axis location the platform font matcher resolved a VARIABLE face
   *  to (win32 DirectWrite reports this for live-resolver `sysfb:` picks — e.g.
   *  "Segoe UI Variable Text" is pinned at opsz 10.5 at every font size).
   *  When present, the hinted-subset pin adopts these values for the axes CSS
   *  can't derive (opsz etc.) instead of computing them from font size. Absent
   *  for static tables, macOS/Linux resolutions, and older win32 helpers. */
  resolvedAxes?: Record<string, number>;
  /** macOS: the CoreText handle's variation axes + CURRENT position at
   *  resolution time (family or fallback query). This is the FACE the
   *  PostScript name denotes — a named instance or clone ("Skia-Regular_Light"
   *  arrives with wght already at 0.48) — and it is what a declared family's
   *  axis location pins in place of any CSS-derived `wght`: Blink applies only
   *  `opsz` + font-variation-settings on top of the matched face
   *  (font_platform_data_mac.mm:113-208, Chromium tag 147.0.7727.15 and rev
   *  7d859f27 — identical). Absent for static faces, static-table keys, and
   *  helper binaries predating the family-query axis report. */
  ctAxes?: DarwinHandleAxis[];
}

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
// DM-1980: deliberately NOT `hostPlatform()` — this picks a BUNDLED ASSET
// path, not a routing decision, and the asset that ships with the package
// does not change because we are simulating another OS.
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
  // Chrome resolves `font-family:"Hiragino Sans"` to the HiraginoSans-W* cut
  // whose OS/2.usWeightClass EXACTLY matches the CSS weight — measured over
  // 100..900 with CDP getPlatformFontsForNode: 100→W0 200→W1 300→W3 400→W4
  // 500→W5 600→W6 700→W7 800→W8 900→W9. (W2 exists at usWeightClass 250 and is
  // never selected, because no CSS weight lands there.) The base key is W4, the
  // weight-400 cut — NOT HiraKakuProN-W3, which is a different family
  // (Hiragino Kaku Gothic ProN) that merely shares the W3 .ttc container.
  "hiragino-jp":      { path: "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc", postscriptName: "HiraginoSans-W4" },
  "hiragino-jp-bold": { path: "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", postscriptName: "HiraginoSans-W6" },
  "hiragino-jp-w0":   { path: "/System/Library/Fonts/ヒラギノ角ゴシック W0.ttc", postscriptName: "HiraginoSans-W0" },
  "hiragino-jp-w1":   { path: "/System/Library/Fonts/ヒラギノ角ゴシック W1.ttc", postscriptName: "HiraginoSans-W1" },
  "hiragino-jp-w3":   { path: "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", postscriptName: "HiraginoSans-W3" },
  "hiragino-jp-w4":   { path: "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc", postscriptName: "HiraginoSans-W4" },
  "hiragino-jp-w5":   { path: "/System/Library/Fonts/ヒラギノ角ゴシック W5.ttc", postscriptName: "HiraginoSans-W5" },
  "hiragino-jp-w6":   { path: "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc", postscriptName: "HiraginoSans-W6" },
  "hiragino-jp-w7":   { path: "/System/Library/Fonts/ヒラギノ角ゴシック W7.ttc", postscriptName: "HiraginoSans-W7" },
  "hiragino-jp-w8":   { path: "/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc", postscriptName: "HiraginoSans-W8" },
  "hiragino-jp-w9":   { path: "/System/Library/Fonts/ヒラギノ角ゴシック W9.ttc", postscriptName: "HiraginoSans-W9" },
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
  // LucidaGrande.ttc's bold member. Chrome switches the whole family over to it
  // from CSS weight 450 up — an ↑ or ✓ falling back to Lucida Grande inside a
  // bold heading is painted BOLD, not regular. Measured over 100…900 in
  // 10-point steps with `CSS.getPlatformFontsForNode` (Chromium on macOS) for
  // arrow / Hebrew / check-mark codepoints alike: 100-440 → LucidaGrande,
  // 450-900 → LucidaGrande-Bold. The 450 boundary is the platform matcher's,
  // not the CSS font-matching walk's — the two faces declare
  // `OS/2.usWeightClass` 500 and 600, which the spec algorithm would split at a
  // different point.
  "lucida-grande-bold": { path: "/System/Library/Fonts/LucidaGrande.ttc", postscriptName: "LucidaGrande-Bold" },
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
  // Helvetica.ttc also carries a LIGHT cut (`OS/2.usWeightClass` 300) that the
  // regular/bold pair above hides. Chrome picks it for every CSS weight ≤ 300 —
  // measured over the whole 100…700 range with `CSS.getPlatformFontsForNode`
  // (Chromium on macOS): 100-300 → Helvetica-Light, 310-590 → Helvetica,
  // 600-700 → Helvetica-Bold, with the oblique column parallel. Routed by
  // `subBoldWeightCutSuffix` in getFontInstance.
  "helvetica-light":        { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-Light" },
  "helvetica-light-italic": { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-LightOblique" },
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
  // DM-1924: name the member this key means, because opening a COLLECTION by
  // path alone selects member 0 and that is the vendor's ordering, not a face
  // any routing table meant. `NotoSansMyanmar.ttc` carries 18 members and member
  // 0 is **Black**, so every Myanmar run painted at weight 900 whatever the CSS
  // asked for — and nothing downstream could notice, since `postscriptName` and
  // `naturalWeight` both came back undefined on the instance. Chrome, asked over
  // CDP, answers `NotoSansMyanmar-Regular` at weight 400: U+1000 advance 1124,
  // against Black's 1121.
  //
  // Same defect this repo already fixed once for `NotoSansArmenian.ttc`, whose
  // member 0 is also Black. Members 9-17 here are Zawgyi, a non-Unicode Myanmar
  // encoding, so a fix by member INDEX rather than by name would have traded a
  // weight error for mojibake.
  //
  // Overridden here rather than edited into the generated table, which says not
  // to edit it by hand and would lose this on the next sweep. The generator is
  // what should learn to emit a name. The spread above comes first, so this wins.
  // `family` is deliberately absent: it is not part of `FontPath`, and
  // `generatedRouteUsable` reads it from `UNICODE_FONT_PATHS` directly.
  //
  // Weight 400 only. Chrome answers `NotoSansMyanmar-Bold` at 700, so this family
  // has a ladder inside the container that one pinned member cannot serve; at 700
  // the renderer now synthesises bold over Regular instead of taking the Bold
  // member. Still strictly better than Black at every weight, and the ladder
  // belongs with the per-family weight-ladder work.
  //
  // The SIBLING renames this started as — the SF faces and the other Noto
  // variable files — are NOT here. They measured as pure improvements in
  // isolation (by-name equals HarfBuzz exactly where by-path does not) and are
  // inert locally, yet the branch carrying them regressed a fixture on CI by 30x
  // worst tile, reproducibly, against a control ref run twice. Until that is
  // explained they stay out; see the ticket.
  "u-noto-sans-myanmar": { path: "/System/Library/Fonts/NotoSansMyanmar.ttc", postscriptName: "NotoSansMyanmar-Regular", extractor: "native" as const },
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
  // cursive / fantasy. Asking fontconfig for its own `cursive` / `fantasy`
  // aliases is the intuitive move and it is the WRONG QUESTION: Blink never
  // asks fontconfig for these. `FontSelector::FamilyNameFromSettings` maps the
  // generic to a browser-side settings value — `settings.Cursive(script)` /
  // `settings.Fantasy(script)` (`platform/fonts/font_selector.cc:80-83`, rev
  // 7d859f27) — and when the configured family is not installed that value
  // falls through to the same face `serif` resolves to.
  //
  // Measured in the pinned noble image (Chromium 147.0.7727.0, CDP
  // `CSS.getPlatformFontsForNode`): Chrome answers **Liberation Serif** for
  // both generics. fontconfig's aliases answer WenQuanYi Zen Hei, and that gap
  // cost 448,990 mismatches — 63.5% of the platform's entire full-corpus
  // mismatch mass — because the generic is the run's PRIMARY, so one wrong
  // answer applies to every codepoint the stack touches.
  //
  // `snell` keeps the fontconfig alias: it is an author-NAMED family, not a
  // settings-mapped generic, so Blink resolves it through the normal family
  // matcher and a substitute is the right behaviour.
  "snell":           { fcMatch: "cursive" },
  "apple-chancery":  { fcMatch: "Liberation Serif", path: `${LIB}/LiberationSerif-Regular.ttf` },
  "papyrus":         { fcMatch: "Liberation Serif", path: `${LIB}/LiberationSerif-Regular.ttf` },
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
  resolvedAxes?: Record<string, number>,
  ctAxes?: DarwinHandleAxis[],
): void {
  if (dynamicSystemFontPaths.has(key)) return;
  dynamicSystemFontPaths.set(key, { path, postscriptName, extractor, resolvedAxes, ctAxes });
  resolvedSpecCache.delete(key); // in case a prior null was cached
}

/**
 * Relocate a table entry whose declared file is not on this host.
 *
 * The path tables hardcode where a system font lived when the entry was
 * written, and the OS moves them: on current macOS all eight PingFang keys
 * declare `/System/Library/Fonts/PingFang.ttc`, which no longer exists — the
 * faces now ship inside `FontServices.framework/…/Reserved/PingFangUI.ttc`.
 * Nothing looked broken because those entries are `extractor: "native"`, so the
 * helper opens them by PostScript name through CoreText and the declared path
 * is never dereferenced on the happy path. But `resolveFontSpec(key).path` is
 * read directly elsewhere — the embedded-subset builder reads those bytes, and
 * mistaking the base entry for the rendered face was the conformance oracle's
 * own instrument bug — so a path that cannot be opened is a live hazard, not
 * cosmetic.
 *
 * Rather than swap one machine's literal for another's, ask the OS: when the
 * declared file is absent and we know the PostScript name, take the path
 * CoreText reports for that face. Self-healing across OS relocations, and it
 * keeps the table honest about what it actually points at.
 *
 * No-op where it cannot help: platforms without the native helper get `null`
 * from `resolveInstalledFont` and keep the declared entry unchanged, which is
 * exactly the previous behavior.
 */
function relocateMissingSpec(spec: FontPath | null): FontPath | null {
  if (spec?.path == null || spec.path === "" || spec.postscriptName == null) return spec;
  if (existsSync(spec.path)) return spec;
  const installed = resolveInstalledFont(spec.postscriptName);
  if (installed?.path == null || !existsSync(installed.path)) return spec;
  return { ...spec, path: installed.path };
}

/**
 * Every font key the CURRENT platform's routing table declares.
 *
 * Read-only enumeration for tooling that has to sweep the routing surface
 * rather than answer one lookup — the shape-agreement harness
 * (`tools/shape-agreement.ts`) uses it to enumerate the faces the renderer can
 * actually pick on this host. Deliberately not the union of all three tables:
 * a key from another platform's table would resolve to a path that does not
 * exist here, and a sweep that silently skipped it would report coverage it
 * never had.
 *
 * Dynamic keys (`sysfb:` / `winfam:`, discovered at runtime by the live
 * per-codepoint resolver) are excluded — they exist only once something has
 * asked for them, so enumerating them at startup would return an empty or
 * order-dependent set.
 */
export function platformFontKeys(): string[] {
  switch (hostPlatform()) {
    case "linux": return Object.keys(LINUX_FONT_PATHS);
    case "win32": return Object.keys(WIN32_FONT_PATHS);
    default:      return Object.keys(FONT_PATHS);
  }
}

export function resolveFontSpec(key: string): FontPath | null {
  // Platform joins the memo key because the ANSWER is per-platform — the switch
  // below picks a different table for each. In production `hostPlatform()` never
  // varies and the component is dead weight; under `withHostPlatform()` it does,
  // and a name-only key then serves whichever platform asked first. Third cache
  // in this file to need it, for the same reason and with the same production
  // impact: none.
  const memoKey = `${hostPlatform()}|${key}`;
  if (resolvedSpecCache.has(memoKey)) return resolvedSpecCache.get(memoKey)!;
  let resolved: FontPath | null;
  if (key.startsWith("sysfb:") || key.startsWith("winfam:")) {
    // Already discovered on this host — by the live per-codepoint resolver
    // (`sysfb:`) or by resolving one of Blink's hardcoded Windows family names
    // through DirectWrite (`winfam:`). Either way the path came from the OS, so
    // there is nothing to relocate.
    resolved = dynamicSystemFontPaths.get(key) ?? null;
  } else {
    switch (hostPlatform()) {
      case "linux": resolved = resolveLinuxSpec(key); break;
      case "win32": resolved = resolveWin32Spec(key); break;
      default:      resolved = FONT_PATHS[key] ?? null; break; // darwin + any other Unix with macOS-style paths
    }
    resolved = relocateMissingSpec(resolved);
  }
  resolvedSpecCache.set(memoKey, resolved);
  return resolved;
}

// DM-1018: per-codepoint memo of the resolved `sysfb:` key (or null when the
// CoreText cascade falls through to LastResort — Chrome paints its placeholder
// there, handled by the primary-`.notdef` terminal).
// Keyed `<cp>|<weight>|<italic>|<size>`, not on the codepoint alone: on macOS
// the answer is weight- and style-dependent, because Blink re-selects the cut
// within the substitute family (see `resolveSystemFallbackFonts`).
const systemFallbackKeyCache = new Map<string, string | null>();

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
  hostPlatform() === "darwin"
  || (hostPlatform() === "linux" && process.env.DOMOTION_SYSTEM_FALLBACK !== "0")
  || (hostPlatform() === "win32" && process.env.DOMOTION_SYSTEM_FALLBACK !== "0");
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
/** DM-1852. Blink asks CoreText for a substitute FROM the run's current font —
 *  `CTFontCreateForString(ct_font, …)`, font_cache_mac.mm:128-150 — and the
 *  cascade it gets back depends on that base. We used to pass a hardcoded
 *  "Helvetica" regardless of what the run paints in, i.e. the right API asked
 *  the wrong question.
 *
 *  DEFAULT-ON as of the measurement below; set `DOMOTION_FALLBACK_BASE=0` to
 *  restore the old hardcoded base for an A/B.
 *
 *  Measured before flipping, because the blast radius is every codepoint that
 *  reaches the live resolver:
 *
 *   - Conformance oracle, 8 corpus stacks × 1,247 codepoints of Greek /
 *     Cyrillic / Hebrew / Arabic / punctuation / currency / arrows / math:
 *     mismatches 2,581 → 2,287. Row-level, 294 fixed, **0 broken**, 0 routes
 *     worse.
 *   - Full 818-fixture macOS unicode sweep, both arms dispatched from ONE
 *     pushed ref so the flag was the only difference (CI runs 30500986491
 *     unarmed / 30501906014 armed, env confirmed in each shard's log):
 *     **0 regressions, 0 fixes, and not a single fixture's pixels moved.**
 *
 *  Those two together are the case for the default: strictly better agreement
 *  with Chrome's font selection, and provably zero visual change on the corpus.
 *  The affected decisions are concentrated in codepoints whose faces differ
 *  without the pixels differing — largely uncovered codepoints where both sides
 *  draw a notdef. */
const _fallbackBaseFromPrimary = process.env.DOMOTION_FALLBACK_BASE !== "0";

/** Memo for `fallbackBaseFor` — the base is asked for once per codepoint, and
 *  the cut resolution behind it walks the platform style matcher. */
const fallbackBaseCache = new Map<string, { name: string; path?: string }>();

/** The cascade base to ask CoreText from, for a run whose primary is `primaryKey`
 *  at this CSS style.
 *
 *  Returns the PostScript name plus — importantly — the on-disk path. The path
 *  is what lets the helper open Apple's hidden `.`-prefixed faces: CoreText
 *  refuses those by name and hands back Times New Roman WITHOUT erroring, so a
/**  name-only lookup would silently walk the wrong font's cascade.
 *
 *  Blink's cascade base is the run's CURRENT font — `font_fallback_list_->
 *  PrimarySimpleFontDataWithSpace(font_description_)` (`shaping/
 *  font_fallback_iterator.cc:279-281`, tag 147.0.7727.15), i.e. the face
 *  `MatchFontFamily` selected AT THE CSS STYLE, not the family's base entry.
 *  The cut is load-bearing rather than cosmetic: `CTFontCreateForString`'s
 *  nomination tracks the base's own boldness — asked from Times-Roman it
 *  nominates STSongti-SC-Regular for U+3400, asked from Times-Bold it nominates
 *  STSongti-SC-Bold, and Chrome paints the Bold.
 *
 *  Nor is it recoverable further down: the in-family re-selection that follows
 *  only adopts a better-matching face when that face still COVERS the
 *  character, so for every ideograph Songti SC Black does not carry — most of
 *  CJK Extension A — a `font-weight: 800` serif run kept the Regular face
 *  nominated from an unweighted base.
 *
 *  The base is taken from `getFontInstance`, not from the static cut ladder,
 *  because on darwin that is the call that runs the declared-family style
 *  matcher — our equivalent of `MatchFontFamily`, whose answer REPLACES the
 *  ladder rather than composing with it. Reading the ladder alone would
 *  reproduce the inputs to Blink's re-selection but not its nomination.
 *
 *  `DOMOTION_FALLBACK_BASE_CUT=0` restores the base-entry behavior for an A/B.
 *  At 400 / upright / 100% the instance IS the base entry, so this changes
 *  nothing there by construction. */
const _fallbackBaseCutEnabled = process.env.DOMOTION_FALLBACK_BASE_CUT !== "0";

function fallbackBaseFor(
  primaryKey: string | undefined, weight: number = 400, fontSize: number = 16,
  slant: number = 0, stretch: number = 100,
): { name: string; path?: string } {
  if (!_fallbackBaseFromPrimary || primaryKey == null) return { name: "Helvetica" };
  const cacheKey = `${primaryKey}|${weight}|${fontSize}|${slant !== 0 ? 1 : 0}|${stretch}`;
  const hit = fallbackBaseCache.get(cacheKey);
  if (hit !== undefined) return hit;

  // Webfont / local-alias keys have no cut ladder of their own — they resolve
  // through their own registries — so they are read as-is.
  const isRegistryKey = primaryKey.startsWith("webfont:") || primaryKey.startsWith("localalias:");
  // Start from the STATIC CUT LADDER, not the raw key. The ladder maps some
  // families to a different file even at 400/upright (a `cursive` primary is
  // one), so reading `primaryKey` directly changes the cascade base for every
  // such family at the default style — which is not a style-matching decision
  // at all. Skipping this cost 18 `cursive` stacks 14 -> ~1,046 mismatches
  // apiece on the synthetic corpus, at weight 400 where the style branch below
  // never even runs.
  const cutKey = isRegistryKey
    ? primaryKey
    : resolveEffectiveCutKey(primaryKey, weight, slant, stretch).key;
  const spec = resolveFontSpec(cutKey) ?? resolveFontSpec(primaryKey);
  let base: { name: string; path?: string };
  if (spec?.postscriptName == null || spec.postscriptName === "") {
    base = { name: "Helvetica" };
  } else {
    base = { name: spec.postscriptName, path: spec.path };
    if (_fallbackBaseCutEnabled && !isRegistryKey
        && (weight !== 400 || slant !== 0 || stretch !== 100)) {
      const inst = getFontInstance(primaryKey, weight, fontSize, slant, undefined, stretch);
      const ps = inst?.postscriptName;
      if (inst != null && ps != null && ps !== "" && ps !== spec.postscriptName) {
        base = { name: ps, path: getFontSourceInfo(inst)?.path ?? spec.path };
      }
    }
  }
  fallbackBaseCache.set(cacheKey, base);
  return base;
}

/** `kColorEmojiFontMac[]` — `mac/font_cache_mac.mm:288`. The STANDARD face, not
 *  the hidden `.AppleColorEmojiUI` variant the UI-font cascade reaches. */
const COLOR_EMOJI_FONT_MAC = "Apple Color Emoji";

/**
 * Blink's `IsAppleColorEmojiFont` (`mac/font_cache_mac.mm:117-125`) — a family
 * name test, case-insensitive, over exactly two names.
 *
 * The hidden `.Apple Color Emoji UI` arm is not incidental: it is the face a
 * `system-ui` run's cascade reaches, so a predicate carrying only the public
 * name would answer "not colour emoji" for every system-ui run and silently
 * disable everything gated on it.
 */
function isAppleColorEmojiFamily(familyName: string | undefined): boolean {
  if (familyName == null) return false;
  const n = familyName.toLowerCase();
  return n === "apple color emoji" || n === ".apple color emoji ui";
}

/** DM-1859. Route a `system-ui` run's per-codepoint fallback through the
 *  helper's UI-font base mode, so CoreText walks the cascade Blink walks.
 *
 *  A `system-ui` family does not go through Blink's normal family matcher at all
 *  — `mac/font_cache_mac.mm:409-412` sends it to `MatchSystemUIFont`, which
 *  builds the base with `CTFontCreateUIFontForLanguage(kCTFontUIFontSystem,
 *  size, nullptr)` (`mac/font_matcher_mac.mm:540-588`). Per-codepoint fallback
 *  then walks FROM that font, and Blink's own comment names the consequence
 *  (`mac/font_cache_mac.mm:156-159`): the system API "might also return '.Apple
 *  Color Emoji UI' when starting from system-ui". Apple's hidden `.…UI` variants
 *  are reachable only that way — the UI font carries its own cascade list, and
 *  opening `SFNS.ttf` by path instead gives a plain font with the default
 *  cascade (measured: `PingFangSC-Regular` at every size and weight).
 *
 *  DEFAULT-ON as of the measurement below; set `DOMOTION_SYSTEM_UI_BASE=0` to
 *  restore the old hardcoded-base behavior for an A/B.
 *
 *  Measured before flipping, as a 2×2 against `_liveFallbackFirst` — because
 *  neither flag can be scored alone. Conformance oracle, CJK slice (8 corpus
 *  stacks × 28,309 codepoints = 226,472 comparisons), all four cells run at one
 *  revision with one instrument:
 *
 *              | chain-first        | OS-first (default)
 *    ----------|--------------------|-------------------
 *    base OFF  | 113,963 / 27 rts   | 113,407 / 16 rts
 *    base ON   | 113,908 / 23 rts   |  29,025 /  4 rts
 *
 *  Read the interaction, not the margins. Against the all-off cell: this base fix
 *  alone is **−55** rows, `_liveFallbackFirst` alone is **−556**, and both
 *  together are **−84,938 (−75%)**. Only 611 of that is explained by the two
 *  flags separately — the remaining **84,327 rows exist only when both are on**.
 *  Asking CoreText the right question cannot pay while the static per-block chain
 *  answers first, and asking in the right order cannot pay while the question
 *  names the wrong base font.
 *
 *  What moves is the concentration this ticket was filed for: all three
 *  `.PingFangUI*` routes — 83,838 rows, 73% of the slice's mismatch mass — go to
 *  zero, taking the `system-ui` stack from 84,567 mismatches to 185.
 *
 *  That interaction is also why `_liveFallbackFirst`'s own comment quotes 29,025
 *  as its result: that figure was measured with this flag armed, and is not
 *  reproducible from `_liveFallbackFirst` alone. The honest attribution is the
 *  table above.
 *
 *  The mechanism itself is verified against Chrome independently of any corpus
 *  score — CDP `CSS.getPlatformFontsForNode`, `font-family: system-ui`, U+6F22,
 *  **18/18 exact** across 9 CSS weights × 2 sizes, including the two rows that
 *  prove it has to be a call rather than a lookup: at 13px only weights 400 and
 *  700 stay in the Text cut (every other weight jumps to Display), and adding
 *  `font-style: italic` at 13px moves the answer from Text to Display because
 *  PingFang has no italic. No table would have carried those rules, and a
 *  sampled one that happened to capture them would be freezing one OS version's
 *  behavior into source. */
const _systemUiBaseEnabled = process.env.DOMOTION_SYSTEM_UI_BASE !== "0";

/** DM-1916: route a `trak` + `STAT` face's shaping to HarfBuzz (outlines stay
 *  with the platform helper). DEFAULT-ON; set `DOMOTION_TRAK_HB_SHAPING=0` to
 *  force the platform shaper for an A/B.
 *
 *  Exists because the faces it covers are `system-ui` and CJK, so the blast
 *  radius is most macOS body text and a fixture that moves cannot be attributed
 *  by re-running one ref — several of the affected fixtures are independently
 *  bistable from a Chrome-side `sans-serif` flip. Both arms then run from ONE
 *  ref on ONE runner, and the flag is the only difference. */
const _trakHbShapingEnabled = process.env.DOMOTION_TRAK_HB_SHAPING !== "0";

/** DM-1868. Put the two kSystemFonts stages in Blink's order — ask the OS first,
 *  and keep the static per-block chain only as the net for what the OS declines.
 *
 *  DEFAULT-ON **on macOS and Linux**; set `DOMOTION_LIVE_FALLBACK_FIRST=0` to
 *  restore the old static-chain-first order for an A/B.
 *
 *  The order is not a tuning choice, it is what `FontFallbackIterator::Next`
 *  does (`font_fallback_iterator.cc:120-157`, Chromium rev 7d859f27): there is no
 *  static per-Unicode-block stage anywhere in Blink's walk, so our chain sits
 *  exactly where Blink asks the OS and pre-empts it. See the step-2 comment in
 *  `resolveFontForCodepoint`.
 *
 *  **Windows is deliberately excluded, and this asymmetry must not be
 *  "simplified" away.** `kSystemFonts` bottoms out in
 *  `FontCache::PlatformFallbackFontForCharacter`, which is a DIFFERENT procedure
 *  per platform, so "ask the OS first" is only Blink's order on two of the three:
 *
 *   - macOS (`mac/font_cache_mac.mm`) → `CTFontCreateForString` directly.
 *   - Linux (`linux/font_cache_linux.cc:89-97`) → `GetFontForCharacter` →
 *     fontconfig directly. No table stage precedes it.
 *   - Windows (`win/font_cache_skia_win.cc:285-295`) →
 *     `GetFallbackFamilyNameFromHardcodedChoices` **first**, and
 *     `GetDWriteFallbackFamily` only "fall through to running the API-based
 *     fallback" on a miss.
 *
 *  On Windows the hardcoded per-script table IS Chrome's first answer, and we
 *  transcribe it (`win-font-fallback.ts`, reached via `win32FallbackChain`), so
 *  running our static chain BEFORE the live DirectWrite resolver is what matches
 *  Blink there. Flipping this on win32 would put `MapCharacters` ahead of the
 *  table and invert the very order it was transcribed to reproduce. The principle
 *  is not "no tables" — it is transcribed-from-Chromium rather than
 *  sampled-from-a-machine (docs/106 §4).
 *
 *  Measured before flipping, because the blast radius is every codepoint the
 *  static chain covers:
 *
 *   - Conformance oracle, CJK slice, 8 corpus stacks × 28,309 codepoints:
 *     mismatches **113,963 → 29,025**, routes 27 → 4, agree-exact 49.4% → 86.9%.
 *     All three `.PingFangUI*` routes collapse to zero, and on ext-B every
 *     wrong `→ PingFangHK-Regular` route (2,139 rows on the largest alone)
 *     collapses to zero — we were painting the Hong Kong regional variant where
 *     Chrome paints SC.
 *
 *     **Attribution correction (DM-1859).** That 29,025 was measured with the
 *     `system-ui` cascade base armed, which was still off by default when this
 *     was written, so the figure is not reproducible from this flag alone. Re-run
 *     as a 2×2 at one revision: this flag alone moves 113,963 → **113,407**, and
 *     the two together give 29,025. The `.PingFangUI*` collapse needs both — see
 *     the table on `_systemUiBaseEnabled`. Neither flag is scoreable in
 *     isolation, which is the general hazard: a fix to a stage another stage
 *     shadows measures as worthless until the shadow is lifted.
 *   - Full 818-fixture macOS unicode sweep, both arms from ONE pushed ref so the
 *     flag was the only difference: only 4 of 818 fixtures moved at all, one
 *     improved, and the single threshold crossing is documented below.
 *
 *  The one fixture that moved the wrong way — a CJK ext-B tile, diffPct 0.0502 →
 *  0.0519 — was run to ground and is NOT a defect: on the cell in question Chrome
 *  paints PingFang SC, the old order painted PingFang HK (wrong), the new order
 *  paints SC (right), our glyph x-positions match Chrome's exactly, and the
 *  helper returns the requested face's own outline (glyph 40500, path length
 *  4665 — distinct from the UI-Text cut's 4680 and Medium's 4617). What is left
 *  is ours rasterizing ~4.8% lighter than Skia's stem-darkened raster at 17px,
 *  i.e. the documented rasterization floor. The old arm scored closer by
 *  coincidence: the WRONG face's outline happened to rasterize nearer Chrome's
 *  hinted raster than the correct face's does. Closer-with-the-wrong-font is not
 *  correctness, which is exactly the confusion a pixel metric cannot resolve and
 *  the conformance oracle can. That fixture's committed CI baseline was refreshed
 *  in this change to record the correct-face raster. */
const _liveFallbackFirst =
  hostPlatform() !== "win32" && process.env.DOMOTION_LIVE_FALLBACK_FIRST !== "0";

/**
 * Does this family stack's PRIMARY resolve through Blink's system-ui path?
 *
 * Blink splits what `matchFamilyNameToKey` merges. `system-ui` and
 * `BlinkMacSystemFont` go to `MatchSystemUIFont` — the platform UI font, built
 * by `CTFontCreateUIFontForLanguage` with its own cascade list — while an
 * explicitly-named `"SF Pro"` / `"SF Pro Text"` goes to `MatchFontFamily`
 * (`mac/font_cache_mac.mm:409-417`). All of them land on our single `sf-pro`
 * key, so the key alone cannot distinguish them.
 *
 * Deliberately NOT fixed by splitting the key: `sf-pro`'s Latin metrics are
 * load-bearing (DM-291 measured SF Pro's advances ~3% wider than Helvetica's,
 * which is why bare `-apple-system` is excluded from that mapping in the first
 * place), and a second key would have to reproduce every one of its entries
 * across three platform tables plus the italic sibling to stay metric-identical.
 * The distinction only matters for the fallback BASE, so it travels as its own
 * signal.
 *
 * Matches on the FIRST family in the stack, since that is the one whose primary
 * the cascade is walked from. `-apple-system` is excluded on purpose, matching
 * `matchFamilyNameToKey`: Chrome resolves it to the UA standard font, not to the
 * UI font, so it falls through the stack rather than becoming the primary.
 */
export function stackPrimaryIsSystemUi(fontFamily: string | undefined): boolean {
  if (fontFamily == null || fontFamily === "") return false;
  const first = fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
  return first === "system-ui" || first === "blinkmacsystemfont";
}

// A batch pre-warm of the system-fallback helper (`warmSystemFallbackForCodepoints`)
// lived here from DM-1889 until DM-1893 deleted it. It asked the helper about a
// whole sweep batch up front so the per-codepoint calls below found the memo
// already populated. Deleted rather than kept gated off, for two reasons:
//  - Its motivation was Windows' per-call spawnSync cost (8.24 ms/codepoint),
//    which the persistent named-pipe helper channel then fixed ~83x at the
//    transport level; on macOS the batch saved ~0.05 ms/codepoint over the
//    already-persistent channel — about a minute across a full conformance
//    sweep whose runtime is dominated by the Chrome side.
//  - It was blamed for moving macOS conformance answers, but the mismatch
//    movement decomposed entirely as CHROME's answers flipping among CJK
//    cousin faces run to run (the conformance oracle's own instability, since
//    detected by the per-face `chromeFaceCounts` baseline comparison). Blink
//    itself performs fallback per character (`PlatformFallbackFontForCharacter`,
//    mac/font_cache_mac.mm:314, rev 7d859f27), so a batch pre-ask was pure
//    infrastructure with no mechanism-parity value to preserve.
// The lazy per-codepoint path below is the only ask pattern that remains.

/**
 * DM-1949: the macOS per-character fallback cache for ideographs — Blink's
 * `character_fallback_cache_`, modeled as DOCUMENT-scoped ordered state.
 *
 * Blink (mac/font_cache_mac.mm:330-372, checkout rev 7d859f27, byte-identical
 * at shipping tag 147.0.7727.15, where the `MacCharacterFallbackCache` runtime
 * feature is `status: "stable"` — i.e. ON in the Chrome we target): for a
 * codepoint with the Unicode property [:Ideographic=Yes:], the result of the
 * system-fallback ask (`GetAlternateFontPlatformData` — the CoreText cascade
 * plus the in-family traits/weight re-selection) is cached under
 * `CharacterFallbackKey` and returned for any LATER ideograph the cached face
 * covers, without re-asking CoreText. Blink's own comment names the cost: it
 * "can introduce context sensitivity of fallback for individual characters."
 * So Chrome's answer for an ideograph depends on which ideograph asked FIRST
 * in that renderer — and matching Chrome means modeling that order.
 *
 * Transcribed semantics, each load-bearing:
 *
 *  - KEY (`CharacterFallbackKey::Make`, mac/character_fallback_cache.mm:86-105):
 *    the BASE font's PostScript name + raw weight + raw style + orientation +
 *    effective font size. The base is the run's primary
 *    (`font_fallback_list_->PrimarySimpleFontDataWithSpace(...)`,
 *    shaping/font_fallback_iterator.cc:279-281 at tag 147.0.7727.15) — our
 *    `fallbackBaseFor(primaryKey).name`. Orientation is constant-horizontal in
 *    this resolver, and style folds to the same italic bit the raw ask itself
 *    discriminates on, so neither needs more resolution than the ask has.
 *  - NO KEY for dot-prefixed faces (`BuildIdentifierKey`,
 *    character_fallback_cache.mm:36-82): a `.`-PS-named font yields a key only
 *    when its descriptor carries BOTH `NSCTFontUIUsageAttribute` and
 *    `CTFontDescriptorLanguageAttribute`. Blink builds the UI font with
 *    `CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, size, nullptr)`
 *    (mac/font_matcher_mac.mm:540-588), and with a null language the descriptor
 *    has NO language attribute (probed with the identical API call: keys are
 *    ["NSCTFontUIUsageAttribute", "NSFontSizeAttribute"]) — so a `system-ui`
 *    base is NEVER cached in shipping Chrome, and must not be here either.
 *  - HIT = cached face covers the codepoint (`unicharToGlyph(character)`,
 *    font_cache_mac.mm:361-366) — a cmap check on the CACHED face, at the same
 *    weight/size/slant the key pins.
 *  - FIRST WRITER WINS: the insert is WTF `HashMap::insert`, which "does
 *    nothing if key is already present" (wtf/hash_map.h:184-188 at tag
 *    147.0.7727.15). A later ideograph the cached face does not cover re-asks
 *    CoreText every time and NEVER replaces the entry. Only successful asks
 *    insert (`if (!alternate_font) return nullptr` precedes it).
 *
 * SCOPE — the part that is deliberately different from every other cache in
 * this module. Blink's map lives on `FontCache` (font_cache.h:338), reached via
 * `FontCache::Get()` → `FontGlobalContext::GetFontCache()` (font_cache.cc:121)
 * — per renderer main thread, which for Domotion's one-page-per-capture flow
 * is per captured document. Modeling it process-globally would make answers
 * depend on SWEEP order (which fixture rendered first in this Node process);
 * scoping it to an explicitly-begun document makes them depend on DOCUMENT
 * order, which is the thing being modeled. Therefore:
 *
 *  - The map exists ONLY between `beginCharacterFallbackDocument()` /
 *    `endCharacterFallbackDocument()`. No active document → no lookup, no
 *    insert — the resolver stays context-free exactly as before.
 *  - Every top-level render entry opens a FRESH document scope (depth-counted,
 *    `finally`-paired), so no state can survive into the next render; the
 *    animator opens ONE scope spanning all frames, because Chrome's cache
 *    persists across the frames of one capture session.
 *  - `clearFontResolutionCaches()` does NOT clear it: it is modeled state, not
 *    a memo — Chrome's cache is not dropped when our sweep trims memory. The
 *    entries are key strings; the faces they name re-materialize through the
 *    `dynamicSystemFontPaths` registry, which that reset also preserves.
 *
 * The value stored is the final resolved `sysfb:` key — the post-re-selection
 * answer, exactly what Blink caches (the `FontPlatformData` AFTER
 * `GetAlternateFontPlatformData`'s in-family re-selection).
 *
 * Set `DOMOTION_MAC_CHAR_FALLBACK_CACHE=0` to disable the model for an A/B —
 * with it off, every ideograph resolves context-free (the pre-DM-1949
 * behavior), which is how "is this mechanism actually in the loop" is checked.
 */
const _macCharFallbackCacheEnabled = process.env.DOMOTION_MAC_CHAR_FALLBACK_CACHE !== "0";
let _charFallbackDocCache: Map<string, string> | null = null;
let _charFallbackDocDepth = 0;

/** Open a document scope for the ideograph fallback cache (nested calls share
 *  the outermost scope). Pair with `endCharacterFallbackDocument` in `finally`. */
export function beginCharacterFallbackDocument(): void {
  if (_charFallbackDocDepth === 0) _charFallbackDocCache = new Map();
  _charFallbackDocDepth++;
}

/** Close the current document scope; the outermost close drops the state. */
export function endCharacterFallbackDocument(): void {
  if (_charFallbackDocDepth > 0) _charFallbackDocDepth--;
  if (_charFallbackDocDepth === 0) _charFallbackDocCache = null;
}

/** Test-only window into the active document cache (null when none is open). */
export function __characterFallbackDocumentCacheForTest(): Map<string, string> | null {
  return _charFallbackDocCache;
}

/**
 * The `CharacterFallbackKey` for this ask, or null when Blink would not cache:
 * no open document, feature off, not [:Ideographic=Yes:], not the darwin path,
 * or a base whose key `BuildIdentifierKey` declines (dot-prefixed / UI font —
 * see the block comment above for the probe establishing the UI font has no
 * language attribute, hence no key).
 */
function characterFallbackDocKey(
  cp: number, baseName: string, useSystemUiBase: boolean,
  weight: number, slant: number, fontSize: number,
): string | null {
  if (_charFallbackDocCache == null || !_macCharFallbackCacheEnabled) return null;
  if (hostPlatform() !== "darwin") return null;
  if (useSystemUiBase || baseName.startsWith(".")) return null;
  if (!isIdeographicCp(cp)) return null;
  return `${baseName}|${weight}|${slant !== 0 ? 1 : 0}|${fontSize}`;
}

function resolveSystemFallbackKeyForCp(
  cp: number, weight: number = 400, slant: number = 0, fontSize: number = 16,
  primaryKey?: string, systemUiPrimary: boolean = false,
  // DM-1863: the content locale. Blink passes it on the Linux path —
  // `font_description.LocaleOrDefault().Ascii().c_str()` reaches fontconfig as
  // FC_LANG (`linux/font_cache_linux.cc:88-95`, rev 7d859f27) — and it decides
  // Han unification: the same unified ideograph legitimately resolves to a
  // Japanese face under `lang="ja"` and a Chinese one under `lang="zh"`. Asking
  // without it produces a face that is wrong in a way that reads as a
  // font-inventory problem rather than a dropped argument.
  lang?: string,
  /** CSS `font-stretch` as a percentage (100 = `normal`). Only reaches the
   *  cascade BASE — it selects which cut of the primary family the substitute is
   *  asked from, the same way weight and slant do. */
  stretch: number = 100,
  /** The run's `font-variant-emoji` override (`normal` = undefined). `text`
   *  forces the fallback priority to `kText`
   *  (`ApplyFontVariantEmojiOnFallbackPriority`, `shaping/harfbuzz_shaper.cc:184-198`,
   *  rev 7d859f27) BEFORE any platform stage reads it — so the emoji-presentation
   *  special-casing here (the macOS Apple Color Emoji short-circuit, the Linux
   *  U+1F46A/`und-Zsye` substitution, the Linux bold-retry exclusion) must not
   *  fire for an `Emoji` codepoint. Measured: under `text`, U+26A1 resolves to
   *  Apple Symbols and U+2B50 to STIX Two Math instead of Apple Color Emoji —
   *  exactly what the suppressed cascade finds. (`emoji` is handled UPSTREAM:
   *  `resolveFontForCodepointInner` routes to the color-emoji face before this
   *  stage is reached.) */
  fontVariantEmoji?: FontVariantEmojiOverride,
): string | null {
  const suppressEmojiPresentation = fontVariantEmoji === "text" && isEmojiCharCp(cp);
  /** Blink's condition for the monochrome-emoji replacement, verbatim: an
   *  `Emoji` character, with no reference to the run's priority
   *  (`mac/font_cache_mac.mm:163-165`). The priority is honored one level up as
   *  an early return for emoji-presentation runs, which the by-name
   *  short-circuit below mirrors — so a run that reaches here has already passed
   *  the same filter Blink applies. */
  const wantMonoEmojiReplacement = isEmojiCharCp(cp);
  const useSystemUiBase = systemUiPrimary && _systemUiBaseEnabled;
      const base = fallbackBaseFor(primaryKey, weight, fontSize, slant, stretch);
  // The base joins the cache key for the same reason the CSS description does:
  // the answer is a function of the font you ask FROM, so a base-blind key would
  // serve whichever base asked first to every later caller (the a72e557 lesson).
  // `lang` joins the key for the same reason the base does: the answer is a
  // function of it, so a lang-blind key would serve whichever locale asked first
  // to every later caller — and on a multilingual page that is silently wrong
  // rather than loudly broken.
  // `hostPlatform()` joins the key for the same reason the base and the locale
  // do: the answer is a function of it. In production it is constant and the
  // component is dead weight — but `withHostPlatform()` makes it vary, and a
  // platform-blind key then serves whichever platform asked first to every
  // later caller. Measured: replaying a Linux cassette under an override and
  // then asking again WITHOUT the override returned the Linux face, so a
  // cross-platform test could assert Linux behaviour and be reading a poisoned
  // memo. That is the same hazard the base and locale components already carry,
  // one axis over, and it is invisible in production precisely because nothing
  // in production varies it.
  const cacheKey = `${hostPlatform()}|${cp}|${weight}|${slant !== 0 ? 1 : 0}|${fontSize}|${base.name}|${useSystemUiBase ? "ui" : ""}|${lang ?? ""}|${suppressEmojiPresentation ? "t" : ""}`;
  // DM-1949: the ideograph document cache (Blink's character_fallback_cache_,
  // font_cache_mac.mm:352-366) is consulted BEFORE any ask — including the
  // process-global memo below, which is a memo of the context-FREE ask and
  // therefore must not answer for a codepoint the document's cached face
  // covers. Hit condition transcribed: the CACHED face has a cmap glyph for
  // this codepoint, at the weight/size/slant the key pins.
  const docKey = characterFallbackDocKey(cp, base.name, useSystemUiBase, weight, slant, fontSize);
  if (docKey != null) {
    const cachedKey = _charFallbackDocCache!.get(docKey);
    if (cachedKey != null) {
      const cachedInst = getFontInstance(cachedKey, weight, fontSize, slant);
      if (cachedInst != null && glyphIdForCp(cachedInst, cp) !== 0) return cachedKey;
    }
  }
  // First-writer-wins insert of a successful ask (WTF HashMap::insert "does
  // nothing if key is already present", wtf/hash_map.h:184-188; nulls are never
  // inserted — Blink returns before its insert when the ask fails). Runs on the
  // memo-hit path too: the raw answer is a pure function of its inputs, so a
  // memoized answer is the same answer this document's ask would have produced.
  const docInsert = (resolvedKey: string | null): void => {
    if (docKey != null && resolvedKey != null && !_charFallbackDocCache!.has(docKey)) {
      _charFallbackDocCache!.set(docKey, resolvedKey);
    }
  };
  if (systemFallbackKeyCache.has(cacheKey)) {
    const memo = systemFallbackKeyCache.get(cacheKey)!;
    docInsert(memo);
    return memo;
  }
  let key: string | null = null;
  try {
    if (hostPlatform() === "darwin") {
      // DM-1884: an EMOJI-PRESENTATION codepoint never reaches the cascade at
      // all. `PlatformFallbackFontForCharacter` short-circuits at its very top
      // (`mac/font_cache_mac.mm:319-324`, rev 7d859f27):
      //
      //     if (IsEmojiPresentationEmoji(fallback_priority)) {
      //       if (const SimpleFontData* emoji_font =
      //               GetFontData(font_description, AtomicString(kColorEmojiFontMac)))
      //         return emoji_font;
      //     }
      //
      // with `kColorEmojiFontMac[] = "Apple Color Emoji"` (`:288`) — a by-NAME
      // family lookup, before `font_data_to_substitute` is even read. So Chrome
      // returns the STANDARD face and the cascade base is irrelevant for emoji.
      //
      // We had no such stage, so emoji fell through to `CTFontCreateForString`.
      // That was invisible while the base was a named face — its cascade happens
      // to reach plain `AppleColorEmoji` — and became visible the moment DM-1859
      // armed the UI-font base, whose own cascade list reaches the hidden
      // `.AppleColorEmojiUI` variant instead. Blink's comment at `:156-159` names
      // exactly that: the system API "might also return '.Apple Color Emoji UI'
      // when starting from system-ui". So DM-1859 did not break emoji routing; it
      // removed the accident that was hiding this missing stage.
      //
      // Fixed here rather than by aliasing `.AppleColorEmojiUI` back to
      // `AppleColorEmoji`: an alias would score well and leave the stage missing,
      // so any OTHER face the UI cascade reaches first would still be wrong.
      //
      // `Emoji_Presentation` is the Unicode property Blink's kEmojiEmoji priority
      // is derived from (`IsEmojiPresentationEmoji` = kEmojiEmoji |
      // kEmojiEmojiWithVS, `font_fallback_priority.h:45-48`). Using the property
      // escape keeps it DERIVED from Unicode data rather than curated — unlike
      // `isEmojiCodepoint`'s hand-listed ranges, which miss ⌚ U+231A / ⌛ U+231B /
      // ⏩ U+23E9 / ⏪ U+23EA precisely because nobody sampled that block.
      //
      // `Emoji_Modifier` (the five skin-tone modifiers U+1F3FB–U+1F3FF) is
      // EXCLUDED, measured rather than assumed: Chrome answers those with
      // `.AppleColorEmojiUI`, i.e. the early return does NOT fire for them and
      // the cascade runs. That fits Blink's model — the priority is a property of
      // the segmented RUN, and a lone modifier is a combining character rather
      // than an emoji-presentation run of its own. Gating on the codepoint alone
      // cannot reproduce run segmentation in general; this is the one place the
      // difference is measurable, and without the exclusion the fix trades 1,698
      // fixed rows for 15 newly-broken ones.
      if (!suppressEmojiPresentation
          && /\p{Emoji_Presentation}/u.test(String.fromCodePoint(cp))
          && !/\p{Emoji_Modifier}/u.test(String.fromCodePoint(cp))) {
        const emoji = resolveInstalledFont(COLOR_EMOJI_FONT_MAC);
        if (emoji != null && emoji.path !== "" && emoji.postscriptName !== "") {
          const emojiKey = `sysfb:${emoji.postscriptName}`;
          registerDynamicSystemFont(emojiKey, emoji.path, emoji.postscriptName);
          systemFallbackKeyCache.set(cacheKey, emojiKey);
          return emojiKey;
        }
        // Font absent (a stripped host): fall through to the cascade rather than
        // tofu — Blink's own `if` only returns when GetFontData succeeds.
      }
      // CoreText CTFontCreateForString via the native helper (always on), THEN
      // the in-family re-selection at the requested traits + weight that Blink
      // runs on the nominated face (font_cache_mac.mm:242-267).
      let resolved = resolveSystemFallbackFonts([cp], base.name, {
        weight, italic: slant !== 0, fontSize, basePath: base.path,
        // DM-1859: a `system-ui` run's cascade is walked from the platform UI
        // font, which the helper builds with `CTFontCreateUIFontForLanguage` the
        // way `MatchSystemUIFont` does. Not expressible as a path — the UI font
        // carries its own cascade list, and that list is what reaches Apple's
        // hidden `.…UI` variants.
        ...(useSystemUiBase ? { systemUi: true } : {}),
        // Blink's monochrome-emoji replacement inside `GetSubstituteFont`
        // (`mac/font_cache_mac.mm:156-184`, rev 7d859f27): a color-emoji
        // answer to a kText-priority ask on an `Emoji` character is re-asked
        // from an "Apple Symbols" base carrying the color font's cascade list.
        // It is what produces the measured `font-variant-emoji: text` answers:
        // ⚡ U+26A1 → Apple Symbols (covers it directly), ⭐ U+2B50 → STIX Two
        // Math (via the cascade), 😀 U+1F600 → back to Apple Color Emoji (no
        // monochrome face exists in the cascade).
        //
        // Gated on `Character::IsEmoji` alone, which is Blink's own condition —
        // there is no priority term in the `if`, and the priority acts one level
        // up as an early return for emoji-presentation runs
        // (`font_cache_mac.mm:314-324`), which our by-name short-circuit above
        // mirrors. So a DEFAULT run over a TEXT-presentation-default emoji
        // reaches the replacement, exactly as it does in Blink. The narrower
        // "only under `font-variant-emoji: text`" gate this replaced was not a
        // transcription of anything; it was where the rule had been left while
        // its effect on the conformance baseline was unmeasured.
        ...(wantMonoEmojiReplacement ? { monoEmojiReplacement: true } : {}),
      }).get(cp);
      // …and discard a replacement that failed to find a monochrome face.
      //
      // KNOWINGLY PARTIAL, and worth saying so plainly rather than presenting it
      // as the mechanism. Blink asks this question with the full VS-aware
      // fallback walk: under a forced/derived text presentation each candidate
      // is tested for the SEQUENCE rather than the bare codepoint, a candidate
      // whose colour-ness contradicts the request is reported as
      // `kUnmatchedVSGlyphId` and skipped (`shaping/harfbuzz_face.cc:191-204`),
      // and an exhausted walk restarts once with `kIgnoreVariationSelector`
      // (`shaping/harfbuzz_shaper.cc:1008-1019`). We model none of that; the
      // full mirror is tracked separately.
      //
      // What we model is the one consequence that reaches this seam: when the
      // re-ask lands back on an Apple colour emoji face, the replacement found
      // nothing monochrome, and Chrome does not paint that answer — it paints
      // the face it had BEFORE the replacement. Measured on a system-ui stack:
      // U+1F321 🌡 re-asks to plain `AppleColorEmoji` while Chrome paints
      // `.Apple Color Emoji UI`, which is precisely the pre-replacement
      // substitute. Keeping the original is therefore not a heuristic — it is
      // the only answer the discarded branch can leave behind.
      //
      // `isAppleColorEmojiFamily` is Blink's own `IsAppleColorEmojiFont`
      // predicate (`mac/font_cache_mac.mm:117-125`), applied to the RESULT
      // rather than to the substitute.
      if (wantMonoEmojiReplacement && resolved != null
          && isAppleColorEmojiFamily(resolved.familyName)) {
        const unreplaced = resolveSystemFallbackFonts([cp], base.name, {
          weight, italic: slant !== 0, fontSize, basePath: base.path,
          ...(useSystemUiBase ? { systemUi: true } : {}),
        }).get(cp);
        if (unreplaced != null && unreplaced.path !== "") resolved = unreplaced;
      }
      if (resolved != null && resolved.path !== "") {
        key = `sysfb:${resolved.postscriptName}`;
        // The handle's axis position also lands on the spec (opsz excluded at
        // derivation time — it is per-style, the non-opsz coordinates are a
        // property of the NAME), so the axis-location derivation can pin the
        // face's own coordinates instead of a CSS-derived `wght`.
        registerDynamicSystemFont(key, resolved.path, resolved.postscriptName, "native", undefined, resolved.ctAxes);
        // The helper decided coverage while it still had the face open, so the
        // caller does not have to ask again over IPC. Recorded per (face,
        // codepoint) because that is what the question is about; `undefined`
        // from an older binary simply leaves the caller's own probe in place.
        if (resolved.covered !== undefined) _sysfbCoverage.set(`${key}|${cp}`, resolved.covered);
        // The substituted handle's variation axes + CURRENT position, observable
        // only here. Blink's clone gate compares against it (CoreText pre-sets
        // `opsz` on some handles), so the instantiated-name stamp in
        // `getFontInstance` consults this rather than the file's fvar defaults.
        if (resolved.ctAxes != null && resolved.ctAxes.length > 0) {
          registerDarwinHandleAxes(key, weight, fontSize, slant, resolved.ctAxes);
        }
      }
    } else if (hostPlatform() === "linux") {
      // DM-1863 stage 1 of 2: BEFORE asking fontconfig, retry the run's own
      // family at standard style and weight. Transcribed from
      // `linux/font_cache_linux.cc:80-87` (rev 7d859f27):
      //
      //     if (!IsEmojiPresentationEmoji(fallback_priority) &&
      //         (font_description.Style() == kItalicSlopeValue ||
      //          font_description.Weight() >= kBoldThreshold)) {
      //       const SimpleFontData* font_data =
      //           FallbackOnStandardFontStyle(font_description, c);
      //       if (font_data) return font_data;
      //     }
      //
      // and `FallbackOnStandardFontStyle` itself (`skia/font_cache_skia.cc:119-137`),
      // which copies the description, sets style normal and weight normal, and
      // accepts the result only when that face actually contains the character.
      //
      // Why it matters: a family's BOLD cut can lack a glyph its regular cut
      // has. Without this stage such a codepoint leaves the family entirely and
      // lands on whatever fontconfig prefers, where Chrome stays in the
      // requested family and synthesises the bold. That is a family change, not
      // a weight change — far more visible than the thing it is standing in for.
      //
      // Emoji-presentation runs are excluded exactly as Blink excludes them:
      // their fallback is a color-emoji font, and retrying the text family at
      // regular weight would find a monochrome glyph and stop there.
      //
      // `kBoldThreshold` is 600 (`font_description.h`), the same constant the
      // helper already uses for the synthetic-bold trait.
      if ((suppressEmojiPresentation || !isEmojiPresentationCp(cp)) && (slant !== 0 || weight >= 600) && primaryKey != null) {
        // The standard-style face of the SAME family. `getFontInstance` is
        // memoised, so this costs a map hit after the first bold codepoint.
        const standard = getFontInstance(primaryKey, 400, fontSize, 0);
        if (standard != null && glyphIdForCp(standard, cp) !== 0) {
          // Blink returns the family's own face here and sets the synthetic-bold
          // / synthetic-italic flags from the ORIGINAL description; our renderer
          // derives those from the requested weight against the resolved face,
          // so returning the key is sufficient and keeps that decision in one
          // place rather than duplicating the predicate.
          systemFallbackKeyCache.set(cacheKey, primaryKey);
          return primaryKey;
        }
      }
      // DM-1403/DM-1416: fontconfig live fallback for Linux, default-on (gated
      // by `_systemFallbackResolutionEnabled`, which honors DOMOTION_SYSTEM_FALLBACK=0).
      // Calibrated against Chromium-on-noble paint — see the flag comment above
      // and docs/80.
      key = resolveLinuxSystemFallbackKeyForCp(cp, lang, suppressEmojiPresentation ? false : undefined);
    } else if (hostPlatform() === "win32") {
      // DM-1403: DirectWrite IDWriteFontFallback::MapCharacters via the win32
      // glyph helper. The helper speaks the same platform-agnostic "fallback"
      // protocol as the macOS CoreText helper, so `resolveSystemFallbackFonts`
      // drives it directly; register the substitute face as a `sysfb:` key with
      // the native (helper) extractor, like darwin. The helper's HasCharacter
      // coverage guard reports found:false for a non-covering pick, so a face only
      // registers when it actually covers `cp`. Default-on (DM-1424); the flag
      // honors DOMOTION_SYSTEM_FALLBACK=0.
      //
      // DM-1864: the run's weight and slant travel with the query. Blink hands
      // DirectWrite `font_description.SkiaFontStyle()` — the run's real style —
      // via Skia's `matchFamilyStyleCharacter`
      // (`win/font_cache_skia_win.cc:238-240` → `SkFontMgr_win_dw.cpp:928-939`),
      // and asking `MapCharacters` with NORMAL weight is a different question:
      // DirectWrite selects the cut, so a bold run was answered with the regular
      // one. Unlike macOS there is no second in-family re-selection step to
      // recover it — the weight has to be in the call. `fontSize` is passed for
      // the request's cache key, not to the matcher (DirectWrite's family match
      // is size-independent).
      // DM-1871: hand DirectWrite the run's primary family, the way Blink does.
      // `fileFamilyNameForKey` reads it from the file the key resolves to, so
      // this is derived rather than a second key→family table; `system-ui` has
      // no literal name and comes from the OS.
      const primaryFamily = primaryKey == null
        ? undefined
        : (primaryKey === "sf-pro"
          ? (resolveSystemUiFamily() ?? fileFamilyNameForKey(primaryKey))
          : fileFamilyNameForKey(primaryKey)) ?? undefined;
      // DM-1896: and the run's fallback LOCALE, the last of `MapCharacters`'
      // arguments we were supplying a constant for (the helper reported a
      // hardcoded `en-us`). Blink resolves it per codepoint —
      // `FallbackLocaleForCharacter(...)->LocaleForSkFontMgr()`,
      // `win/font_cache_skia_win.cc:228-240` — and it is what disambiguates
      // unified Han, so asking without it answers by DirectWrite's default
      // preference order instead of by the page's language. The reduction is
      // Blink's own and is NOT the raw CSS `lang`: it keeps the script subtag
      // and drops the region (`zh-CN` → `zh-Hans`), which is the only part
      // DirectWrite discriminates on. Transcribed in `blinkWinFallbackLocale`.
      const dwLocale = blinkWinFallbackLocale(cp, lang);
      const resolved = resolveSystemFallbackFonts([cp], "Helvetica", {
        weight, italic: slant !== 0, fontSize,
        ...(primaryFamily != null ? { baseFamilyName: primaryFamily } : {}),
        ...(dwLocale !== "" ? { locale: dwLocale } : {}),
      }).get(cp);
      if (resolved != null && resolved.path !== "") {
        key = `sysfb:${resolved.postscriptName}`;
        // DM-1721: carry DirectWrite's resolved axis values (variable faces
        // only) into the dynamic spec so the hinted-subset pin can adopt them.
        registerDynamicSystemFont(key, resolved.path, resolved.postscriptName, "native", resolved.resolvedAxes);
      }
    }
  } catch { key = null; }
  systemFallbackKeyCache.set(cacheKey, key);
  docInsert(key);
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
/**
 * A fontconfig `:lang=` pattern fragment for a CSS locale, or "" when there is
 * none to pass.
 *
 * The tag is passed through whole (lower-cased), NOT reduced to its primary
 * subtag. Measured against fontconfig on the pinned Playwright noble image, with
 * Noto CJK installed so the answer can discriminate at all:
 *
 *     :lang=zh-cn    → Noto Sans CJK SC     ← the region is what discriminates
 *     :lang=zh-tw    → Noto Sans CJK TC
 *     :lang=zh       → WenQuanYi Zen Hei    ← truncating loses the distinction
 *     :lang=zh-hans  → WenQuanYi Zen Hei    ← script subtags are NOT understood
 *     :lang=ja-jp    → (matches; same face here, no Japanese Noto installed)
 *
 * So fontconfig speaks language-REGION (RFC-3066 style), and cutting `zh-CN`
 * down to `zh` throws away precisely the Han-unification signal this argument
 * exists to carry. An earlier revision of this function did that, on the
 * assumption that a region-qualified tag "matches nothing" — measured false.
 *
 * A language-SCRIPT tag (`zh-Hans`) is passed through as-is and simply does not
 * discriminate, which is the same outcome as sending no locale. Mapping script
 * subtags onto regions (`Hans`→`cn`) would be inventing a table rather than
 * transcribing one, and the file that would settle what Chrome does here —
 * `ui/gfx/font_fallback_linux.cc` — is NOT in the local checkout (it carries the
 * Blink tree, not `ui/gfx`). Left alone deliberately, and recorded on the ticket
 * as the one open question rather than guessed at.
 */
export function fcLangProperty(lang?: string): string {
  if (lang == null) return "";
  const tag = lang.trim().toLowerCase().replace(/_/g, "-");
  // Guard the pattern string: fontconfig tags are alphanumeric subtags joined by
  // hyphens, and anything else would either match nothing or inject syntax into
  // the pattern (`:`/`,` are meaningful there).
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(tag)) return "";
  return `:lang=${tag}`;
}

/**
 * Blink's `IsEmojiPresentationEmoji(fallback_priority)`, as far as a single
 * codepoint can express it.
 *
 * Blink's version is a property of the SEGMENTED RUN — `kEmojiEmoji |
 * kEmojiEmojiWithVS` (`font_fallback_priority.h:45-48`) — so a text-presentation
 * codepoint followed by U+FE0F is emoji-presentation there and is not here. Our
 * resolver is per-codepoint, so this is the closest faithful reading: default
 * emoji presentation, minus the skin-tone modifiers, which are never a run's
 * priority on their own.
 *
 * Derived from Unicode properties rather than a hand-listed range set, so it
 * tracks the Unicode version rather than freezing one.
 *
 * DM-1989: a REGIONAL INDICATOR is excluded, and the reason is an ORDERING in
 * Blink's segmenter rather than a property. `GetEmojiSegmentationCategory`
 * (`platform/text/emoji_segmentation_category_inline_header.h:59-65`, rev
 * 7d859f27) tests them in this sequence:
 *
 *     if (Character::IsRegionalIndicator(codepoint))
 *       return EmojiSegmentationCategory::REGIONAL_INDICATOR;
 *
 *     if (Character::IsEmojiEmojiDefault(codepoint))
 *       return EmojiSegmentationCategory::EMOJI_EMOJI_PRESENTATION;
 *
 * The regional-indicator arm returns FIRST, so an RI is never categorised as
 * emoji-presentation however its `Emoji_Presentation` property reads — and it
 * does read Yes for U+1F1E6–U+1F1FF, which is why a property-only test gets
 * this wrong. It is the ragel state machine downstream that turns a PAIR of
 * them into an emoji sequence; a lone one falls through to text. Measured:
 * Chrome paints a lone U+1F1FA from FreeSans on Linux, not Noto Color Emoji.
 *
 * The pair is beyond what a per-codepoint predicate can express, and does not
 * need to be: a real flag sequence is painted by the capture layer's raster
 * overlay, which is keyed on the sequence rather than on this.
 */
export function isEmojiPresentationCp(cp: number): boolean {
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return false;
  const ch = String.fromCodePoint(cp);
  return /\p{Emoji_Presentation}/u.test(ch) && !/\p{Emoji_Modifier}/u.test(ch);
}

/**
 * CSS `font-variant-emoji` values that override presentation (`normal` — no
 * override — is expressed as `undefined` throughout the pipeline).
 *
 * Blink turns the property into two mechanisms (rev 7d859f27):
 *  1. a fallback-priority override — `ApplyFontVariantEmojiOnFallbackPriority`
 *     (`shaping/harfbuzz_shaper.cc:184-198`) forces the run to `kEmojiEmoji`
 *     (`emoji`) or `kText` (`text`) unless the priority came from an explicit
 *     VS15/VS16 in the text (`HasVSFallbackPriority`);
 *  2. a forced variation selector in the glyph lookup —
 *     `GetVariationSelectorModeFromFontVariantEmoji`
 *     (`shaping/variation_selector_mode.cc:19-32`) maps `text`→VS15,
 *     `emoji`→VS16, `unicode`→the codepoint's Unicode default, and
 *     `HarfBuzzGetGlyph` (`shaping/harfbuzz_face.cc:127-206`) then treats a
 *     candidate face with the WRONG presentation as having no glyph
 *     (`kUnmatchedVSGlyphId`), so the cascade moves on. When no face with the
 *     requested presentation exists anywhere, the shaper resets the fallback
 *     queue and re-resolves ignoring the selector
 *     (`harfbuzz_shaper.cc:1010-1020`) — which is why `font-variant-emoji:
 *     text` on U+1F600 still paints the color font.
 */
export type FontVariantEmojiOverride = "text" | "emoji" | "unicode";

/**
 * Blink's `Character::IsEmoji` — the Unicode `Emoji` property. This is the
 * gate for the forced variation selector (`harfbuzz_face.cc:137-139`), and it
 * INCLUDES the keycap bases (`0-9`, `#`, `*`): measured on the pinned Chrome,
 * `font-variant-emoji: emoji` really does move a bare digit `5` and `#` from
 * Helvetica to Apple Color Emoji (CDP `getPlatformFontsForNode`).
 */
export function isEmojiCharCp(cp: number): boolean {
  return /\p{Emoji}/u.test(String.fromCodePoint(cp));
}

/**
 * Does `fve` force EMOJI presentation for this codepoint? `emoji` forces VS16
 * for every `Emoji` codepoint (`harfbuzz_face.cc:156-160`,
 * kForceVariationSelector16); `unicode` only where the Unicode default is
 * already emoji presentation (`IsEmojiEmojiDefault`, same lines) — measured:
 * under `unicode`, U+26A1 moves OFF a covering Apple Symbols primary to Apple
 * Color Emoji, while text-default U+2764 stays on its normal cascade.
 */
export function forcesEmojiPresentation(cp: number, fve: FontVariantEmojiOverride | undefined): boolean {
  if (fve === "emoji") return isEmojiCharCp(cp);
  if (fve === "unicode") return isEmojiPresentationCp(cp);
  return false;
}

/** Is `key` the platform color-emoji face — the fonts the emoji-presentation
 *  stages register (`sysfb:AppleColorEmoji` / `.AppleColorEmojiUI` on macOS,
 *  Noto Color Emoji on Linux, Segoe UI Emoji on Windows)? Used by the renderer
 *  to decide whether a forced-text-presentation codepoint still needs the
 *  raster-emoji overlay (the cascade found no monochrome face — Blink's
 *  ignore-VS reset) or paints as a normal path glyph. */
export function isColorEmojiFontKey(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes("applecoloremoji") || k.includes("notocoloremoji")
    || k.includes("noto color emoji") || k.includes("segoe-ui-emoji") || k.includes("seguiemj");
}

/**
 * The platform color-emoji face for `cp` under FORCED emoji presentation, or
 * null when it does not cover `cp` (Blink then resets and resolves normally —
 * `harfbuzz_shaper.cc:1010-1020`).
 *
 * Per-platform, each the same stage Blink runs for a `kEmojiEmoji`-priority
 * run: macOS `mac/font_cache_mac.mm:319-324` (by-name "Apple Color Emoji"),
 * Linux `linux/font_cache_linux.cc:71-77` + `:89-93` (the U+1F46A/`und-Zsye`
 * fontconfig substitution), Windows `font_fallback_win.cc` GetFallbackFamily
 * under kEmojiEmoji (the color-emoji family list).
 */
function resolveColorEmojiKeyForCp(
  cp: number, weight: number, fontSize: number, slant: number, lang: string | undefined,
): string | null {
  let key: string | null = null;
  try {
    if (hostPlatform() === "darwin") {
      const emoji = resolveInstalledFont(COLOR_EMOJI_FONT_MAC);
      if (emoji != null && emoji.path !== "" && emoji.postscriptName !== "") {
        key = `sysfb:${emoji.postscriptName}`;
        registerDynamicSystemFont(key, emoji.path, emoji.postscriptName);
      }
    } else if (hostPlatform() === "linux") {
      key = resolveLinuxSystemFallbackKeyForCp(cp, lang, true);
    } else if (hostPlatform() === "win32") {
      // The kEmojiEmoji nomination from Blink's hardcoded stage: the first
      // installed family of the color-emoji list (`WIN_COLOR_EMOJI_FONTS`).
      for (const k of win32FallbackChainWithPriority(cp, "emoji-emoji", lang)) { key = k; break; }
    }
  } catch { key = null; }
  if (key == null) return null;
  // Blink's fallback iterator only uses a stage's font when it actually has a
  // glyph for the character; a non-covering color font falls through to the
  // reset. The keycap bases are the measured example of covered-but-unexpected:
  // Apple Color Emoji's cmap really does map a plain digit.
  const inst = getFontInstance(key, weight, fontSize, slant);
  // DM-1986: the CMAP question, not the outline one. A bitmap-only colour font
  // (Linux's `NotoColorEmoji.ttf`) maps the codepoint but yields no Glyph
  // object, so an id test rejected the only font on the system that covers it.
  if (inst == null || !fontCoversCp(inst, cp)) return null;
  return key;
}

/** `uchar::kFamily` — U+1F46A FAMILY. Blink asks fontconfig about THIS instead
 *  of the run's actual emoji (`linux/font_cache_linux.cc:71-77`). */
const BLINK_EMOJI_FALLBACK_CP = 0x1f46a;

/** `kColorEmojiLocale` (`fonts/font_cache.cc:82`). */
const BLINK_COLOR_EMOJI_LOCALE = "und-Zsye";

/**
 * Blink's two emoji substitutions, as a pure function of the query.
 *
 * Split out from the resolver so the SUBSTITUTION can be tested on any host: the
 * resolver itself is platform-gated and needs fontconfig, so a unit test there
 * would only run on Linux and the rule would go unchecked on the machine most
 * changes are written on.
 *
 * Exported for tests; not in the package barrel.
 */
export function blinkEmojiFallbackQuery(
  cp: number, lang?: string,
  /** The run's effective emoji presentation. Defaults to the codepoint's own
   *  (`IsEmojiPresentationEmoji` per-codepoint reading); `font-variant-emoji`
   *  overrides it — `emoji` forces true, `text` forces false — because Blink
   *  applies `ApplyFontVariantEmojiOnFallbackPriority` BEFORE this stage reads
   *  the priority (`harfbuzz_shaper.cc:983-984`, rev 7d859f27). */
  emojiPresentation?: boolean,
): { cp: number; lang?: string } {
  if (!(emojiPresentation ?? isEmojiPresentationCp(cp))) return { cp, lang };
  return { cp: BLINK_EMOJI_FALLBACK_CP, lang: BLINK_COLOR_EMOJI_LOCALE };
}

function resolveLinuxSystemFallbackKeyForCp(
  cp: number, lang?: string,
  /** The run's effective emoji presentation (see `blinkEmojiFallbackQuery`);
   *  `font-variant-emoji` overrides the per-codepoint default. */
  emojiPresentation?: boolean,
): string | null {
  // DM-1895: an emoji-presentation run asks fontconfig a DIFFERENT question —
  // Blink substitutes both the character and the locale before the query
  // (`linux/font_cache_linux.cc:71-77` and `:89-93`, rev 7d859f27):
  //
  //     if (IsEmojiPresentationEmoji(fallback_priority)) {
  //       // FIXME crbug.com/591346: We're overriding the fallback character here
  //       // with the FAMILY emoji in the hope to find a suitable emoji font.
  //       c = uchar::kFamily;
  //     }
  //     ...
  //     FontCache::GetFontForCharacter(
  //         c, IsEmojiPresentationEmoji(fallback_priority)
  //                ? kColorEmojiLocale
  //                : font_description.LocaleOrDefault().Ascii().c_str(), ...)
  //
  // Both matter, and for different reasons. Asking about U+1F46A rather than the
  // run's own emoji is deliberate over-asking: a font covering FAMILY is a real
  // emoji font, where a font covering some INDIVIDUAL emoji may be an ordinary
  // text face that happens to carry a few. And `und-Zsye` is what steers
  // fontconfig toward a colour font instead of toward the page's language.
  //
  // We asked about the literal codepoint with the content locale, so both
  // substitutions were missing. macOS has had its own emoji short-circuit since
  // DM-1884 (a by-name Apple Color Emoji lookup, mirroring
  // `mac/font_cache_mac.mm:319-324`); this is the Linux equivalent, and it is a
  // different mechanism because Blink's is.
  ({ cp, lang } = blinkEmojiFallbackQuery(cp, lang, emojiPresentation));
  // DM-1886: ask fontconfig the way Chrome does, when the helper can.
  //
  // Blink is `linux/font_cache_linux.cc:89-97` → `gfx::GetFallbackFontForChar(c,
  // locale, …)`, which sets FC_LANG from the locale, runs FcConfigSubstitute /
  // FcDefaultSubstitute, calls **FcFontSort**, and walks the sorted set taking
  // the first font whose charset actually covers the character. The `fc-match`
  // path below is `FcFontMatch` with the codepoint as a charset CONSTRAINT — a
  // different question, which scores coverage as one weighted criterion and can
  // therefore answer with a face that does not cover `cp` at all.
  //
  // So the two paths are NOT equivalent, and the coverage guard is the tell:
  // this branch needs none (the helper filters by coverage while walking, and
  // reports found:false when nothing covers), while the fall-through branch
  // cannot do without one. Do not "simplify" them together.
  const viaHelper = resolveFcFallbackFonts([cp], lang ?? "en").get(cp);
  if (viaHelper !== undefined) {
    if (viaHelper === null) return null; // no covering font — Chrome tofus too
    // Name the TTC member by index, not by PostScript name: fontconfig answers
    // with file + index (Blink builds the face from exactly that pair), and a
    // `.ttc` member is not addressable by name here.
    const base = viaHelper.family ?? viaHelper.path.split("/").pop() ?? "fallback";
    const name = viaHelper.index > 0 ? `${base}#${viaHelper.index}` : base;
    const key = `sysfb:${name}`;
    registerDynamicSystemFont(key, viaHelper.path, name, "fontkit");
    return key;
  }

  // Fall-through for a host with no built helper, or a helper predating the
  // `fcfallback` query. Documented as an APPROXIMATION of Chrome's algorithm,
  // not an equivalent of it — it is what shipped before DM-1886 and it keeps a
  // helper-less Linux host working rather than dropping every codepoint to tofu.
  // DM-1863: the locale travels here too. `:lang=` is fontconfig's pattern-level
  // equivalent of the FC_LANG that `gfx::GetFallbackFontForChar` sets from
  // Blink's `font_description.LocaleOrDefault()`. Without it a unified CJK
  // ideograph resolves by fontconfig's default preference order rather than by
  // the page's language, which is the Han-unification trap: a `lang="ja"` page
  // gets a Chinese face and it reads as a missing-font problem.
  //
  // fontconfig wants a bare language tag, so a CSS locale like `ja-JP` is cut at
  // the region — `:lang=ja-jp` matches nothing and would silently widen the
  // query back to no-locale.
  const langProp = fcLangProperty(lang);
  const matched = fcMatch(`:charset=${cp.toString(16)}${langProp}`);
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
      && glyphIdForCp(font, cp) !== 0;
  } catch {
    return false;
  }
}

/**
 * The `sysfb:` key naming the cut of `candidate`'s OWN family that Chrome would
 * paint at this CSS description, or null when the base face already is it.
 *
 * The static per-block chain names a FAMILY, but each entry can name only one
 * face, and the `-bold` siblings beside it are a two-slot approximation of what
 * Chrome does. Chrome runs a ladder: Songti SC answers Light at 100-300, Regular
 * at 400, Bold at 500-700 and Black at 800-900 for the same character. That is
 * not a table to transcribe — it is CoreText's nearest-weight descriptor match,
 * the same one Blink runs on a substituted face (`GetAlternateFontPlatformData`,
 * font_cache_mac.mm:200-280). So this asks for it instead of encoding it: the
 * resolver is handed the candidate's own face as the cascade base, which makes
 * `CTFontCreateForString` answer with that same face (the caller has already
 * checked it covers `cp`) and leaves only the in-family re-selection to move.
 * One mechanism, no third weight table.
 *
 * macOS only. Linux and Windows reach their fallback faces through different
 * engines whose weight handling is calibrated separately, so they keep the base
 * key.
 */
function fallbackFamilyCutKey(
  candidate: string, cp: number, weight: number, slant: number, fontSize: number,
): string | null {
  if (hostPlatform() !== "darwin" || !_systemFallbackResolutionEnabled) return null;
  // The BASE key's face, not `getFontInstance`'s effective key — feeding the
  // `-bold` sibling in would ask CoreText to re-weight an already-re-weighted
  // face, and the point is to replace that approximation rather than compose
  // with it.
  const spec = resolveFontSpec(candidate);
  const base = spec?.postscriptName;
  // Faces with no PostScript name of their own can't be asked about at all.
  if (spec == null || base == null || base === "") return null;
  // Apple's hidden `.`-prefixed faces (`.ThonburiUI-Regular`, `.SFGujarati-…`)
  // must be opened from their FILE. CoreText refuses to resolve those names and
  // answers with Times New Roman without erroring, so a name-only base would
  // silently walk Times' cascade and could return an unrelated family.
  if (base.startsWith(".") && (spec.path == null || spec.path === "")) return null;
  // Platform joins the key here too — see the note at `resolveSystemFallbackKeyForCp`.
  const cacheKey = `${hostPlatform()}|${candidate}|${cp}|${weight}|${slant !== 0 ? 1 : 0}|${fontSize}`;
  const cached = fallbackFamilyCutCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let key: string | null = null;
  try {
    const resolved = resolveSystemFallbackFonts([cp], base, {
      weight, italic: slant !== 0, fontSize, basePath: spec.path,
    }).get(cp);
    if (resolved != null && resolved.path !== "" && resolved.postscriptName !== base) {
      key = `sysfb:${resolved.postscriptName}`;
      registerDynamicSystemFont(key, resolved.path, resolved.postscriptName);
    }
  } catch { key = null; }
  fallbackFamilyCutCache.set(cacheKey, key);
  return key;
}

// Memo for `fallbackFamilyCutKey`, keyed on the candidate family + codepoint +
// CSS description. Process-global, like the other font caches.
const fallbackFamilyCutCache = new Map<string, string | null>();

/**
 * Coverage answers the platform helper volunteered alongside a nomination.
 *
 * Keyed per (face key, codepoint) and therefore UNBOUNDED in the codepoint
 * universe, like the other per-codepoint memos in this file — so it is dropped
 * by `clearFontResolutionCaches()` with them. That is not a detail: an
 * unbounded per-codepoint map with no caller clearing it is exactly what made a
 * full-corpus sweep exhaust the heap earlier in this cycle.
 */
const _sysfbCoverage = new Map<string, boolean>();

/** Test-only: drive the per-codepoint live system-fallback resolver directly
 *  (DM-1403). Honors the platform routing + the `DOMOTION_SYSTEM_FALLBACK`
 *  opt-in, so a Linux/Docker probe can confirm fontconfig resolution end to end. */
/** DM-1884: `primaryKey` / `systemUiPrimary` are exposed because several
 *  behaviors are only OBSERVABLE under the system-ui cascade base — with the
 *  default named base, CoreText's cascade reaches plain `AppleColorEmoji` on its
 *  own, so a test cannot tell a correct short-circuit from an incidental
 *  agreement. That ambiguity is exactly what hid the emoji defect until the
 *  conformance oracle measured it against a `system-ui` stack. */
export function __resolveSystemFallbackKeyForCpForTest(
  cp: number, weight = 400, slant = 0, fontSize = 16,
  primaryKey?: string, systemUiPrimary = false, lang?: string, stretch = 100,
  fontVariantEmoji?: FontVariantEmojiOverride,
): string | null {
  return resolveSystemFallbackKeyForCp(cp, weight, slant, fontSize, primaryKey, systemUiPrimary, lang, stretch, fontVariantEmoji);
}

/** Test-only window into the platform path resolver (DM-258). */
export function __resolveFontSpecForTest(key: string): { path: string; postscriptName?: string; extractor?: string } | null {
  return resolveFontSpec(key);
}

/**
 * Test-only: resolve a key against the **darwin** `FONT_PATHS` table directly,
 * independent of `hostPlatform()`. The darwin-chain well-formedness guard
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
 * `darwinFallbackChain` and `linuxFallbackChain` are parallel routers over the
 * SAME Unicode ranges; only the font KEY chosen per block legitimately differs
 * per platform (CoreText vs fontconfig). The boundaries themselves used to be
 * copy-pasted into each — so they could silently drift apart, and the range (not
 * the key) is what decides which script a codepoint routes as, making any drift a
 * cross-platform correctness bug. Defining each block ONCE here keeps the chains
 * in lockstep on WHERE a script starts/ends while leaving each free to pick its
 * own per-block keys. Granularity is the individual Unicode block so the darwin
 * chain (which groups several blocks into one branch) can compose them; every
 * range below is byte-for-byte the boundary the chains previously inlined.
 *
 * `win32FallbackChain` no longer routes off these ranges. It is a transcription
 * of Blink's own Windows stage, which keys on the ICU Script property plus its
 * own list of `UBlockCode`s — a different partition, deliberately, because that
 * is the partition Chrome-on-Windows uses. Those ranges live with the
 * transcription in `win-font-fallback.ts` rather than being force-fit here.
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
// Defer a Linux fallback route to the live fc-match resolver (step 2b) when it
// covers `cp` — it queries the same fontconfig Chrome does, so it tracks Chrome's
// pick by construction (DM-1416). Returns the static `fallback` only when fc-match
// can't cover the codepoint (safety net). Used for symbol/letterlike blocks whose
// frozen static routes drifted from the current image's Chrome.
function linuxDeferOrStatic(cp: number, fallback: string[]): string[] {
  // Linux-only runtime behavior: consult fc-match (Linux's system-fallback
  // backend). On a non-Linux host — the dev machine running the calibration
  // unit tests directly — return the static route so this stays host-agnostic
  // and `resolveSystemFallbackKeyForCp` (which would use CoreText/DirectWrite
  // off-Linux) is never consulted for Linux logic.
  if (hostPlatform() === "linux" && _systemFallbackResolutionEnabled
      && resolveSystemFallbackKeyForCp(cp) != null) {
    return [];
  }
  return fallback;
}

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
  if (isDingbatsBlock(cp)) return linuxDeferOrStatic(cp, ["free-sans", "free-serif"]);
  // Chess pieces — FreeSerif (probe: ♔♚ → FreeSerif).
  if (cp >= 0x2654 && cp <= 0x265F) return linuxDeferOrStatic(cp, ["free-serif", "free-sans"]);
  // Diagonal arrows ↗↙ — WenQuanYi (probe: arrows-diag → WenQuanYi); the rest of
  // the Arrows block → Liberation Sans (probe: ←→↑↓↔ → Liberation Sans).
  if (cp === 0x2197 || cp === 0x2199) return ["cjk", "helvetica"];
  // Arrows: Liberation Sans covers most; for the ones it lacks (↖↘⇄⇒⇦⇧⇨⇩ …)
  // Chrome's fontconfig picks WenQuanYi Zen Hei. Defer the remainder to the live
  // fc-match resolver (2b) instead of the over-covering FreeSans, which
  // intercepted with a font Chrome doesn't use (verified vs getPlatformFontsForNode).
  if (cp >= 0x2190 && cp <= 0x21FF) return ["helvetica"];
  // Geometric Shapes — Liberation Sans, then WenQuanYi for what it lacks
  // (probe: ▲●◆■□○ → Liberation Sans + WenQuanYi).
  if (cp >= 0x25A0 && cp <= 0x25FF) return ["helvetica", "cjk"];
  // Misc Symbols — Liberation Sans + IPAGothic (probe: ☀☂♠♥♦ → Liberation Sans
  // + IPAGothic).
  // Misc Symbols: Liberation Sans for what it covers; the rest Chrome routes to
  // IPAGothic / WenQuanYi via fontconfig. The old static `hiragino-jp` route maps
  // to an IPAGothic path that isn't present on the current Playwright image, so it
  // fell through to FreeSans — a font Chrome doesn't use here. Defer to the fc-match
  // resolver (2b), which picks exactly Chrome's font on this image.
  if (cp >= 0x2600 && cp <= 0x26FF) return ["helvetica"];
  // Mathematical Alphanumeric — FreeSans + FreeSerif (probe: 𝐀𝒜𝕊 → FreeSans/FreeSerif).
  if (isMathAlphanumericBlock(cp)) return linuxDeferOrStatic(cp, ["free-sans", "free-serif"]);
  // Superscripts / Subscripts — Liberation Sans + FreeSans (probe: aₙ₁).
  if (isSuperSubscriptBlock(cp)) return ["helvetica", "free-sans"];
  // Letterlike — mostly FreeSans (ℝ™ℕℤ), but some codepoints Chrome routes to
  // WenQuanYi / IPAGothic; defer to fc-match (= Chrome) with FreeSans as the net.
  if (isLetterlikeBlock(cp)) return linuxDeferOrStatic(cp, ["free-sans", "helvetica"]);
  // Math Operators — Liberation Sans covers ∑∫≠ etc.; the set-theory / logic
  // operators it lacks (∀∃∅∇∈∉∧∨∪∴ …) Chrome routes to WenQuanYi Zen Hei via
  // fontconfig, NOT FreeSans (verified vs getPlatformFontsForNode). Liberation
  // first, then defer to the fc-match resolver (2b) for the remainder.
  if (isMathOperatorsBlock(cp)) return ["helvetica"];
  // CJK Han / Kana / CJK Symbols & Punctuation — WenQuanYi Zen Hei (probe:
  // 漢字/あ/ア → WenQuanYi). Japanese-tagged text prefers IPAGothic; left as a
  // refinement (untagged probe resolved to WenQuanYi). DM-259 follow-up.
  if (isCjkBmpBlock(cp)) {
    return ["cjk"];
  }
  // Pictographs / Transport residue not caught by the color-emoji raster path
  // (doc 15) — FreeSans as a monochrome last resort.
  if (isPictographResidueBlock(cp)) return linuxDeferOrStatic(cp, ["free-sans"]);
  // DM-984: per-Unicode-block fallback derived from a Chrome CDP sweep inside
  // the Playwright Docker container — `CSS.getPlatformFontsForNode` for every
  // block in tools/unicode-fixtures/*.html. Resolved to bare-image paths by
  // tools/probe-983-genroutes-linux.mjs (Unifont / FreeSans / Liberation / etc).
  // Consulted as a LAST resort so the hand-tuned routes above still win where
  // they match.
  // For blocks with no hand-tuned route above, DEFER to the live fc-match
  // resolver (step 2b) rather than the generated DM-984 table. That table was
  // frozen from one Playwright-image CDP sweep and has drifted from the current
  // image (it routed Georgian → Unifont, CJK-Compatibility → FreeSans, where
  // Chrome's fontconfig now picks FreeSans / WenQuanYi / IPAGothic — verified vs
  // getPlatformFontsForNode). fc-match queries the SAME fontconfig Chrome does,
  // so it tracks Chrome's pick by construction (DM-1416). The generated table is
  // kept only as the post-fc-match safety net.
  const generatedKey = lookupLinuxUnicodeFontRange(codepoint);
  return linuxDeferOrStatic(codepoint, generatedKey != null ? [generatedKey] : []);
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
 * Resolve one of Blink's hardcoded Windows family names to a logical font key.
 *
 * This is `IsFontPresent` and the path lookup in one call, because on Windows
 * they are the same DirectWrite question. Blink's `IsFontPresent` is
 * `SkFontMgr::matchFamilyStyle(name, SkFontStyle())`, which on Windows reduces
 * to an exact `IDWriteFontCollection::FindFamilyName`
 * (`third_party/skia/src/ports/SkFontMgr_win_dw.cpp:381-385` → `:1057-1067`) —
 * and that is exactly what the win32 glyph helper's `family` query runs. So this
 * is the identical API call, not a filename table sampled off one machine's
 * `C:\Windows\Fonts` listing.
 *
 * Returns a `winfam:<postscriptName>` key registered in the dynamic-spec
 * registry (like the live resolver's `sysfb:` keys), or null when the family is
 * not installed — which is precisely `IsFontPresent` answering false.
 *
 * Returns null everywhere the helper is unavailable (non-Windows hosts, and a
 * Windows host with no built helper binary). That is the honest degradation:
 * without the helper there is no DirectWrite to ask, so the generated
 * per-block net carries the whole answer, exactly as it did before.
 */
const win32FamilyKeyCache = new Map<string, string | null>();
let _win32FamilyKeyOverride:
  ((family: string, css?: CssFallbackDescription) => string | null) | null = null;

/**
 * DM-1878: presence and face selection are two DIFFERENT Blink calls, and this
 * function serves both — so the style is optional rather than always passed.
 *
 *  - `css == null` → `matchFamilyStyle(name, SkFontStyle())`, Blink's
 *    `IsFontPresent` (`win/font_fallback_win.cc:54-59`). This is what the
 *    hardcoded-table stage probes with while deciding which family to nominate,
 *    and it is style-blind in Blink too — a bold run does not change whether
 *    "David" is installed.
 *  - `css != null` → `matchFamilyStyle(name, font_description.SkiaFontStyle())`,
 *    which is how Blink instantiates the family it nominated
 *    (`GetFontPlatformData(font_description, create_by_family)`,
 *    `win/font_cache_skia_win.cc:170-176`). DirectWrite picks the cut inside that
 *    call, so the run's weight/slant/stretch have to be IN it: there is no
 *    second in-family re-selection step on Windows the way macOS has one.
 *
 * Passing NORMAL where Blink passes the run's style is what made every
 * weight-700 Windows stack resolve the regular cut — 222,874 of the first
 * Windows conformance baseline's 259,152 mismatches were same-family-wrong-cut.
 * (Chromium rev 7d859f27, 2026-06-27.)
 */
/** Keys whose cut must NOT be re-resolved by family on Windows. */
const WIN32_PRIMARY_CUT_SKIP = new Set([
  // Already a resolved face rather than a logical key — re-asking by family
  // would discard the very resolution that produced it.
  // (`sysfb:` / `winfam:` / `webfont:` / `localalias:` are prefix-matched below.)
  "last-resort",
]);

const win32PrimaryCutCache = new Map<string, string | null>();

/**
 * DM-1881: the Windows face for a logical key at a given weight/slant, resolved
 * by asking DirectWrite for the family — the call Blink makes — rather than by
 * picking a filename out of the table.
 *
 * Returns a `winfam:` key, or null to leave the caller on its existing path.
 *
 * The family name is READ FROM THE FILE the table already points at, so no
 * key→family table is introduced; `system-ui` is the exception, since it has no
 * literal name to read and the OS is asked instead.
 */
/**
 * Author-declared Windows families that only resolved through Blink's
 * family-name suffix adjustment ("Segoe UI Light" → "Segoe UI" with the weight
 * PINNED at 300). Keyed by the dynamic key `matchFamilyNameToKey` registered;
 * the value is what the suffix pinned. `win32PrimaryCutKey` consults this
 * BEFORE its dynamic-prefix skip, because for these keys the style-dependent
 * part (the slope) still has to be re-asked per run — the pinned axis
 * replaces the run's, the others follow it (`font_cache_skia_win.cc:456-480`,
 * rev 7d859f27: the adjusted description overrides weight or stretch and keeps
 * everything else).
 */
const win32SuffixDeclaredForKey = new Map<string, { family: string; weight?: number; stretch?: number }>();

function win32PrimaryCutKey(key: string, weight: number, slant: number, stretch: number = 100): string | null {
  if (WIN32_PRIMARY_CUT_SKIP.has(key)) return null;
  // A suffix-declared family re-resolves per style even though its key is
  // dynamic: the suffix pinned one axis, the run still owns the slope.
  const suffixDecl = win32SuffixDeclaredForKey.get(key);
  // Already-resolved or dynamically-registered faces: the key IS the answer.
  if (suffixDecl == null && (
    key.startsWith("sysfb:") || key.startsWith("winfam:")
      || key.startsWith("webfont:") || key.startsWith("localalias:"))) return null;

  const cacheKey = `${key}|${weight}|${slant !== 0 ? 1 : 0}|${stretch}`;
  const cached = win32PrimaryCutCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: string | null = null;
  try {
    // `system-ui` never reaches font matching as a literal in Blink
    // (`DCHECK_NE(family, kSystemUi)`), so it is asked of the OS.
    const family = suffixDecl != null
      ? suffixDecl.family
      : key === "sf-pro"
        ? (resolveSystemUiFamily() ?? fileFamilyNameForKey(key))
        : fileFamilyNameForKey(key);
    if (family != null && family !== "") {
      const cut = win32FamilyKey(family, {
        weight: suffixDecl?.weight ?? weight,
        slant,
        fontSize: 16,
        stretch: suffixDecl?.stretch ?? stretch,
      });
      // Only adopt a cut that actually resolves to a file; otherwise the table
      // entry stands.
      if (cut != null && resolveFontSpec(cut) != null) result = cut;
    }
  } catch { result = null; }
  win32PrimaryCutCache.set(cacheKey, result);
  return result;
}

// ── macOS declared-family style match (Blink's `BestStyleMatchForFamilyNS`) ──

/**
 * The logical keys a DECLARED CSS family can resolve to on macOS — the literal
 * returns of `matchFamilyNameToKey`, which is itself the transcription of the
 * CSS family names plus Blink's generic-family settings (`sans-serif` →
 * Helvetica, `serif` → Times, `monospace` → Courier, `cursive` → Apple
 * Chancery, `fantasy` → Papyrus on macOS).
 *
 * This bounds the style matcher to the stage Blink runs it in. Blink asks
 * `BestStyleMatchForFamilyNS` for a family named by CSS; the per-codepoint
 * FALLBACK path is a different call (`CTFontCreateForString` then
 * `GetAlternateFontPlatformData`'s in-family re-selection), which is what
 * `fallbackFamilyCutKey` already mirrors on the chain candidates. Running this
 * matcher there too would layer two different mechanisms on one decision.
 *
 * `sf-pro` is deliberately absent even though `matchFamilyNameToKey` returns
 * it: it stands for `system-ui`, and `system-ui` never reaches family matching
 * as a name in Blink either — `CreateTypeface` asserts `DCHECK_NE(family,
 * kSystemUi)`. Its face is the variable `SFNS.ttf` under a dot-prefixed family
 * CoreText refuses to resolve by name from a client process, so the matcher
 * has nothing to address. (Chromium rev 7d859f27.)
 *
 * Kept in sync with `matchFamilyNameToKey` by
 * `darwin-declared-family-cut.test.ts`, which walks the recognized CSS names
 * through `resolveFontKey` and asserts each static key it yields is listed
 * here.
 *
 * `linuxPrimaryCutKey` gates on this same set: which keys a declared CSS
 * family can produce is a property of the shared `matchFamilyNameToKey`, not
 * of the platform, and the `sf-pro` exclusion holds there for the same reason
 * (`CreateTypeface` asserts `DCHECK_NE(family, kSystemUi)` in the shared
 * `font_cache_skia.cc` too — what `system-ui` becomes is decided browser-side,
 * outside the checkout).
 */
const DARWIN_DECLARED_FAMILY_KEYS: ReadonlySet<string> = new Set([
  "courier", "menlo", "monaco", "sf-mono",
  "times", "times-new-roman", "georgia", "source-serif-pro", "playfair-display",
  "hiragino-mincho", "hiragino-jp", "u-arial-unicode-ms",
  "apple-chancery", "snell", "papyrus",
  "helvetica", "helvetica-neue", "arial",
]);

/**
 * The CoreText family behind a dynamically-registered key that a DECLARED CSS
 * family produced (the `resolveInstalledFont(name)` tail of
 * `matchFamilyNameToKey` — how `font-family: "PingFang SC"` becomes
 * `sysfb:PingFangSC-Regular`).
 *
 * Recorded because the `sysfb:` prefix alone cannot tell the two producers
 * apart: the per-codepoint fallback resolver registers keys under it too, and
 * those must keep their own in-family re-selection rather than be re-cut here.
 * Presence in this map IS the declared-family marker.
 */
const declaredFamilyForKey = new Map<string, string>();

/** Memo for `darwinPrimaryCutKey`, keyed on the key AND the full style it
 *  answers for — weight, italic and width. A style-blind key would serve
 *  whichever weight asked first; a width-blind one would serve a normal-width
 *  answer to a `font-stretch: condensed` run, which is the same defect one
 *  axis over. */
const darwinPrimaryCutCache = new Map<string, { key: string; italic: boolean } | null>();

/**
 * The CoreText family name for a static key's face, or null.
 *
 * Asked of CoreText rather than read out of the file, because Apple's `.ttc`
 * members name themselves by CUT: the face our `hiragino-jp` entry points at
 * reports `familyName` "Hiragino Sans W4" and the PingFang entries report
 * ".PingFang UI SC" (a different family from the one Chrome addresses). Both
 * would send the matcher to the wrong candidate list — W4 at every weight, and
 * SC faces for a TC request. CoreText reports "Hiragino Sans" / "PingFang SC",
 * which is the name `availableMembersOfFontFamily` is keyed on.
 */
function darwinCoreTextFamilyForKey(key: string): string | null {
  const spec = resolveFontSpec(key);
  if (spec == null) return null;
  // The table records a PostScript name for `.ttc` members; for single-face
  // files it does not, so read the one the file declares.
  let psName = spec.postscriptName;
  if (psName == null || psName === "") {
    if (spec.path == null || spec.path === "") return null;
    try {
      const opened: any = fontkit.openSync(spec.path);
      const f: any = (opened?.fonts != null && Array.isArray(opened.fonts)) ? opened.fonts[0] : opened;
      const p = f?.postscriptName;
      psName = typeof p === "string" ? p : undefined;
    } catch { return null; }
  }
  if (psName == null || psName === "" || psName.startsWith(".")) return null;
  const fam = resolveInstalledFont(psName)?.familyName;
  // Dot-prefixed families are Apple's hidden system faces. CoreText refuses
  // them by name from a client process (it substitutes Times New Roman and
  // says so on stderr) and Chrome does not match them from CSS either, so
  // there is no candidate list to score.
  return fam != null && fam !== "" && !fam.startsWith(".") ? fam : null;
}

/**
 * The face a DECLARED CSS family opens at this weight/slant on macOS, or null
 * to leave the caller on its existing selection.
 *
 * Replaces the two-slot `key` / `key-bold` approximation. A family does not
 * have two cuts, it has a ladder: Chrome opens five distinct PingFang SC
 * members across the CSS weights and seven Hiragino Sans ones (W0/W3/W4/W5/
 * W6/W7/W9), and Helvetica Neue reaches UltraLight and Thin below 400. Two
 * slots cannot represent that, and the gap is not cosmetic — bold PingFang
 * measured 736 units/em where Chrome paints 749.06, ~1.75% per glyph,
 * accumulating along the line.
 *
 * The selection is Blink's, not ours: `BestStyleMatchForFamilyNS` over the
 * family's AppKit members, compared with `BetterChoiceCT` (nearest CSS weight,
 * bold in the trait-precedence loop; `platform/fonts/mac/font_matcher_mac.mm`
 * :172-277 at Chromium tag 147.0.7727.15, the build Playwright pins), ported
 * in the macOS helper and reachable through `resolveFamilyStyleMatch`.
 *
 * Reads the BASE key, never `getFontInstance`'s effective one: feeding the
 * `-bold` sibling in would ask the matcher to re-weight an already-re-weighted
 * face. Its answer REPLACES that routing rather than composing with it.
 *
 * Degrades to null — and therefore to the previous behavior — whenever the
 * helper is missing, the family has no AppKit members, or the matched face
 * cannot be opened. A host without the built binary must still get a face.
 */
function darwinPrimaryCutKey(
  key: string, weight: number, slant: number, stretch: number = 100,
): { key: string; italic: boolean } | null {
  if (hostPlatform() !== "darwin" || !isGlyphHelperAvailable()) return null;
  const declaredFamily = declaredFamilyForKey.get(key);
  if (declaredFamily == null && !DARWIN_DECLARED_FAMILY_KEYS.has(key)) return null;

  const italicRequested = slant !== 0;
  const cacheKey = `${key}|${weight}|${italicRequested ? 1 : 0}|${stretch}`;
  const cached = darwinPrimaryCutCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: { key: string; italic: boolean } | null = null;
  try {
    const family = declaredFamily ?? darwinCoreTextFamilyForKey(key);
    if (family != null) {
      const match = resolveFamilyStyleMatch(family, { weight, italic: italicRequested, stretch });
      const base = resolveFontSpec(key)?.postscriptName;
      if (match != null && match.postscriptName !== base) {
        const installed = resolveInstalledFont(match.postscriptName);
        if (installed != null && installed.path !== "") {
          const cutKey = `sysfb:${match.postscriptName}`;
          // The BASE key's extractor is preserved: this changes WHICH face is
          // opened, not how its outlines are read, and flipping a fontkit face
          // onto the native path would move the outlines for reasons that have
          // nothing to do with style matching.
          registerDynamicSystemFont(
            cutKey, installed.path, match.postscriptName,
            resolveFontSpec(key)?.extractor ?? "fontkit", installed.resolvedAxes,
            installed.ctAxes,
          );
          if (resolveFontSpec(cutKey) != null) result = { key: cutKey, italic: match.italic };
        }
      }
    }
  } catch { result = null; }
  darwinPrimaryCutCache.set(cacheKey, result);
  return result;
}

// ── Linux declared-family style match (Skia's fontconfig `matchFamilyName`) ──

/**
 * Blink's family-name alias, tried when a declared family fails to match.
 *
 * Transcribed from `AlternateFamilyName`
 * (`platform/fonts/alternate_font_family.h:74-105`, tag 147.0.7727.15 —
 * byte-identical at local checkout rev 7d859f27): Courier ↔ Courier New
 * (the New→plain direction is `!IS_WIN`, so it applies on Linux),
 * Times ↔ Times New Roman, Arial ↔ Helvetica; every other name has no
 * alternate. Comparison is ASCII-case-insensitive (`EqualIgnoringAsciiCase`),
 * so the lower-cased names our stack splitter produces compare the same way.
 * The retry fires in `FontPlatformDataCache::GetOrCreateFontPlatformData`
 * (`font_platform_data_cache.cc:74-105`, tag — identical at 7d859f27) for
 * `kAllowAlternate` requests — the default for every CSS-stack lookup — and,
 * because `FontMatchAliasesAsLastResort` is `status: "stable"` at the tag,
 * for `kLastResort` requests too. The alternate is looked up with
 * `kNoAlternate`, so the alias never chains.
 *
 * (`AdjustFamilyNameToAvoidUnsupportedFonts`, the other rewrite in that
 * header, is entirely `#if BUILDFLAG(IS_WIN)` — a no-op on Linux.)
 */
export function blinkAlternateFamilyName(name: string): string | null {
  const n = name.toLowerCase();
  if (n === "courier") return "Courier New";
  if (n === "courier new") return "Courier";
  if (n === "times") return "Times New Roman";
  if (n === "times new roman") return "Times";
  if (n === "arial") return "Helvetica";
  if (n === "helvetica") return "Arial";
  return null;
}

/**
 * The CSS generic keywords whose concrete family Blink reads from
 * browser-side `GenericFontFamilySettings` values
 * (`FontSelector::FamilyNameFromSettings`, `font_selector.cc:20-113`, tag
 * 147.0.7727.15: serif/sans-serif/cursive/fantasy/monospace/math →
 * `settings.<Generic>(script)`; standard/-webkit-standard/-webkit-body →
 * `settings.Standard(script)`), plus `system-ui`, which resolves through
 * `FontCache::SystemFontFamily()` — also pushed from the browser process.
 * The renderer checkout carries the MECHANISM but not the VALUES, so these
 * names are excluded from the transcribed declared-family walk and stay on
 * the measured static routes (marked un-transcribed in doc 110).
 */
const LINUX_SETTINGS_MAPPED_GENERICS: ReadonlySet<string> = new Set([
  "serif", "sans-serif", "cursive", "fantasy", "monospace", "math",
  "system-ui", "-webkit-standard", "-webkit-body",
]);

/**
 * One Blink family lookup on Linux: the transcribed matcher on the name
 * itself, then — on rejection — one retry on its `AlternateFamilyName`.
 * Returns the match plus the spelling that ACCEPTED (the alternate when the
 * retry is what landed), because that spelling is what per-run style
 * re-matching must nominate: re-asking with the original, rejected spelling
 * would reject at every weight.
 */
function linuxFamilyMatchWithAlternate(
  name: string, style: { weight: number; italic?: boolean; stretch?: number },
): { match: LinuxFamilyMatch; acceptedFamily: string } | null {
  const direct = resolveLinuxFamilyMatch(name, style);
  if (direct != null) return { match: direct, acceptedFamily: name };
  const alt = blinkAlternateFamilyName(name);
  if (alt != null) {
    const viaAlt = resolveLinuxFamilyMatch(alt, style);
    if (viaAlt != null) return { match: viaAlt, acceptedFamily: alt };
  }
  return null;
}

/**
 * Whether the transcribed Linux nomination walk can be trusted to answer
 * "Chrome walks past this family" — i.e. the helper is present AND speaks
 * the `familyMatch` query. Probed with "sans", which
 * `IsFallbackFontAllowed` accepts on any system with at least one valid
 * SFNT font, so a null here means the helper predates the query (or the
 * system has no fonts at all — in which case nothing downstream can render
 * either). Without this probe an older helper would make the walk reject
 * EVERY name and the whole stack would collapse to the terminal key.
 */
function linuxNominationWalkArmed(): boolean {
  return hostPlatform() === "linux" && _systemFallbackResolutionEnabled
    && isGlyphHelperAvailable()
    && resolveLinuxFamilyMatch("sans", { weight: 400 }) != null;
}

/**
 * The transcribed LAST-RESORT chain, reached when a declared family (and its
 * calibrated stand-in) match nothing on this host. Transcribed from
 * `FontCache::GetLastResortFallbackFont` (`fonts/skia/font_cache_skia.cc:147-261`,
 * tag 147.0.7727.15; the checkout at rev 7d859f27 differs only by a UMA-timing
 * wrapper): `GetFallbackFontFamily(description)` — which for a standard
 * description is the EMPTY name (`alternate_font_family.h:107-127`) — then
 * "Sans", then "Arial", then `legacyMakeTypeface(nullptr, style)`, which the
 * FCI manager forwards to the same matcher with a null family
 * (`SkFontMgr_FontConfigInterface.cpp:253-256`, Skia rev fd139e79). An empty
 * family builds a pattern with no FC_FAMILY term, which fontconfig matches
 * against everything and `IsFallbackFontAllowed` accepts — so on any host
 * with one valid font the FIRST rung terminates, and the later rungs are
 * defense-in-depth exactly as they are in Blink. Each rung is a
 * `kLastResort` lookup, and `FontMatchAliasesAsLastResort` is stable at the
 * tag, so each rung also gets the alias retry ("Arial" → "Helvetica").
 *
 * Our pipeline reaches this stage description-blind (the key model does not
 * carry the request's generic-family enum), so the first rung is always the
 * standard-description empty name; the generic-family keywords never get
 * here because their calibrated table entries resolve upstream.
 */
function linuxLastResortMatch(
  style: { weight: number; italic?: boolean; stretch?: number },
): { match: LinuxFamilyMatch; acceptedFamily: string } | null {
  for (const rung of ["", "Sans", "Arial", ""]) {
    const hit = rung === ""
      ? (() => { const m = resolveLinuxFamilyMatch("", style); return m != null ? { match: m, acceptedFamily: "" } : null; })()
      : linuxFamilyMatchWithAlternate(rung, style);
    if (hit != null) return hit;
  }
  return null;
}

/** Memo for `linuxPrimaryCutKey`, keyed on the key AND the full style. */
const linuxPrimaryCutCache = new Map<string, { key: string; italic: boolean } | null>();

/**
 * The fontconfig family a Linux logical key stands for, or null.
 *
 * Derived rather than curated, mirroring the Windows precedent where the name
 * comes from the file the table already points at: here it is the base of the
 * `fcMatch` pattern the `LINUX_FONT_PATHS` entry already carries (its text
 * before any `:style` term), falling back to the family name recorded in the
 * resolved file. No new key→family table is introduced.
 *
 * Deliberately NOT the declared CSS name. With the transcribed nomination
 * walk in `matchFamilyNameToKey`, a declared name the shipping matcher
 * ACCEPTS never produces a static key on Linux any more — it registers a
 * `sysfb:` key carrying the accepted spelling. The static declared keys that
 * still reach this function therefore stand for the stages whose concrete
 * names are NOT in the renderer checkout: the generic keywords
 * (browser-side `GenericFontFamilySettings` values) and the `times`
 * terminal (the `-webkit-standard` stage, `settings.Standard(script)` —
 * measured on the noble image as "Times New Roman" → Liberation Serif, and
 * carried here as the calibrated fcMatch base rather than a transcription).
 */
function linuxFcFamilyForKey(key: string): string | null {
  const entry = LINUX_FONT_PATHS[key];
  const fcBase = entry?.fcMatch?.split(":")[0]?.trim();
  if (fcBase != null && fcBase !== "") return fcBase;
  return fileFamilyNameForKey(key);
}

/**
 * The face a declared family opens at this weight/slant/stretch on Linux, or
 * null to leave the caller on its existing selection.
 *
 * Replaces the two-slot `key` / `key-bold` sibling routing with the mechanism
 * Blink runs there: `FontCache::CreateTypeface` →
 * `skia::DefaultFontMgr()->matchFamilyStyle(name, SkiaFontStyle())`
 * (`fonts/skia/font_cache_skia.cc`, Chromium tag 147.0.7727.15) → the
 * fontconfig-backed manager (`SkFontMgr_New_FCI`, `skia/ext/font_utils.cc:86-89`)
 * → `SkFontConfigInterfaceDirect::matchFamilyName` (Skia rev fd139e79, the
 * revision the tag's DEPS pins). The transcription lives in the Linux glyph
 * helper's `familyMatch` query; `resolveLinuxFamilyMatch` is the Node call.
 *
 * Fontconfig scores the whole style — weight, width, slant — against every
 * face of the nominated family in one sort, so a single call answers what the
 * sibling table answered with two slots and a 600 threshold. The 350/380
 * anchor points in Skia's weight mapping (DemiLight / Book) mean intermediate
 * CSS weights land between fontconfig rungs and resolve by fontconfig's own
 * distance scoring, not by our threshold.
 *
 * Reads the BASE key, never the effective one, for the same reason as the
 * macOS matcher: feeding the `-bold` sibling in would re-weight an already
 * re-weighted face. Its answer REPLACES that routing.
 *
 * Gated on the live-resolver flag (`DOMOTION_SYSTEM_FALLBACK=0` disables it)
 * so the disable-and-require-movement check has a handle, and degrades to null
 * — the two-slot table — when the helper is missing or too old.
 */
function linuxPrimaryCutKey(
  key: string, weight: number, slant: number, stretch: number = 100,
): { key: string; italic: boolean } | null {
  if (hostPlatform() !== "linux" || !_systemFallbackResolutionEnabled
      || !isGlyphHelperAvailable()) return null;
  const declaredFamily = declaredFamilyForKey.get(key);
  if (declaredFamily == null && !DARWIN_DECLARED_FAMILY_KEYS.has(key)) return null;

  const italicRequested = slant !== 0;
  const cacheKey = `${key}|${weight}|${italicRequested ? 1 : 0}|${stretch}`;
  const cached = linuxPrimaryCutCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: { key: string; italic: boolean } | null = null;
  try {
    const style = { weight, italic: italicRequested, stretch };
    // A `sysfb:` key carries the ACCEPTED spelling from the nomination walk;
    // re-match it (with the alias retry, since Blink's lookup always carries
    // it) at this run's full style. A static key stands for a stage whose
    // concrete name is browser-side (generic keyword / the `-webkit-standard`
    // terminal), so it nominates the calibrated stand-in family instead.
    // When even that matches nothing on this host, Blink is out of CSS
    // families AND out of settings values, which is exactly when it runs
    // `GetLastResortFallbackFont` — so run the transcribed chain.
    const family = declaredFamily ?? linuxFcFamilyForKey(key);
    const nominated = (family != null ? linuxFamilyMatchWithAlternate(family, style) : null)
      ?? linuxLastResortMatch(style);
    if (nominated != null) {
      const match: LinuxFamilyMatch | null = nominated.match;
      const baseSpec = resolveFontSpec(key);
      // Adopt the matched face only when it is a DIFFERENT face from the one
      // the key already resolves to — same contract as the macOS matcher.
      if (match != null && match.path !== "" && !(
        baseSpec != null && baseSpec.path === match.path
        && (baseSpec.postscriptName == null || baseSpec.postscriptName === match.postscriptName)
      )) {
        // The PostScript name selects the TTC member downstream (fontkit's
        // `getFont`); a face that declares none can only be addressed as the
        // file's first face, so only single-face files are adoptable then.
        const psName = match.postscriptName !== ""
          ? match.postscriptName
          : (match.index === 0 ? (match.path.split("/").pop() ?? match.path) : "");
        if (psName !== "") {
          // Registered under the `sysfb:` prefix like the macOS matcher's
          // answer — it is the same kind of key (an OS-discovered concrete
          // face), and `resolveFontSpec` serves dynamic registrations only for
          // the prefixes it knows.
          const cutKey = `sysfb:${psName}`;
          // The BASE key's extractor is preserved — this changes WHICH face is
          // opened, not how its outlines are read.
          registerDynamicSystemFont(
            cutKey, match.path, match.postscriptName !== "" ? match.postscriptName : psName,
            baseSpec?.extractor ?? "fontkit",
          );
          if (resolveFontSpec(cutKey) != null) result = { key: cutKey, italic: match.italic };
        }
      }
    }
  } catch { result = null; }
  linuxPrimaryCutCache.set(cacheKey, result);
  return result;
}

/** The family name recorded inside the file a key maps to, or null. */
function fileFamilyNameForKey(key: string): string | null {
  const spec = resolveFontSpec(key);
  if (spec?.path == null || spec.path === "") return null;
  try {
    const opened: any = fontkit.openSync(spec.path);
    let f: any = opened;
    if (opened?.fonts != null && Array.isArray(opened.fonts)) {
      f = (spec.postscriptName != null && opened.getFont != null)
        ? (opened.getFont(spec.postscriptName) ?? opened.fonts[0])
        : opened.fonts[0];
    }
    const fam = f?.familyName;
    return typeof fam === "string" && fam !== "" ? fam : null;
  } catch { return null; }
}

function win32FamilyKey(family: string, css?: CssFallbackDescription): string | null {
  if (_win32FamilyKeyOverride != null) return _win32FamilyKeyOverride(family, css);
  const cacheKey = css == null
    ? family.toLowerCase()
    : `${family.toLowerCase()}|${css.weight}|${css.slant !== 0 ? 1 : 0}|${css.stretch ?? 100}`;
  if (win32FamilyKeyCache.has(cacheKey)) return win32FamilyKeyCache.get(cacheKey)!;
  let key: string | null = null;
  let installed = resolveInstalledFont(
    family,
    css != null ? { weight: css.weight, italic: css.slant !== 0, stretch: css.stretch ?? 100 } : undefined,
  );
  // "Segoe UI Light" / "Arial Narrow" are not DirectWrite families — Blink
  // resolves them by stripping a known weight/stretch suffix and retrying with
  // the suffix's value REPLACING that axis of the description
  // (`FontCache::CreateFontPlatformData`, `win/font_cache_skia_win.cc:409-480`,
  // rev 7d859f27; tables at `:335-407`). The slope is kept — an italic
  // "Segoe UI Light" run reaches SegoeUI-LightItalic. Style-carrying calls
  // only: Blink's `IsFontPresent` (the css == null shape here) probes the
  // literal name with the default style and has no suffix layer.
  if (installed == null && css != null) {
    const adjusted = win32FamilySuffixAdjustment(family);
    if (adjusted != null) {
      installed = resolveInstalledFont(adjusted.family, {
        weight: adjusted.weight ?? css.weight,
        italic: css.slant !== 0,
        stretch: adjusted.stretch ?? css.stretch ?? 100,
      });
    }
  }
  if (installed != null && installed.path !== "" && installed.postscriptName !== "") {
    // The cut travels in the KEY, since it is the PostScript name DirectWrite
    // resolved — `winfam:SegoeUI-Bold` and `winfam:SegoeUI` are distinct keys
    // pointing at distinct files, which is what lets one family serve several
    // weights without the two-slot `-bold` sibling approximation.
    key = `winfam:${installed.postscriptName}`;
    registerDynamicSystemFont(key, installed.path, installed.postscriptName, "native", installed.resolvedAxes);
  }
  win32FamilyKeyCache.set(cacheKey, key);
  return key;
}

/**
 * Test seam for the Windows family-presence lookup.
 *
 * The Blink stage's whole shape depends on WHICH families a host has installed,
 * and that is unreachable from a macOS unit run — the helper's `family` query
 * needs DirectWrite. Injecting the predicate lets the suite drive the
 * transcription against a synthetic Windows font inventory (stock Windows 11, a
 * Noto-CJK-equipped host, a stripped host with nothing installed) and assert the
 * exact family Blink would nominate in each. Pass null to restore the real
 * lookup.
 *
 * DM-1878: the injected function receives the same optional `css` the real
 * lookup does — **absent for the presence probe** (Blink's `IsFontPresent`,
 * default `SkFontStyle()`) and **present for face selection** (the run's
 * `SkiaFontStyle()`). A test can therefore assert not just which family is
 * nominated but that the style reaches the cut-selecting call and NOT the
 * presence one, which is the distinction the defect collapsed. A 1-argument
 * lambda stays valid and simply ignores it.
 */
export function __setWin32FamilyKeyResolverForTest(
  fn: ((family: string, css?: CssFallbackDescription) => string | null) | null,
): void {
  _win32FamilyKeyOverride = fn;
  win32FamilyKeyCache.clear();
}

/**
 * Defer a Windows fallback route to the live DirectWrite resolver (step 2b) when
 * it covers `cp`, exactly as `linuxDeferOrStatic` does for fc-match.
 *
 * The generated per-block table is a SAMPLE of DirectWrite's answers, frozen off
 * one Windows 11 host's CDP sweep. `IDWriteFontFallback::MapCharacters` is
 * DirectWrite itself. Where both can answer, the live call wins by construction,
 * so the sampled table must not pre-empt it — it stays only as the net for a
 * host with no helper binary, a resolver flagged off, or a codepoint DirectWrite
 * declines.
 */
function win32DeferOrStatic(cp: number, fallback: string[]): string[] {
  if (hostPlatform() === "win32" && _systemFallbackResolutionEnabled
      && resolveSystemFallbackKeyForCp(cp) != null) {
    return [];
  }
  return fallback;
}

/**
 * Windows fallback routing — Blink's **hardcoded per-script stage**, transcribed.
 *
 * `FontCache::PlatformFallbackFontForCharacter` on Windows asks a hardcoded
 * table BEFORE DirectWrite and only falls through on a miss
 * (`platform/fonts/win/font_cache_skia_win.cc:286-296`, Chromium rev
 * `7d859f27`). So a Windows implementation built only on
 * `IDWriteFontFallback::MapCharacters` answers Chrome's SECOND question, and on
 * a machine with a complete font set Chrome never asks it — whole scripts
 * diverge with no font-set explanation available.
 *
 * The stage order this produces, matching Blink's:
 *
 * 1. **this chain** — `GetFallbackFamilyNameFromHardcodedChoices`: the ONE family
 *    `GetFallbackFamily` nominates (color/text emoji → Unicode-block specials →
 *    the 74-entry per-script table → plane 1/2/3 routing → `lucida sans unicode`),
 *    then the pan-Unicode probe list. `src/render/win-font-fallback.ts` carries
 *    the transcription and its per-symbol citations.
 * 2. **the live DirectWrite resolver** (`resolveSystemFallbackKeyForCp`), which
 *    the per-codepoint walker runs after this chain — Blink's
 *    `GetDWriteFallbackFamily` fall-through.
 * 3. **the generated per-block net**, deferred behind (2) via
 *    `win32DeferOrStatic` so a frozen sample cannot pre-empt the live API.
 *
 * Coverage is deliberately NOT tested here: `FontContainsCharacter` is the
 * walker's `glyphIdForCp` check, and leaving it there reproduces Blink's control
 * flow exactly — the script table contributes at most one family, and a coverage
 * miss on it goes to the pan-Unicode list rather than to the script list's second
 * slot.
 *
 * What this REPLACES: a per-block routing table calibrated by probing painted
 * advance widths and `CSS.getPlatformFontsForNode` on one Windows 11 host. It
 * scored well on the blocks it had been probed against, and that was the defect
 * — it was a curve fit to sampled outputs standing in for a stage of Blink that
 * simply wasn't implemented. Two divergences it baked in, both now gone by
 * construction: it sent Hebrew to Segoe UI where Blink nominates David first,
 * and Thai to Tahoma-then-Leelawadee-UI as a pair where Blink nominates exactly
 * one family and then probes pan-Unicode.
 *
 * `primaryKey` supplies `FontDescription::GenericFamily()`, which changes an
 * answer only through `FindMonospaceFontForScript` (monospace + Arabic/Hebrew →
 * Courier New). The `monospace` generic resolves to the `courier` key on
 * Windows, so that is the test. An author who names `"Courier New"` explicitly
 * lands on the same key while Blink would see `kStandardFamily` — a documented
 * residual of the key model (the same information loss `system-ui` has), not a
 * behavior choice, and it can only differ for Arabic or Hebrew text in an
 * explicitly-Courier-New run.
 */
/**
 * The Windows fallback priority for one codepoint under one `font-variant-emoji`
 * setting — Blink's two stages in their actual order (DM-1985).
 *
 * 1. `ApplyFontVariantEmojiOnFallbackPriority` (`shaping/harfbuzz_shaper.cc:983-984`,
 *    rev 7d859f27) rewrites the segmented priority from the CSS property.
 * 2. `PlatformFallbackFontForCharacter` (`win/font_cache_skia_win.cc:279-284`)
 *    promotes `kText → kEmojiText` for an `IsEmoji` codepoint — and ONLY from
 *    `kText`, which is why an emoji-presentation codepoint is untouched by it.
 *
 * Getting the guard wrong inverts precisely the emoji-presentation set: 😀🚀⭐
 * resolved Segoe UI Symbol where Chrome paints Segoe UI Emoji.
 */
function winFallbackPriority(
  cp: number, fve: FontVariantEmojiOverride | undefined,
): "text" | "emoji-text" | "emoji-emoji" {
  if (fve === "text" && isEmojiCharCp(cp)) return "emoji-text";
  if (fve === "emoji" && isEmojiCharCp(cp)) return "emoji-emoji";
  if (fve === "unicode" && isEmojiPresentationCp(cp)) return "emoji-emoji";
  if (isEmojiPresentationCp(cp)) return "emoji-emoji";
  return winFallbackPriorityForTextRun(cp);
}

export function win32FallbackChain(
  codepoint: number, primaryKey?: string, lang?: string, css?: CssFallbackDescription,
): string[] {
  // Style-BLIND on purpose: this is Blink's `IsFontPresent`, which asks
  // `matchFamilyStyle(name, SkFontStyle())` with the default style while choosing
  // which family to nominate (`win/font_fallback_win.cc:54-65`). Whether a family
  // is installed does not depend on the run's weight.
  const families = blinkWinHardcodedFamilies(codepoint, {
    generic: primaryKey === "courier" ? "monospace" : "standard",
    lang,
    // DM-1985: the run's SEGMENTED priority, not an unconditional upgrade.
    // `winFallbackPriorityForTextRun` transcribes Blink's `kText → kEmojiText`
    // promotion (`win/font_cache_skia_win.cc:279-284`), and that promotion is
    // guarded on the priority ALREADY being `kText`. An emoji-presentation
    // codepoint never arrives as `kText` — the shaper's segmentation hands it
    // `EMOJI_EMOJI_PRESENTATION` (`platform/text/
    // emoji_segmentation_category_inline_header.h:63-65`), i.e. `kEmojiEmoji` —
    // so it reaches `GetFallbackFamily`'s colour arm. Applying the promotion to
    // every `\p{Emoji}` codepoint inverted exactly that set: 😀🚀⭐ and U+1F46A
    // resolved Segoe UI Symbol where Chrome paints Segoe UI Emoji.
    //
    // A lone REGIONAL INDICATOR is deliberately NOT in this set (see
    // `isEmojiPresentationCp`), and Windows agrees it should not be — Chrome
    // answers Segoe UI Symbol for it, which is the `emoji-text` arm.
    //
    // `font-variant-emoji` sits ABOVE all of it: Blink runs
    // `ApplyFontVariantEmojiOnFallbackPriority` before this stage reads the
    // priority, so `text` forces the mono arm and `emoji` the colour one
    // whatever the codepoint's own presentation says.
    priority: winFallbackPriority(codepoint, css?.fontVariantEmoji),
  }, (family) => win32FamilyKey(family) != null);

  // Style-CARRYING: instantiating the nominated family is
  // `GetFontPlatformData(font_description, create_by_family)`, so the cut comes
  // from the run's own description (DM-1878).
  const keys: string[] = [];
  for (const family of families) {
    const key = win32FamilyKey(family, css);
    if (key != null) keys.push(key);
  }

  // DM-987's generated per-block table: a Chrome CDP `CSS.getPlatformFontsForNode`
  // sweep over every Unicode block on a Windows 11 host, resolved to
  // C:\Windows\Fonts faces. Kept ONLY as the net behind the live DirectWrite
  // resolver — see `win32DeferOrStatic`.
  const generatedKey = lookupWin32UnicodeFontRange(codepoint);
  if (generatedKey != null) keys.push(...win32DeferOrStatic(codepoint, [generatedKey]));
  return keys;
}

/**
 * The Windows hardcoded-stage nomination under a FORCED fallback priority —
 * what `font-variant-emoji: emoji` produces: `ApplyFontVariantEmojiOnFallbackPriority`
 * (`shaping/harfbuzz_shaper.cc:184-198`, rev 7d859f27) sets the run's priority
 * to `kEmojiEmoji` before any platform stage runs, and `GetFallbackFamily`
 * (`win/font_fallback_win.cc:500-607`) then nominates the first installed
 * color-emoji family instead of consulting the per-block table.
 */
function win32FallbackChainWithPriority(
  codepoint: number, priority: "emoji-emoji" | "emoji-text", lang?: string,
): string[] {
  const families = blinkWinHardcodedFamilies(codepoint, { lang, priority },
    (family) => win32FamilyKey(family) != null);
  const keys: string[] = [];
  for (const family of families) {
    const key = win32FamilyKey(family);
    if (key != null) keys.push(key);
  }
  return keys;
}

/** Binary-search the generated `UNICODE_FONT_RANGES_WIN32` for a codepoint. */
function lookupWin32UnicodeFontRange(codepoint: number): string | null {
  return binarySearchRange(UNICODE_FONT_RANGES_WIN32, codepoint);
}

/**
 * `css` carries the run's CSS description. It is consulted only where the chain
 * reaches the LIVE per-codepoint system-fallback resolver, whose answer is
 * weight- and style-dependent on macOS: CoreText nominates one face per family
 * and Blink then re-selects the cut within it (see `resolveSystemFallbackFonts`).
 * Omitted → weight 400 / upright / 16 px, which is what the pure family-routing
 * callers (and the calibration unit tests) want.
 */
export function fallbackFontChain(
  codepoint: number, primaryKey?: string, lang?: string, css?: CssFallbackDescription,
): string[] {
  // Platform-aware routing (DM-259 / DM-260). Each platform's Chromium cascades
  // through entirely different faces (CoreText vs fontconfig vs DirectWrite), so
  // each has its own empirically-probed chain.
  if (hostPlatform() === "linux") return linuxFallbackChain(codepoint, primaryKey, lang);
  // DM-1878: win32 gets the description too. It used to be dropped here, so the
  // nominated family was always instantiated at NORMAL weight — Blink passes the
  // run's `SkiaFontStyle()` and lets DirectWrite pick the cut.
  if (hostPlatform() === "win32") return win32FallbackChain(codepoint, primaryKey, lang, css);
  return darwinFallbackChain(codepoint, primaryKey, lang, css);
}

/** The parts of a run's CSS font description that change which FACE the live
 *  macOS system-fallback resolver answers with. */
export interface CssFallbackDescription {
  weight: number;
  slant: number;
  fontSize: number;
  /** CSS `font-stretch` as a percentage, 100 = `normal`. Optional so existing
   *  callers keep their exact behavior; consulted where Blink's call carries
   *  the width (the Windows family instantiation passes the full
   *  `SkiaFontStyle`, weight-width-slant). */
  stretch?: number;
  /** DM-1985: the run's `font-variant-emoji`. Blink applies
   *  `ApplyFontVariantEmojiOnFallbackPriority` (`harfbuzz_shaper.cc:983-984`)
   *  BEFORE the fallback stage reads the priority, so the override is upstream
   *  of the Windows `kText → kEmojiText` promotion rather than beside it.
   *  Absent = `normal`, and then the codepoint's own segmented priority wins. */
  fontVariantEmoji?: FontVariantEmojiOverride;
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
        && glyphIdForCp(vFont, decomp.base) !== 0) {
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
export function darwinFallbackChain(
  codepoint: number, primaryKey?: string, lang?: string, css?: CssFallbackDescription,
): string[] {
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
    // DM-1850: gated for the same reason `u-noto-sans` is below — a raw key
    // bypasses the installed-family check, so `DOMOTION_HIDE_FAMILIES` cannot
    // hide it and a machine that HAS the font reproduces a different chain than
    // one that does not. Note the very same family IS already gated where it is
    // reached as an author family (`authorFamilyAvailable("Arial Unicode MS")`),
    // so this was the two paths disagreeing about one font.
    if (codepoint >= 0x302A && codepoint <= 0x302F) {
      return generatedRouteUsable("u-arial-unicode-ms")
        ? ["cjk", "u-arial-unicode-ms"]
        : ["cjk"];
    }
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
  // U+2713 CHECK MARK (✓) — context-dependent, per CDP CSS.getPlatformFontsForNode
  // at 16px on each generic primary (02-text-symbols rows): sans → Lucida
  // Grande (the DM-980 finding — Zapf's check is visibly thinner at a
  // different angle), serif → Zapf Dingbats, monospace → Menlo. This must sit
  // BEFORE the Dingbats-block return: the earlier DM-980 rule lived after it
  // and was dead code — the block return shadowed it, which is exactly why the
  // fixture's sans ✓ painted the thin Zapf check.
  if (codepoint === 0x2713) {
    const monoPrimary = primaryKey === "courier" || primaryKey === "menlo"
      || primaryKey === "monaco" || primaryKey === "sf-mono";
    if (monoPrimary) return ["menlo", "zapf-dingbats", "symbols"];
    if (primaryKey === "times" || primaryKey === "times-new-roman" || primaryKey === "georgia" || primaryKey === "palatino") {
      return ["zapf-dingbats", "symbols"];
    }
    return ["lucida-grande", "zapf-dingbats", "symbols"];
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
    // Context split (CDP per-cp probe on the 02-text-symbols rows): a serif
    // primary pulls these from Times New Roman, a monospace primary from
    // Menlo; the sans path keeps Lucida Grande (sans primaries that carry
    // the glyph themselves — Helvetica has ● — never reach this chain).
    if (primaryKey === "courier" || primaryKey === "menlo" || primaryKey === "monaco" || primaryKey === "sf-mono") {
      return ["menlo", "lucida-grande", "symbols"];
    }
    if (primaryKey === "times" || primaryKey === "times-new-roman" || primaryKey === "georgia" || primaryKey === "palatino") {
      return ["times-new-roman", "lucida-grande", "symbols"];
    }
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
  if (codepoint === 0x2196 || codepoint === 0x2198) {
    // ↖ ↘ — Chrome picks Lucida Grande (CDP per-cp probe); Hiragino Sans DOES
    // carry glyphs for these two (unlike ↗ ↙'s original assumption), so the
    // unified chain below would stop there and paint the wrong arrow shape.
    return ["lucida-grande", "symbols"];
  }
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
    if (serifPrimary) {
      // Card suits ♠♣♥♦ — a serif primary pulls these from Times New Roman
      // (CDP per-cp probe: ♥ → Times New Roman), while ★ stays on Songti
      // (cjk-serif). The Songti face covers the suits too, so the uniform
      // cjk-serif-first chain painted the wrong (em-square) suit glyphs.
      if (codepoint === 0x2660 || codepoint === 0x2663 || codepoint === 0x2665 || codepoint === 0x2666) {
        return ["times-new-roman", "cjk-serif", "hiragino-jp", "symbols"];
      }
      return ["cjk-serif", primaryKey ?? "times", "hiragino-jp", "symbols"];
    }
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
    // Context split (CDP per-cp probe): serif primaries pull ← → from Times
    // New Roman and monospace primaries from Menlo; Lucida Grande remains the
    // sans pick and the fall-through for the arrows those faces lack.
    if (primaryKey === "courier" || primaryKey === "menlo" || primaryKey === "monaco" || primaryKey === "sf-mono") {
      return ["menlo", "lucida-grande", "symbols"];
    }
    if (primaryKey === "times" || primaryKey === "times-new-roman" || primaryKey === "georgia" || primaryKey === "palatino") {
      return ["times-new-roman", "lucida-grande", "symbols"];
    }
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
  const generatedKeyRaw = lookupUnicodeFontRange(codepoint);
  // A generated route whose family isn't installed here names a face Chrome
  // will never pick on this machine. Drop it and ask the OS what Chrome WOULD
  // use — the live CoreText resolver queries the same API Chrome does, so it
  // gives the right answer for whatever font set this machine happens to have.
  //
  // The live key must go at the HEAD rather than simply dropping the route:
  // the static tail ends in `last-resort`, whose LastResort.otf has a
  // block-frame glyph for every codepoint, so it would win and paint tofu.
  // `u-noto-sans` in that tail is itself a non-stock download and is skipped
  // when absent, which is exactly how the chain would reach `last-resort`.
  let generatedKey = generatedKeyRaw;
  let liveOverride: string | null = null;
  // Where the sampled route and the live OS resolver DISAGREE, the live answer
  // wins. The table is a snapshot of one machine's CoreText replies at sweep
  // time; the live resolver asks the same API Chrome asks, on this machine, now
  // — so when they differ it is the table that has drifted. Observed cases:
  // U+1DBB (route "Arial", live and Chrome "Menlo") and U+3251 / U+32D0 (live
  // and Chrome "Hiragino Sans").
  //
  // Measured across the full 818-fixture macOS unicode sweep before landing,
  // because the blast radius is every block: 2 fixtures fixed
  // (1D80-phonetic-extensions-supplement, 3200-enclosed-cjk-letters-and-months),
  // 0 broken, 0 made worse. The route is still what supplies the chain when the
  // two AGREE, and it remains the fallback when the OS has no answer.
  if (generatedKeyRaw != null && generatedRouteUsable(generatedKeyRaw)) {
    const live = resolveSystemFallbackKeyForCp(codepoint, css?.weight, css?.slant, css?.fontSize, primaryKey);
    if (live != null && live !== generatedKeyRaw) liveOverride = live;
  }
  if (generatedKeyRaw != null && liveOverride == null && !generatedRouteUsable(generatedKeyRaw)) {
    liveOverride = resolveSystemFallbackKeyForCp(codepoint, css?.weight, css?.slant, css?.fontSize, primaryKey);
    // If the OS has no answer either, keep the generated route: a face Chrome
    // might not pick still beats a guaranteed `last-resort` tofu.
    generatedKey = liveOverride != null ? null : generatedKeyRaw;
  }
  // DM-1850: `u-noto-sans` is injected into these chains as a RAW KEY, which
  // bypasses the installed-family check every GENERATED route already gets. The
  // consequence is not cosmetic: `DOMOTION_HIDE_FAMILIES` exists so a developer
  // Mac can reproduce a leaner machine's font choices, and it gates
  // `resolveInstalledFont` — so it hides the CSS family "Noto Sans" while these
  // three insertions still resolve straight to the file. A fixture then PASSES
  // locally under the flag and FAILS on the runner, which is exactly the case
  // the flag exists to prevent and which cost a full investigation once.
  //
  // `generatedRouteUsable` is the same predicate, so the raw key now answers to
  // it too. On a machine without Noto Sans this is a no-op (the key resolves to
  // nothing either way); on one with it, the flag finally works.
  const notoUsable = generatedRouteUsable("u-noto-sans");
  const noto: string[] = notoUsable ? ["u-noto-sans"] : [];

  if (liveOverride != null) {
    return isEmojiCp
      ? [liveOverride, "symbols", ...noto]
      : [liveOverride, "symbols", ...noto, "last-resort"];
  }
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
      ? [generatedKey, "symbols", ...noto]
      : [generatedKey, "symbols", ...noto, "last-resort"];
  }
  // No generated-table route matched (rare — the table covers most blocks).
  // Try Noto Sans before LastResort: a codepoint with no block route is
  // usually a letter Chrome resolves via its broad Latin/Greek/Cyrillic
  // cascade, which Noto Sans mirrors. DM-1018.
  if (!isEmojiCp) {
    return [...noto, "last-resort"];
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

/**
 * Is a generated per-block route valid on THIS machine?
 *
 * The DM-983 table records, per Unicode block, the family Chrome's CoreText
 * fallback picked when the table was SAMPLED — on one particular Mac. It is
 * therefore a snapshot of that machine's font inventory, and several of its
 * families are not stock: `SF Pro Text` and `Noto Sans` are separate Apple /
 * Google downloads, and the route for e.g. Cyrillic names `SF Pro Text`.
 *
 * On a machine without that family Chrome cannot pick it either, so neither may
 * we — the whole point of the table is to mirror Chrome, and a route to a font
 * Chrome will never choose is worse than no route at all. Measured on the CI
 * runner: for U+04FA Chrome painted `.New York` while we painted the route's
 * `SFNS.ttf`, across ~26 unicode fixtures that pass on a developer Mac.
 *
 * A file-existence check is NOT sufficient and was the trap here: the route's
 * path `/System/Library/Fonts/SFNS.ttf` exists everywhere. What varies is
 * whether the *family* is installed, which is what decides Chrome's pick — so
 * the check is `resolveInstalledFont(family)`, the same rule the CSS-family
 * path already applies to "SF Pro Text" (DM-1659).
 *
 * Conservative by construction: a route with no recorded family, or one whose
 * family resolves, is kept. Only a positively-absent family is rejected.
 */
function generatedRouteUsable(key: string): boolean {
  const entry = UNICODE_FONT_PATHS[key];
  const family = entry?.family;
  if (family == null || family === "") return true;
  return resolveInstalledFont(family) != null;
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

/**
 * The OTHER half of Blink's no-system-fallback rule. Transcribed from
 * `third_party/blink/renderer/platform/fonts/font_cache.cc:242-244`
 * (rev 7d859f27, 2026-06-27):
 *
 *     if (Character::IsPrivateUse(lookup_char) ||
 *         Character::IsNonCharacter(lookup_char))
 *       return nullptr;
 *
 * `Character::IsNonCharacter` is `U_IS_UNICODE_NONCHAR(c)` (`character.cc:294-296`),
 * i.e. ICU's noncharacter set: U+FDD0..U+FDEF plus the last two codepoints of
 * every plane (U+xFFFE / U+xFFFF). Blink's own comment gives the reason — some
 * of these are encoding-detection sentinels that really do appear on the web,
 * and running fallback for U+FFFE cost a memory regression (crbug.com/862352).
 */
export function isNonCharacterCodepoint(cp: number): boolean {
  if (cp > 0x10FFFF) return false;
  if (cp >= 0xFDD0 && cp <= 0xFDEF) return true;
  return (cp & 0xFFFE) === 0xFFFE;
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
  // Enclosed Alphanumeric Supplement squared abbreviations with DEFAULT emoji
  // presentation (Unicode emoji-data Emoji_Presentation=Yes): 🆎 U+1F18E and
  // 🆑–🆚 U+1F191..1F19A (CL COOL FREE ID NEW NG OK SOS UP! VS). Chrome paints
  // these from the color-emoji font WITHOUT a VS-16 (verified vs
  // getPlatformFontsForNode → Noto Color Emoji on Linux / Apple Color Emoji on
  // macOS). The sibling squared letters 1F130–1F189 are Emoji_Presentation=No
  // (text default) and are intentionally NOT included.
  if (cp === 0x1F18E || (cp >= 0x1F191 && cp <= 0x1F19A)) return true;
  // NOTE: ◽◾☝⛹ U+25FD/25FE/261D/26F9 are NOT added here — their presentation is
  // PLATFORM-dependent, not a fixed property: verified vs getPlatformFontsForNode,
  // macOS Chrome paints them as TEXT (Apple Symbols / STIX Two Math) while Linux
  // Chrome's fontconfig falls to Noto Color Emoji. A global emoji flag would break
  // macOS (Domotion already matches Apple Symbols there). The Linux emoji-vs-text
  // fallback for these few codepoints is a documented residual.
  // Regional-indicator flags (pairs are joined into country flag emoji).
  if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return true;
  // Main emoji blocks: Misc Symbols & Pictographs, Emoticons, Transport,
  // Alchemical, Supplemental Symbols, Pictographs Extended-A/B.
  if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;
  return false;
}

/**
 * Sub-bold weight cuts: families whose installed face set carries a face BELOW
 * the regular one, which the plain `weight >= 600 ? bold : regular` split in
 * `getFontInstance` would otherwise hide.
 *
 * Each family lists its extra cuts in ascending order as the inclusive UPPER
 * CSS weight bound that selects it; a request above every listed bound (but
 * still under 600) falls through to the family's regular face. The suffix is
 * appended to the family key to name the `FONT_PATHS` entry —
 * `helvetica` + `light` → `helvetica-light`, and `-italic` on top of that when
 * a slant is requested.
 *
 * The bounds are measured, not derived from the CSS font-matching algorithm:
 * Chrome delegates weight selection to the platform matcher (CoreText on
 * macOS), which does not always agree with the spec's descending/ascending
 * walk. Helvetica's numbers come from asking Chromium directly over the whole
 * 100…700 range in 10-point steps via the CDP `CSS.getPlatformFontsForNode`
 * command: 100-300 → Helvetica-Light, 310-590 → Helvetica, 600-700 →
 * Helvetica-Bold. That matters for the `sans-serif` generic, which Chrome on
 * macOS resolves to Helvetica — so any page setting `font-weight: 100`/`200`/
 * `300` on default sans-serif text was being painted a full cut too heavy.
 *
 * Platform-agnostic by construction: the suffixed key is only adopted when
 * `resolveFontSpec` can resolve it on the host platform, so the Linux
 * (Liberation Sans) and Windows (Arial) mappings for `helvetica` — neither of
 * which ships a light cut — keep falling back to their regular face, which is
 * what Chrome picks there too.
 */
const SUB_BOLD_WEIGHT_CUTS: Record<string, ReadonlyArray<{ maxWeight: number; suffix: string }>> = {
  "helvetica": [{ maxWeight: 300, suffix: "light" }],
};

/**
 * The `FONT_PATHS` key suffix for the sub-bold cut `key` should use at
 * `weight`, or null when the family's regular face is the right pick (no cut
 * declared, the weight sits above every declared cut, or the request is bold
 * and therefore already covered by the `-bold` routing).
 *
 * Exported for unit tests — the mapping is pure and platform-independent, so it
 * can be asserted on any host even though the resolved FILE cannot.
 */
export function subBoldWeightCutSuffix(key: string, weight: number): string | null {
  const cuts = SUB_BOLD_WEIGHT_CUTS[key];
  if (cuts == null || weight >= 600) return null;
  for (const cut of cuts) {
    if (weight <= cut.maxWeight) return cut.suffix;
  }
  return null;
}

/**
 * The `hiragino-jp-*` cut for `weight`, or null outside the ladder.
 *
 * Chrome selects the HiraginoSans cut by EXACT `OS/2.usWeightClass` match; the
 * family ships W0(100) W1(200) W2(250) W3(300) W4(400) W5(500) W6(600) W7(700)
 * W8(800) W9(900). W2 is unreachable from CSS, so the ladder skips it. For a
 * non-standard weight we take the nearest declared cut, ties going lighter —
 * which is what CSS font matching does below 400.
 *
 * Exported for unit tests: the mapping is pure, so it can be asserted on any
 * host even where the FILES cannot be resolved.
 */
const HIRAGINO_CUTS: ReadonlyArray<{ usWeight: number; key: string }> = [
  { usWeight: 100, key: "hiragino-jp-w0" },
  { usWeight: 200, key: "hiragino-jp-w1" },
  { usWeight: 300, key: "hiragino-jp-w3" },
  { usWeight: 400, key: "hiragino-jp-w4" },
  { usWeight: 500, key: "hiragino-jp-w5" },
  { usWeight: 600, key: "hiragino-jp-w6" },
  { usWeight: 700, key: "hiragino-jp-w7" },
  { usWeight: 800, key: "hiragino-jp-w8" },
  { usWeight: 900, key: "hiragino-jp-w9" },
];

export function hiraginoWeightCut(weight: number): string | null {
  let best: { key: string; dist: number } | null = null;
  for (const c of HIRAGINO_CUTS) {
    const dist = Math.abs(c.usWeight - weight);
    if (best == null || dist < best.dist) best = { key: c.key, dist };
  }
  return best?.key ?? null;
}

/**
 * The CUT of `key` a run at this CSS style opens — the `FONT_PATHS` key of the
 * actual face, not of the family's base entry.
 *
 * Split out of `getFontInstance` because two callers need the same answer and
 * only one of them wants a `FontInstance`. The other is the per-codepoint
 * fallback's cascade BASE: Blink asks CoreText for a substitute from
 * `font_data_to_substitute->PlatformData()` — the face the run is actually
 * painting in — and the cascade it hands back depends on that face (measured:
 * `CTFontCreateForString` from Times-Roman nominates STSongti-SC-Regular, from
 * Times-Bold it nominates STSongti-SC-Bold). Asking from the family's base entry
 * therefore asks a different question than Chrome asks, and the difference is
 * not recoverable downstream: the in-family re-selection that follows keeps the
 * nominated face whenever the better-matching one does not cover the character,
 * so a wrong nomination survives to paint.
 *
 * Returns the resolved key plus whether the slant request was satisfied by a
 * real italic / oblique face rather than left to synthetic shear.
 *
 * Webfont and `localalias:` keys are NOT handled here — they resolve through
 * their own registries in `getFontInstance` and never reach this.
 */
function resolveEffectiveCutKey(
  key: string, weight: number, slant: number, stretch: number,
): { key: string; routedItalicCut: boolean } {
  // SF Pro / SF Mono ship their italics as separate .ttf files rather than
  // exposing a `slnt` variable-axis on the upright file, so route italic
  // requests at the spec level instead of trying to drive an axis. Fallback
  // fonts (sf-arabic / cjk / thai / devanagari / symbols) have no italic
  // sibling — the slnt argument is quietly ignored there.
  let effectiveKey = key;
  // Set whenever the slant request is satisfied by routing to a real italic /
  // oblique sibling face rather than left to synthetic shear — see
  // `FontInstance.isRoutedItalicCut`.
  let routedItalicCut = false;
  if (slant !== 0) {
    if (key === "sf-pro") { effectiveKey = "sf-pro-italic"; routedItalicCut = true; }
    else if (key === "sf-mono") { effectiveKey = "sf-mono-italic"; routedItalicCut = true; }
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
    // …and below the regular face, take the family's lighter cut when it ships
    // one and the host platform actually has it (see SUB_BOLD_WEIGHT_CUTS).
    const cutSuffix = subBoldWeightCutSuffix(key, weight);
    if (cutSuffix != null) {
      const cutKey = isItalic ? `${key}-${cutSuffix}-italic` : `${key}-${cutSuffix}`;
      if (resolveFontSpec(cutKey) != null) effectiveKey = cutKey;
    }
    routedItalicCut = routedItalicCut || (isItalic && effectiveKey !== key);
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
  // Hiragino Sans ships a full W0..W9 ladder and Chrome picks the cut whose
  // OS/2.usWeightClass matches the CSS weight (measured — see FONT_PATHS). A
  // single regular + bold pair, which is what this used to be, is wrong at
  // SEVEN of the nine standard weights. Gated on the cut resolving here, so
  // Linux (IPAGothic) and Windows (Yu Gothic) keep their single face.
  if (key === "hiragino-jp") {
    const cut = hiraginoWeightCut(weight);
    if (cut != null && resolveFontSpec(cut) != null) effectiveKey = cut;
  }
  // Apple SD Gothic Neo (Hangul). DM-691.
  if (key === "korean" && weight >= 600) {
    effectiveKey = "korean-bold";
  }
  // Lucida Grande — the macOS fallback for arrows, Hebrew, check marks and a
  // few symbol blocks — has a bold cut, and Chrome crosses to it at 450 rather
  // than the 600 the other families use (its two faces declare usWeightClass
  // 500/600, so the platform matcher's switch-over lands lower). Only adopted
  // when the host platform actually has the face: the Linux (Liberation Sans)
  // and Windows (Arial) mappings for `lucida-grande` have no bold sibling key,
  // so `resolveFontSpec` returns null there and the regular face stands.
  if (key === "lucida-grande" && weight >= 450 && resolveFontSpec("lucida-grande-bold") != null) {
    effectiveKey = "lucida-grande-bold";
  }
  // PingFang ships separate weight subfonts in PingFang.ttc — Regular for
  // body weight, Medium for semibold+. No italic. Same pattern across all
  // regional variants (SC / TC / HK / MO).
  if ((key === "pingfang-sc" || key === "pingfang-tc"
       || key === "pingfang-hk" || key === "pingfang-mo")
      && weight >= 600) {
    effectiveKey = `${key}-bold`;
  }
  // DM-1881: on Windows, resolve the CUT by asking DirectWrite for the family at
  // the requested style, instead of picking a file out of `WIN32_FONT_PATHS`.
  //
  // That table answers two questions at once and only one of them is legitimate:
  // "which family does this logical key mean here" (Blink has the same layer)
  // and "which file to open" (sampled). Blink has no filename path on Windows at
  // all — `CreateTypeface`'s by-file branch (`kCreateFontByFciIdAndTtcIndex` →
  // `FromFilenameAndTtcIndex`) is inside `#if !BUILDFLAG(IS_WIN) && …`
  // (`fonts/skia/font_cache_skia.cc:262-295`, rev 7d859f27), so on Windows it
  // reduces to `MatchFamilyStyle(name, font_description.SkiaFontStyle())`.
  //
  // The visible cost of the sampled half: `sf-pro` mapped to `segoeui.ttf` with
  // no bold sibling, so a weight-700 run took Segoe UI **Regular** and our
  // synthetic-bold gate then dilated the outline. Chrome takes real Segoe UI
  // Bold and synthesises nothing (`win/font_cache_skia_win.cc:481-489`), and a
  // dilated Regular is not Bold — different stem contrast and different
  // ADVANCES, so it shifts the line. That single route was 157,663 of 166,557
  // rows on the Windows conformance baseline: 94.7% of the platform's mismatch
  // mass in one defect.
  //
  // The family NAME is derived rather than curated: it comes from the file the
  // table already points at, except for `system-ui`, which has no literal name
  // to read and is asked of the OS (see `resolveSystemUiFamily`).
  //
  // Falls through to the table untouched when the helper is unavailable or the
  // family does not resolve — a Windows host without the built binary still
  // needs an answer, which is the existing degradation contract.
  if (hostPlatform() === "win32" && isGlyphHelperAvailable()) {
    const cutKey = win32PrimaryCutKey(effectiveKey, weight, slant, stretch);
    if (cutKey != null) effectiveKey = cutKey;
  }
  // macOS: for a family named by CSS, ask Blink's declared-family style matcher
  // which CUT the run opens, instead of picking between the two `key` /
  // `key-bold` slots above. Reads the BASE key, so its answer REPLACES that
  // routing rather than composing with it (composing would re-weight an
  // already-re-weighted face). Null leaves the two-slot result standing, which
  // is the degradation contract for a host with no helper binary.
  const darwinCut = darwinPrimaryCutKey(key, weight, slant, stretch);
  if (darwinCut != null) {
    effectiveKey = darwinCut.key;
    // A matched face carrying CoreText's italic trait satisfies the slant with
    // a real cut; without it the renderer would shear an already-italic face.
    routedItalicCut = slant !== 0 && darwinCut.italic;
  }
  // Linux: same stage, different Blink code — the cut comes from fontconfig's
  // style scoring (`SkFontConfigInterfaceDirect::matchFamilyName`, transcribed
  // in the Linux glyph helper), not from the `-bold` sibling slots above.
  // Reads the BASE key and REPLACES the sibling routing, exactly like the
  // macOS branch; null leaves the two-slot result standing (no helper, an old
  // helper, or `DOMOTION_SYSTEM_FALLBACK=0`).
  const linuxCut = linuxPrimaryCutKey(key, weight, slant, stretch);
  if (linuxCut != null) {
    effectiveKey = linuxCut.key;
    // A matched face whose fontconfig slant is italic satisfies the request
    // with a real cut; without it the renderer keeps its synthetic shear.
    routedItalicCut = slant !== 0 && linuxCut.italic;
  }
  return { key: effectiveKey, routedItalicCut };
}

/**
 * The `wdth` request for a resolved key, or 100 (no request).
 *
 * On macOS, `font-stretch` drives the variable `wdth` axis for exactly ONE
 * face: the `system-ui` one. Blink's `MatchSystemUIFont` applies the CSS
 * percentage as a CoreText `wdth` variation, clamped to the axis range
 * (`mac/font_matcher_mac.mm:540-589` + `:483-538`, rev 7d859f27); every other
 * family goes through `MatchFontFamily`, where the width becomes the
 * condensed/expanded symbolic TRAIT and selects a cut or named instance with
 * no axis applied — including families that carry a wdth axis (measured on the
 * `Skia` family: 50%/62.5%/75% all paint the same `Skia-Regular_Condensed`).
 *
 * Keyed on the sf-pro keys because that is what `system-ui` resolves to here.
 * The key model conflates a literal CSS `"SF Pro"` declaration with
 * `system-ui` (both map to `sf-pro`), so a declared "SF Pro" at non-normal
 * stretch takes the axis where Chrome's declared-family matcher would pick a
 * cut — a known residual of the shared key, same as its weight behavior.
 */
function darwinSystemUiWdth(effectiveKey: string, stretch: number): number {
  if (hostPlatform() !== "darwin" || stretch === 100) return 100;
  return isDarwinSystemUiAxisKey(effectiveKey) ? stretch : 100;
}

/** The keys standing for the macOS `system-ui` face — the ONLY faces whose
 *  variation axes Blink drives from CSS values (`MatchSystemUIFont` sets
 *  wght/wdth variations clamped to the axis range,
 *  `mac/font_matcher_mac.mm:540-589`, identical at tag 147.0.7727.15 and rev
 *  7d859f27). Every other darwin key is a declared family or fallback face,
 *  where the weight lives in WHICH face the matcher picked and only `opsz` +
 *  font-variation-settings are applied on top. Shared by the `wdth` gate
 *  (`darwinSystemUiWdth`) and the `wght` gate on the fontkit path. The key
 *  model's known residual applies: a literal CSS "SF Pro" shares `sf-pro`
 *  with `system-ui` and takes the axis where Chrome's declared-family matcher
 *  would pick a cut. */
function isDarwinSystemUiAxisKey(effectiveKey: string): boolean {
  return effectiveKey === "sf-pro" || effectiveKey === "sf-pro-italic";
}

/** Test-only view of the system-ui `wdth` gate (not in the package barrel). */
export function __darwinSystemUiWdthForTest(effectiveKey: string, stretch: number): number {
  return darwinSystemUiWdth(effectiveKey, stretch);
}

/**
 * @param stretch CSS `font-stretch` as a percentage, 100 = `normal`. Reaches the
 *   macOS declared-family style matcher, where Blink turns it into the condensed
 *   / expanded symbolic trait it scores candidates on — and, for the `system-ui`
 *   face and variable webfonts, the variable `wdth` axis (see
 *   `darwinSystemUiWdth` / `applyVariationAxes`).
 */
export function getFontInstance(
  key: string, weight: number, fontSize: number, slant: number = 0,
  variationSettings?: Record<string, number>, stretch: number = 100,
): FontInstance | null {
  // Webfont keys (`webfont:<lowercased family>`) resolve through the runtime
  // registry rather than the on-disk FONT_PATHS table.
  if (key.startsWith("webfont:")) {
    return pickWebfontVariant(key.slice("webfont:".length), weight, fontSize, slant, variationSettings, stretch);
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
    return getFontInstance(variant.baseKey, variant.weight, fontSize, variant.italic ? slant : 0, variationSettings, stretch);
  }
  const cut = resolveEffectiveCutKey(key, weight, slant, stretch);
  const effectiveKey = cut.key;
  const routedItalicCut = cut.routedItalicCut;

  // DM-578: include author-set variation settings in the cache key so two
  // elements requesting the same (key, weight, size, slant) but with different
  // axis overrides don't share a single cached instance.
  const fvsKey = variationSettings != null
    ? Object.keys(variationSettings).sort().map((t) => `${t}=${variationSettings[t]}`).join(",")
    : "";
  // On the DECLARED-family path `effectiveKey` carries the whole stretch
  // decision (it IS the resolved cut). On the macOS `system-ui` face the
  // stretch ALSO drives the variable `wdth` axis (see `darwinSystemUiWdth`), so
  // two stretches on the same key are two different instances and the width
  // needs its own slot.
  const wdthStretch = darwinSystemUiWdth(effectiveKey, stretch);
  const cacheKey = `${effectiveKey}-${weight}-${fontSize}-${slant}-${fvsKey}${wdthStretch !== 100 ? `-wdth${wdthStretch}` : ""}`;
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
    // DM-1721: on Windows, DirectWrite opening a variable FILE by path yields
    // the DEFAULT fvar instance — unlike CoreText, it does not apply axes
    // internally. Resolve the axis location up front (CSS-derived + the
    // matcher's resolved values — see resolveAxisLocationForFile) and pass it
    // to the helper as `variations`, so its outlines and advances come from
    // the SAME instance the embedded subset pins (e.g. "Segoe UI Variable
    // Display" at opsz 36, not the file default).
    //
    // macOS needs it too, for the same reason and against the previous comment
    // here, which claimed "CoreText named faces already resolve the optical
    // instance". Measured on macOS 26.5.2 with the SF Indic faces
    // (`.SFDevanagari-Regular` in `SFIndia.ttc`, U+0915, upem 1000): a handle
    // opened by name/path reports NO variation and NO optical-size attribute at
    // any size, and its advance is 802 — the face at its default `opsz` 28 —
    // while Chrome paints 833 for a 13 px run. Chrome does not inherit
    // CoreText's implicit sizing either; it OVERRIDES it, cloning the typeface
    // at `opsz` = the specified size (see `resolveDarwinAxisLocation`). So the
    // axes must be applied here rather than assumed.
    //
    // The two platforms resolve DIFFERENT axis sets, which is why this is not
    // one call: Windows pins `wght` from the CSS weight because DirectWrite has
    // not applied it, macOS must not because the CoreText trait/weight
    // re-selection already has.
    const helperFaceInfo = (hintedSubsetEnabled() || hostPlatform() === "win32" || hostPlatform() === "darwin")
      ? resolveFaceInfoForFile(spec.path, spec.postscriptName) : null;
    // The face's own non-default coordinates (macOS): the CoreText handle's
    // observed position (`spec.ctAxes` — covers clone names like
    // `Skia-Regular_Light` whose fvar instances carry no postscriptNameID), or
    // the fvar named instance the PostScript name denotes. Seeded into the
    // darwin axis location so the pinned instance IS the matched face — a
    // CSS-derived `wght` never enters here (Blink's mac path applies only
    // `opsz` + font-variation-settings on top of the matched face,
    // `font_platform_data_mac.mm:113-208`, tag 147.0.7727.15).
    const darwinFaceAxes = hostPlatform() === "darwin"
      ? darwinFaceOwnAxes(spec.ctAxes, helperFaceInfo?.instanceAxes, helperFaceInfo?.fileAxes ?? null)
      : null;
    const helperAxes = helperFaceInfo?.fileAxes == null ? undefined
      : hostPlatform() === "win32"
        ? resolveAxisLocationForFile(helperFaceInfo.fileAxes, weight, fontSize, slant, variationSettings, spec.resolvedAxes)
        : hostPlatform() === "darwin"
          ? resolveDarwinAxisLocation(helperFaceInfo.fileAxes, fontSize, variationSettings, darwinFaceAxes)
          : undefined;
    // DM-1916: a face carrying both `trak` and `STAT` is tracked by HarfBuzz at
    // the run's point size, and no platform helper reproduces that — the macOS
    // helper opens every face at size = unitsPerEm, so it tracks as though every
    // run were 1000 px. Shape those faces with HarfBuzz instead, through the
    // `shapeFallback` seam so OUTLINES stay with the helper. That split is
    // Chrome's own: Blink shapes with HarfBuzz and rasterizes from the platform
    // typeface via Skia.
    //
    // The axis location is the SHAPING-side derivation, not `helperAxes`, and
    // the two legitimately differ: the helper opens the face by PostScript name,
    // so CoreText resolves a named fvar instance itself and `wght` must not be
    // re-applied on top; HarfBuzz opens it by face index and gets the file's
    // default instance, so every axis has to be named explicitly or a request
    // for PingFang Regular shapes with the Medium master it is an instance of.
    const hbShapeFace = _trakHbShapingEnabled && helperFaceInfo != null && faceHasTrakAndStat(spec.path, helperFaceInfo.faceIndex)
      ? makeHarfbuzzShapeFallback(
        spec.path, helperFaceInfo.faceIndex, fontSize,
        helperFaceInfo.fileAxes != null
          ? (hostPlatform() === "darwin"
            // The SAME darwin derivation as `helperAxes` — HarfBuzz opens by
            // face index and gets the file's DEFAULT instance, and the face's
            // own coordinates are already seeded into that derivation. Tags
            // left out sit at the default master, which is exactly where the
            // matched face's unset axes are. No CSS `wght` pin: the weight
            // lives in WHICH face the matcher picked.
            ? (helperAxes ?? null)
            : resolveAxisLocationForFile(helperFaceInfo.fileAxes, weight, fontSize, slant, variationSettings,
                                         spec.resolvedAxes, helperFaceInfo.instanceAxes))
          : null,
      )
      : undefined;
    const helper = createGlyphHelperFont({
      postscriptName: spec.postscriptName, fontPath: spec.path, variations: helperAxes,
      // DM-1883: consulted when the helper's own `shape` query fails, which on
      // Windows is always — its helper has no such query, so without this a
      // shaped run silently degrades to isolated letterforms. On a `trak`+`STAT`
      // face it is consulted FIRST instead (see `preferShapeFallback`), and the
      // fontkit shaper is not the one to consult there: fontkit implements no
      // AAT tracking at all, so it would answer advances with no tracking in
      // them, where Chrome's carry the tracking for the RUN's point size. Only
      // HarfBuzz, told the run size via `ptem`, produces that. (The helper's
      // per-glyph `glyphs` query is deliberately untracked too — a DESIGN-unit
      // advance cannot hold a size-dependent term — but that is the input to
      // tracking, not a substitute for it.)
      shapeFallback: hbShapeFace ?? makeFontkitShaper(spec.path, spec.postscriptName, helperAxes),
      preferShapeFallback: hbShapeFace != null,
    });
    if (helper != null) {
      const instance = helper as unknown as FontInstance;
      // Native-helper instances carry no name of their own. Stamp the resolved
      // cut's, so the instance is self-identifying no matter which of the two
      // branches below records a `fontSourceMap` entry (one is flag-gated).
      instance.postscriptName ??= spec.postscriptName;
      // When Blink would CLONE this face at a non-default axis location, also
      // stamp the name CoreText gives that clone — so the conformance oracle
      // compares Chrome's instantiated name against the instance we actually
      // paint instead of against the base face. The name is composed from the
      // coordinates and handle state on OUR side, never copied from Chrome's
      // answer, so a genuine axis divergence still shows up as a name mismatch.
      //
      // The gate consults the CoreText-substituted handle's CURRENT position as
      // the live resolver observed it (`darwinHandleAxesFor` — see
      // `darwinCloneInstanceName` for the measured mechanism: CoreText pre-sets
      // `opsz` on some handles and Blink then never clones them), so faces the
      // live resolver did not register — static-table keys, hosts on an older
      // helper binary — keep the base name, which is the previous behavior and
      // keeps any resulting oracle route visible rather than guessed at.
      //
      // The composition base is the MEMBER's name: when the requested face is
      // an fvar named instance (`.SFDevanagari-Bold` = the Regular member at
      // wght 700), CoreText composes off-instance clones from the base master
      // (measured: {opsz:20, wght:700} on a `.SFDevanagari-Bold` handle names
      // `.SFDevanagari-Regular_opsz140000_wght2BC0000` — which is also exactly
      // the route name Chrome reports for the bold 20px stacks).
      if (hostPlatform() === "darwin") {
        const handleAxes = darwinHandleAxesFor(key, weight, fontSize, slant);
        const composeBase = helperFaceInfo?.memberPostscriptName ?? spec.postscriptName;
        if (handleAxes != null && composeBase != null) {
          const instName = darwinCloneInstanceName(
            composeBase, handleAxes, fontSize, variationSettings, helperFaceInfo?.namedInstances);
          if (instName != null && instName !== spec.postscriptName) {
            instance.instantiatedPostscriptName = instName;
          }
        }
      }
      // DM-1714: even when outlines come from the native helper (macOS CoreText /
      // Windows DirectWrite — the default for live-resolver-registered system
      // fonts), the on-disk FILE is known. If it's a standard sfnt with glyf/CFF
      // (Windows TTFs are — only genuinely outline-less files like PingFang's hvgl
      // aren't), the hinting-preserving hb-subset path can still subset it by the
      // helper's glyph ids (which share the file's gid space). Record the source
      // so getFontSourceInfo exposes it; buildGlyfFontForEntry guards on actual
      // glyf/CFF presence before subsetting. Behind the flag to avoid the extra
      // fontkit open on the default (svg2ttf) path.
      //
      // DM-1716: when the file is VARIABLE (Segoe UI Variable on Windows 11),
      // also record the axis location this instance resolved to — the
      // embedded subset must pin the same location or it would embed the
      // default master's outlines.
      if (hintedSubsetEnabled() && helperFaceInfo != null) {
        const { faceIndex, nameMatched, fileAxes, instanceAxes } = helperFaceInfo;
        fontSourceMap.set(instance as unknown as object, {
          path: spec.path, postscriptName: spec.postscriptName, faceIndex, nameMatched,
          // DM-1721: `spec.resolvedAxes` (DirectWrite's resolved axis values
          // for live-resolver / family-lookup picks) overrides the CSS-derived
          // opsz pin — named optical subfamilies don't re-vary opsz per size.
          //
          // `fileAxes` is null when the requested name is not a physical member
          // (`nameMatched: false`), so no axis location is derived from a face
          // nobody asked for. That used to report member zero's axes: every
          // PingFang key, whatever its region, came back `{wght: 400}` off
          // `.PingFangUITextSC-Default`, which read as evidence that SC and HK
          // had resolved to the same face.
          variationAxes: fileAxes != null
            ? (helperAxes ?? (hostPlatform() === "darwin"
              // The darwin derivation already folded the face's own
              // coordinates in; when it answers undefined the matched face IS
              // the default master, so pin everything to defaults ({}). The
              // old fall-through to `resolveAxisLocationForFile` here is what
              // pinned the CSS weight onto declared variable families —
              // `font-family: Skia` at ANY CSS weight embedded a subset at
              // wght = clamp(weight, [0.48..3.2]) = 3.2, the Black master,
              // while the shaped advances came from the face Chrome paints.
              ? {}
              : resolveAxisLocationForFile(fileAxes, weight, fontSize, slant, variationSettings, spec.resolvedAxes, instanceAxes)))
            : null,
        });
      }
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
  let faceIndex = 0;
  // Whether `font` is the face `spec.postscriptName` names. False when a
  // collection had no member of that name and the line below fell back to
  // member zero — in which case member zero is genuinely what gets shaped, so
  // `faceIndex` stays truthful about the loaded face while `nameMatched: false`
  // records that it is not the requested one. (Contrast the native-helper branch
  // above, where CoreText loads the requested face by name and it is the INDEX
  // that cannot be named — there `faceIndex` becomes null.)
  let nameMatched = true;
  if (opened != null) {
    font = opened;
    if (opened.fonts != null && Array.isArray(opened.fonts)) {
      font = (spec.postscriptName != null && opened.getFont != null)
        ? (opened.getFont(spec.postscriptName) ?? opened.fonts[0])
        : opened.fonts[0];
      // DM-1714/DM-1716: the collection member index (for hb-subset's
      // hb_face_create). Match by postscriptName, NOT object identity —
      // fontkit's getFont() returns a NEW Font object, so indexOf() is always
      // -1 (which silently subset member 0: NotoSansArmenian.ttc's member 0 is
      // the BLACK weight, and the armenian fixture's dram sign embedded black
      // instead of regular).
      const psName = font?.postscriptName;
      const idx = psName != null ? opened.fonts.findIndex((m: any) => m?.postscriptName === psName) : -1;
      faceIndex = idx >= 0 ? idx : 0;
      if (spec.postscriptName != null && psName !== spec.postscriptName) nameMatched = false;
    } else if (spec.postscriptName != null && opened.postscriptName != null
               && opened.postscriptName !== spec.postscriptName) {
      nameMatched = false;
    }
  }

  const fontkitHasOutlines = font != null && fontHasOutlineTable(font);
  if (helperEligible && !fontkitHasOutlines && isGlyphHelperAvailable()) {
    const helper = createGlyphHelperFont({
      postscriptName: spec.postscriptName, fontPath: spec.path,
      shapeFallback: makeFontkitShaper(spec.path, spec.postscriptName),
    });
    if (helper != null) {
      const instance = helper as unknown as FontInstance;
      instance.postscriptName ??= spec.postscriptName;
      fontInstanceCache.set(cacheKey, instance);
      return instance;
    }
  }
  if (font == null) return null; // couldn't open and the helper didn't (or can't) rescue

  // On macOS, only the `system-ui` face takes CSS-valued weight/width AXIS
  // pins (`MatchSystemUIFont` sets wght/wdth variations clamped to the axis
  // range — `mac/font_matcher_mac.mm:540-589`, identical at tag 147.0.7727.15
  // and rev 7d859f27). A DECLARED family's weight lives in WHICH face the
  // trait/weight matcher picked; nothing applies a wght axis afterward
  // (`FontPlatformDataFromCTFont` touches only `opsz` + font-variation-
  // settings). Pinning `wght` = CSS weight here anyway is what clamped
  // `font-family: Skia` (wght axis [0.48..3.2], QuickDraw units) to the BLACK
  // master at every CSS weight — Chrome paints `Skia-Regular` at 400 and the
  // Light/Bold named instances at 300/700 (measured over CDP: widths 783.36 /
  // 720.81 / 836.44 at 100px, all reproduced by the instance coordinates and
  // none by a CSS-valued pin). So on the darwin declared path the face's own
  // coordinates (CoreText handle position / fvar named instance) replace the
  // CSS-derived wght, and `wght` is left at the file default when the matched
  // face IS the default instance.
  const darwinDeclaredAxisPath = hostPlatform() === "darwin" && !isDarwinSystemUiAxisKey(effectiveKey);
  const fontkitFaceAxes = darwinDeclaredAxisPath
      && font?.variationAxes != null && Object.keys(font.variationAxes).length > 0
    ? darwinFaceOwnAxes(spec.ctAxes,
        resolveFaceInfoForFile(spec.path, spec.postscriptName).instanceAxes,
        font.variationAxes)
    : null;
  // On Linux, Blink applies NO variation coordinates to a system font AT ALL —
  // not the CSS weight, not opsz-from-font-size, not wdth, not slnt, not even
  // author font-variation-settings. `FontCache::CreateFontPlatformData` on the
  // !IS_WIN path (`skia/font_cache_skia.cc:299-358`, rev 7d859f27) constructs
  // the FontPlatformData straight from the typeface `matchFamilyStyle`
  // returned; the only `makeClone` sites in platform/fonts are the webfont
  // path (`font_custom_platform_data.cc:233`) and mac
  // (`font_platform_data_mac.mm:199`), and the only VariationSettings()
  // consumer outside those is the mac font cache. The shaping side just READS
  // the typeface's existing design position (`harfbuzz_face.cc:571-584`,
  // `getVariationDesignPosition` → `hb_font_set_variations`). So the face
  // fontconfig matched — for a variable file, the fvar NAMED INSTANCE its
  // FC_INDEX tells FreeType to load — IS the face, at that instance's own
  // coordinates. Measured in the noble container (Lexend VF, wght [100..900],
  // 100px): CSS 450 paints the Regular instance (847.000px), byte-identical
  // to CSS 400 — not the wght=450 interpolation (853.969px) the CSS pin
  // produced — and every other weight lands on a named instance (Thin
  // 776.313 … Black 915.406), never between two.
  const linuxSystemAxisPath = hostPlatform() === "linux";
  const linuxInstanceAxes = linuxSystemAxisPath
      && font?.variationAxes != null && Object.keys(font.variationAxes).length > 0
    ? resolveFaceInfoForFile(spec.path, spec.postscriptName).instanceAxes ?? null
    : null;
  let instance: FontInstance;
  if (linuxSystemAxisPath) {
    // The named instance the resolved PostScript name denotes, or the file's
    // default master when the matched face IS the base (or the file is
    // static). Mirrors FreeType loading the named instance by index.
    instance = font;
    if (linuxInstanceAxes != null && font.getVariation != null) {
      try {
        const v = font.getVariation({ ...linuxInstanceAxes });
        // Same broken-variation probe as applyVariationAxes: a WOFF2-style
        // instance that can't expose its parent's tables falls back to the
        // base face rather than crashing downstream.
        if ((v as any).unitsPerEm != null) {
          (v as any)._appliedVariationAxes = clampAxesToFvarRange({ ...linuxInstanceAxes }, font.variationAxes ?? {});
          instance = v;
        }
      } catch { /* keep the base face */ }
    }
  } else {
    instance = applyVariationAxes(font, weight, fontSize, slant, variationSettings, wdthStretch,
      darwinDeclaredAxisPath ? { faceAxes: fontkitFaceAxes, cssWghtPin: false } : undefined);
  }
  // DM-1693: expose the static face's natural weight + whether a variable wght
  // axis was baked, so the embedded-font path can decide faux-bold. Read from
  // the ORIGINAL fontkit Font (`font`) — `instance` may be a variation instance
  // whose OS/2 reflects the base, and whose `variationAxes` presence is what we
  // want to gate on. Only set a sane usWeightClass (1..1000); 0/absent → leave
  // undefined so the decision defaults to "no embolden".
  const usWeight = font?.["OS/2"]?.usWeightClass;
  if (typeof usWeight === "number" && usWeight >= 1 && usWeight <= 1000) {
    instance.naturalWeight = usWeight;
  }
  // Linux named-instance case: the face's natural weight is the INSTANCE's
  // wght coordinate, not the base master's OS/2 value. Blink's Linux
  // synthetic-bold delta (`font_description.Weight() > 200 +
  // typeface->fontStyle().weight()`, `skia/font_cache_skia.cc:333-339`) asks
  // the matched typeface, whose style weight is the fontconfig pattern's —
  // the named instance's — so a real Bold instance at CSS 700 must read as
  // weight 700 here or the delta would faux-embolden ink that is already bold.
  if (linuxInstanceAxes?.wght != null && linuxInstanceAxes.wght >= 1 && linuxInstanceAxes.wght <= 1000) {
    instance.naturalWeight = linuxInstanceAxes.wght;
  }
  // `hasWeightAxis` gates faux-bold OFF on the premise that the wght axis was
  // instanced at the requested weight. On the darwin declared path it no
  // longer is (the weight lives in WHICH face the matcher picked), and on the
  // Linux system path the axis is never CSS-driven at all (the fontconfig-
  // matched named instance is the face), so the flag is only honest when the
  // CSS pin actually drove the axis — otherwise the synthetic-bold rule must
  // consult the face itself (mac: the bold trait; Linux: the weight delta
  // against the matched face's weight).
  instance.hasWeightAxis = font?.variationAxes?.wght != null && !darwinDeclaredAxisPath && !linuxSystemAxisPath;
  // The face's BOLD trait, which the macOS and Windows synthetic-bold rules
  // both test. Read from the ORIGINAL fontkit Font for the same reason the
  // weight fields above are: a variation instance's OS/2 reflects the base face.
  const fsSelection = font?.["OS/2"]?.fsSelection;
  if (fsSelection != null) {
    // fontkit may expose fsSelection as a parsed bitfield object or as a raw
    // number depending on version; accept either rather than assuming.
    instance.faceIsBoldTrait = typeof fsSelection === "number"
      ? (fsSelection & 0x20) !== 0
      : fsSelection.bold === true;
  }
  // ...but on macOS, ASK CORETEXT, because OS/2 bit 5 is not the same fact and
  // this was shipped as though it were. Blink tests
  // `CTFontGetSymbolicTraits(ct_font) & kCTFontTraitBold`
  // (`mac/font_cache_mac.mm:424-427`, rev 7d859f27) — a CoreText trait derived
  // from the font's registered traits, not that bit.
  //
  // `/System/Library/Fonts/Times.ttc` is where they diverge, and it is not an
  // exotic corner: EVERY face in the container (Roman, Bold, Italic, BoldItalic)
  // reports `fsSelection.regular = true` with `bold = false`, which the spec
  // forbids — REGULAR is mutually exclusive with BOLD and ITALIC. CoreText says
  // `Times-Bold` is bold anyway. Trusting the bit made `weight > 500 && !bold`
  // fire on the real Times-Bold cut, so every `serif` heading painted synthetic
  // bold on top of an already-bold face.
  //
  // Only overrides when CoreText actually answers; a null (no helper on the
  // host, unknown face) leaves the fsSelection reading in place rather than
  // silently deciding "not bold", which is the direction that emboldens.
  if (hostPlatform() === "darwin") {
    const ps = instance.postscriptName ?? font?.postscriptName;
    if (ps != null && ps !== "") {
      const ctTrait = resolveFaceTraitBold(ps, resolveFontSpec(key)?.path);
      if (ctTrait != null) instance.faceIsBoldTrait = ctTrait;
    }
  }
  // DM-1695: expose the face's italic angle + whether a slnt axis carried the
  // slant, for the embedded-font faux-italic decision. Read from the ORIGINAL
  // fontkit Font (same rationale as the weight fields above).
  const italicAngle = font?.italicAngle;
  if (typeof italicAngle === "number" && isFinite(italicAngle)) {
    instance.resolvedItalicAngle = italicAngle;
  }
  instance.hasSlantAxis = font?.variationAxes?.slnt != null;
  // `post.italicAngle` is not trustworthy on its own: Helvetica-LightOblique and
  // HelveticaNeue-BoldItalic both report 0 even though their outlines lean the
  // same ~12° as their correctly-tagged siblings (an 'I' stem measures 150+
  // font units of horizontal travel from foot to cap). The routing decision
  // above is the reliable signal — when we picked the family's own italic cut,
  // the face IS slanted, whatever its post table claims.
  instance.isRoutedItalicCut = routedItalicCut;
  // DM-891: record the exact file this fontkit instance was loaded from, so the
  // per-glyph helper fallback can open the SAME file (glyph ids match) when
  // fontkit returns an empty outline for a glyph it should be able to draw.
  // Only fontkit instances get an entry — helper instances (whole-font tier)
  // and webfonts (no file) deliberately don't, so they never trigger the
  // per-glyph fallback.
  //
  // DM-1716: `variationAxes` tells the hinting-preserving embedded subset how to
  // instance the file. Three-way: a Record when a variation instance was created
  // (pin exactly those axes); {} when the FILE is variable but shaping used the
  // default master (applyVariationAxes matched no axis or getVariation failed —
  // pin everything to defaults so the consumer browser can't re-vary an axis we
  // didn't); null when the file is static (no pinning needed).
  const fileIsVariable = font?.variationAxes != null && Object.keys(font.variationAxes).length > 0;
  const appliedAxes = (instance as unknown as { _appliedVariationAxes?: Record<string, number> })._appliedVariationAxes;
  // DM-1925: the fontkit path needs the same AAT tracking DM-1916 gave the
  // native-helper path, and for the faces that matter most — `sf-pro`,
  // `sf-pro-italic`, `sf-pro-text` and `sf-hebrew` carry `trak` + `STAT` and
  // land HERE rather than on the helper, because they are ordinary `glyf` files
  // and so never take the `extractor: "native"` branch. That is `system-ui`,
  // i.e. most macOS body text, and fontkit implements no AAT tracking at all.
  //
  // Installed in place rather than proxied: `instance` is already carrying its
  // weight/italic/trait fields and is about to become a `fontSourceMap` key.
  // Only `layout` changes — outlines still come from fontkit, by glyph id, in
  // the same gid space (same file). Same split as the helper path, and Chrome's
  // own: HarfBuzz shapes, the platform typeface draws.
  if (_trakHbShapingEnabled && faceIndex != null && faceHasTrakAndStat(spec.path, faceIndex)) {
    installHarfbuzzShaping(
      instance as unknown as Parameters<typeof installHarfbuzzShaping>[0],
      spec.path, faceIndex, fontSize,
      fileIsVariable ? (appliedAxes ?? null) : null,
    );
  }
  fontSourceMap.set(instance as unknown as object, {
    path: spec.path, postscriptName: spec.postscriptName, faceIndex, nameMatched,
    variationAxes: fileIsVariable ? (appliedAxes ?? {}) : null,
  });
  fontInstanceCache.set(cacheKey, instance);
  return instance;
}

/** DM-1714/DM-1716: the on-disk file + collection index a font instance was
 *  loaded from, for the hinting-preserving hb-subset embedded path. Null for
 *  webfont / synthetic instances that have no backing sfnt file — those keep
 *  the svg2ttf path. `variationAxes` is the axis location to pin when
 *  instancing a variable source file (a Record — possibly empty = all
 *  defaults), or null for a static file. */
export function getFontSourceInfo(font: FontInstance | null | undefined): FontSourceInfo | null {
  if (font == null) return null;
  return fontSourceMap.get(font as unknown as object) ?? null;
}

export interface FontSourceInfo {
  path: string;
  postscriptName?: string;
  /** The file's PHYSICAL sfnt member index the outlines belong to, for
   *  `hb_face_create`. **`null` means "unknown"** — the requested PostScript
   *  name is not among the file's members, so no index can honestly be named.
   *  Read it as an index only after checking it is non-null; treating null as 0
   *  reads member zero, a face nobody asked for.
   *
   *  Why this can happen while the render is still correct: the native helper
   *  resolves the face through CoreText, which enumerates a container's
   *  NAMED INSTANCES (PingFangUI.ttc reports 268) while fontkit — and every
   *  collection-indexing API — sees only its 32 physical members. A face
   *  CoreText loads by name can therefore have no physical member of that name
   *  at all: `PingFangSC-Regular` is one, and the members are the
   *  `.PingFangUIText*-Default` / `*-Medium` cuts. The outlines are right; the
   *  index simply does not exist. */
  faceIndex: number | null;
  /** False when the requested PostScript name was not found among the file's
   *  members. `faceIndex` and `variationAxes` then describe nothing (both are
   *  null) rather than silently describing member zero. */
  nameMatched: boolean;
  /** Axis location the instance resolved to: Record ⇒ variable source file (pin
   *  these tags, all others to default); null/absent ⇒ static file, or an
   *  unidentifiable member whose axes we decline to guess. */
  variationAxes?: Record<string, number> | null;
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
 *  in getFontInstance). Webfonts are absent → no fallback. */
const fontSourceMap = new WeakMap<object, FontSourceInfo>();

/** DM-1714/DM-1716: the hinting-preserving hb-subset embedded path is the
 *  DEFAULT; set DOMOTION_HINTED_SUBSET=0 to fall back to the svg2ttf-only
 *  builder (A/B measurement, escape hatch). Read per call (not at module load)
 *  so tests can toggle it. */
function hintedSubsetEnabled(): boolean {
  return process.env.DOMOTION_HINTED_SUBSET !== "0";
}

/** The collection-member index of `postscriptName` within a (possibly-TTC) sfnt
 *  file (for hb-subset's hb_face_create) plus that face's variation-axis table
 *  (null when static). faceIndex 0 / axes null on open failure. Used for
 *  native-helper instances (Windows DirectWrite / macOS CoreText) that skip
 *  fontkit's own index resolution but whose FILE we still want to subset.
 *  Cached per (path, postscriptName) — the helper branch hits this once per
 *  (weight, size) instance of the same file. */
export interface FileFaceInfo {
  /** Physical sfnt member index, or null when the requested name is neither a
   *  member nor a named instance of one. */
  faceIndex: number | null;
  nameMatched: boolean;
  fileAxes: Record<string, unknown> | null;
  /** Set when the requested name is an fvar NAMED INSTANCE of `faceIndex`'s
   *  member rather than a member itself: the instance's own axis coordinates.
   *  These ARE the requested face, so they beat a CSS-derived pin. */
  instanceAxes?: Record<string, number> | null;
  /** The resolved MEMBER's own PostScript name. Identical to the requested name
   *  for a physical-member match; differs for a named-instance request, where it
   *  is the base master's name — which is what CoreText composes instantiated
   *  names from (measured: cloning a `.SFDevanagari-Bold` handle at
   *  {opsz:20, wght:700} names `.SFDevanagari-Regular_opsz140000_wght2BC0000`,
   *  not `.SFDevanagari-Bold_…`). */
  memberPostscriptName?: string | null;
  /** The resolved member's fvar named instances — PostScript name plus full
   *  coordinate set — for CoreText-style instantiated-name composition
   *  (`coreTextVariationInstanceName`): CoreText reports a named instance's own
   *  PostScript name when an applied location lands exactly on its coordinates
   *  (measured: `{wght: 700}` on `.SFDevanagari-Regular` → `.SFDevanagari-Bold`).
   *  Null when the member is static or no instance resolves a PostScript name. */
  namedInstances?: Array<{ postscriptName: string; coords: Record<string, number> }> | null;
}

/** Find `postscriptName` among a variable member's fvar NAMED INSTANCES.
 *
 *  Many system faces are not physical sfnt members at all. `PingFangSC-Regular`
 *  is instance 0 of member 20 (`PingFangSC-Medium`) at WDTH 500 / wght 400 /
 *  HGHT 500; `.ThonburiUI-Bold` is instance 2 of member 0 at wght 700. CoreText
 *  enumerates those instances as descriptors and loads them by name, so they are
 *  ordinary requests — but a member-name search misses every one of them.
 *
 *  Resolving them is what makes both reported fields correct rather than merely
 *  honest: the member index becomes usable (member 20 for SC, 22 for HK — the
 *  two used to both report 0, which read as "SC and HK resolved to one face"),
 *  and the axis location becomes the instance's own coordinates instead of a
 *  location re-derived from CSS that happens to coincide.
 *
 *  fontkit's own `namedVariations` accessor cannot be used here: it reads
 *  `instance.name.en` and throws on faces whose instance name records carry no
 *  English entry, which includes these Apple system fonts. The underlying
 *  `fvar.instance[]` records are fine, so read those and resolve the
 *  `postscriptNameID` through the name table directly. */
function findNamedInstanceAxes(member: any, postscriptName: string): Record<string, number> | null {
  const instances = member?.fvar?.instance;
  const axisRecords = member?.fvar?.axis;
  if (!Array.isArray(instances) || !Array.isArray(axisRecords)) return null;
  // nameID → string. IDs ≥ 256 land in fontkit's `fontFeatures` group; the
  // standard PostScript-name slot (6) is the member's own name.
  const records = member?.name?.records ?? {};
  const extended: Record<string, Record<string, string> | undefined> = records.fontFeatures ?? {};
  const nameFor = (id: number): string | null => {
    if (id === 6) return pickNameString(records.postscriptName);
    return pickNameString(extended[String(id)]);
  };
  for (const inst of instances) {
    const psId = inst?.postscriptNameID;
    if (typeof psId !== "number") continue;
    if (nameFor(psId) !== postscriptName) continue;
    const coord = inst?.coord;
    if (!Array.isArray(coord)) return null;
    const axes: Record<string, number> = {};
    for (let i = 0; i < axisRecords.length && i < coord.length; i++) {
      const tag = axisRecords[i]?.axisTag;
      const v = coord[i];
      if (typeof tag === "string" && typeof v === "number" && isFinite(v)) axes[tag] = v;
    }
    return Object.keys(axes).length > 0 ? axes : null;
  }
  return null;
}

/** Every fvar named instance of `member` that resolves a PostScript name, with
 *  its full coordinate set in axis order. The forward counterpart of
 *  `findNamedInstanceAxes` above (name → coords): instantiated-name composition
 *  needs the whole list to ask "does this axis location land exactly on a named
 *  instance?" the way CoreText does. Same name-table machinery, same reason
 *  fontkit's `namedVariations` accessor is bypassed (it throws on Apple system
 *  faces whose instance name records carry no English entry). */
function enumerateNamedInstances(member: any): Array<{ postscriptName: string; coords: Record<string, number> }> | null {
  const instances = member?.fvar?.instance;
  const axisRecords = member?.fvar?.axis;
  if (!Array.isArray(instances) || !Array.isArray(axisRecords)) return null;
  const records = member?.name?.records ?? {};
  const extended: Record<string, Record<string, string> | undefined> = records.fontFeatures ?? {};
  const nameFor = (id: number): string | null => {
    if (id === 6) return pickNameString(records.postscriptName);
    return pickNameString(extended[String(id)]);
  };
  const out: Array<{ postscriptName: string; coords: Record<string, number> }> = [];
  for (const inst of instances) {
    const psId = inst?.postscriptNameID;
    if (typeof psId !== "number") continue;
    const name = nameFor(psId);
    if (name == null) continue;
    const coord = inst?.coord;
    if (!Array.isArray(coord)) continue;
    const coords: Record<string, number> = {};
    for (let i = 0; i < axisRecords.length && i < coord.length; i++) {
      const tag = axisRecords[i]?.axisTag;
      const v = coord[i];
      if (typeof tag === "string" && typeof v === "number" && isFinite(v)) coords[tag] = v;
    }
    if (Object.keys(coords).length > 0) out.push({ postscriptName: name, coords });
  }
  return out.length > 0 ? out : null;
}

/** One string out of a fontkit localized-name record, preferring English. */
function pickNameString(rec: unknown): string | null {
  if (typeof rec === "string") return rec;
  if (rec == null || typeof rec !== "object") return null;
  const map = rec as Record<string, unknown>;
  const en = map.en;
  if (typeof en === "string") return en;
  for (const v of Object.values(map)) if (typeof v === "string") return v;
  return null;
}

/**
 * DM-1883: a fontkit-backed shaper for a helper that has no `shape` query.
 *
 * Windows' DirectWrite helper implements `fallback`/`family`/`glyphs`/`meta` and
 * no `shape`, so `layout()` on a helper-backed face could never shape and every
 * run took the naive one-glyph-per-codepoint path. For Arabic that is isolated
 * letterforms — joining silently lost, with correct advances, which is exactly
 * how it presented against Chromium-on-Windows.
 *
 * This returns only ids/positions/clusters; the outlines stay with the helper,
 * so DirectWrite's resolved variable-axis pin (DM-1721) is preserved. Glyph ids
 * index the same gid space because both engines read the same file.
 *
 * `variations` matters and is not optional politeness: when the helper was
 * opened at a non-default fvar location, a fontkit instance at the file default
 * would return advances for a DIFFERENT instance, so the run would shape
 * correctly and measure wrong. `getVariation()` puts both engines on the same
 * instance.
 *
 * Returns null (rather than throwing) whenever fontkit cannot open, cannot find
 * the requested collection member, or produces nothing — the caller then keeps
 * its existing naive path, which still renders text.
 */
export function makeFontkitShaper(
  path: string, postscriptName?: string, variations?: Record<string, number>,
): ((text: string, direction?: "ltr" | "rtl") => { ids: number[]; positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>; clusters: number[] } | null) | undefined {
  if (path === "") return undefined;
  let font: any | null | undefined; // undefined = not yet opened, null = unopenable
  const open = (): any | null => {
    if (font !== undefined) return font;
    font = null;
    try {
      const opened: any = fontkit.openSync(path);
      let f: any = opened;
      // TTC: pick the requested member, mirroring `getFontInstance`'s selection.
      if (opened?.fonts != null && Array.isArray(opened.fonts)) {
        f = (postscriptName != null && opened.getFont != null)
          ? (opened.getFont(postscriptName) ?? opened.fonts[0])
          : opened.fonts[0];
      }
      if (f != null && variations != null && Object.keys(variations).length > 0 && f.getVariation != null) {
        try { f = f.getVariation(variations) ?? f; } catch { /* keep the base face */ }
      }
      font = f ?? null;
    } catch { font = null; }
    return font;
  };
  return (text: string, direction?: "ltr" | "rtl") => {
    const f = open();
    if (f?.layout == null) return null;
    // Direction passed through explicitly when the caller knows it (a
    // single-script segment), the way Blink hands it to HarfBuzz rather than
    // letting content inference decide.
    const run: any = f.layout(text, undefined, undefined, undefined, direction);
    const glyphs: any[] = run?.glyphs ?? [];
    const positions: any[] = run?.positions ?? [];
    if (glyphs.length === 0 || glyphs.length !== positions.length) return null;
    return {
      ids: glyphs.map((g) => g.id as number),
      positions: positions.map((p) => ({
        xAdvance: p.xAdvance ?? 0, yAdvance: p.yAdvance ?? 0,
        xOffset: p.xOffset ?? 0, yOffset: p.yOffset ?? 0,
      })),
      clusters: deriveClusters(text, glyphs, run?.direction),
    };
  };
}

/**
 * Source code-unit index per shaped glyph — the cluster map.
 *
 * fontkit does NOT expose a `cluster` on its glyphs; it exposes `codePoints`,
 * the source codepoints each glyph consumed. Reading a non-existent `.cluster`
 * yields a map of all zeros, which is not obviously wrong at a glance and is
 * badly wrong in effect: every glyph claims to start at source index 0, so the
 * renderer's per-character x positioning collapses. Measured on Arabic against
 * the macOS helper, which reports `4,3,2,1,0` where the naive read gave
 * `0,0,0,0,0`.
 *
 * The walk must run in LOGICAL order, and fontkit hands back VISUAL order — for
 * RTL those are reverses of each other, which is why `direction` is consulted
 * rather than assumed. Consuming codepoints (rather than indexing by glyph
 * position) is what keeps ligatures and marks honest: a ligature consumes
 * several codepoints and correctly reports the first one's index, and a mark
 * consumes its own.
 */
function deriveClusters(text: string, glyphs: any[], direction?: string): number[] {
  // Code-unit index of each codepoint — NOT the codepoint's ordinal, because
  // astral characters occupy two units and the cluster map is in units.
  const unitOf: number[] = [];
  for (let i = 0; i < text.length;) {
    unitOf.push(i);
    i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
  }
  const order = [...glyphs.keys()];
  if (direction === "rtl") order.reverse();
  const clusters = new Array<number>(glyphs.length).fill(0);
  let consumed = 0;
  for (const gi of order) {
    clusters[gi] = unitOf[Math.min(consumed, unitOf.length - 1)] ?? 0;
    consumed += glyphs[gi]?.codePoints?.length ?? 1;
  }
  return clusters;
}

const fileFaceInfoCache = new Map<string, FileFaceInfo>();
function resolveFaceInfoForFile(path: string, postscriptName?: string): FileFaceInfo {
  const cacheKey = `${path}#${postscriptName ?? ""}`;
  const cached = fileFaceInfoCache.get(cacheKey);
  if (cached != null) return cached;
  let result: FileFaceInfo = { faceIndex: 0, nameMatched: true, fileAxes: null };
  try {
    const opened: any = fontkit.openSync(path);
    if (opened?.fonts != null && Array.isArray(opened.fonts)) {
      // Match by postscriptName — getFont() returns a NEW object, so indexOf()
      // is always -1 (see the same fix in getFontInstance).
      const idx = postscriptName != null
        ? opened.fonts.findIndex((m: any) => m?.postscriptName === postscriptName)
        : -1;
      if (idx >= 0) {
        const axes = opened.fonts[idx]?.variationAxes;
        result = {
          faceIndex: idx, nameMatched: true,
          fileAxes: axes != null && Object.keys(axes).length > 0 ? axes : null,
          namedInstances: enumerateNamedInstances(opened.fonts[idx]),
          memberPostscriptName: opened.fonts[idx]?.postscriptName ?? null,
        };
      } else if (postscriptName == null) {
        // No name to match: member zero IS the request, so index 0 is honest.
        const axes = opened.fonts[0]?.variationAxes;
        result = {
          faceIndex: 0, nameMatched: true,
          fileAxes: axes != null && Object.keys(axes).length > 0 ? axes : null,
          namedInstances: enumerateNamedInstances(opened.fonts[0]),
          memberPostscriptName: opened.fonts[0]?.postscriptName ?? null,
        };
      } else {
        // Not a physical member. Before giving up, check whether it is an fvar
        // NAMED INSTANCE of one — the usual shape for a CoreText-resolved face,
        // and resolvable to a real member index plus exact axis coordinates.
        let found: FileFaceInfo | null = null;
        for (let i = 0; i < opened.fonts.length; i++) {
          const instanceAxes = findNamedInstanceAxes(opened.fonts[i], postscriptName);
          if (instanceAxes == null) continue;
          const axes = opened.fonts[i]?.variationAxes;
          found = {
            faceIndex: i, nameMatched: true,
            fileAxes: axes != null && Object.keys(axes).length > 0 ? axes : null,
            instanceAxes,
            namedInstances: enumerateNamedInstances(opened.fonts[i]),
            memberPostscriptName: opened.fonts[i]?.postscriptName ?? null,
          };
          break;
        }
        // Neither a member nor a named instance of one. Member zero is a
        // DIFFERENT face, so neither its index nor its variation axes describe
        // what the caller asked for — say "unknown" rather than reporting member
        // zero's as though they were the requested face's. A caller needing an
        // index then fails loudly instead of silently subsetting member zero.
        result = found ?? { faceIndex: null, nameMatched: false, fileAxes: null };
      }
    } else {
      // Not a collection: index 0 is the file's only face. It may still not be
      // the requested name (a relocated / stub file), which callers can see.
      const axes = opened?.variationAxes;
      const psName = opened?.postscriptName;
      // A single-file VARIABLE font's named instances are ordinary requests
      // too — `Lexend-Medium` is an fvar instance of Lexend-Regular's file,
      // and the platform loads it by name at wght 500. Resolving it here (the
      // same lookup the collection branch already performs per member) is what
      // lets the axis location pin the INSTANCE's coordinates instead of
      // re-deriving a location from CSS that only coincides when the request
      // equals the cut's weight.
      const instanceAxes = postscriptName != null && psName !== postscriptName
        ? findNamedInstanceAxes(opened, postscriptName)
        : null;
      result = {
        faceIndex: 0,
        nameMatched: postscriptName == null || psName == null || psName === postscriptName
          || instanceAxes != null,
        fileAxes: axes != null && Object.keys(axes).length > 0 ? axes : null,
        ...(instanceAxes != null ? { instanceAxes } : {}),
        namedInstances: enumerateNamedInstances(opened),
        memberPostscriptName: psName ?? null,
      };
    }
  } catch { /* unreadable → leave the single-static-face default */ }
  fileFaceInfoCache.set(cacheKey, result);
  return result;
}

/** Test-only view of the member-index resolver (not part of the package's public
 *  barrel), so the honest-reporting contract can be pinned against synthetic
 *  collections instead of whichever fonts a given host happens to ship. */
export function __resolveFaceInfoForFileForTest(path: string, postscriptName?: string): FileFaceInfo {
  return resolveFaceInfoForFile(path, postscriptName);
}

/** Test-only dynamic-font registration (not part of the package's public
 *  barrel): lets a platform-gated test point a `sysfb:`-style key at a font
 *  file it wrote itself — e.g. a variable TTF on a Linux host whose system
 *  inventory ships none — and then drive the real `getFontInstance` path. */
export function __registerDynamicSystemFontForTest(
  key: string, path: string, postscriptName: string,
): void {
  registerDynamicSystemFont(key, path, postscriptName, "fontkit");
}

/**
 * The file + collection member HarfBuzz should open to shape with `fontKey`, or
 * null when there is no file to open.
 *
 * A path alone does not identify a face. macOS ships most system families as
 * `.ttc` collections whose first member is the regular cut, so a bold / UI / PUA
 * face opened by path lands on the wrong one: measured on GeezaPro.ttc, shaping
 * the same Arabic word through member 0 (GeezaPro) and member 1 (GeezaPro-Bold)
 * returns the same five glyphs with different ids and different advances —
 * well-formed, plausible output measured from a face nobody asked for, with
 * nothing anywhere reporting an error.
 *
 * Blink never has to ask this, because by the time it reaches HarfBuzz it holds
 * a typeface rather than a path and the typeface knows its own index:
 * `HbFaceFromSkTypeface` reads it back out via `typeface->openStream(&ttc_index)`
 * and passes it to `hb_face_create`
 * (`external/chromium/.../fonts/shaping/harfbuzz_face_from_typeface.cc:19-44`,
 * rev 7d859f27). We select faces by PostScript name instead, so the equivalent
 * is the member lookup `resolveFaceInfoForFile` already performs for the
 * embedded-font subsetter — including its resolution of a name that is an fvar
 * NAMED INSTANCE of a member rather than a member itself, which is the usual
 * shape for a CoreText-resolved face and which a plain name-table scan misses.
 *
 * `faceIndex` is null when the name is not in the file at all. That propagates:
 * the shaper declines rather than falling back to member zero, which is the
 * whole point.
 */
export function shapingFaceFor(
  fontKey: string,
  /** The run's CSS properties, used only to resolve a VARIABLE file's axis
   *  location. Omit them and `axes` comes back null, which shapes the default
   *  fvar instance — correct for a static face and wrong for a variable one, so
   *  a caller that has these should pass them. */
  weight?: number,
  fontSize?: number,
  slant?: number,
  variationSettings?: Record<string, number>,
): { path: string; faceIndex: number | null; axes: Record<string, number> | null } | null {
  const spec = resolveFontSpec(fontKey);
  const path = spec?.path;
  if (path == null || path === "") return null;
  const info = resolveFaceInfoForFile(path, spec?.postscriptName);
  // The SAME derivation the native outline path uses (see `getFontInstance`'s
  // `variationAxes`), deliberately not a second one: the shaper and the outlines
  // have to agree about which master they are on, and two parallel derivations
  // that happen to coincide today is exactly the shape of bug this area keeps
  // producing. `fileAxes` is null when the requested name is not a physical
  // member, and then no location is derived from a face nobody asked for.
  const axes = info.fileAxes != null
    ? (hostPlatform() === "linux"
      // The Linux system-font derivation: Blink applies NO variation
      // coordinates there (`skia/font_cache_skia.cc:299-358` builds the
      // FontPlatformData straight from the fontconfig-matched typeface), so
      // the shaper sits on the named instance the resolved PostScript name
      // denotes — or the default master — exactly like the outline path.
      ? (info.instanceAxes != null ? { ...info.instanceAxes } : null)
      : weight == null || fontSize == null
      ? null
      : hostPlatform() === "darwin" && !isDarwinSystemUiAxisKey(fontKey)
      // The darwin declared/fallback derivation — the face's own coordinates
      // plus the opsz/font-variation-settings clone pins, never a CSS-valued
      // `wght`. Must stay the same derivation `getFontInstance` uses (that is
      // this function's contract), which no longer CSS-pins wght on macOS.
      ? (resolveDarwinAxisLocation(info.fileAxes, fontSize, variationSettings,
          darwinFaceOwnAxes(spec?.ctAxes, info.instanceAxes, info.fileAxes)) ?? null)
      : resolveAxisLocationForFile(info.fileAxes, weight, fontSize, slant ?? 0, variationSettings, spec?.resolvedAxes, info.instanceAxes))
    : null;
  return { path, faceIndex: info.faceIndex, axes };
}

/** DM-1716: the axis location a run resolved to on a variable file whose
 *  outlines came from the NATIVE helper (CoreText / DirectWrite). Mirrors
 *  applyVariationAxes' resolution — CSS weight → `wght`, font-size → `opsz`
 *  (Chromium's automatic optical sizing), slant → `slnt`, author
 *  `font-variation-settings` on top — restricted to axes the file exposes.
 *
 *  DM-1721 (`resolvedAxes`): on Windows, DirectWrite does NOT re-vary `opsz`
 *  per font size — named optical subfamilies are pinned at a fixed value at
 *  EVERY size ("Segoe UI Variable Text" → 10.5, "Display" → 36; width-matched
 *  to sub-0.01px on the Win11 VM) and the typographic family resolves through
 *  DirectWrite's own instance mapping. No CSS-derived pin reproduces that, so
 *  when the win32 helper reported the matcher's RESOLVED axis values for the
 *  face (`FontPath.resolvedAxes`), those win for every axis EXCEPT:
 *  - `wght`: the fallback query maps at weight 400 only, so the resolved
 *    `wght` is authoritative just for weight-400 runs; other weights keep the
 *    CSS-derived pin (DirectWrite re-matches weight per run, tracking CSS).
 *  - `slnt`: same reasoning — CSS italic drives it per run.
 *  Author `font-variation-settings` still override on top, matching CSS
 *  cascade order. macOS is untouched: the darwin helper reports no axes and
 *  CoreText genuinely applies automatic optical sizing (the opsz=fontSize pin
 *  there is validated pixel-exact by the full macOS sweeps). */
export function resolveAxisLocationForFile( // exported for unit testing (not in the package barrel)
  fileAxes: Record<string, unknown>, weight: number, fontSize: number, slant: number,
  variationSettings?: Record<string, number>,
  resolvedAxes?: Record<string, number>,
  instanceAxes?: Record<string, number> | null,
): Record<string, number> {
  const axes: Record<string, number> = {};
  if (fileAxes.wght != null) axes.wght = weight;
  if (fileAxes.opsz != null) axes.opsz = fontSize;
  if (slant !== 0 && fileAxes.slnt != null) axes.slnt = slant;
  // When the requested PostScript name is an fvar NAMED INSTANCE rather than a
  // physical member, the instance's coordinates ARE the face — that is what the
  // platform loads by that name — so they replace the CSS-derived guess for the
  // tags they cover. Without this, a request for `PingFangSC-Regular` (instance
  // wght 400) at CSS weight 500 would pin wght 500 and paint a face nobody asked
  // for; the two only coincide when the CSS weight happens to equal the cut's.
  //
  // `opsz` is deliberately excluded: CoreText applies automatic optical sizing on
  // top of a named instance, so the `opsz = fontSize` pin stays — it is what the
  // full macOS sweeps validate pixel-exact, and an instance's frozen opsz would
  // override it at every size.
  if (instanceAxes != null) {
    for (const tag of Object.keys(instanceAxes)) {
      if (tag === "opsz" || fileAxes[tag] == null) continue;
      axes[tag] = instanceAxes[tag];
    }
  }
  if (resolvedAxes != null) {
    for (const tag of Object.keys(resolvedAxes)) {
      if (fileAxes[tag] == null) continue;
      if (tag === "slnt") continue;                 // CSS italic drives slant per run
      if (tag === "wght" && weight !== 400) continue; // mapped at 400; CSS weight wins elsewhere
      axes[tag] = resolvedAxes[tag];
    }
  }
  if (variationSettings != null) {
    for (const tag of Object.keys(variationSettings)) {
      if (fileAxes[tag] != null) axes[tag] = variationSettings[tag];
    }
  }
  return clampAxesToFvarRange(axes, fileAxes);
}

/** Clamp an axis location to the file's fvar [min, max] per tag. The
 *  instancers (fontkit getVariation, hb pin) clamp internally anyway, so
 *  out-of-range values produce IDENTICAL instances — but the UNclamped values
 *  were flowing into the embedded-font instanceKey, splitting byte-identical
 *  instances into separate @font-face entries. SF Pro's opsz axis has
 *  min = 17: every run at font-size ≤ 17px is the SAME optical instance, and a
 *  mixed 12/13/14/16px page was carrying four duplicate subsets (the bulk of
 *  the mixed-size demo growth). Clamping at the RECORDING site dedupes the
 *  keys without touching fidelity — the pinned outlines are unchanged by
 *  construction. */
/**
 * The macOS axis location, transcribed from Blink rather than from ours.
 *
 * `resolveAxisLocationForFile` above pins `wght` from the CSS weight, which is
 * right for Windows (DirectWrite hands back the default fvar instance and the
 * weight has nowhere else to come from) and wrong for macOS. Blink's loop —
 * `mac/font_platform_data_mac.mm:169-185`, checkout `7d859f27` — sets exactly
 * two things:
 *
 *   - `opsz`, to the CSS **specified** size, when `font-optical-sizing: auto`
 *     (the default). The source comment is explicit that this is the specified
 *     rather than the computed size, "in order to account for zoom".
 *   - any axis named in `font-variation-settings`, which is allowed to override
 *     the `opsz` just set.
 *
 * `wght` is deliberately absent: on macOS the weight is already baked into the
 * face by the CoreText trait/weight re-selection that runs BEFORE this
 * (`GetAlternateFontPlatformData` → `CreateCopyWithTraitsAndWeightFromFont`,
 * `font_cache_mac.mm:242-267`), which the glyph helper transcribes. Pinning
 * `wght` here as well would re-apply the CSS weight on top of a face that has
 * already answered for it.
 *
 * Both Blink (`VariableAxisChangeEffective`, `:74-79`) and Skia
 * (`SkTPin` in `ctvariation_from_SkFontArguments`, `src/ports/SkTypeface_mac_ct.cpp:1147`,
 * checkout `ebf5052`) clamp the requested value into the axis range before
 * applying it, so the clamp is not our rounding — it is the mechanism. It is
 * what makes a 13 px run on a face whose `opsz` axis is `[17 .. 28]` resolve to
 * 17, which is what Chrome reports (`opsz110000`, hex 16.16 → 17.0).
 *
 * Returns `undefined` when nothing moved off the file's defaults, mirroring
 * Blink's `axes_reconfigured` guard: no clone, keep the base face.
 */
export function resolveDarwinAxisLocation( // exported for unit testing (not in the package barrel)
  fileAxes: Record<string, unknown>, fontSize: number,
  variationSettings?: Record<string, number>,
  /** The FACE's own non-default coordinates (a named instance's, or the
   *  CoreText handle's current position — see `darwinFaceOwnAxes`). Seeded
   *  BEFORE the `opsz` / font-variation-settings pins, exactly where Blink
   *  starts: its loop reads the matched typeface's current design position and
   *  reconfigures only `opsz` + the author's variation settings on top
   *  (`font_platform_data_mac.mm:113-208`, tag 147.0.7727.15 and rev 7d859f27
   *  — identical). A CSS-derived `wght` never enters on this path: the weight
   *  is already baked into WHICH face the trait/weight matcher picked, and
   *  pinning it again is what clamped `font-family: Skia` at CSS 400 to the
   *  wght-axis maximum 3.2 — the Black master — where Chrome paints
   *  `Skia-Regular` (the default instance; axis in QuickDraw units). */
  faceAxes?: Record<string, number> | null,
): Record<string, number> | undefined {
  const axes: Record<string, number> = {};
  if (faceAxes != null) {
    for (const tag of Object.keys(faceAxes)) {
      if (tag !== "opsz" && fileAxes[tag] != null) axes[tag] = faceAxes[tag];
    }
  }
  if (fileAxes.opsz != null) axes.opsz = fontSize;
  if (variationSettings != null) {
    for (const tag of Object.keys(variationSettings)) {
      if (fileAxes[tag] != null) axes[tag] = variationSettings[tag];
    }
  }
  if (Object.keys(axes).length === 0) return undefined;
  clampAxesToFvarRange(axes, fileAxes);
  // Drop any tag that landed back on the file's default — instancing there is a
  // no-op, and an axis map that differs from `{}` only by default values would
  // split otherwise byte-identical embedded subsets into separate @font-face
  // entries (the reason `clampAxesToFvarRange` exists).
  for (const tag of Object.keys(axes)) {
    const def = (fileAxes[tag] as { default?: number } | undefined)?.default;
    if (typeof def === "number" && axes[tag] === def) delete axes[tag];
  }
  return Object.keys(axes).length > 0 ? axes : undefined;
}

/**
 * The FACE's own non-default axis coordinates for a darwin-resolved PostScript
 * name, or null when unknowable / static / all-default.
 *
 * Two sources, in trust order:
 *
 *   1. `spec.ctAxes` — the CoreText handle's variation position observed when
 *      the live resolver answered (family or fallback query). Authoritative
 *      for every name CoreText can mint, including clone names like
 *      `Skia-Regular_Light` whose fvar instances carry no postscriptNameID and
 *      are therefore invisible to a name-table scan.
 *   2. the file's fvar NAMED INSTANCE matching the name by postscriptNameID
 *      (`resolveFaceInfoForFile().instanceAxes`) — the static-file fallback
 *      for hosts whose helper predates the family-query axis report.
 *
 * `opsz` is excluded on both paths: the handle's opsz is per-style state
 * (CoreText pre-sets it on some handles), and the caller derives it from the
 * specified size the way Blink's clone loop does (`resolveDarwinAxisLocation`).
 * Values equal to the axis default are dropped — instancing there is a no-op
 * and default-only maps would split byte-identical embedded subsets.
 */
function darwinFaceOwnAxes(
  ctAxes: DarwinHandleAxis[] | undefined,
  instanceAxes: Record<string, number> | null | undefined,
  fileAxes: Record<string, unknown> | null,
): Record<string, number> | null {
  if (ctAxes != null && ctAxes.length > 0) {
    const axes: Record<string, number> = {};
    for (const a of ctAxes) {
      if (a.tag === "opsz" || a.value === a.def) continue;
      axes[a.tag] = a.value;
    }
    return Object.keys(axes).length > 0 ? axes : null;
  }
  if (instanceAxes != null) {
    const axes: Record<string, number> = {};
    for (const tag of Object.keys(instanceAxes)) {
      if (tag === "opsz") continue;
      const def = (fileAxes?.[tag] as { default?: number } | undefined)?.default;
      if (typeof def === "number" && instanceAxes[tag] === def) continue;
      axes[tag] = instanceAxes[tag];
    }
    return Object.keys(axes).length > 0 ? axes : null;
  }
  return null;
}

/** One axis of a CoreText-substituted handle: fvar metadata plus the handle's
 *  CURRENT position (`value` = CTFontCopyVariation overlay the default). The
 *  macOS glyph helper reports these per fallback answer; see
 *  `SystemFallbackFont.ctAxes`. */
export interface DarwinHandleAxis { tag: string; min: number; def: number; max: number; value: number }

/**
 * The PostScript name Chrome reports for a fallback face on macOS — base name
 * or variation-instantiated clone — decided by Blink's own clone procedure.
 *
 * Two separate mechanisms, both transcribed/measured rather than inferred:
 *
 * **The gate is Blink's, and it is HANDLE-relative.** Blink starts from the
 * substituted typeface's CURRENT design position and sets `opsz` = the CSS
 * **specified** size (under `font-optical-sizing: auto`), then any
 * `font-variation-settings` axis — each set gated on
 * `VariableAxisChangeEffective`: the target, clamped into the axis range, must
 * differ from the handle's current position, or nothing is set. No axis moved →
 * no clone → Chrome keeps the handle's own name
 * (`mac/font_platform_data_mac.mm:60-102` + `:167-195`, checkout `7d859f27`).
 * The current position is NOT the file default: CoreText PRE-SETS `opsz` on
 * some substituted handles (measured on macOS 26.5.2: the 13 px cascade hands
 * back `.SFArabic-Regular` with `CTFontCopyVariation` = {opsz: 17}, so Blink
 * finds 17 == clamp(13) and never clones — Chrome reports the bare
 * `.SFArabic-Regular` — while `.SFDevanagari-Regular` arrives with no
 * variation set, so the same 13 px run clones and Chrome reports
 * `.SFDevanagari-Regular_opsz110000_wght`). That is why this takes the
 * handle's axes as reported by the helper at fallback-resolution time, not the
 * file's fvar table.
 *
 * **The name is CoreText's, and it is DEFAULT-relative.** Skia hands CoreText a
 * dictionary holding every axis — default → current → clamped requested
 * (`ctvariation_from_SkFontArguments`, `src/ports/SkTypeface_mac_ct.cpp:1097-1174`,
 * checkout `ebf5052`; the `SkTPin` at `:1147` is the second clamp) — via
 * `CTFontCreateCopyWithAttributes`. Measured composition rule, every form
 * confirmed against a route name Chrome actually reported:
 *
 *   - location lands exactly on an fvar NAMED INSTANCE → the instance's own
 *     PostScript name ({opsz:28, wght:700} → `.SFDevanagari-Bold`);
 *   - otherwise the MEMBER base name plus one `_<tag>` suffix per axis in the
 *     face's axis order — uppercase hex 16.16 fixed point when the value
 *     differs from the axis DEFAULT, bare tag when it doesn't
 *     (`.SFDevanagari-Regular_opsz110000_wght` = opsz 17, wght at default;
 *     0x110000 / 65536 = 17.0 — a prior session read it as decimal 11, below
 *     the axis minimum, which made the routes look unproducible);
 *   - the suffix comparison is against the DEFAULT even on a pre-set handle
 *     ({opsz:17, wght:700} on the SF Arabic handle whose current opsz IS 17
 *     still hexes it: `_wght2BC0000_opsz110000`), while a dictionary equal to
 *     the handle's current position produces no derived font at all — which
 *     cannot be reached from here because the gate already requires a moved
 *     axis;
 *   - an all-defaults location keeps the base name.
 *
 * Returns null — caller keeps the base name, and any resulting oracle mismatch
 * stays VISIBLE rather than papered over — when no clone would happen, or a
 * coordinate is negative (no macOS system face has a negative-range axis, so
 * the hex encoding of a negative coordinate is unobservable and deliberately
 * not guessed).
 *
 * Exported for unit testing (not in the package barrel).
 */
export function darwinCloneInstanceName(
  basePostscriptName: string,
  handleAxes: DarwinHandleAxis[],
  fontSize: number,
  variationSettings?: Record<string, number>,
  namedInstances?: Array<{ postscriptName: string; coords: Record<string, number> }> | null,
): string | null {
  if (handleAxes.length === 0) return null;
  const fixed = (v: number): number => Math.round(v * 65536); // 16.16 fixed point
  const clampTo = (v: number, a: DarwinHandleAxis): number => Math.min(Math.max(v, a.min), a.max);
  let reconfigured = false;
  const loc: Array<{ tag: string; q: number; qDef: number }> = [];
  for (const a of handleAxes) {
    // Blink's loop, in its order: opsz first, font-variation-settings second
    // (allowed to override the opsz just set). Both gates compare the CLAMPED
    // target against the handle's ORIGINAL current position.
    let v = a.value;
    if (a.tag === "opsz" && fixed(clampTo(fontSize, a)) !== fixed(a.value)) {
      v = fontSize;
      reconfigured = true;
    }
    const fvs = variationSettings?.[a.tag];
    if (fvs != null && fixed(clampTo(fvs, a)) !== fixed(a.value)) {
      v = fvs;
      reconfigured = true;
    }
    const final = clampTo(v, a); // Skia's SkTPin — the second, independent clamp
    if (final < 0) return null;
    loc.push({ tag: a.tag, q: fixed(final), qDef: fixed(a.def) });
  }
  if (!reconfigured) return null; // Blink's axes_reconfigured guard: no clone
  if (namedInstances != null) {
    // Quantized comparison on BOTH sides: fvar instance coordinates are stored
    // in fixed point too, so float drift (e.g. an instance wght of
    // 30.925003051757812) must not defeat an exact match.
    for (const inst of namedInstances) {
      if (loc.every(({ tag, q }) => {
        const c = inst.coords[tag];
        return typeof c === "number" && fixed(c) === q;
      })) return inst.postscriptName;
    }
  }
  if (loc.every(({ q, qDef }) => q === qDef)) return basePostscriptName;
  return basePostscriptName + loc
    .map(({ tag, q, qDef }) => `_${tag}${q === qDef ? "" : q.toString(16).toUpperCase()}`)
    .join("");
}

// The substituted handle's axis state, recorded when the live CoreText resolver
// answers (the only moment it is observable), keyed the way the instance cache
// is keyed — the same (key, weight, size, slant) that will later materialize the
// instance. Two stacks CAN reach one face with different handle states (the
// 13 px italic system-ui cascade hands back `.CJKSymbolsFallbackSC-Regular`
// with a pre-set opsz where the upright one does not), which is exactly why
// this cannot live on the size-independent `sysfb:` spec.
const darwinHandleAxesMap = new Map<string, DarwinHandleAxis[]>();
const darwinHandleAxesKey = (key: string, weight: number, fontSize: number, slant: number): string =>
  `${key}|${weight}|${fontSize}|${slant}`;
function registerDarwinHandleAxes(key: string, weight: number, fontSize: number, slant: number, axes: DarwinHandleAxis[]): void {
  const k = darwinHandleAxesKey(key, weight, fontSize, slant);
  if (!darwinHandleAxesMap.has(k)) darwinHandleAxesMap.set(k, axes);
}
function darwinHandleAxesFor(key: string, weight: number, fontSize: number, slant: number): DarwinHandleAxis[] | undefined {
  return darwinHandleAxesMap.get(darwinHandleAxesKey(key, weight, fontSize, slant));
}

function clampAxesToFvarRange(axes: Record<string, number>, fileAxes: Record<string, unknown>): Record<string, number> {
  for (const tag of Object.keys(axes)) {
    const def = fileAxes[tag] as { min?: number; max?: number } | undefined;
    if (def == null) continue;
    if (typeof def.min === "number" && axes[tag] < def.min) axes[tag] = def.min;
    if (typeof def.max === "number" && axes[tag] > def.max) axes[tag] = def.max;
  }
  return axes;
}
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
function applyVariationAxes(font: any, weight: number, fontSize: number, slant: number, variationSettings?: Record<string, number>,
  /**
   * CSS `font-stretch` as a percentage (100 = `normal`), driving the `wdth`
   * axis when the file exposes one. The MAPPING is the identity — Blink hands
   * the CSS percentage straight to the axis and lets the range clamp do the
   * rest — but only TWO of Blink's paths apply it, so callers gate it:
   *
   *   - the macOS `system-ui` face: `MatchSystemUIFont` sets `wdth` (and
   *     `wght`) in a CoreText variation dict, each clamped to the axis range
   *     first (`ClampVariationValuesToFontAcceptableRange`,
   *     `mac/font_matcher_mac.mm:483-589`, rev 7d859f27). That clamp is why
   *     `font-stretch: 200%` resolves to wdth 150 on SF (axis max), which is
   *     exactly what Chrome reports (`.SFNS-Regular_wdth960000_…` = 150.0).
   *   - variable WEBFONTS, on every platform: `FontCustomPlatformData::
   *     GetFontPlatformData` pins `wdth` to the selection request clamped to
   *     the @font-face descriptor capabilities — or, when the descriptor is
   *     auto, to the font's own axis range
   *     (`font_custom_platform_data.cc:155-169`, rev 7d859f27).
   *
   *   A DECLARED family gets NEITHER: `MatchFontFamily` turns the width into
   *   the condensed/expanded symbolic trait and picks a cut or fvar NAMED
   *   INSTANCE, and no wdth axis is applied afterward (`FontPlatformDataFromCTFont`
   *   touches only `opsz` + `font-variation-settings`). Measured for the
   *   discrimination: `font-family: Skia` (a family with BOTH condensed named
   *   instances AND a wdth axis) paints `Skia-Regular_Condensed` at the SAME
   *   width for 50% / 62.5% / 75%, while `system-ui` moves continuously.
   *   Callers on the declared-family path therefore pass 100 here.
   */
  stretch: number = 100,
  opts?: {
    /** The FACE's own non-default coordinates (macOS declared families: a
     *  CoreText handle position or fvar named instance — see
     *  `darwinFaceOwnAxes`). Pinned for the tags they cover, replacing any
     *  CSS-derived wght/wdth: the platform loads that instance by name, so its
     *  coordinates ARE the face. `opsz` is excluded (the caller's font-size
     *  derivation stands, mirroring Blink's clone loop). */
    faceAxes?: Record<string, number> | null;
    /** False on the darwin declared-family path: Blink never sets a CSS-valued
     *  `wght` axis there — the trait/weight matcher picks a cut or named
     *  instance and `FontPlatformDataFromCTFont` applies only `opsz` +
     *  font-variation-settings (`font_platform_data_mac.mm:113-208`, tag
     *  147.0.7727.15). Defaults to true (webfonts, `system-ui`, Windows'
     *  helper-less degradation path). */
    cssWghtPin?: boolean;
    /** The `@font-face` `font-stretch` DESCRIPTOR as selection capabilities
     *  `[min, max]` — Blink clamps the request into the DESCRIPTOR range when
     *  one is declared, and only falls back to the font's own axis range when
     *  the descriptor is auto (`FontCustomPlatformData::GetFontPlatformData`,
     *  `font_custom_platform_data.cc:155-169`, identical at tag 147.0.7727.15
     *  and rev 7d859f27). A face declared `font-stretch: 75%` therefore pins
     *  wdth = 75 for EVERY request, including `font-stretch: normal`. */
    wdthCapabilities?: readonly [number, number] | null;
    /** True on the webfont path: Blink pushes the wdth coordinate for every
     *  variable webfont — even a normal-stretch (100%) request — clamped to
     *  the capabilities (descriptor or axis range). System-font paths keep
     *  the ≠100 gate (`MatchSystemUIFont` only sets wdth when the width moved
     *  off normal). */
    wdthAlways?: boolean;
    /** The `@font-face` `font-weight` DESCRIPTOR as selection capabilities
     *  `[min, max]` — same rule as `wdthCapabilities`, one axis over: Blink
     *  clamps the request into the DESCRIPTOR range when one is declared, and
     *  only falls back to the font's own wght axis range when the descriptor
     *  is auto (`FontCustomPlatformData::GetFontPlatformData`,
     *  `font_custom_platform_data.cc:136-154`, rev 7d859f27). A face declared
     *  `font-weight: 700` therefore pins wght = 700 for EVERY request —
     *  measured over CDP: Lexend VF (wght [100..900]) declared 700 and
     *  requested at 400 paints `Lexend-Bold` (width 886.281 at 100px), where
     *  an axis-range clamp would paint `Lexend-Regular` (847.000). */
    wghtCapabilities?: readonly [number, number] | null;
  },
): FontInstance {
  if (font.variationAxes == null || Object.keys(font.variationAxes).length === 0 || font.getVariation == null) {
    return font;
  }
  const axes: Record<string, number> = {};
  // Blink's webfont clamps run in FontSelectionValue units — a 16-bit fixed
  // point with TWO fractional bits (`font_selection_types.h:40-105`, identical
  // at tag 147.0.7727.15 and rev 7d859f27), so every endpoint quantizes to
  // quarters, truncating: an axis range of [0.48 .. 3.2] clamps requests into
  // [0.25 .. 3.0], not [0.48 .. 3.2]. Not our rounding — measured: Skia.ttf
  // loaded AS A WEBFONT paints `Skia-Regular_wght30000_wdth14000` (hex 16.16 =
  // wght 3.0, wdth 1.25) where the raw axis maxima are 3.19999 / 1.30000.
  // CSS-unit axes are integers, where the quantization is the identity.
  const q = (x: number): number => Math.trunc(x * 4) / 4;
  const webfontClamps = opts?.wdthAlways === true || opts?.wdthCapabilities != null;
  if (font.variationAxes.wght != null && opts?.cssWghtPin !== false) {
    const wghtCaps = opts?.wghtCapabilities;
    axes.wght = wghtCaps != null
      // Declared `font-weight` descriptor: the request clamps into the
      // DESCRIPTOR range first (`selection_capabilities.weight.clampToRange`,
      // `font_custom_platform_data.cc:136-139`) — which is what pins a
      // `font-weight: 700` face at wght 700 regardless of the run's request.
      // The raw axis-range clamp still applies at instancing (Skia's `SkTPin`
      // on Chrome's side, `clampAxesToFvarRange` + the instancer on ours).
      ? Math.min(Math.max(q(weight), q(wghtCaps[0])), q(wghtCaps[1]))
      : webfontClamps
      // `FontCustomPlatformData::GetFontPlatformData`'s auto-weight branch
      // (`font_custom_platform_data.cc:141-154`): the request clamped into the
      // QUANTIZED axis range.
      ? Math.min(Math.max(q(weight), q(font.variationAxes.wght.min ?? weight)), q(font.variationAxes.wght.max ?? weight))
      : weight;
  }
  if (font.variationAxes.opsz != null) axes.opsz = fontSize;
  if (font.variationAxes.wdth != null) {
    const caps = opts?.wdthCapabilities;
    if (caps != null) {
      // Declared descriptor: the request clamps into the DESCRIPTOR range
      // first (Blink's `selection_capabilities.width.clampToRange`), which is
      // what pins a `font-stretch: 75%` face at wdth 75 regardless of the
      // run's request instead of re-condensing or re-widening it. The raw
      // axis-range clamp still applies at instancing (Skia's `SkTPin` on
      // Chrome's side, `clampAxesToFvarRange` + the instancer on ours) — on a
      // non-CSS-unit axis that is what turns the pinned 75 into the axis
      // maximum, measured as `_wdth14CCC` (= 1.29998) in Chrome.
      axes.wdth = Math.min(Math.max(q(stretch), q(caps[0])), q(caps[1]));
    } else if (opts?.wdthAlways === true) {
      // Auto descriptor, webfont: Blink ALWAYS pushes the wdth coordinate for
      // a variable webfont — a normal-stretch (100%) request included —
      // clamped into the QUANTIZED axis range (`font_custom_platform_data.cc:
      // 155-169`). Measured: auto-descriptor Skia.ttf paints wdth 1.25 =
      // q(1.30000) at every requested stretch.
      axes.wdth = Math.min(Math.max(q(stretch), q(font.variationAxes.wdth.min ?? stretch)), q(font.variationAxes.wdth.max ?? stretch));
    } else if (stretch !== 100) {
      // System-font paths keep the ≠100 gate (`MatchSystemUIFont` only sets
      // wdth when the width moved off normal); the instancers clamp to the
      // axis range internally.
      axes.wdth = stretch;
    }
  }
  if (slant !== 0 && font.variationAxes.slnt != null) axes.slnt = slant;
  // The face's own coordinates beat the CSS-derived pins for the tags they
  // cover — that is what the platform loads by that PostScript name.
  if (opts?.faceAxes != null) {
    for (const tag of Object.keys(opts.faceAxes)) {
      if (tag !== "opsz" && font.variationAxes[tag] != null) axes[tag] = opts.faceAxes[tag];
    }
  }
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
  // DM-1716: record the axis location this variation instance was created at,
  // so the hinting-preserving embedded subset can pin the SAME location when it
  // instances the source file (hb-subset applies the same gvar deltas fontkit
  // did — the pinned subset's outlines match what this instance shaped with).
  // Clamped to the fvar range so byte-identical out-of-range instances share
  // one embedded entry (see clampAxesToFvarRange).
  (v as any)._appliedVariationAxes = clampAxesToFvarRange({ ...axes }, font.variationAxes ?? {});
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
// Does the platform actually resolve this SPECIFIC author family name, the way
// Chrome's FontFallbackIterator does? Chrome uses a CSS family only if it loads
// (`font_fallback_iterator.cc`: `FontDataAt` skips a family that doesn't load;
// `first_candidate_` is the first that does), then cascades to the per-codepoint
// system font. We must mirror that PER-MACHINE so our fallback matches Chrome —
// e.g. "Hiragino Kaku Gothic ProN" / "Arial Unicode MS" are installed on macOS
// but absent on a Linux CI runner, where Chrome cascades to the system CJK font
// (WenQuanYi) rather than a hardcoded substitute. macOS/Windows: the native
// helper's `resolveInstalledFont` matches by exact family (null ⇒ not installed).
// Linux: no native helper (resolveInstalledFont is always null) — fontconfig
// returns the SAME family for a real match but a SUBSTITUTE for a miss, so a
// family whose `fc-match` result canon-differs from the request is "not present".
const _famAvailCache = new Map<string, boolean>();
function canonFamilyName(s: string): string {
  return s.toLowerCase().replace(/[-_ ]/g, "").replace(/(regular|mt|psmt|ps|roman|book)$/g, "");
}
function fcMatchFamilyName(name: string): string | null {
  try {
    const out = execFileSync("fc-match", ["-f", "%{family}", name],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? null : out.split(",")[0];
  } catch { return null; }
}
function authorFamilyAvailable(name: string): boolean {
  const cached = _famAvailCache.get(name);
  if (cached != null) return cached;
  let avail: boolean;
  if (resolveInstalledFont(name) != null) {
    avail = true; // native helper (macOS/Windows) found the exact family
  } else if (hostPlatform() === "linux") {
    const fam = fcMatchFamilyName(name);
    avail = fam != null && canonFamilyName(fam) === canonFamilyName(name);
  } else {
    avail = false;
  }
  _famAvailCache.set(name, avail);
  return avail;
}

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
    // ── Linux declared-family NOMINATION: the transcribed walk ──
    // Blink resolves a non-generic CSS family on Linux by ASKING the matcher,
    // not a table: `FontFallbackList::GetFontData` walks the stack calling
    // `FontCache::GetFontData(desc, family)` per name
    // (`font_fallback_list.cc:149-193`, tag 147.0.7727.15 — the walk is
    // byte-identical at local checkout rev 7d859f27), each call reaching
    // `SkFontConfigInterfaceDirect::matchFamilyName` (the Linux helper's
    // `familyMatch` transcription, Skia rev fd139e79); on rejection the cache
    // retries the aliased name (Courier ↔ Courier New, Times ↔ Times New
    // Roman, Arial ↔ Helvetica — `font_platform_data_cache.cc:74-105` +
    // `alternate_font_family.h:74-105`, tag), and when that rejects too Blink
    // walks PAST the family to the next one in the stack. Mirror exactly
    // that: accept → register the matched face and record the ACCEPTED
    // spelling so the per-run style match (`linuxPrimaryCutKey`) re-cuts it;
    // reject → null so the caller continues the stack. Acceptance is a
    // family-identity question (request vs post-substitution vs
    // metric-equivalence class), so one weight-400 probe answers it; the
    // per-weight CUT is re-matched at render time. Measured over CDP in the
    // pinned noble image (tools/probe-1955-declared-walk.mjs):
    // "Courier New"/"Courier" paint Liberation Mono (metric class / alias),
    // while rejected names ("Menlo", "Consolas", "Helvetica Neue") walk on —
    // a bare stack of them lands on `-webkit-standard` → Liberation Serif,
    // which is what falling through to the `times` terminal below yields.
    // The generic keywords are EXCLUDED: their concrete families are
    // browser-side `GenericFontFamilySettings` values that are not in the
    // renderer checkout (`FontSelector::FamilyNameFromSettings`,
    // `font_selector.cc:20-113`, tag), so they stay on the measured static
    // routes below, marked un-transcribed in doc 110. Gated like the rest of
    // the live Linux resolver (helper + DOMOTION_SYSTEM_FALLBACK), degrading
    // to the calibrated tables when disarmed — including when the helper
    // predates the `familyMatch` query (the armed probe), since a walk that
    // cannot ask the matcher must not declare rejections.
    if (!LINUX_SETTINGS_MAPPED_GENERICS.has(name) && linuxNominationWalkArmed()) {
      const walked = linuxFamilyMatchWithAlternate(name, { weight: 400 });
      if (walked == null) return null; // Chrome walks past this family
      const { match, acceptedFamily } = walked;
      // The PostScript name selects the TTC member downstream; a face that
      // declares none can only be addressed as the file's first face. An
      // unaddressable face falls THROUGH to the calibrated tables rather
      // than dropping a family Chrome would paint.
      const psName = match.postscriptName !== ""
        ? match.postscriptName
        : (match.index === 0 ? (match.path.split("/").pop() ?? match.path) : "");
      if (psName !== "") {
        const key = `sysfb:${psName}`;
        registerDynamicSystemFont(
          key, match.path, match.postscriptName !== "" ? match.postscriptName : psName, "fontkit",
        );
        // Two requested spellings can accept onto the same face (e.g.
        // "Arial" directly and "Helvetica" via its alias) — they then agree
        // on the accepted spelling, or land on the same family's cuts, so
        // the last write is safe.
        declaredFamilyForKey.set(key, acceptedFamily);
        return key;
      }
    }
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
    //
    // Both keys are LOGICAL and resolve per platform through the three path
    // tables — on Windows `apple-chancery` is `comic.ttf` and `papyrus` is
    // `impact.ttf`, which are Chrome's Windows defaults. The macOS-flavoured
    // key names are a naming wart, not a routing one.
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
    // Gated: only when Arial Unicode MS actually resolves here (present on macOS,
    // absent on the Linux runner where Chrome cascades past it — see
    // authorFamilyAvailable). null ⇒ skip this family, continue the stack.
    if (name === "arial unicode ms" || name === "arialunicodems") {
      return authorFamilyAvailable("Arial Unicode MS") ? "u-arial-unicode-ms" : null;
    }
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
    // DM-1681: `system-ui` on Linux does NOT resolve to the `sans-serif` face.
    // Blink configures a `sans-serif` family (Liberation on the noble image) but
    // has no Linux `system-ui` family, so Chrome-on-Linux resolves `system-ui`
    // via fontconfig's raw default — WenQuanYi Zen Hei on noble (verified with
    // `getPlatformFontsForNode`: the `system-ui, sans-serif` fixtures paint
    // WenQuanYi, not Liberation). This is the ONE generic keyword where `fc-match`
    // agrees with Chrome (unlike `sans-serif` — see DM-1691), because Blink
    // doesn't override it. Resolve `system-ui` via the fontconfig default so we
    // match Chrome; keep macOS/Windows on the `sf-pro` key. Gated by the
    // live-resolver flag (default-on; honors DOMOTION_SYSTEM_FALLBACK=0).
    if (name === "system-ui") {
      if (hostPlatform() === "linux" && _systemFallbackResolutionEnabled) {
        const matched = fcMatch("sans-serif");
        if (matched != null) {
          const psName = matched.postscriptName ?? matched.path.split("/").pop() ?? "system-ui";
          const key = `sysfb:${psName}`;
          registerDynamicSystemFont(key, matched.path, matched.postscriptName ?? psName, "fontkit");
          return key;
        }
      }
      return "sf-pro";
    }
    if (name === "blinkmacsystemfont" || name === "sf pro") return "sf-pro";
    // DM-1127 REVERSED (DM-1659): "SF Pro Text" / "SF Pro Display" resolve to the
    // SYSTEM font `SFNS.ttf` (the `sf-pro` key, opsz-pinned to the Text cut via
    // `OPTICAL_CUT_OPSZ`/DM-1103) — NOT the standalone `/Library/Fonts/SF-Pro-*.otf`.
    // DM-1127 preferred the standalone OTF on the assumption it's "the same font
    // Chrome paints"; empirically that's FALSE. Chrome→CoreText paints "SF Pro
    // Text" from the system SFNS optical cut, whose glyph DESIGNS differ from the
    // standalone OTF's — e.g. the '!' dot is a squat rectangle in SFNS (what Chrome
    // shows) vs a round circle in the OTF, and accent/terminal shapes differ across
    // the board. The two share Text-cut METRICS (identical advances), so an
    // advance-only check couldn't tell them apart, but the shapes are Chrome's
    // ground truth. Verified via CDP `getPlatformFontsForNode` + native CoreText
    // rasterization of both files. The OTF's extra coverage (the two-digit enclosed
    // alphanumerics SFNS lacks) is handled by the normal per-codepoint fallback,
    // which is also what Chrome does for those codepoints (SFNS lacks them → cascade).
    // ...but that mapping holds ONLY when the named family actually resolves on
    // THIS machine. Chrome can paint "SF Pro Text" (from its SFNS system cut)
    // only if the font is installed; on a stock macOS install / the GitHub CI
    // runner without Apple's downloadable `/Library/Fonts/SF-Pro-*.otf`, Chrome
    // cannot resolve the name and falls THROUGH to the next CSS family. Mapping
    // it to `sf-pro` (SFNS, always present) there would paint a face Chrome
    // never uses — the root of a pervasive CI-macOS divergence where the "SF Pro
    // Text"-stack fixtures had CI-Chrome fall to Helvetica while Domotion jumped
    // to SFNS (verified: the runner ships SFNS.ttf but no SF-Pro-*.otf; the comma
    // is straight in SFNS vs curved in Chrome's fallback). Mirror Chrome: return
    // `sf-pro` when the named font resolves, else null so the stack walk
    // continues. (When it IS installed, Chrome still paints from SFNS per
    // DM-1659, so `sf-pro` remains correct.)
    if (name === "sf pro text" || name === "sf pro display") {
      const named = name === "sf pro display" ? "SF Pro Display" : "SF Pro Text";
      return resolveInstalledFont(named) != null ? "sf-pro" : null;
    }
    // DM-806: author-named "Hiragino Sans" / "Hiragino Kaku Gothic ProN" /
    // the underlying ヒラギノ角ゴシック native name maps to the JP variant
    // we already ship under the `hiragino-jp` key (HiraKakuProN-W3 /
    // -W6). Without this, the family falls through to `system-ui` →
    // sf-pro, which paints Latin glyphs visibly differently from Hiragino
    // Sans (wider letter spacing on a/c/p — the `niche-text-box-trim`
    // fixture's "ideographic — 日本語テキスト" label exposes this).
    // Gated like Arial Unicode MS: Hiragino is stock macOS but absent on the
    // Linux runner, where Chrome cascades to the per-codepoint system CJK font
    // (WenQuanYi) rather than a hardcoded IPAGothic substitute. Check the
    // canonical "Hiragino Sans" name; null ⇒ skip, continue the stack so the
    // codepoint-level system fallback matches Chrome.
    if (name === "hiragino sans" || name === "hiragino kaku gothic pron"
      || name === "hiragino kaku gothic pro" || name === "ヒラギノ角ゴシック"
      || name === "hiragino maru gothic pron") {
      return authorFamilyAvailable("Hiragino Sans") ? "hiragino-jp" : null;
    }
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
      // DM-1721: `resolvedAxes` carries DirectWrite's pinned axis values for
      // variable-face matches (e.g. "Segoe UI Variable Text" → opsz 10.5 at
      // every size) so the hinted-subset pin embeds the instance Chrome paints.
      // On macOS `ctAxes` carries the CoreText handle's own position instead.
      registerDynamicSystemFont(key, installed.path, installed.postscriptName, "native", installed.resolvedAxes, installed.ctAxes);
      // This resolution answers "which family", never "which cut" — the name
      // lookup is style-blind on macOS, so `font-family:"PingFang SC";
      // font-weight:700` lands on PingFangSC-Regular where Chrome paints
      // Semibold. Record the CoreText family so `getFontInstance` can run
      // Blink's declared-family style matcher over it. Resolving the base name
      // first and matching afterwards is the right ORDER: pinning the weight
      // into the name would double-count it.
      if (hostPlatform() === "darwin" && installed.familyName !== "" && !installed.familyName.startsWith(".")) {
        declaredFamilyForKey.set(key, installed.familyName);
      }
      return key;
    }
    // DM-1690: on Linux the `resolveInstalledFont` native helper is always null,
    // so an installed-but-uncalibrated author family (e.g. `font-family: "DejaVu
    // Sans"`) used to fall through here to the `times` default — whereas
    // Chrome-on-Linux resolves it via fontconfig (`FcFontMatch`). Mirror that:
    // when fontconfig genuinely HAS the family (`authorFamilyAvailable` compares
    // the `fc-match` result canon-to-canon, so a fontconfig SUBSTITUTE for a miss
    // still returns false → we fall through, matching Chrome), register its file
    // as a dynamic `sysfb:` key. Gated by the live-resolver flag (default-on;
    // honors DOMOTION_SYSTEM_FALLBACK=0) so it can be disabled alongside the
    // per-codepoint fontconfig resolver.
    // Windows: an author family like "Segoe UI Light" is not a DirectWrite
    // family, so the `resolveInstalledFont` probe above missed it — Blink
    // resolves it by stripping the weight/stretch suffix and pinning that axis
    // (`win/font_cache_skia_win.cc:409-480`, rev 7d859f27; measured against
    // Chrome over CDP: "Segoe UI Light" paints SegoeUI-Light at EVERY CSS
    // weight). Register the adjusted face and record the pin so
    // `win32PrimaryCutKey` re-resolves the slope per run without letting the
    // run's weight back in.
    if (hostPlatform() === "win32" && isGlyphHelperAvailable()) {
      const adjusted = win32FamilySuffixAdjustment(name);
      if (adjusted != null) {
        const installedAdj = resolveInstalledFont(adjusted.family, {
          weight: adjusted.weight ?? 400,
          italic: false,
          stretch: adjusted.stretch ?? 100,
        });
        if (installedAdj != null && installedAdj.path !== "" && installedAdj.postscriptName !== "") {
          const key = `winfam:${installedAdj.postscriptName}`;
          registerDynamicSystemFont(key, installedAdj.path, installedAdj.postscriptName, "native", installedAdj.resolvedAxes);
          win32SuffixDeclaredForKey.set(key, adjusted);
          return key;
        }
      }
    }
    if (hostPlatform() === "linux" && _systemFallbackResolutionEnabled && authorFamilyAvailable(name)) {
      const matched = fcMatch(name);
      if (matched != null) {
        const psName = matched.postscriptName ?? matched.path.split("/").pop() ?? name;
        const key = `sysfb:${psName}`;
        registerDynamicSystemFont(key, matched.path, matched.postscriptName ?? psName, "fontkit");
        // This resolution is style-blind (`fc-match <name>` carries no weight),
        // so `font-family:"DejaVu Sans"; font-weight:700` would land on the
        // regular cut. Record the AUTHOR'S name — here it is known verbatim —
        // so `getFontInstance` can run the transcribed fontconfig style match
        // over it at the run's actual weight/width/slant (`linuxPrimaryCutKey`),
        // the same order the macOS branch above uses: resolve the base name
        // first, match the style afterwards.
        declaredFamilyForKey.set(key, name);
        return key;
      }
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

/**
 * Computed CSS `font-stretch` → the percentage the font matcher takes.
 *
 * Chrome always computes this property to a percentage — `condensed` serializes
 * as `75%`, `ultra-expanded` as `200%` — so the keyword forms never reach here;
 * anything unparseable reads as `normal` (100). 100 is `kNormalWidthValue`
 * (`platform/fonts/font_selection_types.h:233`, Chromium rev 7d859f27), the
 * value Blink's `ComputeDesiredTraits` compares against to decide whether the
 * run wants a family's condensed cut, its expanded cut, or neither.
 */
export function stretchPercent(value: string | undefined): number {
  if (value == null) return 100;
  const m = /^\s*([\d.]+)%\s*$/.exec(value);
  const n = m != null ? parseFloat(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 100;
}

export function resolveFont(
  fontFamily: string, fontWeight: number, fontSize: number, slant: number = 0,
  variationSettings?: Record<string, number>,
  /** CSS `font-stretch` as a percentage, 100 = `normal`. */
  stretch: number = 100,
): FontInstance | null {
  // DM-1103: pin `opsz` for an explicitly-named optical cut (e.g. "SF Pro
  // Text" → 17) by injecting it as a variation setting — which wins over the
  // `opsz = fontSize` default in `applyVariationAxes`. An author-set
  // `font-variation-settings: "opsz" …` still wins (we don't clobber it).
  const cutOpsz = opticalCutOpszFor(fontFamily);
  if (cutOpsz != null && (variationSettings == null || variationSettings.opsz == null)) {
    variationSettings = { ...(variationSettings ?? {}), opsz: cutOpsz };
  }
  return getFontInstance(resolveFontKey(fontFamily), fontWeight, fontSize, slant, variationSettings, stretch);
}

// ── Glyph Registry (for <defs>/<use> deduplication) ──

/** Stores unique glyph path definitions. Uses short sequential IDs for compact output. */
const glyphDefs = new Map<string, string>();
const glyphKeyToId = new Map<string, string>();
let glyphIdCounter = 0;

export function ensureGlyphDef(
  fontKey: string, weight: number, fontSize: number, slant: number,
  glyphId: number, commands: Array<{ command: string; args: number[] }>,
  /** CSS `font-stretch` percentage. Part of the def identity because the SAME
   *  (fontKey, weight, size, slant, glyphId) tuple names DIFFERENT outlines at
   *  different widths: the run splitter keys runs by the BASE font key while
   *  the width decision (condensed cut, or the system-ui `wdth` axis) happens
   *  inside `getFontInstance` — so without this slot a normal-width run reused
   *  the condensed run's registered outlines glyph id for glyph id. */
  stretch: number = 100,
): string {
  const key = `${fontKey}-${weight}-${fontSize}-${slant}${stretch !== 100 ? `-w${stretch}` : ""}-${glyphId}`;
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
 * Drop every process-global font-resolution MEMO, freeing the fontkit `Font`
 * objects they retain.
 *
 * For long-running sweeps over a large codepoint space — the conformance oracle
 * is the motivating caller — these memos are unbounded in the size of that
 * space, and the retention is far larger than the entry count suggests: fontkit
 * memoizes a `Glyph` object per glyph id for the life of a `Font`, so a `Font`
 * held by `fontInstanceCache` accumulates one retained `Glyph` for every
 * codepoint ever probed through it. A full-universe sweep exhausted a default
 * Node heap partway through, which made the instrument report a PREFIX of the
 * universe as though it were the whole answer.
 *
 * Clearing is safe because every entry here is a pure function of its key:
 * a cold lookup re-derives the identical answer, it just pays for the
 * file/CoreText read again. It is NOT free — expect a sweep to slow measurably —
 * so this is for bounded-memory batch work, not per-render use.
 *
 * Deliberately NOT cleared, because they are registries rather than memos and
 * dropping them would change behavior, not just cost:
 *
 *  - `webfontRegistry` / `embeddedFonts` / `localFontAliasRegistry` — caller-
 *    supplied state (see `clearWebfonts` / `clearEmbeddedFonts` to drop those
 *    deliberately).
 *  - `dynamicSystemFontPaths` — on-disk faces the system fallback discovered
 *    that the static tables don't list. `resolveFontSpec` consults it, so a
 *    cleared entry would make a previously-resolvable `sysfb:` key stop
 *    resolving. It is bounded by the number of distinct fonts, not by
 *    codepoints, so it is not part of the growth being addressed here.
 */
export function clearFontResolutionCaches(): void {
  fontInstanceCache.clear();
  resolvedSpecCache.clear();
  systemFallbackKeyCache.clear();
  fallbackFamilyCutCache.clear();
  fallbackBaseCache.clear();
  darwinPrimaryCutCache.clear();
  helperFontCache.clear();
  helperOutlineCache.clear();
  fileFaceInfoCache.clear();
  _famAvailCache.clear();
  win32FamilyKeyCache.clear();
  darwinHandleAxesMap.clear();
  // `systemFallbackKeyCache` above is this module's per-codepoint memo; the
  // answers it memoizes come from `glyph-helper.ts`, which keeps its OWN
  // per-codepoint memo one layer down. Trimming only the upper one bounded the
  // cheap half of the growth and left the expensive half — a full-corpus sweep
  // still exhausted the heap, because the helper memo had no caller outside the
  // unit tests. The two are the same class of state and must be dropped
  // together.
  _sysfbCoverage.clear();
  clearGlyphHelperCodepointMemos();
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

/**
 * Opaque rollback marker for the paths-mode glyph registry — the full state,
 * not just a count. `truncateGlyphDefs` is the cheap cursor form and is enough
 * for the animator's append-only overlay; a SPECULATIVE pass may also clear the
 * registry outright (any nested producer that starts its own generation calls
 * `resetGeneration()`), which a count can't undo. This marker survives that.
 */
export interface GlyphDefsSnapshot {
  readonly defs: ReadonlyArray<readonly [string, string]>;
  readonly keyToId: ReadonlyArray<readonly [string, string]>;
  readonly idCounter: number;
}

/** Capture the paths-mode glyph registry as a rollback marker. */
export function snapshotGlyphDefs(): GlyphDefsSnapshot {
  return { defs: [...glyphDefs], keyToId: [...glyphKeyToId], idCounter: glyphIdCounter };
}

/** Roll the paths-mode glyph registry back to a `snapshotGlyphDefs()` marker.
 *  Reusable: the marker holds values, so restoring it twice is well-defined. */
export function restoreGlyphDefs(snapshot: GlyphDefsSnapshot): void {
  glyphDefs.clear();
  for (const [id, markup] of snapshot.defs) glyphDefs.set(id, markup);
  glyphKeyToId.clear();
  for (const [key, id] of snapshot.keyToId) glyphKeyToId.set(key, id);
  glyphIdCounter = snapshot.idCounter;
}

/**
 * Rollback marker for BOTH generation-scoped render registries — the
 * embedded-font subset builder and the paths-mode glyph-defs registry. Opaque:
 * hand it back to `restoreGeneration()`.
 */
export interface GenerationSnapshot {
  readonly fonts: EmbeddedFontSnapshot;
  readonly glyphDefs: GlyphDefsSnapshot;
}

/**
 * Capture BOTH generation-scoped registries so a speculative render can be
 * rolled back wholesale — the transactional sibling of `resetGeneration()`.
 *
 * The use case is composing a variant just to measure its real byte size, then
 * discarding it: without a rollback the trial permanently shifts the `dmfN`
 * family names and PUA codepoints (embedded-font mode) or the `gN` def ids
 * (paths mode) that the REAL output goes on to use, so the output stops being a
 * function of its input. Snapshot, compose the trial, measure, restore, compose
 * for real — the bytes are then identical to the no-trial run.
 *
 * Bundled for the same reason `resetGeneration()` is: which registry is live
 * depends on the process-global render-text mode, so a caller that snapshots
 * only one is correct until someone flips the mode. Does NOT cover the webfont
 * registry (session-scoped, and only capture mutates it) or the font-instance /
 * outline caches (memoized deterministic lookups — they never affect output
 * bytes).
 */
export function snapshotGeneration(): GenerationSnapshot {
  return { fonts: snapshotEmbeddedFonts(), glyphDefs: snapshotGlyphDefs() };
}

/**
 * Roll both generation-scoped registries back to a `snapshotGeneration()`
 * marker. Never throws (an empty marker just empties them); markers are
 * reusable and nest, so `snapshot → snapshot → restore → restore` unwinds
 * correctly.
 *
 * Contract: whatever the speculative pass emitted must be discarded — it holds
 * ids that are handed back out to the next composition.
 */
export function restoreGeneration(snapshot: GenerationSnapshot): void {
  restoreEmbeddedFonts(snapshot.fonts);
  restoreGlyphDefs(snapshot.glyphDefs);
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
  if (glyphIdForCp(markFont, 0x25CC) === 0) return null; // ◌ must come from the mark's font, like Chrome
  const hbFace = shapingFaceFor(markKey, weight, fontSize, slant, variationSettings);
  if (hbFace == null) return null;
  const hbInst = makeHarfbuzzShapingInstance(markFont, hbFace.path, hbFace.faceIndex, fontSize, hbFace.axes);
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

/**
 * Coverage predicate behind the synthetic dotted circle: is there ANY font in
 * this run's cascade that paints `cp`, or does it come out as the primary's
 * `.notdef`?
 *
 * The body IS the resolver. It used to be a second, hand-maintained copy of the
 * walk (primary cmap → webfont partition → static chain → live resolver), and
 * that copy drifted twice in one cycle: first the platform arguments (`lang` /
 * `systemUiPrimary`) were dropped on the probe side only, then — within the hour
 * of that being fixed — a concurrent change threaded `stretch` into the resolver
 * and not the probe, reopening the same asymmetry one parameter further along.
 * Beyond the arguments, the copy also never walked the declared family stack
 * (`fontKeyChain` — Blink's kFontFamily stage) and had none of the NFD /
 * math-alphanumeric decomposition stages, so it could answer "uncovered" for a
 * codepoint the emitter goes on to paint with a real glyph. Its one caller
 * (`insertSyntheticDottedCircles`) then synthesizes a U+25CC in front of a mark
 * Chrome paints normally — e.g. a `Helvetica, "Arial Unicode MS"` stack, where
 * U+3099/U+309A live only in the later-declared family (neither in Helvetica nor
 * in its static chain), so only the family walk can cover them.
 *
 * Delegating is also semantically the point, not just drift-proofing: the
 * question this predicate answers for its caller is "will this codepoint paint
 * as the primary's `.notdef`?" (Blink's `kFirstCandidateForNotdefGlyph`
 * terminal), and the authority on what actually paints is
 * `resolveFontForCodepoint`, because the run splitters emit from its answer. Any
 * divergence between the two is by definition a visible contradiction — a ◌
 * inserted beside a glyph that then renders, or a bare tofu where Chrome
 * circles. That includes the decomposition stages counting as "covered": when
 * the resolver covers via an in-font NFD or math-alpha decomposition, the
 * emitter paints real glyphs, so no circle is correct.
 *
 * Two deliberate consequences of sharing the walk, both matching Blink:
 *  - Private-use / noncharacter codepoints now skip system fallback here too
 *    (`FontCache::FallbackFontForCharacter` returns null before the platform is
 *    consulted, `platform/fonts/font_cache.cc:229-244`, Chromium rev 7d859f27).
 *  - The platform is asked with the run's full argument tail and through the
 *    same memo rows the render path populates, in the same order.
 *
 * Measured before landing (macOS host, all \p{M} marks + the complex-shaper
 * dotted-circle Lo set = 7,582 codepoints x 4 stacks, live resolver both on and
 * off): the boolean moved 0 times on this inventory — the skew is a latent
 * cross-inventory and webfont-stack hazard, not a repro on a rich dev Mac. The
 * discriminating case (later-declared family as the only cover) is pinned in
 * `notdef-probe-question-parity.test.ts` with the live resolver disabled.
 */
export function codepointResolvesToNotdef(
  cp: number, primaryFont: FontInstance, primaryFontKey: string,
  weight: number, fontSize: number, slant: number,
  variationSettings: Record<string, number> | undefined, lang: string | undefined,
  /** The run's full declared CSS family stack as font keys — derive with
   *  `resolveFontKeyChain(fontFamily)`, exactly as the run splitters do. */
  fontKeyChain: string[],
  /** True when the run's declared stack starts at `system-ui` /
   *  `BlinkMacSystemFont` — see `stackPrimaryIsSystemUi`, which is what the
   *  caller derives this from. */
  systemUiPrimary: boolean = false,
  /** CSS `font-stretch` as a percentage, 100 = `normal`. */
  stretch: number = 100,
  /** The run's `font-variant-emoji` override (`normal` = undefined) — the
   *  probe must ask the exact question the resolver answers, override included. */
  fontVariantEmoji?: FontVariantEmojiOverride,
): boolean {
  return !resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, fontVariantEmoji).covered;
}

/**
 * DM-1068: the single per-codepoint font decision shared by the glyph-path
 * splitter (`textToPathMarkup`), the embedded-font splitter
 * (`splitTextIntoFontRuns`), and the math fence / radical renderers — previously
 * five drifting copies. Resolves which font + glyph to use for `cp`, trying in
 * order: the primary; a per-codepoint webfont variant (partitioned @font-face —
 * DM-557); the platform system fallback (DM-1018, the `CTFontCreateForString`
 * font Blink would substitute — this is Blink's own `kSystemFonts` stage, so it
 * answers first); the static `fallbackFontChain` as the net for what the OS
 * declines; a Math-Alphanumeric base-letter decomposition; and a canonical (NFD)
 * decomposition (DM-1020/1021, for CJK compatibility ideographs etc.).
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

// DM-1659: the standalone `/Library/Fonts/SF-Pro-*.otf` supplies the few glyphs
// SFNS lacks (see the per-codepoint hook in resolveFontForCodepoint). Resolved +
// registered once, lazily. `undefined` = not yet checked, `null` = OTF not
// installed on this host (Chrome can't use it either → SFNS's cascade continues).
let _sfProCoverageKey: string | null | undefined;
function sfProCoverageOtfKey(): string | null {
  if (_sfProCoverageKey !== undefined) return _sfProCoverageKey;
  _sfProCoverageKey = null;
  try {
    const cut = resolveInstalledFont("SF Pro Text");
    if (cut != null) {
      const key = `sysfb:${cut.postscriptName}`;
      registerDynamicSystemFont(key, cut.path, cut.postscriptName, "fontkit");
      _sfProCoverageKey = key;
    }
  } catch { /* helper unavailable — keep null */ }
  return _sfProCoverageKey;
}

/**
 * Route a resolved codepoint's SHAPING to HarfBuzz — the engine Chrome runs —
 * while leaving the OUTLINES with whichever engine resolved the face.
 *
 * Applies only to the scripts listed in `HARFBUZZ_SHAPED_RANGES`, which is grown
 * one script at a time. The measurement that motivates it: `npm run
 * fonts:shaper-ab` compares HarfBuzz against the macOS CoreText helper over
 * every resolvable face and finds 366 disagreements, spread across all ten
 * dedicated-shaper scripts — so the claim the exclusion used to rest on ("macOS
 * CoreText already matches Chrome for them") is false everywhere it was applied.
 * For Thai, 2 of its 32 are `glyph-ids`: HarfBuzz substitutes the Windows-PUA
 * shift-left forms U+F704 / U+F714 for an above vowel + tone mark over an
 * ascender consonant, per the state machine and mapping table in
 * `external/harfbuzz/src/hb-ot-shaper-thai.cc` (rev 4de187d, :124-137 / :156-159
 * / :172-179 / :188-189), and CoreText emits the plain cmap glyphs. On Arial
 * Unicode MS the PUA forms are the same outline shifted 220 units left — 0.107
 * em, ≈1.7 px at 16 px.
 *
 * **Shaping moves; outlines do not, and that separation is the point.** An
 * earlier attempt routed the whole `layout()` through HarfBuzz and made the Thai
 * fixture WORSE (worst tile 0.0940 → 0.1214, reproducible to six decimal
 * places), even though on the face that fixture actually paints with the two
 * engines shape byte-for-byte identically. The cost was entirely the outline
 * engine changing hands, against which the macOS pixel calibration was measured.
 * `outlinesFromBase` keeps HarfBuzz's ids, positions and clusters and takes each
 * glyph from the base instance, which is well-defined because it is the same
 * file and therefore the same gid space.
 *
 * Returns the resolution unchanged when the face has no on-disk file HarfBuzz
 * can open (a webfont buffer, an unresolvable key) — the run then keeps whatever
 * shaping it had.
 */
function harfbuzzShapedScriptOverride(
  cp: number,
  res: FontResolution,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
): FontResolution {
  if (!res.covered || !usesHarfbuzzShaping(cp)) return res;
  const fvs = res.key === primaryFontKey ? variationSettings : undefined;
  const base = res.fontOverride ?? (res.key === primaryFontKey ? primaryFont : getFontInstance(res.key, weight, fontSize, slant, fvs));
  if (base == null) return res;
  const hbFace = shapingFaceFor(res.key, weight, fontSize, slant, fvs);
  if (hbFace == null) return res;
  const hbInst = makeHarfbuzzShapingInstance(base, hbFace.path, hbFace.faceIndex, fontSize, hbFace.axes, { outlinesFromBase: true });
  if (hbInst === base) return res; // HarfBuzz declined the file
  carryFontInstanceMetadata(hbInst, base);
  return { ...res, fontOverride: hbInst };
}

/**
 * Copy the FontInstance facts a shaping proxy does not forward.
 *
 * `makeHarfbuzzShapingInstance` exposes a FIXED property set — the shaping and
 * metric surface — so everything else a resolved instance carries comes back
 * `undefined` through it. That is harmless for a one-character override and not
 * harmless for a whole run: the embedded-font path reads `naturalWeight` /
 * `faceIsBoldTrait` (or `webfontFace`, for a run resolved through the
 * `@font-face` registry) to decide synthetic bold, `resolvedItalicAngle` /
 * `isRoutedItalicCut` for synthetic oblique, and looks the instance up in
 * `fontSourceMap` to fold the resolved axis location into the subset key. Losing
 * that last one silently collapses two optical instances of one face into a
 * single embedded TTF.
 *
 * Idempotent, and the proxy is memoized per (base, args), so this runs once per
 * distinct proxy in practice.
 */
function carryFontInstanceMetadata(proxy: FontInstance, base: FontInstance): void {
  proxy.naturalWeight = base.naturalWeight;
  proxy.hasWeightAxis = base.hasWeightAxis;
  proxy.faceIsBoldTrait = base.faceIsBoldTrait;
  proxy.webfontFace = base.webfontFace;
  proxy.resolvedItalicAngle = base.resolvedItalicAngle;
  proxy.hasSlantAxis = base.hasSlantAxis;
  proxy.isRoutedItalicCut = base.isRoutedItalicCut;
  proxy.postscriptName = base.postscriptName;
  proxy.instantiatedPostscriptName = base.instantiatedPostscriptName;
  const src = fontSourceMap.get(base as unknown as object);
  if (src != null) fontSourceMap.set(proxy as unknown as object, src);
}

/**
 * Route a run whose feature list carries a DISABLE (`-liga`) or an explicit
 * value (`aalt=2`) through HarfBuzz shaping, so the feature state is honored
 * the way Chrome honors it.
 *
 * Blink appends every `font-feature-settings` entry to the HarfBuzz feature
 * array with its value intact (`FontFeatureRange::FromFontDescription`,
 * `platform/fonts/shaping/font_features.cc:203-225`, rev 7d859f27); HarfBuzz
 * expresses a zero by leaving the feature's lookup mask unset (GSUB) or
 * selecting the feature's OFF selector (AAT — `hb-aat-map.cc:79`, rev 4de187d).
 * fontkit's `layout(text, features)` is enable-only and the platform glyph
 * helpers ignore the list entirely, so without this reroute a run declaring
 * `font-feature-settings: "liga" 0` rendered WITH ligatures — measured on
 * Times ("office waffle affix flight", 24px): Chrome paints 26 glyphs under
 * the disable and our side kept painting 22.
 *
 * Same construction as `harfbuzzShapedScriptOverride`: HarfBuzz supplies the
 * shaping (ids, positions, clusters), the base instance supplies the outlines
 * (`outlinesFromBase`), and the run keeps its resolved face.
 *
 * A webfont has no on-disk file, and until DM-1964 that meant the reroute
 * declined for every `@font-face` run — leaving them on fontkit's enable-only
 * shaping, i.e. dropping the disable this function exists to express. The
 * retained `@font-face` bytes now serve as the face (`webfontShapingFace`).
 * Returns the base unchanged only when there is neither a file nor a buffer.
 */
/**
 * DM-1964: the HarfBuzz face for a run resolved through the webfont registry,
 * built from the retained `@font-face` bytes.
 *
 * Face index 0 rather than a lookup: an `@font-face` src names ONE face, and a
 * collection would be rejected by `getHbEntry`'s `hb_face_count` bounds check
 * (Blink's own, `harfbuzz_face_from_typeface.cc:38-42`) rather than shaped with
 * the wrong member.
 *
 * The axes are the location `applyVariationAxes` already resolved for this
 * instance — the same value `getFontSourceInfo` reports for a file-backed one,
 * read from the same field, so the shaper and the outlines sit on one master by
 * construction rather than by two derivations agreeing.
 */
function webfontShapingFace(base: FontInstance):
    { path: string; faceIndex: number; axes: Record<string, number> | null } | null {
  const bytes = base.webfontBuffer;
  if (bytes == null) return null;
  // Decline a COLLECTION rather than assume member 0. An `@font-face` src names
  // one face and is never a `.ttc` in practice, but the buffer carries no name
  // to resolve a member by — and shaping the wrong member of a collection is
  // precisely the defect `getHbEntry`'s "unidentified face" refusal exists to
  // prevent (every glyph wrong, not subtly off). Falling back to fontkit here
  // loses the disable, which is the lesser failure and the pre-existing one.
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x74746366 /* 'ttcf' */) return null;
  const applied = (base as unknown as { _appliedVariationAxes?: Record<string, number> })._appliedVariationAxes;
  return { path: registerHbBufferSource(bytes), faceIndex: 0, axes: applied ?? null };
}

export function fontFeatureValueShapingOverride(
  base: FontInstance,
  fontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  /** The run's FULL feature list (HarfBuzz feature strings, disables and
   *  values included) — bound into the proxy, which is the one consumer that
   *  receives the unprojected list. */
  features: string[],
): FontInstance {
  // The shaper must open the SAME face the outlines come from. Prefer the
  // resolved instance's own source file over re-deriving one from the font key:
  // a key like `sf-pro` or `georgia` names a FAMILY, and the run's slant/weight
  // pick a sibling file or TTC member from it. `shapingFaceFor(fontKey, …)`
  // resolves the key's base spec, so an ITALIC run shaped against the upright
  // face and then drew those glyph ids out of the italic one — every glyph
  // wrong, not subtly off. Measured on `system-ui` at 800: fontkit returns ids
  // 716,847,577,… for the italic face and the proxy returned 739,894,588,… —
  // the upright face's ids for the same string.
  //
  // `getFontSourceInfo` is the file the outlines are actually taken from, so
  // agreement is by construction rather than by two derivations coinciding.
  // Falls back to the key-based derivation when the instance names no physical
  // member (webfont buffers, CoreText named instances with no sfnt member),
  // which is the case the fallback was always serving.
  const src = getFontSourceInfo(base);
  const hbFace = src != null && src.nameMatched && src.faceIndex != null
    ? { path: src.path, faceIndex: src.faceIndex, axes: src.variationAxes ?? null }
    : shapingFaceFor(fontKey, weight, fontSize, slant, variationSettings)
    // DM-1964: a webfont has no on-disk file, so both derivations above come
    // back empty and the reroute used to decline — leaving the run on fontkit's
    // enable-only shaping, i.e. dropping the very disable this function exists
    // to express. The bytes are the same thing a path would have been read into.
    ?? webfontShapingFace(base);
  if (hbFace == null) return base;
  const hbInst = makeHarfbuzzShapingInstance(base, hbFace.path, hbFace.faceIndex, fontSize, hbFace.axes, { outlinesFromBase: true, features });
  if (hbInst === base) return base; // HarfBuzz declined the file
  carryFontInstanceMetadata(hbInst, base);
  return hbInst;
}

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
  systemUiPrimary: boolean = false,
  /** CSS `font-stretch` as a percentage (100 = `normal`). Reaches the cascade
   *  base, which Blink takes from the face the run is actually painting in. */
  stretch: number = 100,
  /** The run's `font-variant-emoji` override (`normal` = undefined). Callers
   *  that can see the NEXT codepoint pass undefined when it is an explicit
   *  VS15/VS16 — the property must not override an explicit selector
   *  (`HasVSFallbackPriority` guard, `harfbuzz_shaper.cc:184-198`, rev 7d859f27). */
  fontVariantEmoji?: FontVariantEmojiOverride,
): FontResolution {
  return harfbuzzShapedScriptOverride(
    cp,
    resolveFontForCodepointInner(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, fontVariantEmoji),
    primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings,
  );
}

function resolveFontForCodepointInner(
  cp: number,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
  fontKeyChain: string[],
  /** DM-1859: the run's primary is the CSS `system-ui` keyword rather than a
   *  named family. Both land on the `sf-pro` key, so the key cannot carry this;
   *  see `stackPrimaryIsSystemUi` for why it travels separately. */
  systemUiPrimary: boolean = false,
  stretch: number = 100,
  fontVariantEmoji?: FontVariantEmojiOverride,
): FontResolution {
  const ch = String.fromCodePoint(cp);
  const cover = (key: string, fontOverride: FontInstance | null, emitCh = ch, decomposed = false): FontResolution =>
    ({ key, fontOverride, emitCh, decomposed, covered: true });

  // `font-variant-emoji: emoji` (and `unicode`, for emoji-default codepoints)
  // forces VS16 in every glyph lookup, so a candidate WITHOUT color presentation
  // reads as having no glyph and the cascade lands on the color-emoji font —
  // even over a covering primary (`HarfBuzzGetGlyph`,
  // `shaping/harfbuzz_face.cc:127-206` + `ApplyFontVariantEmojiOnFallbackPriority`,
  // `harfbuzz_shaper.cc:184-198`, rev 7d859f27). Measured: bare U+2764 moves
  // ZapfDingbats → Apple Color Emoji, a covered U+263A moves Helvetica → Apple
  // Color Emoji, and even digit `5` moves (the `Emoji` property includes the
  // keycap bases). When the color font does not cover the codepoint, Blink
  // resets the queue and resolves ignoring the selector
  // (`harfbuzz_shaper.cc:1010-1020`) — the fall-through below.
  if (forcesEmojiPresentation(cp, fontVariantEmoji)) {
    const emojiKey = resolveColorEmojiKeyForCp(cp, weight, fontSize, slant, lang);
    if (emojiKey != null) {
      const inst = emojiKey === primaryFontKey ? null : getFontInstance(emojiKey, weight, fontSize, slant);
      return cover(emojiKey, inst);
    }
  }

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
    if (dcps.every((d) => glyphIdForCp(primaryFont, d) !== 0)) {
      const hbFace = shapingFaceFor(primaryFontKey, weight, fontSize, slant, variationSettings);
      if (hbFace != null) {
        const hbInst = makeHarfbuzzShapingInstance(primaryFont, hbFace.path, hbFace.faceIndex, fontSize, hbFace.axes);
        if (hbInst !== primaryFont) return cover(primaryFontKey, hbInst, ch, true);
      }
    }
  }

  // NOTE (DM-1688): a per-codepoint SF-cascade guard was tried here and REVERTED.
  // Chrome's own ground truth (CDP getPlatformFontsForNode) shows Chrome paints
  // the squared / circled / enclosed alphanumerics AND Latin-Extended (🄰 ① Ɓ …)
  // from SF Pro Text (SFNS) — i.e. the fast-path below is already correct. Only a
  // narrow set (🅪🅫 U+1F16A/1F16B RAISED MC/MD) is genuinely cascaded off the SF
  // UI font (→ New York). Detecting THAT precisely needs the SF UI font's real
  // coverage (CTFontCreateUIFontForLanguage + CTFontGetGlyphsForCharacters — a
  // glyph-helper addition); the CoreText default-base (Helvetica) system-fallback
  // query is NOT a valid proxy — it cascades every codepoint Helvetica lacks
  // (all of Latin-Extended-B, the enclosed alphanumerics) that SF actually paints,
  // so gating on it mis-routes those. Left as a documented 2-codepoint residual.

  // 0. Primary fast-path: literal coverage in the run's primary font.
  if (glyphIdForCp(primaryFont, cp) !== 0) return cover(primaryFontKey, null);

  // DM-1659: SF Pro Text/Display and the system font resolve to SFNS (matching
  // Chrome's PAINTED glyph shapes — see matchFamilyNameToKey). But SFNS lacks a
  // few glyphs the standalone `/Library/Fonts/SF-Pro-*.otf` carries (the two-digit
  // enclosed alphanumerics U+2469–2473 / U+24EB–24F4, Enclosed-CJK circled 21–50).
  // For those, Chrome's CoreText cascades from SFNS to the standalone OTF (which it
  // still reports as "SF Pro Text"). Mirror that per-codepoint: an sf-pro run whose
  // codepoint SFNS doesn't cover falls to the standalone OTF BEFORE the declared
  // chain — else it hits a LATER author family (Arial Unicode MS's full-em circled
  // numbers, a visibly larger glyph than Chrome's condensed SF Pro one, DM-1127).
  if (primaryFontKey === "sf-pro" || primaryFontKey === "sf-pro-italic") {
    const otfKey = sfProCoverageOtfKey();
    if (otfKey != null) {
      const otf = getFontInstance(otfKey, weight, fontSize, slant);
      if (otf != null && glyphIdForCp(otf, cp) !== 0) return cover(otfKey, otf);
    }
  }

  // Canonical NFD singleton (e.g. U+2F800→U+4E3D). null when `cp` has no
  // single-codepoint canonical decomposition — multi-char decompositions are not
  // a font-substitution case here.
  const nfd = ch.normalize("NFD");
  const dcp0 = nfd.codePointAt(0);
  const singleton = (dcp0 != null && dcp0 !== cp && String.fromCodePoint(dcp0) === nfd) ? dcp0 : null;

  // Canonical base+mark decomposition (e.g. U+21AE ↮ → U+2194 ↔ + U+0338
  // COMBINING LONG SOLIDUS OVERLAY). Chrome shapes with HarfBuzz, whose
  // normalizer (hb-ot-shape-normalize.cc, decompose_current_character)
  // decomposes a codepoint the current font's cmap lacks and shapes the pieces
  // IN THAT SAME FONT when it covers them — so Chrome-on-Linux paints the
  // negated arrows (↮ ⇎ ↚ ↛) as TWO Liberation Sans glyphs (CDP
  // getPlatformFontsForNode: "Liberation Sans", glyphCount 2): the base arrow
  // plus the zero-advance combining slash drawn naively at the pen position
  // (Liberation has no GPOS mark anchors on arrow bases), and never reaches the
  // per-char fontconfig fallback that would have found FreeSans's PRECOMPOSED
  // ↮ (slash centered through the arrow — a visibly different glyph). Mirror
  // that here: when a declared family covers every NFD piece, route the run
  // through real HarfBuzz (harfbuzzjs — the same engine Chrome embeds) so it
  // decomposes and positions exactly like Chrome.
  //
  // This is HarfBuzz behavior, not a platform quirk, so it is NOT gated by
  // platform. It was originally scoped to Linux because the macOS cases that
  // motivated it (the negated arrows) don't arise there — the darwin chains
  // route those blocks to Apple Symbols and macOS Helvetica lacks the U+2194
  // base piece, so the every-piece-covered guard below simply fails and the
  // walk falls through exactly as before. But the same guard DOES fire on a
  // stock macOS install for accented Latin / Cyrillic: with the non-stock
  // "SF Pro Text" absent, the unicode fixtures' stacks fall to Arial Unicode
  // MS, which has no PRECOMPOSED Ѐ / Ѝ / ѐ / ѝ / Ӭ / ӭ (U+0400, U+040D,
  // U+0450, U+045D, U+04EC, U+04ED) or Ș / Ț / Ǹ / Ȟ / Ȧ / Ǫ… (U+0218-U+0233)
  // yet does cover every NFD piece. Chrome decomposes and paints TWO Arial
  // Unicode MS glyphs there (CDP getPlatformFontsForNode: "Arial Unicode MS",
  // glyphCount 2 — glyphCount 3 for the two-mark U+0230/U+0231). Rejecting the
  // font on missing composed coverage sent us on down the chain to Helvetica,
  // whose PRECOMPOSED glyph carries the accent at a visibly different height —
  // the "accent marks in the wrong place" the stock-macOS runner reports and a
  // developer Mac (which has SF Pro Text, so it never reaches Arial Unicode MS)
  // cannot reproduce.
  const baseMarkNfd = singleton == null ? nfdBaseMarkDecomposition(cp) : null;
  const baseMarkCps = baseMarkNfd != null ? [...baseMarkNfd].map((c) => c.codePointAt(0)!) : null;

  // Materialize a chain key to an instance — webfont-partition-aware, and only
  // the primary carries the author's font-variation-settings.
  const instanceFor = (key: string): FontInstance | null => {
    const fvs = key === primaryFontKey ? variationSettings : undefined;
    if (key === primaryFontKey) return primaryFont;
    if (key.startsWith("webfont:")) {
      const family = key.slice("webfont:".length);
      const v = pickWebfontVariantForCodepoint(family, weight, fontSize, slant, cp, variationSettings, stretch);
      if (v != null) return v;
    }
    return getFontInstance(key, weight, fontSize, slant, fvs);
  };

  // 1. kFontFamily — walk the declared families (literal, then in-font decomp).
  for (const key of fontKeyChain) {
    const inst = instanceFor(key);
    if (inst == null) continue;
    if (glyphIdForCp(inst, cp) !== 0) return cover(key, key === primaryFontKey ? null : inst);
    if (singleton != null && glyphIdForCp(inst, singleton) !== 0) {
      return cover(key, key === primaryFontKey ? null : inst, String.fromCodePoint(singleton), true);
    }
    // Base+mark NFD within this same font (Linux — see baseMarkNfd above). The
    // run keeps the SOURCE char (HarfBuzz decomposes internally, like Chrome),
    // so clusters / xOffsets stay aligned; `decomposed: true` routes the
    // glyph-path emitter to its run-shaping branch. Falls through when the key
    // has no on-disk file HarfBuzz can open.
    if (baseMarkCps != null && baseMarkCps.every((d) => glyphIdForCp(inst, d) !== 0)) {
      const hbFace = shapingFaceFor(key, weight, fontSize, slant, variationSettings);
      if (hbFace != null) {
        const hbInst = makeHarfbuzzShapingInstance(inst, hbFace.path, hbFace.faceIndex, fontSize, hbFace.axes);
        if (hbInst !== inst) return cover(key, hbInst, ch, true);
      }
    }
  }

  // 2. kSystemFonts.
  //
  // Blink has exactly ONE stage here, and it is the OS. `FontFallbackIterator::Next`
  // (font_fallback_iterator.cc:120-157, Chromium rev 7d859f27) runs
  // kFontGroupFonts / kSegmentedFace → (kFallbackPriorityFonts, one-shot) →
  // **kSystemFonts = `UniqueSystemFontForHintList`** → kFirstCandidateForNotdefGlyph
  // → kOutOfLuck. There is no static per-Unicode-block table anywhere in that
  // walk; `UniqueSystemFontForHintList` goes straight to the platform fallback
  // (`CTFontCreateForString` on macOS).
  //
  // Our static `fallbackFontChain` is therefore an EXTRA stage, sitting exactly
  // where Blink asks the OS — so whenever it answers first, Chrome's question is
  // never asked (docs/106). Measured cost of that shadowing, back when it did:
  // the UI-font cascade base, verified 18/18 against Chrome, moved the CJK slice
  // by 55 rows out of an expected 83,838, purely because `[pingfang-sc, cjk]`
  // covers Han and the walk stopped there.
  //
  // So the OS goes first, and the static chain is the NET for what the OS
  // declines — which is where it still earns its keep (no helper on the host, a
  // platform whose live resolver is flagged off, or a codepoint the OS has no
  // answer for, all of which would otherwise drop straight to tofu).
  // `DOMOTION_LIVE_FALLBACK_FIRST=0` restores the old chain-first order for an
  // A/B; see the flag's declaration for the measurement that set the default.
  const liveFallback = (): FontResolution | null => {
    if (!_systemFallbackResolutionEnabled) return null;
    const sysKey = resolveSystemFallbackKeyForCp(cp, weight, slant, fontSize, primaryFontKey, systemUiPrimary, lang, stretch, fontVariantEmoji);
    if (sysKey == null) return null;
    const sf = getFontInstance(sysKey, weight, fontSize, slant);
    if (sf == null) return null;
    // DM-1986: coverage is the CMAP question — see `fontCoversCp`. The id test
    // discarded the live resolver's own answer for every emoji-presentation
    // codepoint on Linux, because the font it names (`NotoColorEmoji.ttf`) is
    // bitmap-only and yields no Glyph object.
    // The helper now answers coverage with the nomination (as the Linux
    // `fcfallback` query always has), so the second round trip this line used to
    // cost is gone wherever the binary reports it. `??` rather than a default:
    // an older helper omits the field, and treating "absent" as "not covered"
    // would silently discard every live answer.
    if (_sysfbCoverage.get(`${sysKey}|${cp}`) ?? fontCoversCp(sf, cp)) return cover(sysKey, null);
    if (singleton != null && fontCoversCp(sf, singleton)) {
      return cover(sysKey, null, String.fromCodePoint(singleton), true);
    }
    return null;
  };
  const staticChain = (): FontResolution | null => {
    // DM-1985: the run's `font-variant-emoji` reaches the chain, because on
    // Windows it decides which arm of `GetFallbackFamily` the codepoint takes.
    for (const candidate of fallbackFontChain(cp, primaryFontKey, lang, { weight, slant, fontSize, fontVariantEmoji })) {
      if (candidate === "last-resort") continue;
      const cf = getFontInstance(candidate, weight, fontSize, slant);
      // The coverage test, answered from a local cmap bitset when the face can
      // be identified in its file and from the helper otherwise. This walk is
      // where ~64% of the resolver's coverage probes come from — 4.43 per
      // codepoint on Windows — and each one is a round trip whose answer the
      // font file already holds. `nativeFaceCoversCp` returns null rather than
      // guessing when it cannot name the face, so the helper stays the
      // authority for exactly the cases it is needed for.
      if (cf != null && (nativeFaceCoversCp(cf, cp) ?? glyphIdForCp(cf, cp) !== 0)) {
        const cut = fallbackFamilyCutKey(candidate, cp, weight, slant, fontSize);
        if (cut != null) {
          const cutFont = getFontInstance(cut, weight, fontSize, slant);
          if (cutFont != null && (nativeFaceCoversCp(cutFont, cp) ?? glyphIdForCp(cutFont, cp) !== 0)) return cover(cut, null);
        }
        return cover(candidate, null);
      }
    }
    return null;
  };

  // Blink runs NO system fallback for private-use or noncharacter codepoints.
  // `FontCache::FallbackFontForCharacter` returns null before it ever reaches
  // `PlatformFallbackFontForCharacter` (`platform/fonts/font_cache.cc:229-244`,
  // rev 7d859f27):
  //
  //     if (Character::IsPrivateUse(lookup_char) ||
  //         Character::IsNonCharacter(lookup_char))
  //       return nullptr;
  //
  // pinned upstream by `FontCacheTest.NoFallbackForPrivateUseArea`
  // (`font_cache_test.cc:44-61`), which asserts null for exactly
  // U+E000 / U+E401-E403 / U+F8FF / U+F0000 / U+FAAAA / U+100000 / U+10AAAA.
  //
  // Both stages below stand in for Blink's `kSystemFonts`: `liveFallback` is
  // the CoreText / fontconfig / DirectWrite call itself, and the static
  // `fallbackFontChain` is our extra table sitting in the same slot (docs/106).
  // So the rule gates both. The DECLARED-family stages above are untouched —
  // Blink still walks those, which is why an icon webfont, or macOS Helvetica's
  // real U+F8FF  glyph, still paints from the family that actually carries it.
  //
  // Falling through to the uncovered terminal is what makes the rest correct:
  // the run stays on the primary and paints ITS `.notdef`, at the advance
  // Chrome measured. Reaching a substitute instead is visible twice over — the
  // wrong glyph, and (because a substitute's `.notdef` advance is its own)
  // ink wider than the advance the capture recorded, which overlaps the next
  // character. Measured on macOS before this gate: CoreText answers
  // `SFCompact-Regular` for U+100000 (Apple keeps SF Symbols in plane 16) and
  // our chain tail answered LastResort for U+E000 / U+F0000, whose glyph is
  // 35.20px wide against Helvetica's 20.28px `.notdef` at 32px.
  const noSystemFallback = isPrivateUseCodepoint(cp) || isNonCharacterCodepoint(cp);
  if (noSystemFallback) {
    return { key: primaryFontKey, fontOverride: null, emitCh: ch, decomposed: false, covered: false };
  }

  if (_liveFallbackFirst) {
    const live = liveFallback();
    if (live != null) return live;
    const stat = staticChain();
    if (stat != null) return stat;
  } else {
    const stat = staticChain();
    if (stat != null) return stat;
    const live = liveFallback();
    if (live != null) return live;
  }

  // 3. Math-Alphanumeric decomposition (NFKD compatibility axis).
  const decomp = decomposeMathAlphaRun(cp, fallbackFontChain(cp, primaryFontKey, lang, { weight, slant, fontSize }), weight, fontSize);
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
  const circleGid = glyphIdForCp(primaryFont, 0x25CC);
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

