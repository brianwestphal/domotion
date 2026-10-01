/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import * as fontkit from "fontkit";
import { hostPlatform } from "./host-platform.js";
import { isTransientFsError, retrySync } from "./sync-retry.js";
import { parseCssFontFamilyEntries } from "../font-family-stack.js";
import {
  createGlyphHelperFont,
  isGlyphHelperAvailable,
  resolveFaceTraitBold,
  resolveFaceTraitItalic,
  resolveSystemUiFontFace,
  type GlyphRasterRepresentation,
} from "./glyph-helper.js";
import { faceHasTrakAndStat, installHarfbuzzShaping, makeHarfbuzzShapeFallback } from "./harfbuzz-shaper.js";
import { isLegitimatelyInklessCodepoint } from "./unicode-classification.js";
import { SUB_BOLD_WEIGHT_CUTS } from "./fallback-chain.js";
import type { FontFallbackSemanticContext } from "./fallback-chain.js";
import { createFontFallbackSemanticContext } from "./fallback-chain.js";
import { resolveFontSpec } from "./font-spec.js";
import { win32PrimaryCutKey } from "./fallback-chain.linux.js";
import { darwinPrimaryCutKey } from "./family-match.js";
import { linuxPrimaryCutKey } from "./family-match.js";
import { pickWebfontVariant } from "./webfont-registry.js";
import { pickLocalFontAliasVariant } from "./webfont-registry.js";
import { _trakHbShapingEnabled } from "./system-fallback-resolver.js";
import { registerDynamicSystemFont } from "./font-paths.win32.js";
// re-export for text-to-path.test.ts + text.ts

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
  /** The `@font-face` `font-style` DESCRIPTOR as selection capabilities
   *  `[min, max]` in Blink's slope-DEGREE convention (`normal` = `[0, 0]`,
   *  `italic`/bare `oblique` = `[14, 14]`, `oblique <angle>` = `[a, a]`,
   *  `oblique <min> <max>` = the range with decreasing endpoints swapped —
   *  `core/css/font_face.cc:776-858`, rev 7d859f27), or null when the
   *  descriptor is auto/absent. Null does NOT mean "no capabilities": an
   *  auto descriptor SELECTS as exactly normal style `[0, 0]`, so the
   *  distinction only changes whether the variable-`slnt`-axis exemption
   *  below is allowed to fire — see `webfontSyntheticItalic`, the mirror of
   *  `webfontSyntheticBold`. */
  declaredStyleCaps?: readonly [number, number] | null;
  /** The buffer's own `slnt` fvar axis MINIMUM, in the axis's own OpenType
   *  sign convention (negative = right-leaning — opposite of CSS), or null
   *  when the buffer exposes no `slnt` axis (a static face). */
  slntAxisMin?: number | null;
  /** Whether the BASE buffer declares itself italic — Skia's
   *  `SkTypeface::isItalic()`, i.e. `fontStyle().slant() != kUpright_Slant`
   *  (`external/skia` `src/core/SkTypeface.cpp:495-497`, rev ebf5052 — read
   *  at the checkout's working-tree revision rather than Chromium's
   *  DEPS-pinned `62efacd3`: this agent's worktree isolation blocks `git
   *  show` against a revision other than the checkout's current HEAD, and
   *  `isItalic()`/`isBold()` are adjacent one-line accessors unchanged across
   *  the handful of `SkFontConfigInterface_direct.cpp` lines known to differ
   *  between the two revisions, so the drift risk here is negligible).
   *  Domotion's proxy for the underlying fact — OS/2 `fsSelection` bit 0
   *  (ITALIC), the same table `baseIsBold` reads bit 5 from. */
  baseIsItalic?: boolean;
}

export interface FontInstance {
  /** Physical SFNT table directory when fontkit opened the face. Native-helper
   * instances omit it. Used for Blink's color-table presentation test. */
  directory?: { tables?: Record<string, unknown> };
  /**
   * DM-1894: `script`/`language`/`direction` mirror fontkit's own signature, and
   * `direction` is the one that matters — Blink passes direction into the shaper
   * explicitly (`HarfBuzzShaper::Shape(font, direction, …)`) rather than letting
   * it be inferred from content, because inference reads an RTL stretch inside an
   * otherwise-LTR run as left-to-right. Callers that shape a single-script
   * segment should pass it; omitting it preserves the previous infer-it behavior.
   */
  layout(
    text: string,
    features?: string[],
    script?: string,
    language?: string,
    direction?: "ltr" | "rtl",
  ): {
    glyphs: Array<{
      id: number;
      path: { commands: Array<{ command: string; args: number[] }> };
      advanceWidth: number;
      codePoints?: number[];
      rasterRepresentation?: GlyphRasterRepresentation;
    }>;
    positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
    clusters?: number[];
    glyphFlags?: number[];
  };
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition: number;
  underlineThickness: number;
  /** Available OpenType feature tags (e.g. ['liga', 'kern', 'smcp']). Used by
   *  the synthesized-small-caps path to detect when smcp is missing. */
  availableFeatures?: string[];
  /** Skia's Windows scaler uses its embedded-bitmap/GDI-classic route for this
   *  size. Such text is capture-raster-owned because a webfont subset cannot
   *  reproduce the native terminal mask. */
  embeddedBitmapPaint?: boolean;
  "OS/2"?: {
    yStrikeoutPosition?: number;
    yStrikeoutSize?: number;
    /** sTypoAscender / sTypoDescender (font units; descender stored negative).
     *  Feed the normalized-typo-descent rule for `text-underline-position:
     *  under` (`platform/fonts/simple_font_data.cc:360-415`, rev 7d859f27).
     *  Present on fontkit-backed instances and native helpers that expose the
     *  selected face's OS/2 table; older helpers fall back to
     *  FloatAscent/FloatDescent normalization. */
    typoAscender?: number;
    typoDescender?: number;
  };
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
   *  faux-bold decision (DM-1693/DM-2390): when the requested weight exceeds
   *  this by a wide margin and no weight axis satisfies it, Chromium asks Skia
   *  to frame the unchanged source outline. Absent on native-helper / webfont
   *  instances; webfonts carry their separate descriptor facts. */
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
  /**
   * The mirror of `faceIsBoldTrait` for the ITALIC style bit, which the macOS
   * synthetic-oblique rule tests (`mac/font_cache_mac.mm:431-436`, rev
   * 7d859f27): `matched_font_traits & kCTFontTraitItalic`, not the face's own
   * `post.italicAngle` — see `faceNeedsSyntheticOblique`.
   *
   * Same two sources as the bold trait: OS/2 `fsSelection` bit 0 for a
   * fontkit-opened face, the CoreText trait itself for a helper-backed one.
   * Undefined when neither is readable, and callers fall back to the
   * outline-derived heuristic (`hasSlantAxis` / `isRoutedItalicCut` /
   * `resolvedItalicAngle`).
   *
   * Linux's helper also reports its native FreeType italic style bit. The
   * Windows reports `IDWriteFontFace3::GetStyle()`, the exact source Chromium's
   * pinned `DWriteFontTypeface::GetStyle` reads. The field stays optional for
   * older helper/DirectWrite versions; those paths keep the outline heuristic
   * in `faceNeedsSyntheticOblique`.
   */
  faceIsItalicTrait?: boolean;
  /**
   * DM-2017: set ONLY on a face resolved through the Linux live per-codepoint
   * SYSTEM-FALLBACK path (`resolveFcFallbackFonts`'s `fcfallback` query), from
   * the fontconfig `FC_WEIGHT` / `FC_SLANT` classification of the CHOSEN
   * candidate — the same `isBold` / `isItalic` bits Blink reads back and uses
   * to MUTATE the description before painting (`linux/font_cache_linux.cc:
   * 106-125`, rev 7d859f27). Deliberately a DIFFERENT field from
   * `faceIsBoldTrait`: that one is a fact about the file's own OS/2 table and
   * feeds the darwin/win32 threshold-pair rules and the general Linux DELTA
   * rule's fallback path; this pair feeds a THIRD rule that applies only to a
   * fallback pick, because Blink's `PlatformFallbackFontForCharacter`
   * explicitly OVERRIDES whatever `CreateFontPlatformData`'s internal delta
   * test computed (`platform_data->SetSyntheticBold(should_set_synthetic_bold)`,
   * `font_cache_linux.cc:132-136`) with a binary test against fontconfig's
   * own bits instead. Undefined for every other Linux face (declared-family
   * resolution, the static fallback chain, non-Linux platforms), where the
   * existing rules are unchanged. See `faceNeedsSyntheticBold` /
   * `faceNeedsSyntheticOblique`.
   */
  linuxFallbackIsBold?: boolean;
  linuxFallbackIsItalic?: boolean;
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
  /** The matched `@font-face` variant's `unicode-range` descriptor, on
   *  instances resolved through the webfont registry and only when the variant
   *  declares one. The cluster-granularity splitter clamps its shaped-cluster
   *  verdicts to it, mirroring how Blink passes the segmented face's range set
   *  into shaping so out-of-range characters read as `.notdef` and re-queue
   *  (`ShapeRange(..., current_font_data_for_range_set->Ranges(), ...)`,
   *  `harfbuzz_shaper.cc:1119`, rev 7d859f27). */
  webfontUnicodeRange?: Array<[number, number]>;
  /** Zero-based source declaration order within an author webfont family.
   * Blink retains this identity while walking a segmented face in reverse
   * declaration order; physical font bytes are not sufficient because two
   * overlapping declarations may reference the same resource. */
  webfontDeclarationOrder?: number;
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
  /** Set on every instance whose `layout` shapes through HarfBuzz — the proxy
   *  `makeHarfbuzzShapingInstance` returns, or an instance whose layout
   *  `installHarfbuzzShaping` replaced in place. `harfbuzzShapedRunOverride`
   *  reads it so a run already shaping via hb is never wrapped twice (a
   *  proxy-over-proxy has no `getGlyph`, which would silently swap the outline
   *  engine to HarfBuzz's own `glyphToPath`). */
  shapesWithHarfbuzz?: true;
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
 * which for a color bitmap font is always no.
 *
 * Falls back to the id test when the instance exposes no `hasGlyphForCodePoint`
 * (the native-helper instances), so nothing that works today changes behavior.
 */
export function fontCoversCp(font: FontInstance, cp: number): boolean {
  const has = font.hasGlyphForCodePoint;
  if (typeof has === "function") {
    try {
      if (has.call(font, cp) === true) return true;
    } catch {
      /* fall through to the id test */
    }
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
export const coverageBitsets = new Map<string, Uint8Array | null>();

export function nativeFaceCoversCp(font: FontInstance, cp: number): boolean | null {
  // `DOMOTION_NO_COVERAGE_BITSET=1` makes every caller fall through to its own
  // platform probe. This exists to be TURNED OFF: a purely-performance seam is
  // only answer-neutral if disabling it leaves the answers byte-identical, and
  // an unchanged answer with the seam supposedly live means something
  // intercepted ahead of it. Same reasoning as `DOMOTION_DISABLE_HELPER` /
  // `DOMOTION_SYSTEM_FALLBACK=0`.
  if (process.env.DOMOTION_NO_COVERAGE_BITSET === "1") return null;
  // A file's cmap only stands in for the PLATFORM's coverage answer where the
  // platform's answer is itself a cmap lookup — DirectWrite's `HasCharacter`
  // and fontconfig's charset are, CoreText's is not, and the gap is real
  // rather than theoretical. Measured on a 5M-comparison macOS slice: 364
  // comparisons left agree-exact because the bitset reported Hiragino Sans GB
  // as not covering U+2011 and the chain walked past it to Arial Unicode MS.
  // No member of `Hiragino Sans GB.ttc` maps U+2011 in its cmap (checked, all
  // four) — yet CoreText answers that it covers it, and CHROME PAINTS
  // HiraginoSansGB-W3 for it. So on macOS the file's cmap is not the table
  // that decides the answer, and the probe is the mechanism, not an
  // optimization target.
  if (hostPlatform() === "darwin") return null;
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

export const fontInstanceCache = new Map<string, FontInstance>();

// Webfont registry. Populated per capture by `discoverAndRegisterWebfonts`
// in capture.ts after the page's `document.fonts.ready` resolves. Keys are
// lower-cased family names (matching `resolveFontKey`'s normalization). Each
// family can have multiple registered variants (different weights / italic).
//
// Resolution policy: when the author's font-family stack matches a registered
// family, we pick the variant whose (weight, style) is closest to the request.
// This sidesteps the system-font fallback in `getFontInstance` entirely —
// webfont glyphs come from the loaded buffer, not from disk.
export interface WebfontVariant {
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

export const webfontRegistry = new Map<string, WebfontVariant[]>();

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
 * DEGRADED TIER ONLY, and an approximation — nearest `usWeightClass` with
 * ties-to-lighter is NOT Chrome's rule. Chrome's declared-family selection is
 * `BestStyleMatchForFamilyNS` / `BetterChoiceCT` over AppKit members (tag
 * 147.0.7727.15), whose bold-trait mask makes the Hiragino ladder
 * NON-monotonic in a way no nearest-weight rule can express: CSS 500 opens W5
 * (the exact-weight escape, `font_matcher_mac.mm:186-196`), but 510-590 open
 * W4 — W5 carries the AppKit bold trait and loses on traits before weight
 * distance is compared — and 650 opens W7 over the equally-distant W6 (the
 * further-from-500 tie-break). Measured against Chrome over CDP, 2026-08-08.
 * On an armed host `darwinPrimaryCutKey` runs the ported matcher and its
 * answer replaces this ladder's; this ladder decides only where the matcher
 * cannot run, where it disagrees with Chrome at exactly those intermediate
 * weights.
 *
 * The family ships W0(100) W1(200) W2(250) W3(300) W4(400) W5(500) W6(600)
 * W7(700) W8(800) W9(900); W2 is unreachable from CSS, so the ladder skips it.
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
export function resolveEffectiveCutKey(
  key: string,
  weight: number,
  slant: number,
  stretch: number,
  systemUiPrimary: boolean = false,
  declaredFamily?: string,
  semanticContext: FontFallbackSemanticContext = createFontFallbackSemanticContext(),
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
    if (key === "sf-pro") {
      effectiveKey = "sf-pro-italic";
      routedItalicCut = true;
    } else if (key === "sf-mono") {
      effectiveKey = "sf-mono-italic";
      routedItalicCut = true;
    }
  }
  // Helvetica/Arial/Courier/Menlo/Times/Georgia don't expose a variable wght
  // axis — pick the right sub-font (or sibling file) based on weight × slant.
  // DEGRADED-TIER APPROXIMATION, not Chrome's rule: the 600 boundary is
  // `kBoldThreshold` (`font_selection_types.h:182`, rev 7d859f27), which Blink
  // consults only for the SYNTHETIC-bold predicate (`:212`) and for the
  // desired-bold TRAIT bit (`ComputeDesiredTraits`) — never as a cut selector.
  // Blink's cut selection is the platform matcher, which `darwinPrimaryCutKey`
  // / `linuxPrimaryCutKey` below run whenever the helper is armed; their
  // answer (base face included) REPLACES this split, so it decides only on a
  // host that cannot ask the matcher. Times/Georgia ship four sibling files
  // (regular/bold/italic/bold-italic) for headings + emphasis in serif
  // content (DM-269).
  if (
    key === "helvetica" ||
    key === "helvetica-neue" ||
    key === "arial" ||
    key === "courier" ||
    key === "courier-new" ||
    key === "menlo" ||
    key === "times" ||
    key === "times-new-roman" ||
    key === "georgia" ||
    key === "source-serif-pro" ||
    key === "playfair-display"
  ) {
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
  // few symbol blocks. DEGRADED TIER ONLY: on an armed host the static chain
  // this key belongs to never answers (the live resolver does, and its
  // in-family re-selection is the same CoreText call Blink makes), and a
  // DECLARED "Lucida Grande" resolves through `darwinPrimaryCutKey`, where
  // Chrome's matcher crosses to Bold at 600 like every other declared family
  // (measured over CDP 2026-08-08: declared 450/500 paint LucidaGrande
  // regular). The 450 crossover encoded here is the FALLBACK-cascade
  // behavior — as a fallback face under a weight-450+ run, Chrome's
  // `GetAlternateFontPlatformData` re-selection answers LucidaGrande-Bold
  // (same CDP sweep) — sampled, kept as the helper-less approximation. Only
  // adopted when the host platform actually has the face: the Linux
  // (Liberation Sans) and Windows (Arial) mappings for `lucida-grande` have
  // no bold sibling key, so `resolveFontSpec` returns null there and the
  // regular face stands.
  if (key === "lucida-grande" && weight >= 450 && resolveFontSpec("lucida-grande-bold") != null) {
    effectiveKey = "lucida-grande-bold";
  }
  // PingFang ships separate weight subfonts in PingFang.ttc — Regular for
  // body weight, Medium for semibold+. No italic. Same pattern across all
  // regional variants (SC / TC / HK / MO).
  if (
    (key === "pingfang-sc" || key === "pingfang-tc" || key === "pingfang-hk" || key === "pingfang-mo") &&
    weight >= 600
  ) {
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
  // Bold and synthesizes nothing (`win/font_cache_skia_win.cc:481-489`), and a
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
  const darwinCut = systemUiPrimary ? null : darwinPrimaryCutKey(key, weight, slant, stretch, declaredFamily);
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
  const linuxCut = linuxPrimaryCutKey(key, weight, slant, stretch, semanticContext);
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
 * The shared `sf-pro` key is necessary but not sufficient: `systemUiPrimary`
 * preserves whether the winning CSS family entered through
 * `MatchSystemUIFont`, so explicitly named SF families keep the declared-family
 * cut matcher even though they open the same underlying files.
 */
function darwinSystemUiWdth(effectiveKey: string, stretch: number, systemUiPrimary: boolean): number {
  if (hostPlatform() !== "darwin" || stretch === 100) return 100;
  return isDarwinSystemUiAxisKey(effectiveKey, systemUiPrimary) ? stretch : 100;
}

/** The keys standing for the macOS `system-ui` face — the ONLY faces whose
 *  variation axes Blink drives from CSS values (`MatchSystemUIFont` sets
 *  wght/wdth variations clamped to the axis range,
 *  `mac/font_matcher_mac.mm:540-589`, identical at tag 147.0.7727.15 and rev
 *  7d859f27). Every other darwin key is a declared family or fallback face,
 *  where the weight lives in WHICH face the matcher picked and only `opsz` +
 *  font-variation-settings are applied on top. Shared by the `wdth` gate
 *  (`darwinSystemUiWdth`) and the `wght` gate on the fontkit path. The model
 *  therefore carries the route as the separate `systemUiPrimary`
 *  bit rather than duplicating every SF entry in the platform tables. */
function isDarwinSystemUiAxisKey(effectiveKey: string, systemUiPrimary: boolean): boolean {
  return systemUiPrimary && (effectiveKey === "sf-pro" || effectiveKey === "sf-pro-italic");
}

/** Test-only view of the system-ui `wdth` gate (not in the package barrel). */
export function __darwinSystemUiWdthForTest(effectiveKey: string, stretch: number, systemUiPrimary: boolean): number {
  return darwinSystemUiWdth(effectiveKey, stretch, systemUiPrimary);
}

/** Stable cache identity for one fully resolved font instance request. */
export function fontInstanceCacheKey(
  effectiveKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  systemUiPrimary: boolean,
  declaredFamily: string | undefined,
  wdthStretch: number,
): string {
  const fvsKey =
    variationSettings != null
      ? Object.keys(variationSettings)
          .sort()
          .map((tag) => `${tag}=${variationSettings[tag]}`)
          .join(",")
      : "";
  const sizeSpaceKey =
    variationSettings == null
      ? ""
      : `-logical${logicalFontSize(variationSettings, fontSize)}-optical${opticalSizingDisabled(variationSettings) ? "none" : "auto"}`;
  const familyRoute = systemUiPrimary ? "system-ui" : `declared:${declaredFamily ?? ""}`;
  const widthRoute = wdthStretch !== 100 ? `-wdth${wdthStretch}` : "";
  // Platform-prefixed like every other resolution memo: `effectiveKey` names a
  // different file per host, so a `withHostPlatform` probe must not be served the
  // real host's instance.
  return `${hostPlatform()}|${effectiveKey}-${weight}-${fontSize}-${slant}-${fvsKey}${sizeSpaceKey}-${familyRoute}${widthRoute}`;
}

type RegisteredFontResolution = { handled: false } | { handled: true; instance: FontInstance | null };

/** Resolve registry-backed keys before platform file discovery. */
function resolveRegisteredFontInstance(
  key: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  stretch: number,
): RegisteredFontResolution {
  if (key.startsWith("webfont:")) {
    return {
      handled: true,
      instance: pickWebfontVariant(key.slice("webfont:".length), weight, fontSize, slant, variationSettings, stretch),
    };
  }
  if (key.startsWith("localalias:")) {
    const family = key.slice("localalias:".length);
    const variant = pickLocalFontAliasVariant(family, weight, slant !== 0);
    return {
      handled: true,
      instance:
        variant == null
          ? null
          : getFontInstance(
              variant.baseKey,
              variant.weight,
              fontSize,
              variant.italic ? slant : 0,
              variationSettings,
              stretch,
              false,
            ),
    };
  }
  return { handled: false };
}

/**
 * @param stretch CSS `font-stretch` as a percentage, 100 = `normal`. Reaches the
 *   macOS declared-family style matcher, where Blink turns it into the condensed
 *   / expanded symbolic trait it scores candidates on — and, for the `system-ui`
 *   face and variable webfonts, the variable `wdth` axis (see
 *   `darwinSystemUiWdth` / `applyVariationAxes`).
 */
function instantiateResolvedFont(
  key: string,
  weight: number,
  fontSize: number,
  slant: number = 0,
  variationSettings?: Record<string, number>,
  stretch: number = 100,
  /** True only when the winning CSS family entered Blink through
   *  `MatchSystemUIFont`; named SF families share the key but not this route. */
  systemUiPrimary: boolean = false,
  /** Original author family when a protected SF family shares `sf-pro`. */
  declaredFamily?: string,
  /** Descriptor state used only if the common-Skia terminal is reached. Never
   *  inferred from `declaredFamily`: that parameter identifies a selected SF
   *  route, not the unresolved descriptor stack. */
  semanticContext: FontFallbackSemanticContext = createFontFallbackSemanticContext(),
): FontInstance | null {
  // Webfont keys (`webfont:<lowercased family>`) resolve through the runtime
  // registry rather than the on-disk FONT_PATHS table.
  const registered = resolveRegisteredFontInstance(key, weight, fontSize, slant, variationSettings, stretch);
  if (registered.handled) return registered.instance;
  // `localalias:<family>` — the family was declared via @font-face local() and
  // we tracked one or more declared (weight, italic) variants pointing at base
  // FONT_PATHS keys. Pick the closest declared variant and use ITS weight /
  // italic to drive the sibling-file selection below — NOT the requested
  // weight/italic — so Chrome's "no bold-italic declared → use italic 400"
  // behavior is preserved instead of silently substituting the on-disk
  // bold-italic sibling. DM-360.
  const cut = resolveEffectiveCutKey(key, weight, slant, stretch, systemUiPrimary, declaredFamily, semanticContext);
  const effectiveKey = cut.key;
  const routedItalicCut = cut.routedItalicCut;

  // DM-578: include author-set variation settings in the cache key so two
  // elements requesting the same (key, weight, size, slant) but with different
  // axis overrides don't share a single cached instance.
  // On the DECLARED-family path `effectiveKey` carries the whole stretch
  // decision (it IS the resolved cut). On the macOS `system-ui` face the
  // stretch ALSO drives the variable `wdth` axis (see `darwinSystemUiWdth`), so
  // two stretches on the same key are two different instances and the width
  // needs its own slot.
  const wdthStretch = darwinSystemUiWdth(effectiveKey, stretch, systemUiPrimary);
  const cacheKey = fontInstanceCacheKey(
    effectiveKey,
    weight,
    fontSize,
    slant,
    variationSettings,
    systemUiPrimary,
    declaredFamily,
    wdthStretch,
  );
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
  //      behavior: open the font, see no outlines, fall through to the helper.
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
    const helperFaceInfo =
      hintedSubsetEnabled() || hostPlatform() === "win32" || hostPlatform() === "darwin"
        ? resolveFaceInfoForFile(spec.path, spec.postscriptName)
        : null;
    // The face's own non-default coordinates (macOS): the CoreText handle's
    // observed position (`spec.ctAxes` — covers clone names like
    // `Skia-Regular_Light` whose fvar instances carry no postscriptNameID), or
    // the fvar named instance the PostScript name denotes. Seeded into the
    // darwin axis location so the pinned instance IS the matched face — a
    // CSS-derived `wght` never enters here (Blink's mac path applies only
    // `opsz` + font-variation-settings on top of the matched face,
    // `font_platform_data_mac.mm:113-208`, tag 147.0.7727.15).
    const darwinFaceAxes =
      hostPlatform() === "darwin"
        ? darwinFaceOwnAxes(spec.ctAxes, helperFaceInfo?.instanceAxes, helperFaceInfo?.fileAxes ?? null)
        : null;
    const helperAxes =
      helperFaceInfo?.fileAxes == null
        ? undefined
        : hostPlatform() === "win32"
          ? resolveAxisLocationForFile(
              helperFaceInfo.fileAxes,
              weight,
              fontSize,
              slant,
              variationSettings,
              spec.resolvedAxes,
            )
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
    const hasTrakAndStat = helperFaceInfo != null && faceHasTrakAndStat(spec.path, helperFaceInfo.faceIndex);
    const hbShapeFace =
      _trakHbShapingEnabled && hasTrakAndStat
        ? makeHarfbuzzShapeFallback(
            spec.path,
            helperFaceInfo.faceIndex,
            logicalFontSize(variationSettings, fontSize),
            helperFaceInfo.fileAxes != null
              ? hostPlatform() === "darwin"
                ? // The SAME darwin derivation as `helperAxes` — HarfBuzz opens by
                  // face index and gets the file's DEFAULT instance, and the face's
                  // own coordinates are already seeded into that derivation. Tags
                  // left out sit at the default master, which is exactly where the
                  // matched face's unset axes are. No CSS `wght` pin: the weight
                  // lives in WHICH face the matcher picked.
                  (helperAxes ?? null)
                : resolveAxisLocationForFile(
                    helperFaceInfo.fileAxes,
                    weight,
                    fontSize,
                    slant,
                    variationSettings,
                    spec.resolvedAxes,
                    helperFaceInfo.instanceAxes,
                  )
              : null,
          )
        : undefined;
    const helper = createGlyphHelperFont({
      postscriptName: spec.postscriptName,
      fontPath: spec.path,
      variations: helperAxes,
      fontSizePx: fontSize,
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
      fontShapeRouteMap.set(
        instance as unknown as object,
        hbShapeFace != null
          ? `native-harfbuzz:${helperFaceInfo?.faceIndex ?? "null"}`
          : `native-platform:${_trakHbShapingEnabled ? "enabled" : "disabled"}:${helperFaceInfo?.faceIndex ?? "null"}:${hasTrakAndStat ? "tracked" : "untracked"}`,
      );
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
            composeBase,
            handleAxes,
            fontSize,
            variationSettings,
            helperFaceInfo?.namedInstances,
          );
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
          path: spec.path,
          postscriptName: spec.postscriptName,
          faceIndex,
          nameMatched,
          descriptorAxes: spec.ctAxes == null ? null : spec.ctAxes.map((axis) => ({ ...axis })),
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
          variationAxes:
            fileAxes != null
              ? (helperAxes ??
                (hostPlatform() === "darwin"
                  ? // The darwin derivation already folded the face's own
                    // coordinates in; when it answers undefined the matched face IS
                    // the default master, so pin everything to defaults ({}). The
                    // old fall-through to `resolveAxisLocationForFile` here is what
                    // pinned the CSS weight onto declared variable families —
                    // `font-family: Skia` at ANY CSS weight embedded a subset at
                    // wght = clamp(weight, [0.48..3.2]) = 3.2, the Black master,
                    // while the shaped advances came from the face Chrome paints.
                    {}
                  : resolveAxisLocationForFile(
                      fileAxes,
                      weight,
                      fontSize,
                      slant,
                      variationSettings,
                      spec.resolvedAxes,
                      instanceAxes,
                    )))
              : null,
        });
      }
      fontInstanceCache.set(cacheKey, instance);
      return instance;
    }
  }

  // TTC collections expose .fonts + .getFont(postscriptName). The requested
  // member is picked; the first sub-font stands in if it is missing (defensive
  // against OS font updates renaming members).
  const openedFace = openFontkitFace(spec.path, { postscriptName: spec.postscriptName, faceIndex: spec.faceIndex });
  let font: any = openedFace?.face ?? null;
  // The collection member index feeds hb-subset's hb_face_create.
  const faceIndex = openedFace?.faceIndex ?? 0;
  // Whether `font` is the face `spec.postscriptName` names. False when a
  // collection had no member of that name and member zero stands in — in which
  // case member zero is genuinely what gets shaped, so `faceIndex` stays truthful
  // about the loaded face while `nameMatched: false` records that it is not the
  // requested one. (Contrast the native-helper branch above, where CoreText loads
  // the requested face by name and it is the INDEX that cannot be named — there
  // `faceIndex` becomes null.)
  const nameMatched = openedFace?.nameMatched ?? true;

  const fontkitHasOutlines = font != null && fontHasOutlineTable(font);
  if (helperEligible && !fontkitHasOutlines && isGlyphHelperAvailable()) {
    const helper = createGlyphHelperFont({
      postscriptName: spec.postscriptName,
      fontPath: spec.path,
      fontSizePx: fontSize,
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
  const darwinDeclaredAxisPath = hostPlatform() === "darwin" && !isDarwinSystemUiAxisKey(effectiveKey, systemUiPrimary);
  const fontkitFaceAxes =
    darwinDeclaredAxisPath && font?.variationAxes != null && Object.keys(font.variationAxes).length > 0
      ? darwinFaceOwnAxes(
          spec.ctAxes,
          resolveFaceInfoForFile(spec.path, spec.postscriptName).instanceAxes,
          font.variationAxes,
        )
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
  const linuxInstanceAxes =
    linuxSystemAxisPath && font?.variationAxes != null && Object.keys(font.variationAxes).length > 0
      ? (resolveFaceInfoForFile(spec.path, spec.postscriptName).instanceAxes ?? null)
      : null;
  let instance: FontInstance;
  if (linuxSystemAxisPath) {
    // The named instance the resolved PostScript name denotes, or the file's
    // default master when the matched face IS the base (or the file is
    // static). Mirrors FreeType loading the named instance by index.
    instance = font;
    if (linuxInstanceAxes != null && font.getVariation != null) {
      instance = instantiateVariation(font, linuxInstanceAxes) ?? instance;
    }
  } else {
    instance = applyVariationAxes(
      font,
      weight,
      fontSize,
      slant,
      variationSettings,
      wdthStretch,
      darwinDeclaredAxisPath ? { faceAxes: fontkitFaceAxes, cssWghtPin: false } : undefined,
    );
    // Fontkit keeps SFNS.ttf's default `.SFNS-Regular` PostScript name after
    // `getVariation`, even when the CSS system-ui route has instanced its wght
    // axis at 700. Blink first builds that face through MatchSystemUIFont, and
    // CoreText names the resulting 700 cut `.SFNS-Bold` (other intermediate
    // weights may have coordinate-bearing clone names). Ask the already-ported
    // native route for the identity; keep the fontkit instance and its outlines
    // unchanged. An explicit author variation is applied later in Blink and is
    // not represented by this native UI query, so leave that case unclassified.
    if (
      isDarwinSystemUiAxisKey(effectiveKey, systemUiPrimary) &&
      (variationSettings == null || Object.keys(variationSettings).length === 0)
    ) {
      const uiFace = resolveSystemUiFontFace({ weight, slant, stretch, size: fontSize });
      if (uiFace?.postscriptName != null && uiFace.postscriptName !== instance.postscriptName) {
        instance.instantiatedPostscriptName = uiFace.postscriptName;
      }
    }
    // A declared variable-family cut can be a named instance in a single file.
    // fontkit returns the base master's PostScript name from getVariation(),
    // but Blink/CoreText retain the matched instance identity. The requested
    // spec is source-derived from MatchFontFamily, and `fontkitFaceAxes` proves
    // that name resolved to coordinates in this exact file, so preserve it for
    // the conformance/oracle identity as well as the outlines already selected.
    if (
      darwinDeclaredAxisPath &&
      fontkitFaceAxes != null &&
      spec.postscriptName != null &&
      spec.postscriptName !== font?.postscriptName
    ) {
      instance.instantiatedPostscriptName = spec.postscriptName;
    }
  }
  // DM-1693: expose the static face's natural weight + whether a variable wght
  // axis was applied, so both render modes can decide faux-bold. Read from
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
  // `hasWeightAxis` records whether a wght coordinate was pushed from the
  // CSS-VALUED request, as opposed to a declared family's own face/named-
  // instance coordinates (which are not CSS-comparable — see the DM-2023
  // block below) or no axis push at all. On the darwin declared path the wght
  // axis is never CSS-driven (the weight lives in WHICH face the matcher
  // picked), and on the Linux system path there is no CSS-driven axis either
  // (the fontconfig-matched named instance is the face) — so the flag is only
  // true when the CSS pin actually drove the axis. Read below to correct
  // `naturalWeight` / `faceIsBoldTrait` to the instantiated position, and by
  // the Linux-system-font-axes test to pin that the Linux path never sets it.
  instance.hasWeightAxis = font?.variationAxes?.wght != null && !darwinDeclaredAxisPath && !linuxSystemAxisPath;
  // The face's BOLD trait, which the macOS and Windows synthetic-bold rules
  // both test. Read from the ORIGINAL fontkit Font for the same reason the
  // weight fields above are: a variation instance's OS/2 reflects the base face.
  const fsSelection = font?.["OS/2"]?.fsSelection;
  if (fsSelection != null) {
    // fontkit may expose fsSelection as a parsed bitfield object or as a raw
    // number depending on version; accept either rather than assuming.
    instance.faceIsBoldTrait = typeof fsSelection === "number" ? (fsSelection & 0x20) !== 0 : fsSelection.bold === true;
    // Bit 0 (mask 0x01) is ITALIC, the same OpenType fsSelection field bold
    // reads bit 5 from — see `FontInstance.faceIsItalicTrait`.
    instance.faceIsItalicTrait =
      typeof fsSelection === "number" ? (fsSelection & 0x01) !== 0 : fsSelection.italic === true;
  }
  // DM-2017: fontconfig's own is_bold/is_italic classification of a Linux
  // live-fallback pick, copied from the spec onto the instance so
  // `faceNeedsSyntheticBold` / `faceNeedsSyntheticOblique` can apply Blink's
  // fallback-specific binary rule. Deliberately independent of the
  // `faceIsBoldTrait` OS/2 read just above — see `FontInstance
  // .linuxFallbackIsBold` for why the two must not be conflated. Undefined for
  // every spec but a Linux `fcfallback` pick, so this never affects a declared
  // family or another platform.
  if (spec.linuxFallbackIsBold != null) instance.linuxFallbackIsBold = spec.linuxFallbackIsBold;
  if (spec.linuxFallbackIsItalic != null) instance.linuxFallbackIsItalic = spec.linuxFallbackIsItalic;
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
      // Same override, for `kCTFontTraitItalic` — the bit
      // `faceNeedsSyntheticOblique`'s macOS branch tests
      // (`mac/font_cache_mac.mm:431-436`, rev 7d859f27).
      const ctItalicTrait = resolveFaceTraitItalic(ps, resolveFontSpec(key)?.path);
      if (ctItalicTrait != null) instance.faceIsItalicTrait = ctItalicTrait;
    }
  }
  // DM-2023: everything set above describes the DEFAULT instance, because it
  // is read from the ORIGINAL fontkit `font` (its OS/2 table, and — on darwin
  // — a CoreText query keyed by the face's un-instanced PostScript name).
  // Chrome has no equivalent gap: `typeface->fontStyle().weight()` and
  // `kCTFontTraitBold` both describe the typeface Blink actually painted, i.e.
  // the INSTANTIATED one.
  //
  // `hasWeightAxis` (just above) already identifies exactly the case where a
  // wght coordinate was pushed from the CSS-VALUED request — macOS
  // `system-ui`, or the general (non-darwin-declared, non-Linux-system) path
  // most platforms take — as opposed to a declared family's own face/named-
  // instance coordinates, which are NOT CSS-comparable (`Skia`'s wght axis is
  // QuickDraw units `[0.48..3.2]`; pushing 1.95 into a CSS-weight field would
  // corrupt it). Gate the correction on that same condition: only then is
  // `_appliedVariationAxes.wght` — the exact coordinate `applyVariationAxes`
  // instanced — a CSS-weight number, and only then does it get to overrule the
  // base-face reads above. naturalWeight becomes the instantiated coordinate,
  // and faceIsBoldTrait is recomputed from it with the same threshold
  // `faceNeedsSyntheticBold`'s own fallback already uses (`>= 600`) — the base
  // face's OS/2 bit / CoreText trait is not a fact about this position, so it
  // must not survive past it unexamined. (`getVariation` never rewrites OS/2
  // or the PostScript name to match the instanced coordinates, which is the
  // reporting gap itself: measured pre-fix, `sf-pro` instanced at 400/700/900
  // all read `naturalWeight: 400, faceIsBoldTrait: false`, the unchanged
  // default.)
  if (instance.hasWeightAxis === true) {
    const appliedWght = (instance as unknown as { _appliedVariationAxes?: Record<string, number> })
      ._appliedVariationAxes?.wght;
    if (typeof appliedWght === "number" && appliedWght >= 1 && appliedWght <= 1000) {
      instance.naturalWeight = appliedWght;
      instance.faceIsBoldTrait = appliedWght >= 600;
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
      spec.path,
      faceIndex,
      fontSize,
      fileIsVariable ? (appliedAxes ?? null) : null,
    );
  }
  fontSourceMap.set(instance as unknown as object, {
    path: spec.path,
    postscriptName: spec.postscriptName,
    faceIndex,
    nameMatched,
    variationAxes: fileIsVariable ? (appliedAxes ?? {}) : null,
    descriptorAxes: spec.ctAxes == null ? null : spec.ctAxes.map((axis) => ({ ...axis })),
  });
  fontInstanceCache.set(cacheKey, instance);
  return instance;
}

/** Public key-to-instance coordinator; platform dispatch lives in the stage above. */
export function getFontInstance(
  key: string,
  weight: number,
  fontSize: number,
  slant: number = 0,
  variationSettings?: Record<string, number>,
  stretch: number = 100,
  systemUiPrimary: boolean = false,
  declaredFamily?: string,
  semanticContext: FontFallbackSemanticContext = createFontFallbackSemanticContext(),
): FontInstance | null {
  return instantiateResolvedFont(
    key,
    weight,
    fontSize,
    slant,
    variationSettings,
    stretch,
    systemUiPrimary,
    declaredFamily,
    semanticContext,
  );
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
  /** Full axis dictionary observed on the live CoreText handle before any
   * physical-member reopening. */
  descriptorAxes?: DarwinHandleAxis[] | null;
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
export function fontHasOutlineTable(
  font: { directory?: { tables?: Record<string, unknown> } } | null | undefined,
): boolean {
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
export const fontSourceMap = new WeakMap<object, FontSourceInfo>();

const fontShapeRouteMap = new WeakMap<object, string>();

/** Test-only diagnostic for native-helper shaping dispatch. */
export function __fontShapeRouteForTest(font: FontInstance | null): string | null {
  return font == null ? null : (fontShapeRouteMap.get(font as unknown as object) ?? null);
}

/** Keep source bookkeeping for the default-on hinted-subset path. The explicit
 *  `0` arm is the svg2ttf control/escape hatch; all unsafe individual entries
 *  are rejected by embedded-font-builder and fall back there. */
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
function enumerateNamedInstances(
  member: any,
): Array<{ postscriptName: string; coords: Record<string, number> }> | null {
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
  path: string,
  postscriptName?: string,
  variations?: Record<string, number>,
):
  | ((
      text: string,
      direction?: "ltr" | "rtl",
      features?: string[],
      script?: string,
      language?: string,
    ) => {
      ids: number[];
      positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
      clusters: number[];
    } | null)
  | undefined {
  if (path === "") return undefined;
  let font: any | null | undefined; // undefined = not yet opened, null = unopenable
  const open = (): any | null => {
    if (font !== undefined) return font;
    // TTC: the requested member, exactly as `getFontInstance` selects it.
    font = openFontkitFace(path, { postscriptName, variations })?.face ?? null;
    return font;
  };
  return (text: string, direction?: "ltr" | "rtl", features?: string[], script?: string, language?: string) => {
    const f = open();
    if (f?.layout == null) return null;
    // Direction passed through explicitly when the caller knows it (a
    // single-script segment), the way Blink hands it to HarfBuzz rather than
    // letting content inference decide.
    // DM-2656: Windows delegates shaping to this fontkit view because its
    // DirectWrite helper has no shape query. Preserve the renderer's exact
    // OpenType request here; otherwise metadata can correctly suppress
    // synthetic small caps while shaping still silently drops smcp/c2sc.
    const run: any = f.layout(text, features, script, language, direction);
    const glyphs: any[] = run?.glyphs ?? [];
    const positions: any[] = run?.positions ?? [];
    if (glyphs.length === 0 || glyphs.length !== positions.length) return null;
    return {
      ids: glyphs.map((g) => g.id as number),
      positions: positions.map((p) => ({
        xAdvance: p.xAdvance ?? 0,
        yAdvance: p.yAdvance ?? 0,
        xOffset: p.xOffset ?? 0,
        yOffset: p.yOffset ?? 0,
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

export const fileFaceInfoCache = new Map<string, FileFaceInfo>();

function openFontkitFileRecovering(path: string): any {
  return retrySync(() => fontkit.openSync(path), { shouldRetry: isTransientFsError });
}

/** The fontkit face object as far as this module reads it. The library's own
 *  typings do not cover collections or variation, so this is the one place the
 *  untyped boundary is named; callers below see this shape instead of `any`. */
interface FontkitFace {
  postscriptName?: string;
  familyName?: string;
  glyphForCodePoint?: (cp: number) => unknown;
  getVariation?: (axes: Record<string, number>) => FontkitFace | undefined;
  [key: string]: unknown;
}

interface OpenedFontkitFace {
  face: FontkitFace;
  /** Member index within a collection (0 for a single-face file). */
  faceIndex: number;
  /** False when the requested PostScript name was absent and member zero stands in. */
  nameMatched: boolean;
  /** The opened container, for callers that must look at sibling members. */
  container: any;
}

/**
 * Open `path` with fontkit and select one face, with the EMFILE/ENFILE/EAGAIN
 * back-off, or null when the file is unopenable for a lasting reason.
 *
 * Member selection is the one `getFontInstance` has always used: an explicit
 * in-range `faceIndex` wins, else the member named `postscriptName`, else member
 * zero. `variations`, when non-empty, instance the chosen face (a failed or
 * empty instancing keeps the base face).
 */
export function openFontkitFace(
  path: string,
  options: { postscriptName?: string; faceIndex?: number; variations?: Record<string, number> } = {},
): OpenedFontkitFace | null {
  let container: any;
  try {
    container = openFontkitFileRecovering(path);
  } catch {
    return null;
  }
  if (container == null) return null;
  let face: any = container;
  let faceIndex = 0;
  let nameMatched = true;
  const { postscriptName, faceIndex: requested } = options;
  if (Array.isArray(container.fonts)) {
    face =
      requested != null && requested >= 0 && requested < container.fonts.length
        ? container.fonts[requested]
        : postscriptName != null && container.getFont != null
          ? (container.getFont(postscriptName) ?? container.fonts[0])
          : container.fonts[0];
    // Match by postscriptName, NOT object identity: fontkit's getFont() returns
    // a NEW object, so indexOf() is always -1 (which once silently subset
    // member 0 of NotoSansArmenian.ttc, the BLACK weight).
    const ps = face?.postscriptName;
    const idx = ps != null ? container.fonts.findIndex((m: any) => m?.postscriptName === ps) : -1;
    faceIndex = idx >= 0 ? idx : 0;
    if (requested == null && postscriptName != null && ps !== postscriptName) nameMatched = false;
  } else if (
    postscriptName != null &&
    container.postscriptName != null &&
    container.postscriptName !== postscriptName
  ) {
    nameMatched = false;
  }
  if (face == null) return null;
  const { variations } = options;
  if (variations != null && Object.keys(variations).length > 0 && face.getVariation != null) {
    try {
      face = face.getVariation(variations) ?? face;
    } catch {
      /* keep the base face */
    }
  }
  return { face: face as FontkitFace, faceIndex, nameMatched, container };
}

/** The `FileFaceInfo` describing one physical face (a collection member or a whole single-face file). */
function describeFileFace(member: any, faceIndex: number, extra: Partial<FileFaceInfo> = {}): FileFaceInfo {
  const axes = member?.variationAxes;
  return {
    faceIndex,
    nameMatched: true,
    fileAxes: axes != null && Object.keys(axes).length > 0 ? axes : null,
    ...extra,
    namedInstances: enumerateNamedInstances(member),
    memberPostscriptName: member?.postscriptName ?? null,
  };
}

export function resolveFaceInfoForFile(
  path: string,
  postscriptName?: string,
  preferredFaceIndex?: number,
): FileFaceInfo {
  const cacheKey = `${path}#${postscriptName ?? ""}#${preferredFaceIndex ?? ""}`;
  const cached = fileFaceInfoCache.get(cacheKey);
  if (cached != null) return cached;
  let result: FileFaceInfo = { faceIndex: 0, nameMatched: true, fileAxes: null };
  try {
    // Not `openFontkitFace`: that swallows an open failure into null, and this resolver must tell an
    // unreadable file (not cached, see the catch below) from a readable one that lacks the name.
    const opened: any = openFontkitFileRecovering(path);
    if (opened?.fonts != null && Array.isArray(opened.fonts)) {
      if (preferredFaceIndex != null && preferredFaceIndex >= 0 && preferredFaceIndex < opened.fonts.length) {
        result = describeFileFace(opened.fonts[preferredFaceIndex], preferredFaceIndex);
      } else {
        // Match by postscriptName — getFont() returns a NEW object, so indexOf()
        // is always -1 (see the same fix in getFontInstance).
        const idx =
          postscriptName != null ? opened.fonts.findIndex((m: any) => m?.postscriptName === postscriptName) : -1;
        if (idx >= 0) {
          result = describeFileFace(opened.fonts[idx], idx);
        } else if (postscriptName == null) {
          // No name to match: member zero IS the request, so index 0 is honest.
          result = describeFileFace(opened.fonts[0], 0);
        } else {
          // Not a physical member. Before giving up, check whether it is an fvar
          // NAMED INSTANCE of one — the usual shape for a CoreText-resolved face,
          // and resolvable to a real member index plus exact axis coordinates.
          let found: FileFaceInfo | null = null;
          for (let i = 0; i < opened.fonts.length; i++) {
            const instanceAxes = findNamedInstanceAxes(opened.fonts[i], postscriptName);
            if (instanceAxes == null) continue;
            found = describeFileFace(opened.fonts[i], i, { instanceAxes });
            break;
          }
          // Neither a member nor a named instance of one. Member zero is a
          // DIFFERENT face, so neither its index nor its variation axes describe
          // what the caller asked for — say "unknown" rather than reporting member
          // zero's as though they were the requested face's. A caller needing an
          // index then fails loudly instead of silently subsetting member zero.
          result = found ?? { faceIndex: null, nameMatched: false, fileAxes: null };
        }
      }
    } else {
      // Not a collection: index 0 is the file's only face. It may still not be
      // the requested name (a relocated / stub file), which callers can see.
      const psName = opened?.postscriptName;
      // A single-file VARIABLE font's named instances are ordinary requests
      // too — `Lexend-Medium` is an fvar instance of Lexend-Regular's file,
      // and the platform loads it by name at wght 500. Resolving it here (the
      // same lookup the collection branch already performs per member) is what
      // lets the axis location pin the INSTANCE's coordinates instead of
      // re-deriving a location from CSS that only coincides when the request
      // equals the cut's weight.
      const instanceAxes =
        postscriptName != null && psName !== postscriptName ? findNamedInstanceAxes(opened, postscriptName) : null;
      result = describeFileFace(opened, 0, {
        nameMatched: postscriptName == null || psName == null || psName === postscriptName || instanceAxes != null,
        ...(instanceAxes != null ? { instanceAxes } : {}),
      });
    }
  } catch {
    // Unreadable does not mean "member zero". It means no member identity was
    // established, and it may be transient resource pressure. Do not cache the
    // failure: a later request must be able to reopen and recover the named
    // instance rather than inheriting a fabricated face index for the process.
    return { faceIndex: null, nameMatched: false, fileAxes: null };
  }
  fileFaceInfoCache.set(cacheKey, result);
  return result;
}

/** Test-only view of the member-index resolver (not part of the package's public
 *  barrel), so the honest-reporting contract can be pinned against synthetic
 *  collections instead of whichever fonts a given host happens to ship. */
export function __resolveFaceInfoForFileForTest(
  path: string,
  postscriptName?: string,
  preferredFaceIndex?: number,
): FileFaceInfo {
  return resolveFaceInfoForFile(path, postscriptName, preferredFaceIndex);
}

/** Test-only dynamic-font registration (not part of the package's public
 *  barrel): lets a platform-gated test point a `sysfb:`-style key at a font
 *  file it wrote itself — e.g. a variable TTF on a Linux host whose system
 *  inventory ships none — and then drive the real `getFontInstance` path. */
export function __registerDynamicSystemFontForTest(key: string, path: string, postscriptName: string): void {
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
  const info = resolveFaceInfoForFile(path, spec?.postscriptName, spec?.faceIndex);
  // The SAME derivation the native outline path uses (see `getFontInstance`'s
  // `variationAxes`), deliberately not a second one: the shaper and the outlines
  // have to agree about which master they are on, and two parallel derivations
  // that happen to coincide today is exactly the shape of bug this area keeps
  // producing. `fileAxes` is null when the requested name is not a physical
  // member, and then no location is derived from a face nobody asked for.
  const axes =
    info.fileAxes != null
      ? hostPlatform() === "linux"
        ? // The Linux system-font derivation: Blink applies NO variation
          // coordinates there (`skia/font_cache_skia.cc:299-358` builds the
          // FontPlatformData straight from the fontconfig-matched typeface), so
          // the shaper sits on the named instance the resolved PostScript name
          // denotes — or the default master — exactly like the outline path.
          info.instanceAxes != null
          ? { ...info.instanceAxes }
          : null
        : weight == null || fontSize == null
          ? null
          : hostPlatform() === "darwin" && !isDarwinSystemUiAxisKey(fontKey, false)
            ? // The darwin declared/fallback derivation — the face's own coordinates
              // plus the opsz/font-variation-settings clone pins, never a CSS-valued
              // `wght`. Must stay the same derivation `getFontInstance` uses (that is
              // this function's contract), which no longer CSS-pins wght on macOS.
              (resolveDarwinAxisLocation(
                info.fileAxes,
                fontSize,
                variationSettings,
                darwinFaceOwnAxes(spec?.ctAxes, info.instanceAxes, info.fileAxes),
              ) ?? null)
            : resolveAxisLocationForFile(
                info.fileAxes,
                weight,
                fontSize,
                slant ?? 0,
                variationSettings,
                spec?.resolvedAxes,
                info.instanceAxes,
              )
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
function opticalSizingDisabled(settings: Record<string, number> | undefined): boolean {
  return (
    (settings as (Record<string, number> & { __dmOpticalSizingNone?: boolean }) | undefined)?.__dmOpticalSizingNone ===
      true && settings?.opsz == null
  );
}

type FontSizeSpaceSettings = Record<string, number> & {
  __dmLogicalFontSize?: number;
  __dmComputedFontSize?: number;
};

export function logicalFontSize(settings: Record<string, number> | undefined, fallback: number): number {
  return (settings as FontSizeSpaceSettings | undefined)?.__dmLogicalFontSize ?? fallback;
}

export function computedFontSize(settings: Record<string, number> | undefined, fallback: number): number {
  return (settings as FontSizeSpaceSettings | undefined)?.__dmComputedFontSize ?? fallback;
}

export function resolveAxisLocationForFile( // exported for unit testing (not in the package barrel)
  fileAxes: Record<string, unknown>,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings?: Record<string, number>,
  resolvedAxes?: Record<string, number>,
  instanceAxes?: Record<string, number> | null,
): Record<string, number> {
  const axes: Record<string, number> = {};
  if (fileAxes.wght != null) axes.wght = weight;
  if (fileAxes.opsz != null && !opticalSizingDisabled(variationSettings))
    axes.opsz = logicalFontSize(variationSettings, fontSize);
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
      if (tag === "slnt") continue; // CSS italic drives slant per run
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
  fileAxes: Record<string, unknown>,
  fontSize: number,
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
  // RECORDED DIVERGENCE, inert at every current input: `fontSize` here is the
  // captured COMPUTED size, while Blink passes the SPECIFIED size — its
  // `coordinate.value = SkFloatToScalar(specified_size)` with the comment "Do
  // not use font size here, but specified size in order to account for zoom"
  // (`font_platform_data_mac.mm:169-177`, rev 7d859f27). The two differ only
  // under CSS zoom, which Domotion neither captures nor models (capture runs
  // at zoom 1 and the tree carries no pre-zoom size), so no current input can
  // distinguish them. If zoom ever becomes a capture input, the pre-zoom
  // specified size must be plumbed to here.
  if (fileAxes.opsz != null && !opticalSizingDisabled(variationSettings))
    axes.opsz = logicalFontSize(variationSettings, fontSize);
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
export interface DarwinHandleAxis {
  tag: string;
  min: number;
  def: number;
  max: number;
  value: number;
}

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
    const opticalSize = logicalFontSize(variationSettings, fontSize);
    if (
      a.tag === "opsz" &&
      !opticalSizingDisabled(variationSettings) &&
      fixed(clampTo(opticalSize, a)) !== fixed(a.value)
    ) {
      v = opticalSize;
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
      if (
        loc.every(({ tag, q }) => {
          const c = inst.coords[tag];
          return typeof c === "number" && fixed(c) === q;
        })
      )
        return inst.postscriptName;
    }
  }
  if (loc.every(({ q, qDef }) => q === qDef)) return basePostscriptName;
  return (
    basePostscriptName +
    loc.map(({ tag, q, qDef }) => `_${tag}${q === qDef ? "" : q.toString(16).toUpperCase()}`).join("")
  );
}

// The substituted handle's axis state, recorded when the live CoreText resolver
// answers (the only moment it is observable), keyed the way the instance cache
// is keyed — the same (key, weight, size, slant) that will later materialize the
// instance. Two stacks CAN reach one face with different handle states (the
// 13 px italic system-ui cascade hands back `.CJKSymbolsFallbackSC-Regular`
// with a pre-set opsz where the upright one does not), which is exactly why
// this cannot live on the size-independent `sysfb:` spec.
export const darwinHandleAxesMap = new Map<string, DarwinHandleAxis[]>();

const darwinHandleAxesKey = (key: string, weight: number, fontSize: number, slant: number): string =>
  `${key}|${weight}|${fontSize}|${slant}`;

export function registerDarwinHandleAxes(
  key: string,
  weight: number,
  fontSize: number,
  slant: number,
  axes: DarwinHandleAxis[],
): void {
  const k = darwinHandleAxesKey(key, weight, fontSize, slant);
  if (!darwinHandleAxesMap.has(k)) darwinHandleAxesMap.set(k, axes);
}

function darwinHandleAxesFor(
  key: string,
  weight: number,
  fontSize: number,
  slant: number,
): DarwinHandleAxis[] | undefined {
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

export const helperFontCache = new Map<string, FontInstance | null>();
// path → helper instance | null

export type GlyphCommandDisposition =
  | "source-outline"
  | "helper-outline"
  | "legitimately-inkless"
  | "missing-glyph"
  | "unclassified-empty-glyph"
  | "helper-unavailable"
  | "source-unavailable"
  | "helper-font-unopenable"
  | "helper-glyph-unavailable";

export interface GlyphCommandResolution {
  commands: PathCommand[];
  disposition: GlyphCommandDisposition;
}

interface HelperOutlineResolution {
  commands: PathCommand[];
  disposition: "helper-outline" | "helper-font-unopenable" | "helper-glyph-unavailable";
}

export const helperOutlineCache = new Map<string, HelperOutlineResolution>();
// `${source identity}#${id}` → classified result

export type CoreTextDesignOutlineEligibility =
  | "eligible"
  | "not-darwin"
  | "source-unavailable"
  | "static-source"
  | "face-index-unknown"
  | "face-name-unmatched"
  | "face-reopen-unaddressable";

/**
 * Classify the deliberately narrow non-empty-outline route to CoreText.
 *
 * Pinned Skia constructs macOS data-backed typefaces through
 * `SkTypeface_Mac::MakeFromStream`, then creates paths from the resulting
 * CoreText face (`SkFontMgr_mac_ct.cpp:485-507`,
 * `SkTypeface_mac_ct.cpp:1279-1325`, and
 * `SkScalerContext_mac_ct.cpp:621-675`, Skia 62efacd3). Only an authenticated
 * physical variable-face instance is equivalent to that handoff. Static
 * sources retain fontkit, while webfonts/unmatched collection members have no
 * exact file/face/axis identity to reopen and therefore remain ineligible.
 */
export function coreTextDesignOutlineEligibility(
  source: FontSourceInfo | null | undefined,
  platform: NodeJS.Platform = hostPlatform(),
): CoreTextDesignOutlineEligibility {
  if (platform !== "darwin") return "not-darwin";
  if (source == null) return "source-unavailable";
  if (source.variationAxes == null) return "static-source";
  if (source.faceIndex == null) return "face-index-unknown";
  if (!source.nameMatched) return "face-name-unmatched";
  // The helper addresses a collection member by PostScript name. With no
  // name it can only reopen the file's first member, so a known nonzero member
  // is still not an exact reopen target.
  if (source.faceIndex !== 0 && source.postscriptName == null) return "face-reopen-unaddressable";
  return "eligible";
}

function helperOutlineSourceIdentity(source: FontSourceInfo): string {
  const axes =
    source.variationAxes == null
      ? null
      : Object.fromEntries(Object.entries(source.variationAxes).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify({
    path: source.path,
    postscriptName: source.postscriptName ?? null,
    faceIndex: source.faceIndex,
    axes,
  });
}

// A glyph is worth probing the helper for only if at least one source codepoint
// is plausibly inkable. Keep UNKNOWN separate from genuinely inkless: both
// avoid an invented helper lookup, but only the latter is source-owned empty
// paint. Collapsing them was the partial-output hole DM-2399 closes.
function glyphInkExpectation(glyph: { codePoints?: number[] }): "inkable" | "inkless" | "unknown" {
  const cps = glyph.codePoints;
  if (cps == null || cps.length === 0) return "unknown";
  return cps.every((cp) => isLegitimatelyInklessCodepoint(cp)) ? "inkless" : "inkable";
}

export interface EmptyGlyphOutlineEvidence {
  glyphPresent: boolean;
  glyphId: number;
  codePoints?: number[];
  helperAvailable: boolean;
  /** Undefined until the selected instance has been resolved back to a file. */
  sourceAvailable?: boolean;
  /** Undefined until the native helper has been asked for this gid. */
  helperResult?: "outline" | "font-unopenable" | "glyph-unavailable";
}

/** Pure classification table for the empty-outline branch. Production uses
 * the `probe-helper` result to perform the next source-backed probe; tests pin
 * every terminal row without depending on one host's installed helpers/fonts. */
export function classifyEmptyGlyphOutline(
  evidence: EmptyGlyphOutlineEvidence,
): GlyphCommandDisposition | "probe-helper" {
  if (!evidence.glyphPresent || evidence.glyphId === 0) return "missing-glyph";
  const expectation = glyphInkExpectation({ codePoints: evidence.codePoints });
  if (expectation === "inkless") return "legitimately-inkless";
  if (expectation === "unknown") return "unclassified-empty-glyph";
  if (!evidence.helperAvailable) return "helper-unavailable";
  if (evidence.sourceAvailable === false) return "source-unavailable";
  if (evidence.sourceAvailable !== true || evidence.helperResult == null) return "probe-helper";
  if (evidence.helperResult === "outline") return "helper-outline";
  return evidence.helperResult === "font-unopenable" ? "helper-font-unopenable" : "helper-glyph-unavailable";
}

/** Fetch glyph `glyphId`'s outline from the native helper opening the exact
 * selected file/face/variation tuple. The cache preserves whether the face
 * could not be opened or the selected glyph produced no path; those are
 * distinct degraded facts. */
function helperGlyphOutline(source: FontSourceInfo, glyphId: number): HelperOutlineResolution {
  const sourceIdentity = helperOutlineSourceIdentity(source);
  const cacheKey = `${sourceIdentity}#${glyphId}`;
  const cached = helperOutlineCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let helper = helperFontCache.get(sourceIdentity);
  if (helper === undefined) {
    helper =
      (createGlyphHelperFont({
        postscriptName: source.postscriptName,
        fontPath: source.path,
        variations: source.variationAxes ?? undefined,
      }) as unknown as FontInstance) ?? null;
    helperFontCache.set(sourceIdentity, helper);
  }

  let result: HelperOutlineResolution;
  if (helper == null) {
    result = { commands: [], disposition: "helper-font-unopenable" };
  } else {
    try {
      const g = (helper as unknown as NonNullable<ReturnType<typeof createGlyphHelperFont>>).getGlyph(glyphId);
      const commands: PathCommand[] = g?.path?.commands ?? [];
      result =
        commands.length > 0
          ? { commands, disposition: "helper-outline" }
          : { commands: [], disposition: "helper-glyph-unavailable" };
    } catch {
      result = { commands: [], disposition: "helper-glyph-unavailable" };
    }
  }
  helperOutlineCache.set(cacheKey, result);
  return result;
}

/**
 * Resolve the concrete outline representation for one already-shaped glyph.
 *
 * Blink has already selected the face/gid at this point. Skia either requests
 * that face's path, retains only metrics for a raster-owned glyph, or paints no
 * ink for a genuine empty. A consumer-side CSS-family retry is not one of those
 * outcomes. Keep every empty reason explicit so callers can preserve successful
 * source spans and terminate an unavailable outline at a documented degraded
 * boundary instead of silently presenting a partial run as complete.
 */
export function resolveGlyphCommands(
  glyph: FontkitGlyph | null | undefined,
  fontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  /** Source-derived codepoints for this shaped cluster. fontkit memoizes Glyph
   * objects by gid, so `glyph.codePoints` is only a fallback when the emitter
   * cannot map the glyph back to source text. */
  sourceCodePoints?: number[],
  /** The exact selected run instance. Supplying it avoids re-resolving a
   * variable face without the run's complete variation settings and is
   * required for the bounded macOS CoreText outline route. */
  selectedFont?: FontInstance,
): GlyphCommandResolution {
  const cmds: PathCommand[] = glyph?.path?.commands ?? [];
  const helperAvailable = isGlyphHelperAvailable();
  const codePoints = sourceCodePoints ?? glyph?.codePoints;
  const expectation = glyphInkExpectation({ codePoints });

  // Preserve source-owned empty outcomes before considering a native outline.
  // A space in a variable face is still genuinely inkless, not a helper error.
  if (cmds.length === 0) {
    if (glyph == null || glyph.id === 0) return { commands: [], disposition: "missing-glyph" };
    if (expectation === "inkless") return { commands: [], disposition: "legitimately-inkless" };
    if (expectation === "unknown") return { commands: [], disposition: "unclassified-empty-glyph" };
  }

  const selectedSource = selectedFont == null ? undefined : fontSourceMap.get(selectedFont as unknown as object);
  if (selectedSource != null && coreTextDesignOutlineEligibility(selectedSource) === "eligible") {
    // Once this exact variable instance is known to belong to CoreText, a
    // missing helper cannot truthfully fall back to fontkit's different path.
    if (!helperAvailable) return { commands: [], disposition: "helper-unavailable" };
    return helperGlyphOutline(selectedSource, glyph!.id);
  }

  if (cmds.length > 0) return { commands: cmds, disposition: "source-outline" };
  const initial = classifyEmptyGlyphOutline({
    glyphPresent: glyph != null,
    glyphId: glyph?.id ?? 0,
    codePoints,
    helperAvailable,
  });
  if (initial !== "probe-helper") return { commands: [], disposition: initial };
  // Re-resolve the instance (cache hit) to read the exact file fontkit loaded.
  // variationSettings don't affect the file path, so they're omitted here.
  const inst = selectedFont ?? getFontInstance(fontKey, weight, fontSize, slant);
  const src = inst != null ? fontSourceMap.get(inst as unknown as object) : undefined;
  if (src == null) {
    return {
      commands: [],
      disposition: classifyEmptyGlyphOutline({
        glyphPresent: true,
        glyphId: glyph!.id,
        codePoints: sourceCodePoints ?? glyph!.codePoints,
        helperAvailable,
        sourceAvailable: false,
      }) as GlyphCommandDisposition,
    };
  }
  return helperGlyphOutline(src, glyph!.id);
}

/** Backward-compatible command-only projection used outside the ownership-aware
 * text emitter. New routing code must consume `resolveGlyphCommands` instead. */
export function commandsFor(
  glyph: FontkitGlyph | null | undefined,
  fontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  selectedFont?: FontInstance,
): PathCommand[] {
  return resolveGlyphCommands(glyph, fontKey, weight, fontSize, slant, undefined, selectedFont).commands;
}

/** Test-only: clear the per-glyph fallback caches (helper instances + outlines). */
export function __clearGlyphFallbackCachesForTest(): void {
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
export function applyVariationAxes(
  font: any,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings?: Record<string, number>,
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
    axes.wght =
      wghtCaps != null
        ? // Declared `font-weight` descriptor: the request clamps into the
          // DESCRIPTOR range first (`selection_capabilities.weight.clampToRange`,
          // `font_custom_platform_data.cc:136-139`) — which is what pins a
          // `font-weight: 700` face at wght 700 regardless of the run's request.
          // The raw axis-range clamp still applies at instancing (Skia's `SkTPin`
          // on Chrome's side, `clampAxesToFvarRange` + the instancer on ours).
          Math.min(Math.max(q(weight), q(wghtCaps[0])), q(wghtCaps[1]))
        : webfontClamps
          ? // `FontCustomPlatformData::GetFontPlatformData`'s auto-weight branch
            // (`font_custom_platform_data.cc:141-154`): the request clamped into the
            // QUANTIZED axis range.
            Math.min(
              Math.max(q(weight), q(font.variationAxes.wght.min ?? weight)),
              q(font.variationAxes.wght.max ?? weight),
            )
          : weight;
  }
  if (font.variationAxes.opsz != null && !opticalSizingDisabled(variationSettings))
    axes.opsz = logicalFontSize(variationSettings, fontSize);
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
      axes.wdth = Math.min(
        Math.max(q(stretch), q(font.variationAxes.wdth.min ?? stretch)),
        q(font.variationAxes.wdth.max ?? stretch),
      );
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
  return instantiateVariation(font, axes) ?? font;
}

/**
 * The variation instance of `font` at `axes`, or null when the instance cannot be used and the caller
 * should keep the base face. Shared by the CSS-driven path (`applyVariationAxes`) and the Linux named-
 * instance path, which used to carry the same three steps separately:
 *
 * - `getVariation` may throw for an axis set fontkit rejects;
 * - fontkit's WOFF2 variation path returns an instance whose internal stream does not expose the parent's
 *   tables, so reading `unitsPerEm` / `layout(...)` throws "Cannot read properties of undefined" — probe
 *   for that and refuse the instance;
 * - the axis location the instance was created at is recorded (clamped to the fvar range, so byte-
 *   identical out-of-range instances share one embedded entry) so the hinting-preserving embedded subset
 *   can pin the SAME location when it instances the source file with hb-subset.
 */
// `font` is `any` at the fontkit boundary, like every other reader of `getVariation` / `variationAxes` here.
function instantiateVariation(font: any, axes: Record<string, number>): FontInstance | null {
  let instance: FontInstance;
  try {
    instance = font.getVariation!({ ...axes });
    if ((instance as any).unitsPerEm == null) return null;
  } catch {
    return null;
  }
  (instance as any)._appliedVariationAxes = clampAxesToFvarRange({ ...axes }, font.variationAxes ?? {});
  return instance;
}

/** The family-name spellings Blink classifies as `<generic-family>` keywords
 *  when they appear UNQUOTED: `FontFamily::InferredTypeFor`
 *  (`platform/fonts/font_family.cc:63-74`, rev 7d859f27) — cursive, fantasy,
 *  monospace, sans-serif, serif, system-ui, math — by case-SENSITIVE
 *  AtomicString equality against the canonical lowercase names. The computed
 *  style preserves the distinction: `SerializeFontFamily`
 *  (`core/css/css_markup.cc:224-230`) force-quotes a literal family name that
 *  collides with a generic spelling (`FontFamilyNeedsQuoting`,
 *  `core/css/properties/css_parsing_utils.cc:4359-4374`), while genuine
 *  generic keywords serialize unquoted and lowercase. `-webkit-standard` /
 *  `-webkit-body` are keyword-only tokens (routed via
 *  `FontDescription::GenericFamily()`, not `InferredTypeFor`), included here
 *  because an unquoted occurrence can only be the keyword. */
export const BLINK_GENERIC_FAMILY_SPELLINGS: ReadonlySet<string> = new Set([
  "cursive",
  "fantasy",
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "math",
  "-webkit-standard",
  "-webkit-body",
]);

// Blink's macOS platform-font cache folds family keys case-insensitively even
// though the `system-ui` intercept itself is an exact AtomicString comparison.
// Consequently an exact system-ui lookup warms the cache entry later used by
// an ordinary case-variant `System-ui` family. Keep this process-scoped like
// Blink's FontCache; memory-trim resets deliberately do not clear it.
export let darwinSystemUiPlatformCacheWarm = false;
export function setDarwinSystemUiPlatformCacheWarm(value: boolean): void {
  darwinSystemUiPlatformCacheWarm = value;
}

/** One name of a computed `font-family` stack: the lower-cased unquoted name,
 *  plus whether this occurrence is a CSS `<generic-family>` KEYWORD rather
 *  than a literal family name. Quoted values are never generic — Blink's
 *  `FontSelector::FamilyNameFromSettings` refuses to substitute settings for
 *  them (`platform/fonts/font_selector.cc:25-32`, rev 7d859f27: "Quoted
 *  <font-family> values corresponding to a <generic-family> keyword should
 *  not be converted to a family name via user settings", gated on
 *  `!generic_family.FamilyIsGeneric()`) — and neither is a case-variant
 *  spelling like `Monospace`, which the computed style only contains for a
 *  literal family (the keyword serializes canonically lowercase). */
interface FontFamilyStackEntry {
  name: string;
  /** Original unquoted spelling passed to the platform family matcher. */
  lookupName: string;
  generic: boolean;
  /** Exact canonical spelling after quote removal. Family lookup is generally
   * case-insensitive, but Blink's `system-ui` platform intercept is not. */
  canonicalSystemUiName: boolean;
}

/** Normalize a computed `font-family` string into its ordered list of
 *  lower-cased, unquoted family names (Chrome's `getComputedStyle().fontFamily`
 *  is the full unresolved comma-separated stack), carrying the
 *  generic-keyword-vs-literal-name bit per entry (see FontFamilyStackEntry). */
export function splitFontFamilyNames(fontFamily: string): FontFamilyStackEntry[] {
  return parseCssFontFamilyEntries(fontFamily).map((entry) => {
    const name = entry.name.toLowerCase();
    return {
      name,
      lookupName: entry.name,
      generic: entry.type === "generic-family",
      canonicalSystemUiName: entry.name === "system-ui",
    };
  });
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
// Linux: `resolveInstalledFont` is always null here, and fontconfig returns
// the SAME family for a real match but a SUBSTITUTE for a miss — told apart by
// Skia's own acceptance rule (`skiaFamilyMatchAcceptable` below), not by name
// canonicalization.
export const _famAvailCache = new Map<string, boolean>();
