/**
 * Text-to-Path: shaping + SVG markup. The font-resolution subsystem it builds on
 * (font loading, the FONT_PATHS tables, the fallback chains, the webfont/embedded
 * registries, glyph-command extraction) lives in ./font-resolution.ts and is
 * re-exported here so the module's public surface is unchanged (DM-1307).
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
import { createGlyphHelperFont, isGlyphHelperAvailable, resolveSystemFallbackFonts, resolveInstalledFont, type GlyphRasterRepresentation } from "./glyph-helper.js";
export type { GlyphRasterRepresentation } from "./glyph-helper.js";
// The SHARED attribute escaper. Two local copies used to live in this file and
// escaped only the five XML metacharacters, so a codepoint the XML `Char`
// production forbids (U+FFFE / U+FFFF, a stray control, an unpaired surrogate)
// reached the accessible name verbatim and made the whole document unparseable
// — the consumer showed a broken-image icon rather than the drawing. Import the
// one implementation instead of restating it; see `esc` for the disposition.
import { esc as escAttr } from "./format.js";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss, trackGlyphInEmbedFont } from "./embedded-font-builder.js";
import { emboldenStrengthForFont, OBLIQUE_SHEAR, resolveFakeBoldTextStroke, skiaFakeBoldStrokeExtraPx } from "./embolden-outline.js";
// DM-1984: the two "does this face need a synthetic bold / oblique?" predicates
// live in one module because BOTH render modes ask them. Re-exported below so
// the long-standing `text-to-path.js` import sites keep working.
import { faceNeedsSyntheticBold, faceNeedsSyntheticOblique, synthesisAllowed, type FontSynthesisAllowance } from "./synthesis-decision.js";
export { faceNeedsSyntheticBold, faceNeedsSyntheticOblique, synthesisAllowed, type FontSynthesisAllowance } from "./synthesis-decision.js";
import { UNICODE_FONT_PATHS, UNICODE_FONT_RANGES } from "./unicode-font-routing.darwin.generated.js";
import { UNICODE_FONT_PATHS_LINUX, UNICODE_FONT_RANGES_LINUX } from "./unicode-font-routing.linux.generated.js";
import { UNICODE_FONT_FILES_WIN32, UNICODE_FONT_RANGES_WIN32 } from "./unicode-font-routing.win32.generated.js";
// Unicode-classification predicates (mathAlphaToBase, isRtlScriptCodepoint, isStretchyFenceChar, complex-shaper / matra / rtl ranges, …) moved to ./unicode-classification.ts (DM-1305).
import { bidiLevelsFor, segmentForShaping } from "./script-segmentation.js";
import { SCRIPT_NAME_TO_ISO15924 } from "./script-iso15924.generated.js";

const BLINK_CURSIVE_SPACING_SCRIPTS = new Set([
  "Arabic", "Hanifi_Rohingya", "Mandaic", "Mongolian", "Nko", "Phags_Pa", "Syriac",
]);
function blinkSuppressesInterLetterSpacing(script: string): boolean {
  return BLINK_CURSIVE_SPACING_SCRIPTS.has(script);
}
import { clusterFallbackEnabled, splitTextIntoFontRunsShaped } from "./cluster-fallback.js";
import { featureListNeedsHbShaping, fontkitFeatureList } from "./font-features.js";
import { icuCodepointProperties, isIcuHelperAvailable } from "./icu-helper.js";
import { recordSelectedFontRuns, recordTextEmitterTransition, type TextRunRequestDiagnostic } from "./text-run-provenance.js";
export { getTextRunProvenance, resetTextRunProvenance, setTextRunProvenanceEnabled } from "./text-run-provenance.js";
import { mathAlphaToBase, isLegitimatelyInklessCodepoint, isHarfbuzzDefaultIgnorable, canTextDecorationSkipInk, usesDedicatedShaper, isTrimmableCjkPunct, complexShaperBaseMarkDecomposition, isStrippableOrphanIgnorable, isLeftReorderingMatra, isRtlScriptCodepoint } from "./unicode-classification.js";


import {
  BLINK_ITALIC_SLOPE_VALUE,
  BLINK_NORMAL_SLOPE,
  DecorationMetrics,
  FontInstance,
  FontRun,
  ITALIC_SLNT,
  PathCommand,
  TextPathOwnership,
  TextPathResult,
  codepointResolvesToNotdef,
  commandsFor,
  currentRenderTextMode,
  ensureGlyphDef,
  fallbackFontChain,
  fontAutoInsertsDottedCircle,
  fontFeatureValueShapingOverride,
  FontVariantEmojiOverride,
  fontHasSupportedColorTable,
  getFontInstance,
  getFontSourceInfo,
  glyphInkXRange,
  glyphPathIntercepts,
  haltInfoFor,
  isNonCharacterCodepoint,
  mergeGaps,
  opticalCutOpszFor,
  pickWebfontVariantForCodepoint,
  r2,
  glyphIdForCp,
  harfbuzzShapedRunOverride,
  resolveDottedCircleHbRun,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontSpec,
  resolveGlyphCommands,
  setRenderTextMode,
  stretchPercent,
  syntheticMarkCenteringOffsetPx,
  win,
  stackPrimaryIsSystemUi,
} from "./font-resolution.js";

/** Blink shapes each font run with the UBA-resolved text direction, including
 * dual-direction scripts whose HarfBuzz script default is INVALID/LTR. */
export function shapingDirectionAt(text: string, utf16Index: number): "ltr" | "rtl" {
  return ((bidiLevelsFor(text)?.[utf16Index] ?? 0) & 1) === 1 ? "rtl" : "ltr";
}

function recordRendererRuns(
  emitter: "paths" | "embedded-font",
  sourceText: string,
  runs: FontRun[],
  request: Omit<TextRunRequestDiagnostic, "direction">,
): void {
  for (const run of runs) {
    recordSelectedFontRuns(emitter, sourceText, {
      ...request,
      direction: run.shapingDirection ?? shapingDirectionAt(sourceText, run.startIdx),
    }, [run]);
  }
}
export * from "./font-resolution.js";

function slantForStyle(style: string | undefined): number {
  if (style == null) return 0;
  const s = style.toLowerCase();
  return (s === "italic" || s.startsWith("oblique")) ? ITALIC_SLNT : 0;
}

/**
 * The requested CSS `font-style` as Blink's `FontSelectionRequest.slope` —
 * the value `faceNeedsSyntheticOblique`'s platform dispatch needs, in CSS
 * degrees (positive = clockwise = right-leaning), NOT the OT-sign-convention
 * boolean gate `slantForStyle` produces above.
 *
 * Transcribed from `StyleBuilderConverterBase::ConvertFontStyle`
 * (`core/css/resolver/style_builder_converter.cc:1102-1140`, rev 7d859f27):
 * `normal`/absent is `kNormalSlopeValue` (0); `italic` and bare `oblique`
 * (no angle) are BOTH `kItalicSlopeValue` (14) — the CSS parser gives
 * `oblique` the italic sentinel, not zero; `oblique <angle>` is the literal
 * angle, WHATEVER it is — including 0 (collapses to normal) and including 14
 * (indistinguishable from `italic` at the request level, which is why
 * Windows/Linux's `Style() == kItalicSlopeValue` test cannot tell `italic`
 * apart from `oblique 14deg`, only from every OTHER explicit angle).
 *
 * `getComputedStyle().fontStyle` (what `style` is captured as) already
 * serializes with this much precision — `computed_style_utils.cc:1096-1129`
 * keeps an author's explicit angle rather than collapsing it back to
 * `oblique`, even at exactly 14deg — so no information is lost re-parsing it
 * here.
 */
function blinkRequestedSlopeDegrees(style: string | undefined): number {
  if (style == null) return BLINK_NORMAL_SLOPE;
  const s = style.trim().toLowerCase();
  if (s === "" || s === "normal") return BLINK_NORMAL_SLOPE;
  if (s === "italic") return BLINK_ITALIC_SLOPE_VALUE;
  const m = /^oblique(?:\s+(-?[\d.]+)deg)?$/.exec(s);
  if (m == null) return BLINK_NORMAL_SLOPE; // unrecognized — treat as normal, never as italic
  if (m[1] == null) return BLINK_ITALIC_SLOPE_VALUE; // bare `oblique`
  const deg = parseFloat(m[1]);
  return Number.isFinite(deg) ? deg : BLINK_NORMAL_SLOPE;
}

// macOS system font paths (the `darwin` column of the per-platform path
// tables — see DM-258 / resolveFontSpec below for Linux + Windows). TTC
// collections require picking a sub-font by postscript name — fontkit returns
// a TTCFont wrapper for .ttc files and .getFont(name) extracts the member.

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

// DM-1215: resolve the HarfBuzz cluster font for an orphaned combining mark that
// the synthetic-dotted-circle pass (or the source) placed after a U+25CC. Chrome's
// HarfBuzz inserts the ◌ from the MARK's OWN font (`hb-ot-shaper-syllabic.cc` →
// `font->get_nominal_glyph(0x25CC)`) and GPOS-positions the whole cluster within
// that single font: Indic faces give the mark a real offset (Brahmi U+11038 →
// -294, centered on the 594-wide ◌), USE faces give offset 0 and self-position via
// the mark's own outline (Adlam / Kharoshthi / Miao / Tagalog / Tai-Tham / Syloti).
// Domotion's geometric `syntheticMarkCenteringOffsetPx` only approximated the Indic
// case, so USE marks floated off the ◌. Shaping ◌+mark with real HarfBuzz in the
// mark's font (harfbuzzjs — robust on the Indic Noto GSUB tables that crash fontkit)
// reproduces BOTH styles exactly; both run-splitters route the cluster into one run
// whose font is the returned HarfBuzz instance, so the shaping path lays the mark
// out at HarfBuzz's advance + GPOS offset. Returns null (→ caller keeps the per-char
// centering path) when nothing covers the mark, the mark's font lacks U+25CC, or
// HarfBuzz can't open the font file. Shared by `textToPathMarkup` (glyph-path) and
// `splitTextIntoFontRuns` (embedded-font) so both emit the cluster identically.

/**
 * The glyph-path emitter's font-run split (the "paths" render mode —
 * `textToPathMarkup` and the visual-regression suites that pin it).
 *
 * Default: Blink's shape-then-requeue mechanism at shaped-cluster granularity
 * (`splitTextIntoFontRunsShaped`, docs/113 — `ExtractShapeResults`,
 * `platform/fonts/shaping/harfbuzz_shaper.cc:627-787`, rev 7d859f27), invoked
 * in its "paths" mode so the emitter's per-run `decomposed`
 * flags (which pick the emitter's run-text branch). This makes the glyph-path
 * and embedded pipelines assign the SAME fonts to the same partially-covered
 * clusters — previously this walk decided per codepoint from cmap coverage
 * before any shaping, so the two modes could disagree about one cluster.
 *
 * A decline (a face HarfBuzz cannot open, or a violated contract) falls back
 * to the legacy per-codepoint walk below; `DOMOTION_CLUSTER_FALLBACK=0`
 * restores that walk wholesale for an A/B.
 */
export function splitTextIntoGlyphPathRuns(
  text: string,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
  fontKeyChain: string[],
  systemUiPrimary: boolean,
  stretch: number,
  fontVariantEmoji: FontVariantEmojiOverride | undefined,
  fontFamily: string,
  /** OpenType features used by Blink's shape-then-requeue coverage verdict. */
  features?: string[],
  /** CSS bidi override applied before Blink's script/run segmentation. */
  bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string },
  /** Exact Blink cache-key request state; neither field changes shaping. */
  fallbackRequest?: { rawSlope: number; orientation: number },
): FontRun[] {
  const clusterEnabled = clusterFallbackEnabled();
  if (clusterEnabled) {
    const shaped = splitTextIntoFontRunsShaped(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, fontVariantEmoji, fontFamily, {
      mode: "paths", features, bidiOverride,
      fallbackRawSlope: fallbackRequest?.rawSlope,
      fallbackOrientation: fallbackRequest?.orientation,
    });
    if (shaped != null) return shaped;
  }
  const legacyMechanism: NonNullable<FontRun["routeMechanism"]> = clusterEnabled ? "cluster-decline-legacy" : "cluster-disabled-legacy";
  const runs: FontRun[] = [];
  let curKey = primaryFontKey;
  let curFontOverride: FontInstance | null = null; // DM-557: per-codepoint webfont variant
  let curDecomposed = false;
  let curText = "";
  let curStart = 0;
  let i = 0;
  // DM-1215: an active dotted-circle cluster being routed through real HarfBuzz
  // (the mark's own font). Set when an ORPHANED combining mark (or an explicit
  // U+25CC before a mark) is seen; trailing combining marks join the same run;
  // any spacing base / whitespace clears it. `clusterHasBase` tracks whether the
  // current cluster already has a spacing base, so a mark with no base is treated
  // as orphaned — exactly the case Chrome's HarfBuzz paints with an inserted ◌.
  let hbDottedCircleRun: { key: string; font: FontInstance } | null = null;
  let clusterHasBase = false;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const nextCp = i + ch.length < text.length ? text.codePointAt(i + ch.length)! : 0;
    let emitCh: string;
    let useKey: string;
    let useFontOverride: FontInstance | null;
    let useDecomposed: boolean;
    // DM-1215: route a dotted-circle cluster through real HarfBuzz in the mark's
    // own font so the mark lands on the ◌ exactly as Chrome paints it (see
    // `resolveDottedCircleHbRun`). An ORPHANED mark (no spacing base) opens the
    // cluster — HarfBuzz inserts AND positions the ◌ the way Chrome's HarfBuzz
    // does, where fontkit either omits it (Adlam / Miao) or mis-places it. An
    // explicit U+25CC before a mark (already inserted upstream) opens it too.
    // Trailing combining marks join the same HarfBuzz-shaped run; any spacing
    // base / whitespace ends it.
    const chIsMark = /\p{M}/u.test(ch);
    let clusterRun: { key: string; font: FontInstance } | null = null;
    if (hbDottedCircleRun != null) {
      if (chIsMark) clusterRun = hbDottedCircleRun;
      else hbDottedCircleRun = null; // a base/space closes the cluster
    }
    if (clusterRun == null) {
      const markForCluster = (cp === 0x25CC && nextCp !== 0 && /\p{M}/u.test(String.fromCodePoint(nextCp)))
        ? nextCp                                  // explicit ◌ + mark (mark drives the shaping font)
        : (chIsMark && !clusterHasBase) ? cp      // orphaned bare mark (HarfBuzz inserts the ◌)
        : 0;
      if (markForCluster !== 0) {
        const hbRun = resolveDottedCircleHbRun(markForCluster, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
        if (hbRun != null) { hbDottedCircleRun = hbRun; clusterRun = hbRun; }
      }
    }
    // Track spacing-base presence for the NEXT codepoint's orphan test: a base
    // (incl. the ◌ itself) sets it, whitespace resets it, marks leave it.
    if (/\s/.test(ch) && ch.length === 1) clusterHasBase = false;
    else if (!chIsMark) clusterHasBase = true;
    // The char appended to the current run's text. Normally the source char;
    // for a Math-Alpha decomposition it's the substituted base letter/digit.
    // DM-1068: the per-codepoint decision is the shared resolver (primary →
    // webfont variant → chain → system fallback → math-alpha → NFD). This path
    // also keeps `useDecomposed` so a math-alpha / NFD run renders via its text
    // (the substituted base char) rather than the per-char source index.
    // The property must not override an explicit VS15/VS16 in the text
    // (`HasVSFallbackPriority`, `harfbuzz_shaper.cc:184-198`, rev 7d859f27).
    const effFve = (nextCp === 0xFE0E || nextCp === 0xFE0F) ? undefined : fontVariantEmoji;
    const res = clusterRun != null ? null : resolveFontForCodepoint(
      cp, primaryFont, primaryFontKey, weight, fontSize, slant,
      variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, effFve,
      fontFamily, fallbackRequest?.rawSlope, fallbackRequest?.orientation,
    );
    if (clusterRun != null) {
      emitCh = ch;
      useKey = clusterRun.key;
      useFontOverride = clusterRun.font;
      useDecomposed = true;
    } else if (res!.covered) {
      emitCh = res!.emitCh;
      useKey = res!.key;
      useFontOverride = res!.fontOverride;
      useDecomposed = res!.decomposed;
    } else {
      // Glyph-path terminal: nothing covers `cp`. Blink's iterator ends at
      // `kFirstCandidateForNotdefGlyph` and re-returns the first candidate so
      // that font's `.notdef` paints; the stage before it asks
      // `GetLastResortFallbackFont`, which on macOS is **Times** (Lucida
      // Grande as a backstop, `mac/font_cache_mac.mm:376-392`) and is NEVER
      // the Unicode LastResort font — the TODO at
      // `font_fallback_iterator.cc:147-149` explicitly wishes it were.
      //
      // Measured against Chrome rather than inferred, on five codepoints
      // nothing on the host covers (Egyptian Hieroglyphs Ext-A U+13460, CJK
      // Ext-G U+30000, Sutton SignWriting U+1D800, Tangut Components U+18800,
      // Vithkuqi U+10570): `CSS.getPlatformFontsForNode` names **Helvetica**
      // for all five and the advance is 20.2813px at 32px — exactly
      // Helvetica's `.notdef` (1298/2048 em). LastResort's glyph would be
      // 35.2031px.
      //
      emitCh = ch;
      useKey = primaryFontKey;
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
      if (f != null) runs.push({ fontKey: curKey, font: f, text: curText, startIdx: curStart, endIdx: i, isPrimary: curKey === primaryFontKey, routeMechanism: legacyMechanism, decomposed: curDecomposed });
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
    const finalKey = curKey === primaryFontKey ? primaryFontKey : (f === primaryFont ? primaryFontKey : curKey);
    runs.push({ fontKey: finalKey, font: f, text: curText, startIdx: curStart, endIdx: text.length, isPrimary: finalKey === primaryFontKey, routeMechanism: legacyMechanism, decomposed: curDecomposed });
  }
  for (const run of runs) {
    run.font = harfbuzzShapedRunOverride(run.font, run.fontKey, weight, fontSize, slant,
      run.isPrimary ? variationSettings : undefined, run.text, features);
  }
  return runs;
}

export function textFontRequest(
  fontWeight: string,
  fontStyle: string | undefined,
  fontStretch: string | undefined,
): { weight: number; slant: number; stretch: number } {
  return {
    weight: parseFloat(fontWeight) || 400,
    slant: slantForStyle(fontStyle),
    stretch: stretchPercent(fontStretch),
  };
}

export function embeddedBaselineY(
  y: number,
  fontSize: number,
  unitsPerEm: number,
  ascent: number,
  ascentOverride: number | undefined,
): number {
  const baselineAscent = ascentOverride != null
    ? ascentOverride
    : Math.round(ascent * (fontSize / unitsPerEm));
  return y + baselineAscent;
}

export function synthesizedSmallCapsScale(fontSize: number): number {
  return Math.round(fontSize * 0.7) / fontSize;
}

function createTextPathOwnership(): TextPathOwnership {
  return { vectorGlyphs: 0, rasterGlyphs: 0, inklessGlyphs: 0, degradedGlyphs: [] };
}

function boundedSourceSpan(text: string, start: number, end: number): [number, number] {
  const lo = Math.max(0, Math.min(text.length, start));
  const hi = Math.max(lo, Math.min(text.length, end));
  return [lo, hi];
}

function codePointsInSourceSpan(text: string, span: [number, number]): number[] {
  return [...text.slice(span[0], span[1])].map((ch) => ch.codePointAt(0)!);
}

function noteRasterGlyph(
  ownership: TextPathOwnership,
): void {
  ownership.rasterGlyphs++;
}

/** Resolve one shaped glyph and preserve the reason for an empty outline.
 * `commandsFor`'s old command-only return made every empty look harmless, so a
 * missing helper outline could disappear inside an otherwise successful run.
 */
function ownedCommandsFor(
  ownership: TextPathOwnership,
  glyph: Parameters<typeof resolveGlyphCommands>[0],
  fontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  sourceSpan: [number, number],
  sourceText: string,
): PathCommand[] {
  const resolution = resolveGlyphCommands(
    glyph, fontKey, weight, fontSize, slant,
    codePointsInSourceSpan(sourceText, sourceSpan),
  );
  if (resolution.disposition === "source-outline" || resolution.disposition === "helper-outline") {
    ownership.vectorGlyphs++;
  } else if (resolution.disposition === "legitimately-inkless") {
    ownership.inklessGlyphs++;
  } else {
    ownership.degradedGlyphs.push({
      sourceSpan,
      glyphId: glyph?.id ?? 0,
      disposition: resolution.disposition,
    });
  }
  return resolution.commands;
}

function renderTextPathRuns(
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
  /** The element's `direction` + `unicode-bidi`; only the override values act.
   *  See `bidiLevelsFor`, which is where it is consumed and why. */
  bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string },
  /** Computed CSS `font-stretch` (e.g. `"75%"`). Selects the family's condensed /
   *  expanded cut in the declared-family style matcher — see `stretchPercent`. */
  fontStretch?: string,
  /** The run's `font-variant-emoji` override (`normal` = undefined). Overrides
   *  per-codepoint emoji presentation in the resolver and the raster-overlay
   *  suppression below — except where the text carries an explicit VS15/VS16,
   *  which wins (the `HasVSFallbackPriority` guard,
   *  `shaping/harfbuzz_shaper.cc:184-198`, rev 7d859f27). */
  fontVariantEmoji?: FontVariantEmojiOverride,
  /** DM-1971 / DM-1984: the run's `font-synthesis` permissions. Read by the
   *  small-caps stand-in below AND by the per-run faux-bold frame. */
  fontSynthesis?: FontSynthesisAllowance,
  /**
   * DM-1984: paints Skia's synthetic-bold frame on the runs that need it. The
   * fill color travels because the frame IS the fill color — `useStrokeForFakeBold`
   * frame-and-fills with one paint (Skia `src/core/SkScalerContext.cpp:1019-1041`,
   * rev ebf5052).
   *
   * PER RUN rather than on the outer group, which is the decision this
   * parameter exists to encode. The outer-group version was measured and is
   * WORSE THAN NO SYNTHESIS AT ALL on a mixed-script line: Papyrus (no bold cut)
   * + CJK at weight 700, best-shift IoU against Chrome — 0.6997 with an
   * outer-group frame, 0.8882 with none, 0.8736 for the plain control. The
   * fallback run routes to a real bold cut (HiraginoSans W6) and needs no
   * frame; giving it one closes the counters of glyphs whose perimeter dwarfs
   * the Latin run's, so the spurious frame costs more than the missing one
   * gained. Absent ⇒ no frame anywhere (what a `-webkit-text-stroke` run does,
   * since that already occupies the stroke attributes).
   */
  fauxBold?: { fill: string },
  fallbackRequest?: { rawSlope: number; orientation: number },
): TextPathResult | null {
  const ownership = createTextPathOwnership();
  const { weight, slant, stretch } = textFontRequest(fontWeight, fontStyle, fontStretch);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch, lang);
  if (primaryFont == null) return null;

  const primaryFontKey = resolveFontKey(fontFamily, lang);
  const fontKeyChain = resolveFontKeyChain(fontFamily, lang);

  // DM-1984: the synthetic-bold frame for ONE run's glyph group. `groupScale`
  // is that group's own `scale(s,-s)` factor, so the emitted width lands at
  // `extra` CSS px after the transform — a fallback run on a face with a
  // different unitsPerEm gets its own conversion rather than the primary's.
  const fauxBoldAttrFor = (runFont: FontInstance, groupScale: number): string =>
    fauxBold != null && groupScale > 0 && faceNeedsSyntheticBold(runFont, weight, fontSynthesis)
      ? ` stroke="${escAttr(fauxBold.fill)}" stroke-width="${r2(skiaFakeBoldStrokeExtraPx(fontSize) / groupScale)}"`
      : "";

  // Split the text into runs by font. Code points that primary lacks (Arabic,
  // CJK, …) get routed to a fallback font. Each run keeps its order; this
  // does NOT do BiDi reordering — that's tracked separately. startIdx/endIdx
  // are UTF-16 code-unit positions into `text` so the multi-font path can
  // slice xOffsets per run (SK-1255).
  // Default: shaped-cluster granularity via the shared shape-then-requeue
  // splitter (docs/113) in its "paths" mode — the same cluster decisions the
  // embedded pipeline makes — with the legacy per-codepoint walk as the
  // decline / flag-off fallback. See `splitTextIntoGlyphPathRuns`.
  // `decomposed` marks runs whose `text` is not the source slice (substituted
  // Math-Alphanumeric base letters, dotted-circle clusters); those render
  // through the run-text / min-x anchored branch — the per-char path (which
  // reads `text` by index) can't be used for them.
  const runs: FontRun[] = splitTextIntoGlyphPathRuns(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, stackPrimaryIsSystemUi(fontFamily, lang), stretch, fontVariantEmoji, fontFamily, features, bidiOverride, fallbackRequest);
  // A feature list carrying a disable (`-liga`) or an explicit value can only
  // be honored by HarfBuzz — fontkit's list is enable-only and the platform
  // glyph helpers ignore it — so such a run swaps its shaping to a HarfBuzz
  // proxy with the FULL list bound (outlines stay with the resolved face).
  // Chrome's own split: Blink shapes with HarfBuzz and rasterizes from the
  // platform typeface. See `fontFeatureValueShapingOverride`. Applied after
  // run grouping (the proxy is memoized, so identical bases keep identity).
  if (featureListNeedsHbShaping(features)) {
    for (const run of runs) {
      const fvs = run.fontKey === primaryFontKey ? variationSettings : undefined;
      run.font = fontFeatureValueShapingOverride(run.font, run.fontKey, weight, fontSize, slant, fvs, features!);
    }
  }
  recordRendererRuns("paths", text, runs, {
    fontFamily, fontWeight: weight, fontStyle, fontStretch: stretch, fontSizePx: fontSize,
    variationSettings, features, language: lang, fontVariantEmoji,
  });
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
  // DM-1971: `font-synthesis-small-caps: none` vetoes only the SYNTHESIZED
  // form — the scaled-uppercase stand-in taken when the face has no `smcp`.
  // A face that really carries the feature is unaffected, because that is a
  // real OpenType substitution rather than a synthesis, and Blink's
  // `font_synthesis_small_caps_` gates the same narrow thing.
  const capsSynthOk = synthesisAllowed(fontSynthesis, "smallCaps");
  const hasFeature = (f: string) => !capsSynthOk || availableFeatures.includes(f);
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
  //
  // Blink doesn't apply that 0.7 as a continuous scale, though:
  // `SimpleFontData::CreateScaledFontData` (same file) rounds the SCALED
  // SIZE to a whole pixel before building the scaled font —
  // `lroundf(font_description.ComputedSize() * scale_factor)` — and the
  // synthesized glyph is built at THAT integer size. At 16px Chrome's
  // small-caps glyph is a 11px face (16 × 0.7 = 11.2 → round → 11), not an
  // unrounded 11.2px one. `SMALL_CAP_SCALE` here is expressed as a per-size
  // RATIO (`roundedSize / fontSize`) rather than a flat 0.7 so downstream
  // multiplications (`runScale * SMALL_CAP_SCALE`) land on the same rounded
  // pixel size Blink does.
  const SMALL_CAP_SCALE = Math.round(fontSize * 0.7) / fontSize;
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
  if (runs.length === 1 && runs[0].fontKey === primaryFontKey && !synthSmallCaps
      && runs[0].decomposed !== true && runs[0].font.shapesWithHarfbuzz !== true) {
    return singleFontMarkup(runs[0].font, runs[0].fontKey, runs[0].text, weight, fontSize, slant, targetWidth, xOffsets, features, stretch, fauxBoldAttrFor, ownership);
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
    // DM-1894: per-code-unit bidi embedding levels for the whole text, computed
    // once. This is the outer of Blink's two segmentation levels — it shapes each
    // BIDI RUN with its own direction (harfbuzz_shaper.cc:1145-1148) and splits
    // by script within it. `undefined` when the text is unidirectional, which
    // lets the segmenter take its cheap path.
    const bidiLevels = bidiLevelsFor(text, bidiOverride);
    for (const run of runs) {
      const runScale = fontSize / run.font.unitsPerEm;
      const sc = Number(runScale.toFixed(5));
      // Decomposed Math-Alpha runs render via the run-text branch too: their
      // `text` carries the substituted base letters, which don't line up with
      // the original astral codepoints the per-char branch reads from `text`.
      // DM-1868: decide this from the run's SCRIPT, not from its routing key.
      //
      // The three key names below are the static fallback-table keys for Arabic /
      // Devanagari / Thai. When the live system-fallback resolver answers instead
      // — which is what `resolveFontForCodepoint` does for any codepoint the
      // static chain misses, and what it does for ALL of them once the stages run
      // in Blink's order — the key becomes `sysfb:GeezaPro` /
      // `sysfb:KohinoorDevanagari-Regular`, these comparisons all go false, and
      // the run silently drops to the per-char branch. Arabic contextual joining
      // and Devanagari cluster reordering just stop happening: measured as 4 diff
      // regions on `text-mixed-script`, with the FACE and the glyph positions
      // both correct, because only the shaping was lost.
      //
      // `usesDedicatedShaper` is the same predicate the resolver already uses to
      // decide which codepoints CoreText shapes correctly, so keying on it makes
      // the two agree by construction instead of by a name that has to be kept
      // in sync. The key checks stay as-is: they cost nothing and they keep the
      // behavior identical for every run that still routes through a static key.
      const isShapingRequired = run.fontKey === "sf-arabic"
        || run.fontKey === "devanagari"
        || run.fontKey === "thai"
        || run.decomposed === true
        // A face deliberately wrapped with the Chromium-configured HarfBuzz
        // engine must shape as a run. Sending that wrapper one scalar at a
        // time defeats the very syllable/cluster logic it was selected for,
        // including broken-syllable dotted-circle insertion.
        // Synthesized caps must still take the per-character branch below: it
        // uppercases and applies Blink's rounded small-cap size independently
        // to each source character. The HarfBuzz proxy remains the shaper for
        // every ordinary run, but treating it as an unconditional run-shaping
        // signal here would silently discard that synthesis.
        || (run.font.shapesWithHarfbuzz === true && !synthSmallCaps)
        || [...run.text].some((c) => usesDedicatedShaper(c.codePointAt(0)!));

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
            // Enable-only projection: a disable/value entry is honored by the
            // run's HarfBuzz proxy (bound at wrap time above), never by fontkit.
            ? run.font.layout(ch, fontkitFeatureList(features))
            : run.font.layout(ch);
          const nextI = i + ch.length;
          const uses: string[] = [];
          for (const g of layout.glyphs) {
            if (glyphUsesRasterRepresentation(run.font, run.fontKey, g, fontSize, weight, slant)) {
              noteRasterGlyph(ownership);
              continue;
            }
            const gCmds = ownedCommandsFor(
              ownership, g, run.fontKey, weight, fontSize, slant,
              boundedSourceSpan(text, i, nextI),
              text,
            );
            if (gCmds.length === 0) continue;
            // A PUA codepoint with no covering icon font paints its `.notdef`
            // like any other uncovered codepoint — see `singleFontMarkup`'s
            // comment on the same removal for the single-font branch. Chrome's
            // fallback iterator lands on the run's own font and paints THAT
            // font's `.notdef` (`font_fallback_iterator.cc:159-164`), so the
            // synthetic hollow-rect stand-in this branch used to draw here (a
            // box ~0.7 × advance wide, 0.65 em tall, with a 0.03 em border) was
            // a workaround for a defect one layer up, not behavior Chrome
            // exhibits — and even where it fired, it measured narrower,
            // shorter and far thinner-stroked than Helvetica's real `.notdef`
            // (0.71 em vs 0.90 em wide). Uncovered-PUA is otherwise rare (this
            // fires only for a codepoint neither the primary nor any fallback
            // in the run's chain covers), so this is expected to move no
            // current fixture — it's a consistency fix, not a visible one.
            const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, g.id, gCmds, stretch);
            uses.push(`<use href="#${defId}" x="0" y="0"/>`);
          }
          if (uses.length > 0) {
            let cssX = Number(xOffsets[i].toFixed(3));
            // DM-1184: shift trimmed fullwidth-punctuation ink (see
            // cjkTrimShiftFontUnits / the embedded-font path for the rationale).
            if (nextI < xOffsets.length && layout.glyphs.length === 1) {
              const shiftFU = cjkTrimShiftFontUnits(run.font, run.fontKey, layout.glyphs[0], cp,
                xOffsets[nextI] - xOffsets[i], fontSize, runScale);
              if (shiftFU !== 0) cssX = Number((cssX + shiftFU * runScale).toFixed(3));
            }
            groups.push(`<g transform="translate(${cssX},0) scale(${chScale},${-chScale})"${fauxBoldAttrFor(run.font, chScale)}>${uses.join("")}</g>`);
            if (cssX > rightEdge) rightEdge = cssX;
          }
          i += ch.length;
        }
      } else {
        // Shaping fallback — shape by SEGMENT, not by whole run.
        //
        // A run is split on font boundaries only, so a face covering several
        // scripts leaves a mixed-script line in one run. Shaping that as a unit
        // makes the shaper choose ONE script and direction for all of it, and an
        // RTL stretch inside an LTR run then comes back in logical order and
        // paints mirrored. Chromium does not do this: `HarfBuzzShaper::Shape`
        // takes direction per BIDI RUN (harfbuzz_shaper.cc:1145-1148 → :341) and
        // segments by SCRIPT within it via RunSegmenter (:1168-1177). See
        // `segmentForShaping`, which mirrors both levels.
        //
        // `needsSegmentation` keeps the common case free — the analogue of
        // Blink's 8-bit shortcut (:1157-1161), which skips segmentation for
        // Latin-1 because it cannot hold a script or direction boundary.
        // The level array spans the WHOLE text; `run.text` is a slice of it
        // starting at `run.startIdx`, and both consumers below index it with
        // RUN-RELATIVE offsets. Handing them the unsliced array reads the level
        // of whatever character happens to sit that far from the start of the
        // LINE, so every run except the first was scored against the wrong
        // characters — `Hello مرحبا …` read levels 0,0,0,0,0 (the `Hello`) for
        // its Arabic run and called it left-to-right.
        //
        // That was invisible for as long as the shaper ignored the direction it
        // was handed: the macOS helper's shape query takes no direction argument
        // at all (`shapeText(text)`), so it inferred RTL from the content and
        // came out right for the wrong reason. HarfBuzz obeys — see the segment
        // loop below — so the misalignment became a mirrored word the moment any
        // RTL script was routed to it.
        //
        // Sliced only when the run's text is the source slice character for
        // character. A Math-Alphanumeric `decomposed` run holds SUBSTITUTED base
        // letters (`mathAlphaToBase`), so its length need not match the span it
        // came from and no per-character alignment exists to preserve; those runs
        // are Latin base letters by construction, and `undefined` levels are read
        // as left-to-right, which is what they are.
        const runLevels = (bidiLevels != null && run.text.length === run.endIdx - run.startIdx)
          ? bidiLevels.subarray(run.startIdx, run.endIdx)
          : undefined;
        // Blink's 8-bit shortcut is the only case that may skip script
        // itemization. A one-segment non-Latin run still needs its resolved
        // script: HarfBuzz selects the syllabic shaper from that tag, so an
        // Inherited Vedic mark itemized as Devanagari is observably different
        // from the same buffer left as Common.
        const isEightBit = [...run.text].every((ch) => ch.codePointAt(0)! <= 0xff);
        const segments = isEightBit
          ? [{
            start: 0,
            end: run.text.length,
            script: "Latin",
            rtl: runLevels != null && runLevels.length > 0 && (runLevels[0] & 1) === 1,
          }]
          : segmentForShaping(run.text, runLevels);

        // A note on what an override run does NOT need: a different shaper.
        //
        // It looked like it did. The platform helper's `shape` query takes no
        // direction and infers one from the string's own bidi — the exact
        // inference an override exists to suppress — so the run was routed to
        // HarfBuzz, the one shaper that can be TOLD a direction. That fixed the
        // Hebrew cases and left Arabic worse than before (0.526% -> 0.701%).
        //
        // The reason is below, at the segment: HarfBuzz does not honour a
        // contrary direction by shaping the text as-is under it. It reverses the
        // characters into the script's native order first. So the question was
        // never "which shaper can be told LTR" — it was "which buffer would
        // HarfBuzz have shaped", and that buffer is one the helper's own
        // inference reads correctly. Reversing here leaves nothing for a second
        // shaper to do, and keeps the AAT-capable one, which on macOS is
        // load-bearing: GeezaPro and Helvetica carry `morx` and no `GSUB`.
        for (const seg of segments) {
          const segText = run.text.slice(seg.start, seg.end);
          if (segText === "") continue;
          // Anchor each segment at its OWN visual-leftmost captured x, rather
          // than accumulating advances across segments. Chrome already decided
          // where each character sits, so this reuses its positioning instead of
          // re-deriving it — and it is what keeps a mirrored RTL segment landing
          // in the right place. Math.min covers both directions.
          let segMinX = Infinity;
          for (let i = run.startIdx + seg.start; i < run.startIdx + seg.end && i < xOffsets.length; i++) {
            if (xOffsets[i] < segMinX) segMinX = xOffsets[i];
          }
          if (!Number.isFinite(segMinX)) continue;

          // Direction is passed EXPLICITLY, the way Blink passes it, rather than
          // left for the shaper to infer from content — inference is what
          // produced an LTR reading of an Arabic stretch in the first place.
          // Script stays undefined so fontkit derives it from the segment, which
          // is now single-script by construction; it reads the same
          // `unicode-properties` table the segmenter does, so the two agree.
          const dir = seg.rtl ? "rtl" : "ltr";
          // Does the SEGMENT's own content imply the direction we are asking
          // for? `_RTL_RE`-equivalent: any strong-RTL character makes the
          // content RTL for this purpose.
          const contentIsRtl = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(segText);

          // When the two disagree, shape the REVERSED characters in the script's
          // own direction — which is what HarfBuzz does, and therefore what
          // Chrome does.
          //
          // `hb_ensure_native_direction` (`external/harfbuzz/src/hb-ot-shape.cc:588`,
          // rev 4de187d) runs before any shaper sees the buffer: if the requested
          // direction is horizontal and differs from
          // `hb_script_get_horizontal_direction(script)`, it reverses the buffer's
          // clusters and flips the direction, so the shaper always runs natively;
          // `hb_ot_shape_internal` reverses back at the end (`:1184`).
          //
          // The consequence is easy to miss and is the whole of this ticket:
          // reversing BEFORE shaping means the contextual forms are computed on
          // the reversed character sequence. Under `bidi-override; direction: ltr`
          // Chrome therefore paints Arabic UNJOINED at the ends — the word's first
          // letter has nothing to its right any more. Verified equivalent on
          // GeezaPro: `hb-shape --direction=ltr` over the source and
          // `--direction=rtl` over the reversed source return byte-identical
          // glyphs and advances (meem isolated 900 | reh.final 700 | hah.medial
          // 1359 | beh.initial 656 | alef isolated 647), differing only in cluster
          // numbering. Shaping the source as-is under a forced direction — which
          // is what asking a shaper for "this text, LTR" does — keeps the joined
          // forms and is simply a different word shape.
          //
          // Doing the reversal here rather than passing a direction down also
          // removes the reason the override run needed a different shaper at all.
          // The platform helper infers direction from content and cannot be told
          // otherwise; on the reversed string that inference now lands on exactly
          // the direction we want, so the helper stays usable without a shaper
          // swap. The ground for that is the SAME `hb_ensure_native_direction`
          // equivalence cited above — `shape(source, requestedDir)` ==
          // `shape(reversed(source), nativeDir)` from HarfBuzz's point of
          // view — not an AAT/`morx` capability gap in our own wasm. (An
          // earlier version of this comment attributed the need to the
          // *published* harfbuzzjs npm package being built `-DHB_TINY`, which
          // strips AAT and does return GeezaPro's isolated forms —
          // 900/902/1292/1415/647 against real HarfBuzz's 900/700/1359/656/647
          // — because the table that joins them is compiled out. That
          // description is stale for this project: `vendor/harfbuzzjs/` is
          // rebuilt with Chromium's own HarfBuzz configuration and keeps AAT
          // — see `vendor/harfbuzzjs/README.md` and
          // `build/config-override.h` — so an AAT gap was never why these
          // faces stay on the platform helper; `hb_ensure_native_direction`
          // is.)
          //
          // Reversal is by code point, matching `reverse_clusters()` on a buffer
          // that has not been shaped yet, where clusters are still per-character.
          //
          // Gated on there being an override, and the gate is now a narrowing
          // rather than a correction. It used to be load-bearing for a different
          // reason: the level array was indexed run-relatively against
          // whole-line levels (fixed above), so a plain mixed-script line handed
          // the Arabic segment `rtl: false` while its content was plainly RTL,
          // and reversing on that signal mirrored the word. With the run-aligned
          // levels, `seg.rtl` and `contentIsRtl` agree for every strong-script
          // segment outside an override, so the two forms coincide there; the
          // gate is kept because the ONE input that can legitimately contradict
          // the content is an override, where Blink's injected LRO/RLO makes the
          // level authoritative by construction — which is the whole point of
          // the property.
          const flipToNative = bidiOverride != null && seg.rtl !== contentIsRtl;
          const shapeText = flipToNative ? [...segText].reverse().join("") : segText;
          // Once flipped, the run IS native, so hand the shaper the direction its
          // content implies rather than the paragraph's.
          const shapeDir = flipToNative ? (contentIsRtl ? "rtl" : "ltr") : dir;
          const shapeFont = run.font;
          // Shaped fallback already resolved the item's script before it chose
          // this face. Keep that authoritative tag through emission; legacy
          // runs without provenance retain the local segment derivation.
          const scriptTag = run.shapingScript ?? SCRIPT_NAME_TO_ISO15924[seg.script];
          const layout = features != null && features.length > 0
            ? shapeFont.layout(shapeText, fontkitFeatureList(features), scriptTag, lang, shapeDir)
            : shapeFont.layout(shapeText, undefined, scriptTag, lang, shapeDir);
          const uses: string[] = [];
          const shapedClusters = (layout as typeof layout & { clusters?: number[] }).clusters;
          const glyphSourceSpans = shapedGlyphSourceSpans(
            segText, shapeText, layout.glyphs, shapedClusters,
            shapeDir === "rtl", flipToNative,
          );
          const placements = blinkSuppressesInterLetterSpacing(seg.script)
            ? (() => {
              let cursorFU = 0;
              return layout.positions.map((pos) => {
                const xFontUnits = cursorFU + pos.xOffset;
                cursorFU += pos.xAdvance;
                return { xFontUnits, rightCss: segMinX + cursorFU * runScale };
              });
            })()
            : positionShapedClusters(
              segText, shapeText, layout.glyphs, layout.positions, shapedClusters,
              xOffsets, run.startIdx + seg.start, runScale, segMinX, seg.rtl, flipToNative,
            );
          let maxRightCss = segMinX;
          for (let gi = 0; gi < layout.glyphs.length; gi++) {
            const glyph = layout.glyphs[gi];
            const pos = layout.positions[gi];
            // Blink applies letter/word spacing after shaping, then paints each
            // shaped cluster at that post-spacing inline origin. Preserve that
            // captured cluster anchor while retaining HarfBuzz's intra-cluster
            // advance and GPOS offset. Anchoring only the segment (the previous
            // behavior) discarded spacing between clusters and accumulated a
            // visible drift across ordinary shaped Latin runs.
            const rasterOwned = glyphUsesRasterRepresentation(
              run.font, run.fontKey, glyph, fontSize, weight, slant,
            );
            if (rasterOwned) noteRasterGlyph(ownership);
            const glyphCmds = rasterOwned
              ? []
              : ownedCommandsFor(
                ownership, glyph, run.fontKey, weight, fontSize, slant,
                boundedSourceSpan(
                  text,
                  run.startIdx + seg.start + glyphSourceSpans[gi][0],
                  run.startIdx + seg.start + glyphSourceSpans[gi][1],
                ),
                text,
              );
            if (glyphCmds.length > 0) {
              const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, glyph.id, glyphCmds, stretch);
              const tx = placements[gi].xFontUnits;
              const ty = -pos.yOffset;
              uses.push(`<use href="#${defId}" x="${r2(tx)}" y="${r2(ty)}"/>`);
            }
            maxRightCss = Math.max(maxRightCss, placements[gi].rightCss);
          }
          if (uses.length > 0) {
            const cssX = Number(segMinX.toFixed(3));
            groups.push(`<g transform="translate(${cssX},0) scale(${sc},${-sc})"${fauxBoldAttrFor(run.font, sc)}>${uses.join("")}</g>`);
            const segRight = maxRightCss;
            if (segRight > rightEdge) rightEdge = segRight;
          }
        }
      }
    }
    return { markup: groups.join(""), width: rightEdge, ownership };
  }

  // Multi-font path: emit one <g scale> per run, each at its accumulated CSS-x.
  const groups: string[] = [];
  let xCss = 0;
  for (const run of runs) {
    const runScale = fontSize / run.font.unitsPerEm;
    const runDirection = run.shapingDirection ?? shapingDirectionAt(text, run.startIdx);
    // Even without captured per-character anchors, a uniform non-Latin run
    // still needs Blink's explicit script tag. Keep the pre-existing whole-run
    // layout for genuinely mixed segments; the font-run splitter normally
    // separates those, while declining here avoids inventing placement rules.
    const runSegments = segmentForShaping(run.text);
    const runScript = run.shapingScript ?? (runSegments.length === 1
      ? SCRIPT_NAME_TO_ISO15924[runSegments[0].script]
      : undefined);
    const layout = features != null && features.length > 0
      ? run.font.layout(run.text, fontkitFeatureList(features), runScript, lang, runDirection)
      : run.font.layout(run.text, undefined, runScript, lang, runDirection);
    const glyphSourceSpans = shapedGlyphSourceSpans(
      run.text,
      run.text,
      layout.glyphs,
      (layout as typeof layout & { clusters?: number[] }).clusters,
      runDirection === "rtl",
    );
    const uses: string[] = [];
    let runX = 0;
    for (let i = 0; i < layout.glyphs.length; i++) {
      const glyph = layout.glyphs[i];
      const pos = layout.positions[i];
      const rasterOwned = glyphUsesRasterRepresentation(
        run.font, run.fontKey, glyph, fontSize, weight, slant,
      );
      if (rasterOwned) noteRasterGlyph(ownership);
      const glyphCmds = rasterOwned
        ? []
        : ownedCommandsFor(
          ownership, glyph, run.fontKey, weight, fontSize, slant,
          boundedSourceSpan(
            text,
            run.startIdx + glyphSourceSpans[i][0],
            run.startIdx + glyphSourceSpans[i][1],
          ),
          text,
        );
      if (glyphCmds.length > 0) {
        const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, glyph.id, glyphCmds, stretch);
        const tx = runX + pos.xOffset;
        const ty = -pos.yOffset;
        uses.push(`<use href="#${defId}" x="${r2(tx)}" y="${r2(ty)}"/>`);
      }
      runX += pos.xAdvance;
    }
    if (uses.length > 0) {
      const sc = Number(runScale.toFixed(5));
      groups.push(`<g transform="translate(${r2(xCss)},0) scale(${sc},${-sc})"${fauxBoldAttrFor(run.font, sc)}>${uses.join("")}</g>`);
    }
    xCss += runX * runScale;
  }
  return {
    markup: groups.length > 0 ? groups.join("") : "",
    width: xCss,
    ownership,
  };
}

/** Public path-mode entry point; run routing/emission lives in the stage above. */
export function textToPathMarkup(
  text: string,
  fontSize: number,
  fontFamily: string,
  fontWeight: string,
  targetWidth?: number,
  xOffsets?: number[],
  fontStyle?: string,
  features?: string[],
  lang?: string,
  variationSettings?: Record<string, number>,
  bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string },
  fontStretch?: string,
  fontVariantEmoji?: FontVariantEmojiOverride,
  fontSynthesis?: FontSynthesisAllowance,
  fauxBold?: { fill: string },
  fallbackRequest?: { rawSlope: number; orientation: number },
): TextPathResult | null {
  return renderTextPathRuns(
    text, fontSize, fontFamily, fontWeight, targetWidth, xOffsets, fontStyle,
    features, lang, variationSettings, bidiOverride, fontStretch,
    fontVariantEmoji, fontSynthesis, fauxBold, fallbackRequest,
  );
}

/** Original single-font path (unchanged behavior — preserves xOffsets / targetWidth). */
// DM-1184: CSS `text-spacing-trim` collapses the built-in half-width side-
// bearing that CJK fullwidth punctuation (（「」）。、 …) carries, so adjacent
// trimmed punctuation packs ~0.5em apart instead of the full ~1em advance.
// Chrome's already-trimmed pen positions ARE captured (and we anchor each glyph
// at them), but the glyph OUTLINE is still the full-width one, whose ink sits in
// only one half of the em box. For OPENING punctuation (（「) the ink is in the
// RIGHT half, so drawing the full glyph at the trimmed (leftward) pen pushes the
// ink ~0.5em too far right — it overlaps the next glyph (the visible "「 lands on
// 」" bug). The font's `halt` (alternate half widths) feature is pure GPOS: it
// halves the advance AND repositions the ink to fit (xOffset −0.5em for opening
// punctuation, 0 for closing — closing ink is already left-aligned). We borrow
// only its xOffset to nudge the ink at the already-trimmed anchor; the advance
// is irrelevant because placement uses the captured pen, not a re-shaped one.

// DM-1184: the font-unit x-shift that repositions a TRIMMED fullwidth-punctuation
// glyph's ink so the full-width outline lands where Chrome painted the
// half-width form. 0 when the glyph isn't trimmed (captured advance ≈ full em)
// or isn't opening punctuation (closing punctuation's ink is already left-
// aligned, so it needs no shift). Prefers the font's own `halt` GPOS xOffset;
// falls back to ink geometry (ink in the RIGHT half of the em box ⇒ opening ⇒
// shift left by the trimmed amount) when the font instance can't apply `halt`.
export function cjkTrimShiftFontUnits(
  font: FontInstance,
  fontKey: string,
  glyph: { id: number; advanceWidth?: number; path?: { commands: Array<{ command: string; args: number[] }> }; codePoints?: number[] },
  cp: number,
  capturedAdvCss: number,
  fontSize: number,
  scale: number,
): number {
  void fontSize;
  const emFU = font.unitsPerEm;
  const fullAdvCss = (glyph.advanceWidth != null && glyph.advanceWidth > 0 ? glyph.advanceWidth : emFU) * scale;
  if (!(capturedAdvCss > 0 && fullAdvCss > 0 && capturedAdvCss < fullAdvCss * 0.75)) return 0;
  const halt = haltInfoFor(font, fontKey, cp);
  if (halt.halved) return halt.xOffset;
  if (isGlyphHelperAvailable() && isIcuHelperAvailable()) return 0;
  // Fallback (font can't report `halt`): classify by ink position.
  if (!isTrimmableCjkPunct(cp)) return 0;
  const ink = glyphInkXRange(glyph);
  if (ink == null) return 0;
  const inkCenter = (ink.min + ink.max) / 2;
  if (inkCenter <= emFU * 0.5) return 0; // closing punctuation — already aligned
  const trimFU = (fullAdvCss - capturedAdvCss) / scale; // amount Chrome removed
  return -trimFU;
}

/**
 * UTF-16 length of the source cluster a shaped glyph consumed, measured from
 * the SOURCE TEXT rather than from the glyph's own `codePoints`.
 *
 * fontkit memoizes `Glyph` objects by glyph id, so a glyph reached from more
 * than one source codepoint reports the `codePoints` of whichever codepoint
 * FIRST materialized it. `.notdef` (id 0) is the acute case: every codepoint no
 * font in the chain covers shares that single Glyph instance, so once any BMP
 * codepoint has missed, a later ASTRAL miss still reports the BMP one — and a
 * span derived from it counts 1 code unit where the source consumed 2 (a
 * surrogate pair). The cursor then lands mid-pair, and every later glyph in the
 * run reads the wrong captured x. The synthetic dotted circle after an orphaned
 * astral combining mark collapses onto the mark's tofu instead of sitting
 * beside it — the whole cell paints one glyph-width narrow.
 *
 * It is order-dependent, which is why it only ever showed up in a multi-fixture
 * sweep: rendered on its own, a fixture's first `.notdef` miss IS the astral
 * one, so the stale value happens to be right.
 *
 * The glyph still tells us HOW MANY source codepoints it consumed (1 for a
 * plain glyph, 2+ for a ligature) — only their code-unit widths come from the
 * text, which is the part a shared Glyph cannot know. `backwards` walks an RTL
 * run, whose cursor sits at the cluster END rather than its start.
 */
export function sourceClusterSpan(
  text: string, cursor: number, cpCount: number, backwards: boolean,
): number {
  let span = 0;
  for (let k = 0; k < cpCount; k++) {
    if (backwards) {
      const end = cursor - span;
      if (end <= 0) break;
      const unit = text.charCodeAt(end - 1);
      const isLowSurrogate = unit >= 0xDC00 && unit <= 0xDFFF;
      span += isLowSurrogate && end - 2 >= 0 ? 2 : 1;
    } else {
      const at = cursor + span;
      if (at >= text.length) break;
      span += text.codePointAt(at)! > 0xFFFF ? 2 : 1;
    }
  }
  // Never return 0: the caller's cursor must advance or the walk never ends.
  return span > 0 ? span : 1;
}

export interface ShapedClusterPlacement {
  xFontUnits: number;
  rightCss: number;
}

/** Map shaped glyphs back to exact source UTF-16 cluster spans. HarfBuzz
 * cluster indices may repeat for multi-glyph clusters; the next distinct
 * cluster supplies the end without trusting fontkit's memoized codePoints. */
export function shapedGlyphSourceSpans(
  sourceText: string,
  shapedText: string,
  glyphs: Array<{ codePoints?: number[] }>,
  clusters: number[] | undefined,
  rtl: boolean,
  reversedForNativeDirection = false,
): Array<[number, number]> {
  const clusterStarts = clusters == null
    ? []
    : [...new Set(clusters.filter((value) =>
      Number.isInteger(value) && value >= 0 && value < shapedText.length))]
      .sort((a, b) => a - b);
  let fallbackCursor = rtl ? shapedText.length : 0;
  return glyphs.map((glyph, index) => {
    const cluster = clusters?.[index];
    let shapedStart: number;
    let span: number;
    if (cluster != null && Number.isInteger(cluster) && cluster >= 0 && cluster < shapedText.length) {
      shapedStart = cluster;
      const next = clusterStarts.find((value) => value > cluster) ?? shapedText.length;
      span = Math.max(1, next - cluster);
    } else {
      const cpCount = glyph.codePoints != null && glyph.codePoints.length > 0
        ? glyph.codePoints.length
        : 1;
      if (rtl) {
        span = sourceClusterSpan(shapedText, fallbackCursor, cpCount, true);
        shapedStart = Math.max(0, fallbackCursor - span);
        fallbackCursor = shapedStart;
      } else {
        shapedStart = fallbackCursor;
        span = sourceClusterSpan(shapedText, fallbackCursor, cpCount, false);
        fallbackCursor += span;
      }
    }
    const sourceStart = reversedForNativeDirection
      ? Math.max(0, sourceText.length - shapedStart - span)
      : shapedStart;
    return boundedSourceSpan(sourceText, sourceStart, sourceStart + span);
  });
}

/** Map a shaped glyph stream back onto Blink's captured post-spacing cluster
 * origins. Glyphs sharing one cluster retain their HarfBuzz advance/offset;
 * spacing between clusters comes exclusively from capture. */
export function positionShapedClusters(
  sourceText: string,
  shapedText: string,
  glyphs: Array<{ codePoints?: number[] }>,
  positions: Array<{ xAdvance: number; xOffset: number }>,
  clusters: number[] | undefined,
  xOffsets: number[],
  sourceStart: number,
  runScale: number,
  groupOriginCss: number,
  rtl: boolean,
  reversedForNativeDirection = false,
): ShapedClusterPlacement[] {
  const out: ShapedClusterPlacement[] = [];
  let fallbackTextIdx = rtl ? shapedText.length : 0;
  let previousCluster: number | undefined;
  let previousSourceCluster = 0;
  let clusterCursorFU = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i];
    const pos = positions[i];
    let shapedCluster = clusters?.[i];
    if (shapedCluster == null) {
      const span = sourceClusterSpan(shapedText, rtl ? Math.max(0, fallbackTextIdx - 1) : fallbackTextIdx,
        glyph.codePoints != null && glyph.codePoints.length > 0 ? glyph.codePoints.length : 1, rtl);
      if (rtl) fallbackTextIdx -= span;
      shapedCluster = Math.max(0, fallbackTextIdx);
      if (!rtl) fallbackTextIdx += span;
    }
    if (shapedCluster !== previousCluster) {
      previousCluster = shapedCluster;
      clusterCursorFU = 0;
      const cpCount = glyph.codePoints != null && glyph.codePoints.length > 0 ? glyph.codePoints.length : 1;
      const span = sourceClusterSpan(shapedText, shapedCluster, cpCount, false);
      previousSourceCluster = reversedForNativeDirection
        ? Math.max(0, sourceText.length - shapedCluster - span)
        : shapedCluster;
    }
    const anchorCss = xOffsets[sourceStart + previousSourceCluster] ?? groupOriginCss;
    const xFontUnits = (anchorCss - groupOriginCss) / runScale + clusterCursorFU + pos.xOffset;
    clusterCursorFU += pos.xAdvance;
    out.push({ xFontUnits, rightCss: anchorCss + clusterCursorFU * runScale });
  }
  return out;
}

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
  /** CSS `font-stretch` percentage — part of the glyph-def identity (see
   *  `ensureGlyphDef`). */
  stretch: number = 100,
  /** DM-1984: builds the synthetic-bold frame attribute for this font at the
   *  emitted group's own scale. Supplied by `textToPathMarkup`, which owns the
   *  decision; a single-font run is the case where the outer group and the run
   *  coincide, so the placement is moot here — it stays a callback purely so
   *  the two branches cannot drift on WHETHER to synthesize. */
  fauxBoldAttrFor: ((font: FontInstance, groupScale: number) => string) | undefined = undefined,
  ownership: TextPathOwnership = createTextPathOwnership(),
): TextPathResult {
  const scale = fontSize / font.unitsPerEm;
  const run = features != null && features.length > 0
    // Enable-only projection — a caller whose list carries a disable hands in a
    // font already wrapped in the HarfBuzz proxy, which shapes with the full
    // list it was bound with and ignores this argument.
    ? font.layout(text, fontkitFeatureList(features))
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
      const cps = glyph.codePoints;
      const clusterSpan = sourceClusterSpan(
        text, textIdx, cps != null && cps.length > 0 ? cps.length : 1, false,
      );
      const rasterOwned = glyphUsesRasterRepresentation(font, fontKey, glyph, fontSize, weight, slant);
      if (rasterOwned) noteRasterGlyph(ownership);
      const dCmds = rasterOwned
        ? []
        : ownedCommandsFor(
          ownership, glyph, fontKey, weight, fontSize, slant,
          boundedSourceSpan(text, textIdx, textIdx + clusterSpan),
          text,
        );
      if (textIdx < xOffsets.length && dCmds.length > 0) {
        const defId = ensureGlyphDef(fontKey, weight, fontSize, slant, glyph.id, dCmds, stretch);
        const tx = xOffsets[textIdx] / scale + pos.xOffset;
        const ty = -pos.yOffset;
        uses.push(`<use href="#${defId}" x="${r2(tx)}" y="${r2(ty)}"/>`);
      }
      // Advance the text-index cursor by the cluster's char span: each BMP
      // codepoint in the cluster consumes 1 text index, each astral codepoint
      // consumes 2 (surrogate pair). Measured against the SOURCE text, not the
      // glyph's own `codePoints` — see `sourceClusterSpan` for why a shared
      // (memoized) Glyph misreports those. Good enough for the Latin ligature
      // cases we hit; Arabic/Devanagari/Thai re-ordering goes through the
      // multi-font run path, not here.
      textIdx += clusterSpan;
    }
    return {
      markup: uses.length > 0 ? `<g transform="scale(${sc},${-sc})"${fauxBoldAttrFor?.(font, sc) ?? ""}>${uses.join("")}</g>` : "",
      width: xOffsets[xOffsets.length - 1] + nativeWidth / Math.max(1, text.length),
      ownership,
    };
  }
  const usePerChar = xOffsets != null && xOffsets.length === run.glyphs.length;
  const sc = Number(scale.toFixed(5));
  const uses: string[] = [];
  let x = 0;
  let sourceCursor = 0;
  // Every glyph the shaper produced is emitted, `.notdef` included. Chrome does
  // the same: for a codepoint nothing covers, Blink's fallback iterator ends at
  // `kFirstCandidateForNotdefGlyph` and paints the RUN'S OWN font's `.notdef`
  // (`font_fallback_iterator.cc:159-164`, rev 7d859f27) — for macOS Helvetica a
  // hollow rectangle, 1298/2048 em wide.
  //
  // There used to be a private-use exception here that suppressed the `.notdef`
  // and drew a synthetic hollow rect (~0.7 × advance × 0.65 em) in its place.
  // It was a workaround for a defect one layer up, not a behaviour of Chrome's:
  // the terminal used to pin to the fallback chain's LAST entry, i.e. LastResort,
  // whose glyph is a rounded box with a `?` measuring 2253/2048 em — so it
  // overhung the following character, and suppressing it was the visible cure.
  // With the terminal on the primary (where Blink has it), the `.notdef`'s
  // advance IS the advance the capture recorded, so it cannot overhang, and
  // painting it is both simpler and pixel-identical to Chrome. The synthetic
  // rect never was: measured against Helvetica's real `.notdef` it is narrower
  // (0.71 em vs 0.90), shorter (0.65 em vs 0.72) and far thinner in the stroke.
  for (let i = 0; i < run.glyphs.length; i++) {
    const glyph = run.glyphs[i];
    const pos = run.positions[i];
    const cps = glyph.codePoints;
    const clusterSpan = sourceClusterSpan(
      text, sourceCursor, cps != null && cps.length > 0 ? cps.length : 1, false,
    );
    const rasterOwned = glyphUsesRasterRepresentation(font, fontKey, glyph, fontSize, weight, slant);
    if (rasterOwned) noteRasterGlyph(ownership);
    const eCmds = rasterOwned
      ? []
      : ownedCommandsFor(
        ownership, glyph, fontKey, weight, fontSize, slant,
        boundedSourceSpan(text, sourceCursor, sourceCursor + clusterSpan),
        text,
      );
    if (eCmds.length > 0) {
      const defId = ensureGlyphDef(fontKey, weight, fontSize, slant, glyph.id, eCmds, stretch);
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
        // DM-1184: when Chrome trimmed this fullwidth-punctuation glyph under
        // `text-spacing-trim` — detectable as a captured advance ~half the full
        // em — shift its ink by the font's `halt` xOffset so the full-width
        // outline lands where Chrome painted the half-width form (see
        // haltInfoFor). Gated on the captured advance actually being trimmed so
        // an untrimmed （ ） is left untouched.
        const cp0 = glyph.codePoints != null && glyph.codePoints.length > 0 ? glyph.codePoints[0] : undefined;
        if (cp0 != null && i + 1 < xOffsets!.length) {
          const fullAdv = pos.xAdvance * scale;                 // full em advance, CSS px
          const capturedAdv = xOffsets![i + 1] - xOffsets![i];  // what Chrome used, CSS px
          if (fullAdv > 0 && capturedAdv > 0 && capturedAdv < fullAdv * 0.75) {
            const halt = haltInfoFor(font, fontKey, cp0);
            if (halt.halved) tx += halt.xOffset; // font units
          }
        }
      } else {
        tx = (x + pos.xOffset) * xScale;
      }
      const ty = -pos.yOffset;
      uses.push(`<use href="#${defId}" x="${r2(tx)}" y="${r2(ty)}"/>`);
    }
    x += pos.xAdvance;
    sourceCursor += clusterSpan;
  }
  return {
    markup: uses.length > 0 ? `<g transform="scale(${sc},${-sc})"${fauxBoldAttrFor?.(font, sc) ?? ""}>${uses.join("")}</g>` : "",
    width: usePerChar ? (xOffsets![xOffsets!.length - 1] + nativeWidth / run.glyphs.length) : (targetWidth ?? nativeWidth),
    ownership,
  };
}


// DM-1026: does `cp` resolve to a `.notdef` (no real font in the chain covers
// it)? Mirrors the coverage resolution in `splitTextIntoFontRuns`'s walk —
// primary, then per-codepoint webfont variant, then the static fallback chain,
// then the CoreText system-fallback — but only the "is it covered anywhere"
// question (no Math-Alpha / NFD decomposition, which don't apply to a combining
// mark). Returns true when nothing but `last-resort` (or nothing) covers it.

// DM-1158: drop ORPHANED default-ignorable code points (see
// `isStrippableOrphanIgnorable`) from `text` + `xOffsets` so neither the
// embedded-font nor the glyph-path branch paints ink where Chrome paints none.
// "Orphaned" = no base char precedes it in the cluster: a variation selector
// that FOLLOWS a base (emoji presentation VS-16, CJK variation sequences) is
// meaningful, so it is left in place for the downstream emoji-overlay /
// shaping logic. A no-op for text with none.
//
// DM-1835: font coverage is deliberately NOT consulted. HarfBuzz hides every
// default-ignorable AFTER shaping, whether or not the font has a glyph for it:
// `hb_ot_hide_default_ignorables` (harfbuzz `src/hb-ot-shape.cc`) rewrites each
// glyph whose codepoint `_hb_glyph_info_is_default_ignorable` flags to the
// font's invisible/space glyph with a zero advance (and deletes it outright
// when no space glyph exists). The flag is a Unicode property of the CODEPOINT,
// never a cmap lookup. An earlier version of this function only stripped
// selectors the primary font did NOT cover, which left U+FE0F painting a box in
// the variation-selector fixture: that cell's stack leads with Apple Color
// Emoji, whose cmap DOES map U+FE0F (to a zero-advance, outline-less glyph). We
// then built an embedded subset whose only glyph had no outline at all, which
// Chrome's OTS rejects — so the consumer browser cascaded past our font and
// painted its own `.notdef` tofu for the PUA codepoint.
export function stripOrphanedDefaultIgnorables(
  text: string, xOffsets: number[] | undefined,
): { text: string; xOffsets: number[] | undefined } {
  let any = false;
  for (const ch of text) { if (isStrippableOrphanIgnorable(ch.codePointAt(0)!)) { any = true; break; } }
  if (!any) return { text, xOffsets };
  const haveX = xOffsets != null;
  let outText = "";
  const outX: number[] = [];
  let clusterHasBase = false;
  let changed = false;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const chLen = cp > 0xFFFF ? 2 : 1;
    const ch = text.slice(i, i + chLen);
    const isWs = chLen === 1 && /\s/.test(ch);
    const isMark = /\p{M}/u.test(ch);
    if (isStrippableOrphanIgnorable(cp) && !clusterHasBase) {
      // Drop it: emit no char and no x entry. The cluster base state is
      // unchanged (an ignorable never establishes a base).
      changed = true;
      i += chLen;
      continue;
    }
    if (isWs) clusterHasBase = false;
    else if (!isMark && !isStrippableOrphanIgnorable(cp)) clusterHasBase = true;
    outText += ch;
    if (haveX) for (let k = 0; k < chLen; k++) outX.push(xOffsets![i + k] ?? xOffsets![i] ?? 0);
    i += chLen;
  }
  if (!changed) return { text, xOffsets };
  return { text: outText, xOffsets: haveX ? outX : undefined };
}

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
  /** Computed CSS `font-stretch` (e.g. `"75%"`). */
  fontStretch?: string,
  /** Default shaped-cluster fallback feeds uncovered clusters through the same
   *  HarfBuzz syllabic shaper as Chromium. Retained for call-site compatibility;
   *  qualifying orphan marks are now made explicit before that splitter because
   *  its first-candidate `.notdef` run cannot reliably infer the source script.
   *  An explicit U+25CC makes the syllable based, so HarfBuzz does not insert a
   *  second circle. */
  shapeUncoveredOrphansNatively = false,
  fallbackRequest?: { rawSlope: number; orientation: number },
): { text: string; xOffsets: number[] | undefined } {
  // Fast path: nothing to do when the text has no combining marks AND the
  // capture probe flagged no codepoints (the latter can be category-Lo cluster
  // letters — e.g. Soyombo — that carry no \p{M}, DM-1157).
  if (!/\p{M}/u.test(text) && (dottedCircleMarks == null || dottedCircleMarks.length === 0)) {
    return { text, xOffsets };
  }
  // An EMPTY array means the capture probe ran and circled nothing — that is
  // authoritative (it vetoes the static block heuristic), so it maps to an empty
  // set, NOT null. Only `undefined` (no probe data) falls back to the heuristic.
  const coveredCircleSet = dottedCircleMarks != null ? new Set(dottedCircleMarks) : null;
  const primaryFontKey = resolveFontKey(fontFamily, lang);
  // The full declared stack, derived the same way the run splitters derive it —
  // the coverage probe below delegates to `resolveFontForCodepoint`, which walks
  // it (Blink's kFontFamily stage), so a mark covered only by a later-declared
  // family is "covered" here exactly when the emitter will paint it.
  const fontKeyChain = resolveFontKeyChain(fontFamily, lang);
  const stretch = stretchPercent(fontStretch);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch, lang);
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
  let dottedCircleRunFont: FontInstance | null | undefined;
  const resolveDottedCircleRunFont = (): FontInstance | null => {
    if (dottedCircleRunFont !== undefined) return dottedCircleRunFont;
    if (glyphIdForCp(primaryFont, 0x25CC) !== 0) return (dottedCircleRunFont = primaryFont);
    // Blink's family stage can select a later declared face as the first
    // candidate for .notdef. The macOS Vedic fixture is exactly that shape:
    // Mukta is absent, Arial Unicode lacks U+1CD1 but supplies U+25CC, so the
    // broken syllable is shaped on Arial rather than on the generic primary.
    for (const key of fontKeyChain) {
      const candidate = key === primaryFontKey ? primaryFont : getFontInstance(key, weight, fontSize, slant);
      if (candidate != null && glyphIdForCp(candidate, 0x25CC) !== 0) {
        return (dottedCircleRunFont = candidate);
      }
    }
    return (dottedCircleRunFont = null);
  };
  const resolveDottedCircleAdvance = (): number => {
    if (dottedCircleAdvanceCss >= 0) return dottedCircleAdvanceCss;
    dottedCircleAdvanceCss = 0;
    const advFrom = (cf: FontInstance | null): number | null => {
      const g = cf != null ? cf.glyphForCodePoint(0x25CC) : null;
      if (cf != null && g != null && g.id !== 0) return (g.advanceWidth ?? 0) * (fontSize / cf.unitsPerEm);
      return null;
    };
    const fromRunFont = advFrom(resolveDottedCircleRunFont());
    if (fromRunFont != null) { dottedCircleAdvanceCss = fromRunFont; return dottedCircleAdvanceCss; }
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
    const icu = icuCodepointProperties(cp);
    // ICU UCharCategory: NON_SPACING_MARK=6, ENCLOSING_MARK=7,
    // COMBINING_SPACING_MARK=8, FORMAT_CHAR=16. The pinned companion is the
    // production authority; Unicode regexes remain only the degraded fallback.
    const isMark = icu != null ? icu.generalCategory >= 6 && icu.generalCategory <= 8 : /\p{M}/u.test(ch);
    const isWs = chLen === 1 && /\s/.test(ch);
    const nextCp = i + chLen < text.length ? text.codePointAt(i + chLen)! : -1;
    // ICU Indic_Syllabic_Category=Joiner is 20 in the pinned companion. The
    // literal fallback is helper-absent degradation, not a script/font route.
    const shapingTransparentControl = icu != null ? icu.indicSyllabicCategory === 20
      : cp === 0x200C || cp === 0x200D;
    if (!clusterHasBase && shapingTransparentControl && nextCp >= 0
        && (coveredCircleSet?.has(i + chLen) === true)) {
      // A leading format control belongs to the following broken syllable. The
      // capture-side Chromium probe establishes whether that syllable receives
      // a dotted circle; HarfBuzz inserts it at the syllable start, before the
      // transparent prefix. This replaces the former Tamil ZWJ/codepoint pair
      // with the general shaping-machine rule.
      const joinerX = haveX ? (xOffsets![i] ?? 0) : 0;
      outText += "◌" + ch;
      if (haveX) outX.push(joinerX, joinerX);
      clusterHasBase = true;
      changed = true;
      i += chLen;
      continue;
    }
    if (needsSyntheticVowelConstraintCircle(cp, nextCp)) {
      // Current Chromium's HarfBuzz inserts U+25CC BETWEEN these invalid
      // base+dependent-vowel pairs before shaping. Our vendored harfbuzzjs
      // v1.4.0 predates these generated-table cases and CoreText does not
      // supply them either. Preserve the source anchors; the inserted circle
      // borrows the following vowel sign's captured anchor.
      outText += ch;
      if (haveX) for (let k = 0; k < chLen; k++) outX.push(xOffsets![i + k] ?? xOffsets![i] ?? 0);
      outText += "◌";
      if (haveX) outX.push(xOffsets![i + chLen] ?? xOffsets![i] ?? 0);
      clusterHasBase = true;
      changed = true;
      i += chLen;
      continue;
    }
    // Canvas cannot observe Linux's HarfBuzz insertion for zero-advance marks.
    // Ask the selected shaping face the logical question instead: with Blink's
    // resolved script, does shaping this orphan emit that face's U+25CC glyph?
    const orphaned = !clusterHasBase;
    const logicalHbRun = isMark && orphaned
      ? resolveDottedCircleHbRun(cp, primaryFont, primaryFontKey, weight, fontSize, slant,
        variationSettings, lang, fontKeyChain)
      : null;
    const fallbackScript = isMark ? segmentForShaping(ch)[0]?.script : undefined;
    const icuScriptTag = icu?.scriptName;
    const logicalScriptTag = icuScriptTag != null && icuScriptTag !== "Zinh"
      && icuScriptTag !== "Zyyy" && icuScriptTag !== "Zzzz"
      ? icuScriptTag
      : fallbackScript != null ? SCRIPT_NAME_TO_ISO15924[fallbackScript] : undefined;
    // Covered marks shape on their resolved mark face. An uncovered mark stays
    // on Blink's first candidate for `.notdef`, which is the run primary here.
    // In both cases ask the actual HarfBuzz proxy whether the bare orphan emits
    // that face's U+25CC glyph; no script/block membership participates.
    const logicalBaseFont = logicalHbRun?.font ?? primaryFont;
    const logicalFontKey = logicalHbRun?.key ?? primaryFontKey;
    const logicalShapeFont = isMark && orphaned
      ? harfbuzzShapedRunOverride(logicalBaseFont, logicalFontKey, weight, fontSize, slant,
        variationSettings, ch)
      : null;
    const logicalCircleGid = logicalShapeFont?.shapesWithHarfbuzz === true
      ? glyphIdForCp(logicalShapeFont, 0x25cc) : 0;
    const logicalLayout = logicalShapeFont?.shapesWithHarfbuzz === true && logicalScriptTag != null
      ? logicalShapeFont.layout(ch, undefined, logicalScriptTag, lang, "ltr")
      : null;
    const logicallyFlagged = logicalCircleGid !== 0
      && logicalLayout != null
      && logicalLayout.glyphs.some((g) => g.id === logicalCircleGid);
    // When capture supplied probe data, its answer is authoritative for
    // covered marks: an empty set means Chromium painted the mark bare (Tai
    // Tham), while a positive index means it painted a circle. Falling back to
    // the static shaper class despite an explicit negative answer duplicates
    // font/shaper-owned circles (Balinese) and invents circles for bare marks.
    // With no capture data (unit callers / old captures), use the same selected
    // face plus HarfBuzz shaping evidence rather than a codepoint range.
    const probeFlagged = coveredCircleSet != null
      ? coveredCircleSet.has(i)
      : logicallyFlagged;
    if (isMark || probeFlagged) {
      // The canvas probe is authoritative only for a glyph Chrome actually
      // painted. For an uncovered mark it observes the fallback face's bare
      // .notdef box, not HarfBuzz's broken-syllable decision, and therefore
      // commonly returns an empty array (the macOS Vedic CI route is Arial
      // Unicode's .notdef plus its real U+25CC). The selected-face HarfBuzz
      // result answers that uncovered case; keep the probe veto for covered
      // marks where Chromium's live paint is authoritative.
      const wantUncoveredCircle = logicallyFlagged;
      // DM-1851: HarfBuzz will not insert a dotted circle unless THE FONT USED
      // FOR THE RUN has a glyph for U+25CC. Transcribed from
      // `hb_syllabic_insert_dotted_circles` (`external/harfbuzz/src/hb-ot-shaper-syllabic.cc:51-53`,
      // rev 4de187d):
      //
      //     hb_codepoint_t dottedcircle_glyph;
      //     if (!font->get_nominal_glyph (0x25CCu, &dottedcircle_glyph))
      //       return false;
      //
      // Blink shapes with HarfBuzz on every platform, so this is Chrome's rule
      // rather than an approximation of it. Note what it is NOT about: the
      // MARK's coverage. Whether Chrome circles depends on U+25CC's coverage in
      // the face the run was shaped with, and the two come apart exactly where
      // this went wrong before — a mark nothing covers still gets a circle if
      // the run's font has one, and a covered mark gets none if it does not.
      //
      // The run's font here is the primary: an uncovered codepoint paints the
      // primary's `.notdef` (Blink's `kFirstCandidateForNotdefGlyph`), which is
      // the same face HarfBuzz would have been handed.
      //
      // ANDed with the existing conditions rather than replacing them. The probe
      // stands in for HarfBuzz's other requirement — a broken (base-less)
      // syllable — which we cannot read off the font. So this can only ever
      // REMOVE a circle we would otherwise have drawn, never add one.
      const runFontHasDottedCircle = resolveDottedCircleRunFont() != null;
      if (orphaned && wantUncoveredCircle && runFontHasDottedCircle
          && !(shapeUncoveredOrphansNatively && logicalShapeFont?.shapesWithHarfbuzz === true)
          && codepointResolvesToNotdef(cp, primaryFont, primaryFontKey, weight, fontSize, slant,
            variationSettings, lang, fontKeyChain, stackPrimaryIsSystemUi(fontFamily, lang), stretch,
            undefined, fallbackRequest?.rawSlope, fallbackRequest?.orientation)) {
        const adv = resolveDottedCircleAdvance();
        const markX = haveX ? (xOffsets![i] ?? 0) : 0;
        if (isLeftReorderingMatra(cp) || isRtlScriptCodepoint(cp)) {
          // "mark ◌" layout: the mark paints at the cell origin and the ◌ to its
          // RIGHT. Two cases land here:
          //   • DM-1109 — a pre-base (left) matra reorders BEFORE its base under
          //     the Universal Shaping Engine.
          //   • DM-1215 — an orphaned mark in an RTL SMP script (Sogdian, Old
          //     Uyghur, Garay, …): Chrome lays the cell out right-to-left, so the
          //     mark/tofu sits LEFT and the synthetic ◌ sits to its right.
          // Either way the leading glyph clears its full box, so the ◌ shifts
          // right by the mark tofu's advance.
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
      // DM-1212/DM-1157: this covered-path CENTERS the codepoint on the ◌ (for
      // combining marks with negative-x ink). It must stay gated to category-M
      // MARKS — a COVERED category-Lo letter that the ink probe false-positives
      // (e.g. a wide Egyptian hieroglyph U+130C3) would otherwise get a spurious
      // centered ◌ stamped over it. Uncovered orphaned Lo cluster letters
      // (Soyombo) are handled by the notdef path above instead.
      const coveredMarkResolution = probeFlagged && logicalHbRun == null
        ? resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant,
          variationSettings, lang, fontKeyChain, stackPrimaryIsSystemUi(fontFamily, lang), stretch,
          undefined, undefined, fallbackRequest?.rawSlope, fallbackRequest?.orientation)
        : null;
      const coveredMarkFont = logicalHbRun?.font
        ?? (coveredMarkResolution?.covered === true
          ? (coveredMarkResolution.fontOverride
            ?? (coveredMarkResolution.key === primaryFontKey ? primaryFont : getFontInstance(coveredMarkResolution.key, weight, fontSize, slant)))
          : null);
      if (isMark && orphaned && probeFlagged
          && coveredMarkFont != null
          && glyphIdForCp(coveredMarkFont, cp) !== 0
          && glyphIdForCp(coveredMarkFont, 0x25CC) !== 0
          // If the selected face's own layout already emitted its U+25CC gid,
          // keep the source cluster intact. The normal run shaper will produce
          // that same attached circle; materialising a separate "◌+mark"
          // string here splits fallback ownership and paints the two glyphs
          // apart (Miao/Brahmi). Only synthesize for a probe-positive face whose
          // layout facade does NOT already own the circle.
          && !logicallyFlagged
          && !fontAutoInsertsDottedCircle(coveredMarkFont, ch)
          // DM-1229 / DM-2020: U+302E–302F (the actual Hangul tone marks —
          // `isHangulTone` in `hb-ot-shaper-hangul.cc:130`, rev 4de187d;
          // U+302A–302D are the unrelated Mandarin/CJK ideographic tone marks
          // and do NOT get this treatment from HarfBuzz) must NOT take this
          // "◌ + centered-mark" path. Real HarfBuzz on the bare mark in Arial
          // Unicode MS already reproduces Chrome exactly by routing through the
          // DM-1215 dotted-circle HarfBuzz path (see `resolveDottedCircleHbRun`)
          // instead of our own synthesis here.
          //
          // The ordering our own synthesis would otherwise hard-code is NOT
          // simply "[mark, ◌]" — HarfBuzz's own rule (`hb-ot-shaper-hangul.cc:
          // 231-247`) picks `[u, ◌]` (mark left) unless `is_zero_width_char`
          // says the tone-mark glyph has zero advance in the run's font, in
          // which case it picks `[◌, u]` (circle left) instead; letting real
          // HarfBuzz shape the run (rather than re-deriving that rule here)
          // reproduces whichever ordering the font calls for. HarfBuzz's other
          // "move an ALREADY-attached tone mark in front of a valid preceding
          // syllable" rule (same file, :215-226) is a different code path
          // (a real base exists; this is the ORPHANED branch) and stays
          // unmodeled here — noted rather than implied as covered.
          && !(cp >= 0x302e && cp <= 0x302f)
          // DM-1126: skip LEFT-reordering matras (pre-base vowels, e.g. Grantha
          // U+11347/11348). Chrome paints them "matra ◌" (the matra reorders
          // BEFORE the synthetic circle), not "◌ + centered-mark" — the centering
          // here would mis-place them. They render correctly via the existing
          // path; no Vedic combining mark (the motivating case) is a left matra.
          && !isLeftReorderingMatra(cp)) {
        // DM-1126: covered mark Chrome circles (capture-detected) whose fontkit
        // primary won't auto-insert the ◌ (native-extractor Indic faces already
        // insert it — the guard above skips them to avoid a DOUBLE circle).
        // Insert it and anchor the ◌ at the
        // mark's captured cell origin; the combining mark draws onto the circle,
        // re-centered HarfBuzz-style (Mukta's marks have negative-x ink + no
        // GPOS anchor, so the per-char emitter needs the centered x baked in).
        const markX = haveX ? (xOffsets![i] ?? 0) : 0;
        const markCenteredX = markX + syntheticMarkCenteringOffsetPx(coveredMarkFont, ch, fontSize);
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
    } else if (shapingTransparentControl) {
      // Joiners and other format controls neither create nor clear a base.
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

/**
 * Tamil, Malayalam and Sinhala rows added to HarfBuzz's generated vowel-
 * constraint preprocessor after vendored harfbuzzjs v1.4.0. Transcribed from
 * `external/harfbuzz/src/hb-ot-shaper-vowel-constraints.cc` (rev 4de187d),
 * cases HB_SCRIPT_TAMIL / MALAYALAM / SINHALA.
 */
export function needsSyntheticVowelConstraintCircle(base: number, next: number): boolean {
  if (base === 0x0B85) return next === 0x0BC2;
  if (base === 0x0D07 || base === 0x0D09) return next === 0x0D57;
  if (base === 0x0D0E) return next === 0x0D46;
  if (base === 0x0D12) return next === 0x0D3E || next === 0x0D57;
  if (base === 0x0D85) return next === 0x0DCF || next === 0x0DD0 || next === 0x0DD1;
  if (base === 0x0D8B || base === 0x0D8F || base === 0x0D94) return next === 0x0DDF;
  if (base === 0x0D8D) return next === 0x0DD8;
  if (base === 0x0D91) {
    return next === 0x0DCA || next === 0x0DD9 || next === 0x0DDA
      || next === 0x0DDC || next === 0x0DDD || next === 0x0DDE;
  }
  return false;
}

// DM-655: split text into per-codepoint font runs the same way
// textToPathMarkup does — primary font first, fall back to per-codepoint
// webfont partitions, then the system fallback chain. Shared between the
// glyph-path emission path (textToPathMarkup) and the embedded-font path
// (renderTextAsEmbedded) so both make the SAME per-codepoint font
// decisions. Returns one run per consecutive same-font segment.

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
  /** DM-1859: the run's primary is the CSS `system-ui` keyword. Passed rather
   *  than derived, because `system-ui` and an explicitly-named "SF Pro" share
   *  the `sf-pro` key — see `stackPrimaryIsSystemUi`. */
  systemUiPrimary: boolean = false,
  /** CSS `font-stretch` as a percentage, 100 = `normal`. */
  stretch: number = 100,
  /** The run's `font-variant-emoji` override (`normal` = undefined). */
  fontVariantEmoji?: FontVariantEmojiOverride,
  /** DM-2017: the run's RAW CSS `font-family` stack, passed through to the
   *  Linux live resolver's standard-style retry — see
   *  `resolveSystemFallbackKeyForCp`'s `declaredFamily` param. */
  fontFamily?: string,
  /** OpenType features used by Blink's shape-then-requeue coverage verdict. */
  features?: string[],
  bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string },
  fallbackRequest?: { rawSlope: number; orientation: number },
): FontRun[] {
  // Default: fallback at shaped-cluster granularity — Blink's shape-then-
  // requeue mechanism (`ExtractShapeResults`, harfbuzz_shaper.cc:627-787, rev
  // 7d859f27) instead of the per-codepoint cmap walk below. A decline (null)
  // falls through to the legacy walk, and `DOMOTION_CLUSTER_FALLBACK=0`
  // restores it wholesale for an A/B. See docs/113-cluster-granularity-fallback.md.
  const clusterEnabled = clusterFallbackEnabled();
  if (clusterEnabled) {
    const shaped = splitTextIntoFontRunsShaped(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, fontVariantEmoji, fontFamily, {
      features, bidiOverride,
      fallbackRawSlope: fallbackRequest?.rawSlope,
      fallbackOrientation: fallbackRequest?.orientation,
    });
    if (shaped != null) return shaped;
  }
  const legacyMechanism: NonNullable<FontRun["routeMechanism"]> = clusterEnabled ? "cluster-decline-legacy" : "cluster-disabled-legacy";
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
      if (glyphIdForCp(primaryFont, cp) !== 0) {
        continue; // primary covers it — no fallback probe happens for this cp
      }
      // A webfont primary first tries a per-codepoint webfont variant before the
      // fallback chain; when the variant covers the cp the chain is never probed,
      // so exclude it here (don't warm fonts the walk won't touch). Variants are
      // webfonts (in-process fontkit), so this probe issues no helper round-trip.
      if (primaryFontKey.startsWith("webfont:")) {
        const family = primaryFontKey.slice("webfont:".length);
        const cpVariant = pickWebfontVariantForCodepoint(family, weight, fontSize, slant, cp, variationSettings, stretch);
        if (cpVariant != null && glyphIdForCp(cpVariant, cp) !== 0) {
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
      const key = chain.join("\0");
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
  // DM-1215: see `textToPathMarkup` — a dotted-circle cluster routed through real
  // HarfBuzz in the mark's own font so the mark lands on the ◌ exactly as Chrome
  // paints it. The embedded loop's cluster-aware anchoring (DM-1028) places each
  // HarfBuzz cluster at its captured xOffset and lays out the glyphs by shaped
  // advance + GPOS x/y offset. `clusterHasBase` flags orphaned marks (no spacing
  // base) — the case Chrome's HarfBuzz paints with an inserted ◌.
  let hbDottedCircleRun: { key: string; font: FontInstance } | null = null;
  let clusterHasBase = false;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const nextCp = i + ch.length < text.length ? text.codePointAt(i + ch.length)! : 0;
    // DM-1215: route an orphaned mark (or an explicit ◌ + mark) through HarfBuzz in
    // the mark's font — HarfBuzz inserts + GPOS-positions the ◌ like Chrome, where
    // fontkit omits it (Adlam / Miao) or mis-places it. Trailing marks join; a
    // spacing base / whitespace closes the cluster.
    const chIsMark = /\p{M}/u.test(ch);
    let clusterRun: { key: string; font: FontInstance } | null = null;
    if (hbDottedCircleRun != null) {
      if (chIsMark) clusterRun = hbDottedCircleRun;
      else hbDottedCircleRun = null;
    }
    if (clusterRun == null) {
      const markForCluster = (cp === 0x25CC && nextCp !== 0 && /\p{M}/u.test(String.fromCodePoint(nextCp)))
        ? nextCp
        : (chIsMark && !clusterHasBase) ? cp
        : 0;
      if (markForCluster !== 0) {
        const hbRun = resolveDottedCircleHbRun(markForCluster, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
        if (hbRun != null) { hbDottedCircleRun = hbRun; clusterRun = hbRun; }
      }
    }
    if (/\s/.test(ch) && ch.length === 1) clusterHasBase = false;
    else if (!chIsMark) clusterHasBase = true;
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
    // Explicit VS15/VS16 wins over `font-variant-emoji` (`HasVSFallbackPriority`,
    // `harfbuzz_shaper.cc:184-198`, rev 7d859f27).
    const effFve = (nextCp === 0xFE0E || nextCp === 0xFE0F) ? undefined : fontVariantEmoji;
    const res = clusterRun != null ? null : resolveFontForCodepoint(
      cp, primaryFont, primaryFontKey, weight, fontSize, slant,
      variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, effFve,
      fontFamily, fallbackRequest?.rawSlope, fallbackRequest?.orientation,
    );
    const emitCh = clusterRun != null ? ch : res!.emitCh;
    const useKey = clusterRun != null ? clusterRun.key : res!.key;
    const useFontOverride = clusterRun != null ? clusterRun.font : res!.fontOverride;
    const runChanged = useKey !== curKey || useFontOverride !== curFontOverride;
    if (runChanged && curText.length > 0) {
      const fvs = curKey === primaryFontKey ? variationSettings : undefined;
      // DM-1103: for the primary key use the resolved `primaryFont` directly so
      // the optical-cut opsz (injected by resolveFont from the family name)
      // survives — re-resolving via the collapsed key would lose it.
      const f = curFontOverride ?? (curKey === primaryFontKey ? primaryFont : getFontInstance(curKey, weight, fontSize, slant, fvs));
      if (f != null) runs.push({ fontKey: curKey, font: f, text: curText, startIdx: curStart, endIdx: i, isPrimary: curKey === primaryFontKey, routeMechanism: legacyMechanism });
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
    runs.push({ fontKey: curKey, font: f, text: curText, startIdx: curStart, endIdx: text.length, isPrimary: curKey === primaryFontKey, routeMechanism: legacyMechanism });
  }
  for (const run of runs) {
    run.font = harfbuzzShapedRunOverride(run.font, run.fontKey, weight, fontSize, slant,
      run.isPrimary ? variationSettings : undefined, run.text, features);
  }
  return runs;
}

/**
 * True when a CSS/SVG fill string is fully transparent — `transparent`, or an
 * `rgba()`/`hsla()` with a 0 alpha channel (the shape `colorStr()` and the
 * capture layer emit for `color: transparent`). Gradient/pattern refs
 * (`url(#…)`) and every opaque color form return false. Used to pick the
 * synthetic-bold stroke model for outline-only text (see
 * `resolveFakeBoldTextStroke`).
 */
function isFullyTransparentColor(fill: string): boolean {
  const f = fill.trim().toLowerCase();
  if (f === "transparent" || f === "none") return true;
  const m = /^(?:rgba|hsla)\(\s*[^)]*[,/]\s*(0|0?\.0+)\s*\)$/.exec(f);
  return m != null;
}

export type EmbeddedTextDeclineReason =
  | "primary-font-unresolved"
  | "empty-shaped-runs"
  | "layout-failed"
  | "glyph-outline-unavailable"
  | "pua-exhausted"
  | "all-raster-owned"
  | "all-inkless"
  | "no-emittable-glyphs";

export interface EmbeddedTextAttempt {
  markup: string | null;
  decline?: {
    reason: EmbeddedTextDeclineReason;
    glyphDisposition?: Exclude<ReturnType<typeof resolveGlyphCommands>["disposition"], "source-outline" | "helper-outline" | "legitimately-inkless">;
  };
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
 * Returns a classified decline when the run can't be embedded (resolveFont
 * failed, a glyph outline is missing, or the PUA-A block ran out). The
 * coordinator records the reason and enters paths mode.
 */
function renderEmbeddedGlyphRuns(
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
  /** Computed CSS `font-stretch` (e.g. `"75%"`). */
  fontStretch?: string,
  /** The run's `font-variant-emoji` override (`normal` = undefined). */
  fontVariantEmoji?: FontVariantEmojiOverride,
  /** DM-1971: the run's `font-synthesis` permissions. Absent = `auto`. */
  fontSynthesis?: FontSynthesisAllowance,
  /** CSS bidi override applied before Blink's script/run segmentation. */
  bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string },
  fallbackRequest?: { rawSlope: number; orientation: number },
): EmbeddedTextAttempt {
  const { weight, slant, stretch } = textFontRequest(fontWeight, fontStyle, fontStretch);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch, lang);
  if (primaryFont == null) return { markup: null, decline: { reason: "primary-font-unresolved" } };
  const primaryFontKey = resolveFontKey(fontFamily, lang);
  const fontKeyChain = resolveFontKeyChain(fontFamily, lang);
  // DM-1103: the optical-cut opsz `resolveFont` pinned for the primary face,
  // folded into the per-instance embed key below so a cut-pinned run (e.g.
  // "SF Pro Text" → opsz 17) doesn't dedup-collide with a generic SF Pro run
  // that shares the collapsed `sf-pro` key at the same weight/slant.
  const primaryCutOpsz = opticalCutOpszFor(fontFamily, lang);

  const runs = splitTextIntoFontRuns(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, stackPrimaryIsSystemUi(fontFamily, lang), stretch, fontVariantEmoji, fontFamily, features, bidiOverride, fallbackRequest);
  if (runs.length === 0) return { markup: null, decline: { reason: "empty-shaped-runs" } };

  // Same reroute as the glyph-path branch (textToPathMarkup): a feature list
  // carrying a disable or an explicit value shapes through HarfBuzz with the
  // full list bound, since neither fontkit nor the platform helpers can honor
  // it. The proxy's glyph ids live in the same gid space as the file the
  // embedded subset is cut from, so the subset carries exactly the glyphs the
  // proxy shaped. See `fontFeatureValueShapingOverride`.
  if (featureListNeedsHbShaping(features)) {
    for (const run of runs) {
      const fvs = run.isPrimary ? variationSettings : undefined;
      run.font = fontFeatureValueShapingOverride(run.font, run.fontKey, weight, fontSize, slant, fvs, features!);
    }
  }
  recordRendererRuns("embedded-font", text, runs, {
    fontFamily, fontWeight: weight, fontStyle, fontStretch: stretch, fontSizePx: fontSize,
    variationSettings, features, language: lang, fontVariantEmoji,
  });

  // Per-run baseline: SVG `<text y=...>` puts the BASELINE at y. Use the
  // captured Chrome `fontBoundingBoxAscent` when provided (matches what
  // Chrome's text engine measured on the original page); else fall back
  // to the primary font's HHEA ascent scaled to fontSize.
  const baselineY = embeddedBaselineY(
    y, fontSize, primaryFont.unitsPerEm, primaryFont.ascent, ascentOverride,
  );

  const esc = escAttr;
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
  let rasterOwnedGlyphs = 0;
  let inklessGlyphs = 0;
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
  //
  // That 0.7 isn't applied continuously: `SimpleFontData::CreateScaledFontData`
  // (same file) rounds the scaled size to a whole pixel BEFORE building the
  // synthesized font — `lroundf(font_description.ComputedSize() * scale_factor)`
  // — so a 16px run gets an 11px small-caps glyph (16 × 0.7 = 11.2 → round →
  // 11), not an unrounded 11.2px one. `emitFontSize` below is `fontSize ×
  // runScale`, so expressing the scale as the per-size RATIO
  // `roundedSize / fontSize` (rather than a flat 0.7) makes that product land
  // on Blink's rounded pixel size exactly.
  const SMALL_CAP_SCALE = synthesizedSmallCapsScale(fontSize);
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
    // DM-1971: same narrow veto as the paths branch — see `capsSynthOk` there.
    // Reporting the feature as PRESENT is how the veto is expressed: every
    // synthesis site below is `want<F> && !fontHas("<f>")`, so a present
    // feature means no stand-in, and shaping still asks for the tag (harmless
    // when the face lacks it, correct when it does not).
    const capsSynthOk = synthesisAllowed(fontSynthesis, "smallCaps");
    const fontHas = (f: string) => !capsSynthOk || availableFeatures.includes(f);
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
      const runDirection = run.shapingDirection ?? shapingDirectionAt(text, run.startIdx);
      layout = features != null && features.length > 0
        ? run.font.layout(shapingText, fontkitFeatureList(features), run.shapingScript, lang, runDirection)
        : run.font.layout(shapingText, undefined, run.shapingScript, lang, runDirection);
    } catch {
      return { markup: null, decline: { reason: "layout-failed" } };
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
    // DM-1698: fold the RESOLVED axis location into the key. A variable font
    // with an `opsz` axis (SF Pro = the macOS system-ui) resolves a DIFFERENT
    // optical instance per font size (auto optical sizing pins opsz to the
    // size), but nothing size-derived was in the key — so a page mixing sizes
    // collapsed every size into ONE entry and the first-seen size's outlines
    // won for shared glyph ids (tracking is idempotent per (key, gid)). The
    // wavy-underline fixture's 36px row rendered with opsz-13 outlines: ~1px
    // ink shift and subtly wrong shapes ("font size doesn't seem right").
    const srcInfo = getFontSourceInfo(run.font);
    const axesTuple = srcInfo?.variationAxes != null && Object.keys(srcInfo.variationAxes).length > 0
      ? "|ax=" + Object.keys(srcInfo.variationAxes).sort().map((k) => `${k}=${srcInfo.variationAxes![k]}`).join(",")
      : "";

    // Ascent/descent are font-wide metrics that drive baseline placement
    // when the consumer browser lays out our PUA codepoints. Use the run
    // font's own metrics so glyphs from this run sit on their natural
    // baseline (matching what Chrome would render with the original font).
    const runAscent = run.font.ascent;
    const runDescent = run.font.descent;

    // DM-1693: faux-bold for a resolved STATIC face that lacks the requested
    // weight. Chrome (via fontconfig/FreeType on Linux, CoreText/DirectWrite
    // elsewhere) emboldens such a face algorithmically; the embedded `@font-face`
    // otherwise paints the thin natural outline (the descriptor already carries
    // the requested weight, so the consumer browser synthesizes nothing). When
    // the requested weight exceeds the face's natural weight by a wide margin
    // AND no variable `wght` axis carries the weight, bake the same dilation
    // into the embedded outline. Threshold + strength are empirically calibrated
    // against Chrome-on-Linux's painted ink (see embolden-outline.ts). Fonts WITH
    // the weight (a real bold sibling / a baked wght axis) resolve to that face,
    // so their natural weight ≈ requested → delta small → no embolden.
    //
    // Stroked runs used to be gated OFF entirely (design-space vs device-space
    // edge residual traced by the stroke). Chrome-on-Linux, however, implements
    // synthetic bold as a STROKE-frame inflation (Skia `useStrokeForFakeBold`,
    // SkScalerContext.cpp:1019-1041) — both the fill pass and the
    // `-webkit-text-stroke` pass grow by `extra = fontSize/24…/32`, so leaving
    // the stroke at its CSS width painted a hairline where Chrome paints a
    // `w + extra` band. `resolveFakeBoldTextStroke` (embolden-outline.ts) maps
    // Chrome's two emboldened passes onto our flat SVG emit: on Linux the
    // emitted stroke widens to `w + extra` (default paint order / transparent
    // fill) or the fill emboldens with the stroke kept at `w` (stroke-first +
    // opaque fill, where the fill covers the stroke's inner half). Other
    // platforms keep the previous behavior (embolden only unstroked runs).
    // DM-1984: the predicate itself moved to `synthesis-decision.ts` so paths
    // mode reads the SAME one rather than re-deriving it. Its per-platform
    // transcription (macOS `Weight() > 500` + `kCTFontTraitBold`, Linux's
    // `> 200 + typeface weight` delta, Windows' `>= 600` + `isBold()`, and the
    // fourth platform-independent webfont-descriptor rule) is documented there.
    const faceLacksWeight = faceNeedsSyntheticBold(run.font, weight, fontSynthesis);
    const runStrokeFirst = paintOrder != null && /^\s*stroke(?:\s|$)/.test(paintOrder);
    const fakeBoldStroke = resolveFakeBoldTextStroke({
      strokeWidthPx: (textStrokeWidth != null && textStrokeWidth > 0
        && textStrokeColor != null && textStrokeColor !== "") ? textStrokeWidth : 0,
      strokeFirst: runStrokeFirst,
      fillIsTransparent: isFullyTransparentColor(fill),
      faceLacksWeight,
      fontSizePx: fontSize,
    });
    const emboldenStrengthFU = fakeBoldStroke.emboldenFill
      ? emboldenStrengthForFont(run.font.unitsPerEm) : 0;

    // DM-1695: faux-italic. Embedded mode BAKES the shear into the outline (the
    // @font-face descriptor stays italic, so the consumer synthesizes nothing).
    // A shear is a pure affine transform, so — unlike faux-bold — it reproduces
    // Chrome's device-space skew exactly and is safe on stroked runs too (no
    // gate). Paths mode applies the same factor as a group `skewX`; the
    // WHETHER is the shared predicate, only the HOW differs. DM-1984.
    const shearFactor = faceNeedsSyntheticOblique(run.font, blinkRequestedSlopeDegrees(fontStyle), fontSynthesis)
      ? OBLIQUE_SHEAR : 0;

    // DM-1722: for a STATIC-weight source on the hinted path (no wght axis,
    // no faux-bold bake), the glyph outlines are identical at every requested
    // CSS weight — the file is what it is. Requested weight then only matters
    // for the @font-face descriptor, so drop it from the key and let the
    // builder emit a `font-weight: min max` RANGE descriptor covering every
    // weight tracked into the entry. Collapses e.g. the two Arial entries a
    // page requesting weights 400 and 500 used to carry — each duplicating
    // Arial's ~6 KB fixed hinting program (cvt/fpgm/prep).
    // The shared entry must be keyed on the SOURCE FILE identity, not the
    // logical fontKey: one key (e.g. `helvetica`) resolves per-weight to
    // DIFFERENT faces (Regular vs the Bold TTC member), and collapsing those
    // into one `w=*` entry made first-seen-file glyphs win for every weight
    // (a 400-weight body line rendered from the Bold face's gids).
    // Source-file identity requires a NAMED member: when the requested
    // PostScript name is not a physical member of the file, `faceIndex` is null,
    // and `path#null` is the same string for every face in that container —
    // which would collapse e.g. PingFang SC and HK (same .ttc, different
    // outlines: measured 4665 vs 4680 path chars for the same glyph id) into one
    // shared entry, the exact first-seen-face-wins bug the comment above
    // describes. Fall back to per-weight keying when the member can't be named.
    const staticWeightShared = srcInfo != null && srcInfo.nameMatched && srcInfo.faceIndex != null
      && srcInfo.variationAxes?.wght == null && !emboldenStrengthFU;
    const weightPart = staticWeightShared
      ? `w=*|src=${srcInfo!.path}#${srcInfo!.faceIndex}`
      : `w=${weight}`;
    // DM-1971: the SYNTHESIS BAKE is part of the entry's identity. Two runs can
    // agree on family, weight, slant, features and axes and still need different
    // outlines, because one baked a faux-bold dilation or a faux-oblique shear
    // and the other was vetoed by `font-synthesis`. Without this, the second run
    // silently reuses the first's entry and paints the synthesis it asked NOT to
    // have — measured: `font-style: italic` with and without
    // `font-synthesis-style: none` both resolved to one italic entry, so the
    // veto changed nothing in the output. (The bold pair escaped only by
    // accident: `emboldenStrengthFU` already forces `weightPart` off the shared
    // `w=*` form, so its two arms keyed apart for an unrelated reason.)
    const synthPart = `|b=${emboldenStrengthFU}|sh=${shearFactor}`;
    const instanceKey = `${run.fontKey}|${weightPart}|s=${slant}${fvsTuple}${cutTuple}${axesTuple}${synthPart}`;


    // DM-1714/DM-1716: tag the run with the sfnt file it resolved to, so the
    // embedded builder can hb-subset the ORIGINAL (hinted) font instead of the
    // outline-only svg2ttf rebuild. Variable faces are covered too: the source
    // info carries the axis location the run resolved to (`variationAxes`), and
    // the builder pins the subset to that location — hb applies the same gvar
    // deltas fontkit's getVariation did, so the instanced subset's outlines
    // match what this run shaped with (and hinting survives instancing).
    // Webfont instances return null here (no backing file) and keep svg2ttf.
    const hintedSource = srcInfo;

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
      const firstTextCp = run.text.codePointAt(0);
      const lastTextCp = run.text.codePointAt(run.text.length - (run.text.codePointAt(run.text.length - 2)! > 0xFFFF ? 2 : 1));
      // DM-1849: a `.notdef` (id 0) never identifies a codepoint. fontkit
      // memoizes ONE Glyph per glyph id, so every uncovered codepoint in a font
      // shares one `.notdef` instance whose `codePoints` is whichever codepoint
      // materialized it FIRST in this process — process-global state wearing the
      // costume of per-glyph data. Asking it "which char are you?" breaks BOTH
      // ways here: a stale value that happens to equal `lastTextCp` fakes RTL on
      // an LTR run, and a genuinely RTL run whose first glyph is tofu fails the
      // test and gets walked LTR. Either mis-anchors every glyph in the run, and
      // neither reproduces in a single-fixture run because the first miss is
      // then the fixture's own.
      const firstGlyph = layout.glyphs[0];
      if (firstGlyph.id !== 0) {
        const firstGlyphCp = firstGlyph.codePoints?.[0];
        if (firstGlyphCp != null && firstGlyphCp === lastTextCp && firstTextCp !== lastTextCp) {
          runIsRtl = true;
        }
      } else if (layout.clusters != null && layout.clusters.length >= 1) {
        // Source-derived and trustworthy: an RTL shaper emits the LAST cluster
        // first, so the first glyph's source index is past the start.
        runIsRtl = layout.clusters[0] > 0;
      }
      // No `else`: with a `.notdef` first glyph and no cluster data there is no
      // sound signal here, so the LTR default stands — same as before this
      // change, since the old comparison against a stale codepoint would have
      // failed too. Deliberately NOT falling back to `isRtlScriptCodepoint`,
      // which is SMP-only (`RTL_SMP_SCRIPT_RANGES`) and answers false for BMP
      // Hebrew and Arabic — it would have walked the most common RTL text as
      // LTR while looking like a fix. The residual case is a genuinely RTL run
      // whose first glyph is tofu AND which was shaped without clusters.
    }
    // Walk the shaped glyph stream. For each glyph: convert its cluster's
    // first-codepoint xOffset to a CSS pixel x, OR fall back to the
    // accumulated cursor when no xOffsets are present (or the cluster
    // boundary doesn't have one). The cluster's UTF-16 span is measured from
    // the SOURCE text (BMP=1, astral=2) rather than from the glyph's own
    // `codePoints`, which a memoized/shared Glyph misreports — see
    // `sourceClusterSpan`. A missing or empty codePoints array (decomposed
    // glyphs, native-helper glyphs) counts as one source codepoint, so the
    // cursor still advances.
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
      // DM-2410: retain color glyphs in the ORIGINAL shaped run so their
      // advances continue to position later outlines, but do not insert an
      // empty stand-in into the embedded subset. On macOS Skia makes exactly
      // this metrics-vs-paint split: a color typeface sets `neverRequestPath`
      // while `CTFontGetAdvancesForGlyphs` still supplies the run advance
      // (`SkScalerContext_mac_ct.cpp:297-311`, rev ebf5052). Rewriting the
      // source cluster to U+200B upstream collapsed that advance; embedding an
      // empty PUA glyph here risks the consumer painting `.notdef`. The raster
      // overlay owns the paint, while this shaped glyph still owns placement.
      const rasterOwned = glyphUsesRasterRepresentation(
        run.font, run.fontKey, glyph, fontSize, weight, slant);
      const commandResolution = rasterOwned
        ? null
        : resolveGlyphCommands(glyph, run.fontKey, weight, fontSize, slant);

      let xCss: number;
      let yCss = 0;
      let glyphScale: number;
      // DM-1867: this glyph's index into the WHOLE captured text. Both branches
      // below already compute it, but each in its own scope, so it was not
      // reachable from the inkless check further down — which therefore read the
      // glyph's `codePoints` and, for any glyph fontkit memoized, could get a
      // different character's answer. Hoisted rather than recomputed so there is
      // one derivation and the two cannot drift.
      let glyphSrcIdx: number | undefined;
      if (clusters != null) {
        // CoreText-shaped run: cluster-aware anchoring + GPOS offsets.
        const srcIdx = clusters[i];
        const wholeTextIdx = run.startIdx + srcIdx;
        glyphSrcIdx = wholeTextIdx;
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
        // DM-1184: nudge trimmed fullwidth-punctuation ink (see
        // cjkTrimShiftFontUnits). Only at a cluster's first glyph, gated on the
        // captured advance to the next char being trimmed (~half em).
        let trimShiftFU = 0;
        // DM-1849: source first. `wholeTextIdx` is this cluster's first source
        // char, which is exactly what the trim logic wants, and it cannot be
        // aliased by a shared Glyph the way `codePoints` can.
        const cpCl = text.codePointAt(wholeTextIdx) ?? glyph.codePoints?.[0];
        if (cpCl != null && xOffsets != null) {
          const nextCharIdx = wholeTextIdx + (cpCl > 0xFFFF ? 2 : 1);
          if (xOffsets[wholeTextIdx] != null && xOffsets[nextCharIdx] != null) {
            trimShiftFU = cjkTrimShiftFontUnits(run.font, run.fontKey, glyph, cpCl,
              xOffsets[nextCharIdx] - xOffsets[wholeTextIdx], fontSize, runScale);
          }
        }
        xCss = clusterAnchorCss + (clusterCursorFU + pos.xOffset + trimShiftFU) * runScale;
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
        const span = sourceClusterSpan(
          run.text, textIdx, cps != null && cps.length > 0 ? cps.length : 1, runIsRtl);
        // For RTL runs, textIdx walks backwards: the cluster's first
        // logical char sits at (textIdx - span), so subtract BEFORE lookup
        // so the lookup index lands on the cluster's first char.
        if (runIsRtl) textIdx -= span;
        const wholeTextIdx = run.startIdx + textIdx;
        glyphSrcIdx = wholeTextIdx;
        if (xOffsets != null && xOffsets[wholeTextIdx] != null) {
          xCss = xOffsets[wholeTextIdx];
          // DM-1184: nudge trimmed fullwidth-punctuation ink (see
          // cjkTrimShiftFontUnits) in the fontkit-shaped embedded path too.
          // DM-1849: source first, as above.
          const cp0 = text.codePointAt(wholeTextIdx) ?? glyph.codePoints?.[0];
          if (cp0 != null) {
            const nextCharIdx = wholeTextIdx + (cp0 > 0xFFFF ? 2 : 1);
            if (xOffsets[nextCharIdx] != null) {
              const shiftFU = cjkTrimShiftFontUnits(run.font, run.fontKey, glyph, cp0,
                xOffsets[nextCharIdx] - xOffsets[wholeTextIdx], fontSize, runScale);
              if (shiftFU !== 0) xCss = xCss + shiftFU * runScale;
            }
          }
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
      // DM-1675: don't EMIT a glyph for a legitimately-inkless codepoint (ZWSP,
      // ZWJ/ZWNJ, other Cf/Cc format chars, variation selectors, tags — and
      // whitespace separators). Chrome paints NO ink for any of these, so their
      // advance is all that matters, and that's already handled by the cursor
      // below. But the resolved font's glyph for them is often a zero-width form
      // the embedded subset then paints as a visible tofu BOX (Chrome maps the
      // PUA codepoint to the subset's `.notdef`). The prime case: `::first-letter`
      // suppression replaces the consumed first letter with U+200B (ZWSP); paths
      // mode drops it (no outline), but the embedded path was tracking+emitting
      // a box for every drop cap. Skipping emission is safe for real spaces too —
      // a blank glyph paints nothing whether emitted or not, and the gap comes
      // from the advance. (The glyph is still tracked above so cursor/textIdx
      // stay aligned; it's just left unreferenced — harmless, like any unused
      // subset glyph.) This also retires the DM-1689 variation-selector boxes.
      // DM-1867: decide from the SOURCE character at this glyph's position.
      // Reading `glyph.codePoints` here was the same aliasing hazard the notdef
      // checks had: fontkit memoizes `Glyph` objects by glyph id, so a glyph
      // shared across codepoints reports whichever was probed first. Getting it
      // wrong is not cosmetic in either direction — a stale INKLESS value drops
      // a real tofu box, and a stale inkable one keeps a box Chrome never paints.
      // Falls back to `codePoints` only when the index is out of range, which
      // means the cluster map disagreed with the text.
      const srcCpForInk = glyphSrcIdx != null ? text.codePointAt(glyphSrcIdx) : undefined;
      const glyphInkless = srcCpForInk != null
        ? isLegitimatelyInklessCodepoint(srcCpForInk)
        : (glyph.codePoints != null && glyph.codePoints.length > 0
          && glyph.codePoints.every((cp) => isLegitimatelyInklessCodepoint(cp)));
      let placement: ReturnType<typeof trackGlyphInEmbedFont> = null;
      if (rasterOwned) {
        rasterOwnedGlyphs++;
      } else if (glyphInkless) {
        inklessGlyphs++;
      } else if (commandResolution == null || commandResolution.commands.length === 0) {
        return {
          markup: null,
          decline: {
            reason: "glyph-outline-unavailable",
            ...(commandResolution == null
              || commandResolution.disposition === "source-outline"
              || commandResolution.disposition === "helper-outline"
              || commandResolution.disposition === "legitimately-inkless"
              ? {}
              : { glyphDisposition: commandResolution.disposition }),
          },
        };
      } else {
        placement = trackGlyphInEmbedFont(
          instanceKey, run.font.unitsPerEm, runAscent, runDescent,
          glyph.id, commandResolution.commands, glyph.advanceWidth,
          // The descriptor exactly matches the already-resolved/baked face;
          // the consumer browser performs neither face selection nor shaping.
          { italic: slant !== 0, weight, emboldenStrengthFU, shearFactor, hintedSource, runToken: run },
        );
        if (placement == null) {
          return { markup: null, decline: { reason: "pua-exhausted" } };
        }
        if (runCssFamily == null) runCssFamily = placement.cssFamily;
      }
      if (!rasterOwned && !glyphInkless && placement != null) {
        perGlyph.push({ pua: String.fromCodePoint(placement.puaCodepoint), xCss, yCss, scale: glyphScale });
      }
      // DM-2020: HarfBuzz doesn't just hide a default-ignorable's ink after
      // shaping — `hb_ot_zero_width_default_ignorables` (hb-ot-shape.cc:779-796,
      // rev 4de187d) zeroes its ADVANCE too, so it never widens the run even
      // when it sits attached to a base (the ATTACHED case is the one that
      // reaches here — an orphaned one was already dropped by
      // `stripOrphanedDefaultIgnorables` upstream and never gets this far).
      // Scoped to `isHarfbuzzDefaultIgnorable` specifically, NOT the broader
      // `glyphInkless`/`isLegitimatelyInklessCodepoint` set above — that set
      // also covers genuine whitespace (Zs), whose advance is real width and
      // must NOT be zeroed. Whenever a captured `xOffset` exists for the NEXT
      // character this is inert (each glyph is anchored at its own captured
      // position, so a stray advance here never propagates), but it is not
      // inert for a run with no captured offsets — the accumulated-advance
      // fallback path this same file uses when Chrome didn't record per-char
      // positions — or for a multi-glyph cluster's WITHIN-cluster cursor,
      // both of which read `runCursorFontUnits`/`clusterCursorFU` directly.
      const srcCpsForAdvance = srcCpForInk != null ? [srcCpForInk] : (glyph.codePoints ?? []);
      const zeroAdvance = srcCpsForAdvance.length > 0 && srcCpsForAdvance.every((cp) => isHarfbuzzDefaultIgnorable(cp));
      runCursorFontUnits += zeroAdvance ? 0 : pos.xAdvance;
    }
    // A run made entirely of selected raster glyphs contributes advance but no
    // embedded glyph segment. Keep walking so adjacent vector runs remain in
    // embedded mode; if every run is raster-owned, `pending` stays empty and
    // the coordinator declines cleanly to the path/overlay boundary below.
    if (perGlyph.length === 0 || runCssFamily == null) {
      cssX += runCursorFontUnits * runScale;
      continue;
    }

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
    // DM-1970: a synthetic-bold frame is painted in the FILL color and has no
    // CSS stroke behind it, so it carries its own colour rather than reading
    // `textStrokeColor` (which is null on these runs — the old guard would have
    // dropped the frame entirely).
    if (fakeBoldStroke.strokeIsFakeBold === true && fakeBoldStroke.strokeWidthPx > 0) {
      strokeAttr = ` stroke="${esc(fill)}" stroke-width="${r2(fakeBoldStroke.strokeWidthPx)}"`;
    } else if (fakeBoldStroke.strokeWidthPx > 0 && textStrokeColor != null && textStrokeColor !== "") {
      // `fakeBoldStroke.strokeWidthPx` is the CSS width plus Chrome-on-Linux's
      // synthetic-bold inflation when this run's face lacks the weight (see the
      // faux-bold block above); elsewhere it's the CSS width unchanged.
      strokeAttr = ` stroke="${textStrokeColor}" stroke-width="${r2(fakeBoldStroke.strokeWidthPx)}"`;
      if (runStrokeFirst) {
        strokeAttr += ` paint-order="stroke fill"`;
      }
    }
    pending.push({ perGlyph, runCssFamily, weightAttr, italicAttr, fvsAttr, strokeAttr });
    cssX += runCursorFontUnits * runScale;
  }

  if (pending.length === 0) {
    const reason: EmbeddedTextDeclineReason = rasterOwnedGlyphs > 0 && inklessGlyphs === 0
      ? "all-raster-owned"
      : inklessGlyphs > 0 && rasterOwnedGlyphs === 0
        ? "all-inkless"
        : "no-emittable-glyphs";
    return { markup: null, decline: { reason } };
  }
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
      const xList = slice.map((g) => r2(x + g.xCss * xScale)).join(" ");
      const puaStream = slice.map((g) => g.pua).join("");
      const emitFontSize = r2(fontSize * runScale);
      // DM-1028: emit a per-glyph y-list only when a glyph carries a vertical
      // GPOS offset (Brahmic marks stacked above/below their base). The common
      // case (all glyphs on the baseline) keeps the single `y` attribute and
      // the smaller markup.
      const anyY = slice.some((g) => g.yCss !== 0);
      const yAttr = anyY
        ? `y="${slice.map((g) => r2(baselineY + g.yCss)).join(" ")}"`
        : `y="${r2(baselineY)}"`;
      segments.push(`<text x="${xList}" ${yAttr} font-family="${p.runCssFamily}" font-size="${emitFontSize}"${p.weightAttr}${p.italicAttr}${p.fvsAttr} fill="${fill}"${p.strokeAttr}>${puaStream}</text>`);
      runStart = runEnd;
    }
  }

  if (segments.length === 0) return { markup: null, decline: { reason: "no-emittable-glyphs" } };

  // Accessibility: wrap the per-font `<text>` segments in a labeled <g>
  // so screen readers + Find-In-Page see the ORIGINAL text. The visible
  // glyph stream is PUA codepoints, which AT would otherwise read as
  // garbage. The aria-label / <title> carry the human-readable form.
  return { markup: `<g role="img" aria-label="${esc(text)}"><title>${esc(text)}</title>${segments.join("")}</g>` };
}

/** Embedded-mode coordinator; shaping/subsetting/emission lives above. */
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
  textStrokeWidth?: number,
  textStrokeColor?: string,
  paintOrder?: string,
  targetWidth?: number,
  fontStretch?: string,
  fontVariantEmoji?: FontVariantEmojiOverride,
  fontSynthesis?: FontSynthesisAllowance,
  bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string },
  fallbackRequest?: { rawSlope: number; orientation: number },
): EmbeddedTextAttempt {
  return renderEmbeddedGlyphRuns(
    text, x, y, fontSize, fontFamily, fontWeight, fill, xOffsets, fontStyle,
    ascentOverride, features, lang, variationSettings, textStrokeWidth,
    textStrokeColor, paintOrder, targetWidth, fontStretch, fontVariantEmoji,
    fontSynthesis, bidiOverride, fallbackRequest,
  );
}

/**
 * Depth counter, >0 while the tree renderer is emitting inside an ancestor CSS
 * `<g transform>` group. Baseline pixel-grid snapping (see `renderTextAsPath`)
 * is suppressed there: Skia's glyph y-rounding happens in DEVICE space, after
 * the full transform, so rounding the LOCAL baseline under a scale/rotation/
 * fractional-translation ancestor would land on a different device y than
 * Chrome's paint (measured on the preserve-3d feature fixture, where the
 * perspective-projected `translateZ` scale turned a local-space snap into a
 * regression). Unsnapped local coordinates are the closer approximation there.
 */
let baselineSnapSuppressionDepth = 0;
export function pushBaselineSnapSuppression(): void {
  baselineSnapSuppressionDepth++;
}
export function popBaselineSnapSuppression(): void {
  if (baselineSnapSuppressionDepth > 0) baselineSnapSuppressionDepth--;
}

/**
 * The font context shared by `renderTextAsPath` and the measurement helpers
 * (`getDecorationMetrics`, `fontSpaceAdvancePx`, `measureLastGlyphRsb`,
 * `measureInkMetrics`, `computeSkipInkGaps`, `renderStretchyFenceGlyph`,
 * `renderRadicalGlyph`). One object, so a run's glyph emission and its
 * measurements resolve the SAME face — the positional lists this replaced let
 * the two drift (a helper that never grew the newest parameter measured a
 * different cut than the one the glyphs came from).
 */
export interface TextFontOptions {
  fontSize: number;
  fontFamily: string;
  /** CSS `font-weight` — numeric string (`"700"`) or number. */
  fontWeight: string | number;
  /** CSS font-style; 'italic' / 'oblique' activate SF Pro's slnt axis. */
  fontStyle?: string;
  /** Blink FontOrientation numeric value for fallback-cache identity. The
   * normal horizontal path is 0; vertical upright runs pass 3. */
  fontOrientation?: number;
  /**
   * The element's computed `font-stretch` (always a percentage string out of
   * Chrome — `condensed` serializes as `75%`).
   *
   * It selects which CUT of the declared family the run opens: Blink's
   * declared-family style matcher turns any width below 100% into the condensed
   * symbolic trait and compares that BEFORE weight
   * (`mac/font_matcher_mac.mm:185-202` and `:234-235`, rev 7d859f27). On the
   * macOS `system-ui` face it instead drives the variable `wdth` axis — see
   * `resolveFont`.
   */
  fontStretch?: string;
  /** BCP-47 language tag for locale-aware Han fallback variant routing
   *  (PingFang TC / HK / MO, or Hiragino Kaku for `ja`). DM-394. */
  lang?: string;
  /** Author-set `font-variation-settings` axis overrides. DM-578. */
  variationSettings?: Record<string, number>;
  /**
   * OpenType feature tags forwarded to fontkit (e.g. ['smcp'] when CSS
   * `font-variant: small-caps` is in effect on this run). DM-294.
   */
  features?: string[];
  /**
   * CSS `font-variant-emoji`, when not `normal`. A genuine face-selection
   * input: Blink overrides the run's fallback priority and forces a variation
   * selector into every glyph lookup (`ApplyFontVariantEmojiOnFallbackPriority`,
   * `shaping/harfbuzz_shaper.cc:184-198`; `HarfBuzzGetGlyph`,
   * `shaping/harfbuzz_face.cc:127-206`, rev 7d859f27), so `emoji` moves even a
   * primary-covered U+263A from Helvetica to Apple Color Emoji and `text`
   * moves U+26A1 from Apple Color Emoji to Apple Symbols. Explicit VS15/VS16
   * in the text wins over the property.
   */
  fontVariantEmoji?: FontVariantEmojiOverride;
  /**
   * CSS `font-synthesis`, as the three permissions Blink derives from it.
   * Absent (or a `true` field) means `auto` — synthesis permitted, which is the
   * initial value and today's unconditional behavior.
   *
   * Blink does not treat these as hints. `SyntheticBoldAllowed()` and
   * `SyntheticItalicAllowed()` are each one comparison against the `auto`
   * keyword (`platform/fonts/font_description.h:312-320`, rev 7d859f27), ANDed
   * into the synthesis decision on BOTH paths that make one — the webfont path
   * (`core/css/css_segmented_font_face.cc:116-123`) and the per-platform
   * system-font paths. So `none` is a hard veto, not a preference. DM-1971.
   */
  fontSynthesis?: FontSynthesisAllowance;
}

type RasterKindGlyph = {
  id: number;
  path: { commands: PathCommand[] };
  type?: string;
  getImageForSize?: (size: number) => unknown;
  rasterRepresentation?: GlyphRasterRepresentation;
};

/** Pure selected-glyph representation seam used by the mutation matrix. */
export function glyphUsesRasterRepresentation(
  font: FontInstance & { COLR?: { baseGlyphRecord?: Array<{ gid: number }> } },
  fontKey: string,
  glyph: RasterKindGlyph,
  fontSize: number,
  weight = 400,
  slant = 0,
): boolean {
  return glyphRasterRepresentation(font, fontKey, glyph, fontSize, weight, slant) != null;
}

export function glyphRasterRepresentation(
  font: FontInstance & { COLR?: { baseGlyphRecord?: Array<{ gid: number }> } },
  fontKey: string,
  glyph: RasterKindGlyph,
  fontSize: number,
  weight = 400,
  slant = 0,
): GlyphRasterRepresentation | null {
  // DM-2403: DirectWrite can return a perfectly usable monochrome BASE outline
  // for a COLR glyph. Skia asks the selected gid's color-paint APIs first and,
  // on success, never requests that path. The Windows helper transcribes that
  // exact per-glyph answer; it must therefore outrank outline presence. A face-
  // wide COLR/CBDT/SVG table flag remains only the compatibility fallback for
  // helpers that predate the field and for outline-less fontkit glyphs.
  if (glyph.rasterRepresentation != null) return glyph.rasterRepresentation;
  if (glyph.type === "SBIX") {
    try { if (glyph.getImageForSize?.(fontSize) != null) return "sbix"; } catch { /* use table/path evidence below */ }
  }
  if (glyph.type === "COLR" && font.COLR?.baseGlyphRecord?.some((record) => record.gid === glyph.id)) return "colr";
  if (commandsFor(glyph, fontKey, weight, fontSize, slant).length > 0) return null;
  const tables = font.directory?.tables;
  if (tables != null && "CBDT" in tables && "CBLC" in tables) return "bitmap";
  if (tables != null && "sbix" in tables) return "sbix";
  if (tables != null && "COLR" in tables && "CPAL" in tables) return "colr";
  return tables != null && "SVG " in tables ? "svg" : null;
}

/**
 * Decide the raster boundary from the face selected by the same run splitter
 * used by glyph emission. This is intentionally downstream of presentation
 * segmentation and declared-family fallback: Blink does not infer color paint
 * from a Unicode block or a family name. A selected glyph needs an overlay
 * only when its concrete representation is non-outline (sbix, COLR, CBDT, or
 * OpenType SVG). Plain outline glyphs in a mixed color-capable face stay vector.
 */
export function selectedGlyphRasterSpans(
  text: string,
  candidates: Array<{ start: number; end: number }>,
  options: TextFontOptions,
): Array<{ start: number; end: number; representation: GlyphRasterRepresentation }> {
  if (text.length === 0 || candidates.length === 0) return [];
  const fontSize = options.fontSize;
  const fontFamily = options.fontFamily;
  const weight = cssWeightOf(options.fontWeight);
  const slant = slantForStyle(options.fontStyle);
  const stretch = stretchPercent(options.fontStretch);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, options.variationSettings, stretch, options.lang);
  if (primaryFont == null) return [];
  const primaryKey = resolveFontKey(fontFamily, options.lang);
  const chain = resolveFontKeyChain(fontFamily, options.lang);
  const runs = splitTextIntoGlyphPathRuns(
    text, primaryFont, primaryKey, weight, fontSize, slant,
    options.variationSettings, options.lang, chain,
    stackPrimaryIsSystemUi(fontFamily, options.lang), stretch,
    options.fontVariantEmoji, fontFamily, options.features,
  );
  const out: Array<{ start: number; end: number; representation: GlyphRasterRepresentation }> = [];
  for (const candidate of candidates) {
    const run = runs.find((r) => candidate.start >= r.startIdx && candidate.start < r.endIdx);
    if (run == null) continue;
    const source = text.slice(candidate.start, candidate.end);
    let glyphs: Array<{ id: number; path: { commands: PathCommand[] }; type?: string; getImageForSize?: (size: number) => unknown; rasterRepresentation?: GlyphRasterRepresentation }>;
    try {
      glyphs = run.font.layout(source, options.features != null ? fontkitFeatureList(options.features) : undefined).glyphs;
    } catch { continue; }
    const fontWithColr = run.font as FontInstance & {
      COLR?: { baseGlyphRecord?: Array<{ gid: number }> };
      directory?: { tables?: Record<string, unknown> };
    };
    const representation = glyphs.map((glyph) => glyphRasterRepresentation(
      fontWithColr, run.fontKey, glyph, fontSize, weight, slant,
    )).find((kind) => kind != null);
    if (representation != null) out.push({ ...candidate, representation });
  }
  return out;
}

/** Normalize `TextFontOptions.fontWeight` to the numeric CSS weight. */
export function cssWeightOf(fontWeight: string | number): number {
  return typeof fontWeight === "number" ? fontWeight : (parseFloat(fontWeight) || 400);
}

/** Options for `renderTextAsPath` beyond the shared font context. */
export interface RenderTextOptions extends TextFontOptions {
  /** Paint color for the glyph fills. */
  fill: string;
  /** Chrome's measured text width — used to scale glyph positions for accurate layout. */
  targetWidth?: number;
  /** Per-char x offsets relative to this text's origin (CSS pixels). */
  xOffsets?: number[];
  /**
   * Captured `canvas.measureText().fontBoundingBoxAscent` (px) — distance
   * from line-box top to baseline as Chrome will paint it. Overrides the
   * fontkit-derived ascent, which is HHEA-based and disagrees with
   * Chrome on macOS for Helvetica/Arial/Times/Georgia/Menlo/Courier (Chrome
   * uses winAscent there). Per-font metric-selection rules are fragile to
   * derive but trivial to read from the browser. See SK-1267 / DM-237.
   */
  ascentOverride?: number;
  /** DM-719: `-webkit-text-stroke-width` (px). When > 0, the emitted text
   *  group gets a `stroke` attribute so each glyph paints with an outline. */
  textStrokeWidth?: number;
  /** DM-719: `-webkit-text-stroke-color`. Required when `textStrokeWidth > 0`. */
  textStrokeColor?: string;
  /** DM-719: `paint-order` (e.g. "stroke fill"). When `stroke fill`, the
   *  stroke paints UNDER the fill so half the stroke is covered, eliminating
   *  the chunky fill-on-stroke look at large widths. */
  paintOrder?: string;
  /** DM-1126: UTF-16 indices (into `text`) of covered orphaned marks the capture
   *  layer detected Chrome auto-circles. Forwarded to `insertSyntheticDottedCircles`. */
  dottedCircleMarks?: number[];
  /**
   * The element's resolved `direction` and `unicode-bidi`. Only the OVERRIDE
   * values matter here, and they matter because they are the one bidi input
   * that cannot be recovered from the text: `bidi-override` /
   * `isolate-override` instruct the algorithm to disregard each character's
   * own bidi type and treat it as strong in `direction`. Running the UBA over
   * the characters — which is what deriving levels from the text does — asks
   * exactly the question the override says not to ask, so RTL text under
   * `bidi-override; direction: ltr` shaped right-to-left where Chrome forces it
   * left-to-right.
   */
  bidiOverride?: { direction: "ltr" | "rtl"; unicodeBidi: string };
}

export type SourceOwnedTextBoundaryReason =
  | EmbeddedTextDeclineReason
  | "path-primary-font-unresolved"
  | "path-layout-failed"
  | "element-render-failed"
  | "path-outline-unavailable"
  | "path-all-raster-owned"
  | "path-all-inkless"
  | "path-no-emittable-glyphs";

/**
 * A deterministic terminal for text whose selected face/gid cannot be painted
 * as a source outline. It deliberately contains no visible SVG `<text>` and no
 * authored font-family: the consumer browser therefore cannot make a new face
 * selection. Capture-owned raster overlays are composed by the caller beside
 * this marker; genuinely missing outlines remain an explicit, accessible,
 * machine-diagnosable degraded boundary.
 */
export function renderSourceOwnedTextBoundary(
  text: string,
  reason: SourceOwnedTextBoundaryReason,
  degraded: TextPathOwnership["degradedGlyphs"] = [],
): string {
  const details = degraded.length === 0
    ? ""
    : ` data-domotion-text-degraded-spans="${escAttr(degraded.map((item) =>
      `${item.sourceSpan[0]}-${item.sourceSpan[1]}:${item.glyphId}:${item.disposition}`).join(","))}"`;
  return `<g role="img" aria-label="${escAttr(text)}" data-domotion-text-owner="source-boundary" data-domotion-text-boundary="${reason}"${details}><title>${escAttr(text)}</title></g>`;
}

/**
 * Render text as SVG markup using path outlines with <defs>/<use> deduplication.
 * Returns a <g> element containing <use> references, positioned at (x, y) top.
 */
export function renderTextAsPath(
  text: string,
  x: number,
  y: number,
  options: RenderTextOptions,
): string {
  const { fontSize, fontFamily, fill, targetWidth, fontStyle, ascentOverride,
    features, lang, variationSettings, textStrokeWidth, textStrokeColor,
    paintOrder, dottedCircleMarks, bidiOverride, fontStretch, fontVariantEmoji,
    fontSynthesis, fontOrientation = 0 } = options;
  const fontWeight = String(options.fontWeight);
  let { xOffsets } = options;
  const weight = cssWeightOf(options.fontWeight);
  const slant = slantForStyle(fontStyle);
  const stretch = stretchPercent(fontStretch);
  const fallbackRequest = {
    rawSlope: blinkRequestedSlopeDegrees(fontStyle),
    orientation: fontOrientation,
  };
  const esc = escAttr;

  // DM-1026 / DM-1126: synthesize the dotted circle Chrome's HarfBuzz inserts
  // before an orphaned complex-shaper combining mark — for UNCOVERED marks
  // (no-font Brahmic blocks, detected here) and for CAPTURE-flagged COVERED marks
  // (`dottedCircleMarks`, e.g. Mukta Vedic). Run once at the funnel so both the
  // embedded-font and glyph-path branches below receive the augmented text +
  // xOffsets. A no-op for text with no combining marks.
  ({ text, xOffsets } = insertSyntheticDottedCircles(
    text, xOffsets, fontFamily, weight, fontSize, slant, variationSettings, lang,
    dottedCircleMarks, fontStretch, clusterFallbackEnabled(), fallbackRequest));

  // DM-1158: hide orphaned variation selectors / tags Chrome paints nothing for
  // (they otherwise fall through to a last-resort tofu box).
  if (!(clusterFallbackEnabled() && isGlyphHelperAvailable() && isIcuHelperAvailable())) {
    ({ text, xOffsets } = stripOrphanedDefaultIgnorables(text, xOffsets));
  }

  // The default embedded path emits already-shaped glyph IDs through generated
  // PUA codepoints in a generated `dmfN` font, with explicit captured origins.
  // The consumer does no authored-text shaping or family fallback. A classified
  // embedded decline enters the source-outline path below.
  if (currentRenderTextMode === "embedded-font") {
    // DM-655: emit `<text>` against a custom-built TTF that contains the
    // exact shaped glyphs Chrome painted with — webfont or system font,
    // variable-axis instance included. The renderTextAsEmbedded path
    // mirrors textToPathMarkup's per-codepoint font-resolution so
    // partitioned webfonts (Geist split across Latin/Cyrillic), fallback-
    // chain runs (Helvetica → Apple Symbols), and primary-only runs all
    // get the SAME font decision the path-mode renderer would have made.
    // A classified null markup falls through to source glyph paths when the run
    // can't be embedded (font failed to resolve, layout threw, PUA-A exhausted,
    // etc.). No authored family is emitted at either terminal.
    const embedded = renderTextAsEmbedded(text, x, y, fontSize, fontFamily, fontWeight, fill,
      xOffsets, fontStyle, ascentOverride, features, lang, variationSettings,
      textStrokeWidth, textStrokeColor, paintOrder, targetWidth, fontStretch, fontVariantEmoji,
      fontSynthesis, bidiOverride, fallbackRequest);
    if (embedded.markup != null) {
      recordTextEmitterTransition({ kind: "embedded-succeeded", sourceText: text });
      return embedded.markup;
    }
    recordTextEmitterTransition({
      kind: "embedded-declined-to-paths",
      sourceText: text,
      reason: embedded.decline?.glyphDisposition == null
        ? embedded.decline?.reason
        : `${embedded.decline.reason}:${embedded.decline.glyphDisposition}`,
    });
  }

  // DM-1984: `-webkit-text-stroke` already occupies the stroke attributes, and
  // Chrome's own handling of the two together is a per-platform mapping onto a
  // single flat paint (`resolveFakeBoldTextStroke`). Rather than run two stroke
  // sources against each other, a stroked run keeps the outer-group treatment
  // below and takes the primary font's decision; an unstroked run — every
  // ordinary one — gets the per-run frame.
  const wantsTextStroke = textStrokeWidth != null && textStrokeWidth > 0
    && textStrokeColor != null && textStrokeColor !== "";
  let result: TextPathResult | null;
  try {
    result = textToPathMarkup(text, fontSize, fontFamily, fontWeight, targetWidth, xOffsets, fontStyle, features, lang, variationSettings, bidiOverride, fontStretch, fontVariantEmoji, fontSynthesis,
      wantsTextStroke ? undefined : { fill }, fallbackRequest);
  } catch {
    const reason = "path-layout-failed" as const;
    recordTextEmitterTransition({ kind: "paths-declined", sourceText: text, reason });
    recordTextEmitterTransition({ kind: "source-owned-boundary", sourceText: text, reason });
    return renderSourceOwnedTextBoundary(text, reason);
  }
  if (result == null) {
    const reason = "path-primary-font-unresolved" as const;
    recordTextEmitterTransition({ kind: "paths-declined", sourceText: text, reason });
    recordTextEmitterTransition({ kind: "source-owned-boundary", sourceText: text, reason });
    return renderSourceOwnedTextBoundary(text, reason);
  }
  if (result.markup === "") {
    const reason: SourceOwnedTextBoundaryReason = result.ownership.degradedGlyphs.length > 0
      ? "path-outline-unavailable"
      : result.ownership.rasterGlyphs > 0 && result.ownership.inklessGlyphs === 0
        ? "path-all-raster-owned"
        : result.ownership.inklessGlyphs > 0 && result.ownership.rasterGlyphs === 0
          ? "path-all-inkless"
          : "path-no-emittable-glyphs";
    recordTextEmitterTransition({
      kind: "paths-declined", sourceText: text, reason,
      degradedSpans: result.ownership.degradedGlyphs,
    });
    recordTextEmitterTransition({
      kind: "source-owned-boundary", sourceText: text, reason,
      degradedSpans: result.ownership.degradedGlyphs,
    });
    return renderSourceOwnedTextBoundary(text, reason, result.ownership.degradedGlyphs);
  }
  recordTextEmitterTransition({
    kind: "paths-succeeded", sourceText: text,
    ...(result.ownership.degradedGlyphs.length === 0
      ? {}
      : { reason: "partial-source-outline", degradedSpans: result.ownership.degradedGlyphs }),
  });

  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch, lang);
  if (font == null) {
    const reason = "path-primary-font-unresolved" as const;
    recordTextEmitterTransition({ kind: "source-owned-boundary", sourceText: text, reason });
    return renderSourceOwnedTextBoundary(text, reason, result.ownership.degradedGlyphs);
  }

  const scale = fontSize / font.unitsPerEm;
  // Use the captured fontBoundingBoxAscent when available — that's the exact
  // value Chrome used to position the baseline within the line box. fontkit's
  // font.ascent (HHEA) is the right answer for SF Pro / SF Mono (where HHEA
  // = winAscent) but ~5 px too small at fontSize=32 for Helvetica and other
  // legacy MS fonts on macOS, where Chrome reads winAscent.
  const ascent = ascentOverride != null ? ascentOverride : Math.round(font.ascent * scale);
  // Snap the baseline to the integer pixel grid, mirroring Skia's glyph
  // rasterization: for axis-aligned horizontal text Skia keeps quarter-pixel
  // subpixel sampling in x but rounds every glyph's y to an integer device
  // pixel — `SkGlyphPositionRoundingSpec::HalfAxisSampleFreq` returns
  // `{kSubpixelRound, SK_ScalarHalf}` for `SkAxisAlignment::kX` and the
  // rounding spec drops all y subpixel bits (Skia `src/core/SkGlyph.cpp:695-726`,
  // checkout ebf5052 2026-07-31); the axis alignment comes from
  // `computeAxisAlignmentForHText` (`src/core/SkScalerContext.cpp:991-1011`)
  // whenever the default-on baseline-snap flag is set (`SkFont.cpp:44`,
  // `kDefault_Flags = kBaselineSnap_PrivFlag`) — Blink never clears it. So
  // Chrome paints a line whose layout baseline is fractional (line-height
  // accumulates in 1/64px LayoutUnits, e.g. 18px × 1.6 → 28.796875) at
  // floor(y + 0.5); emitting the unsnapped fractional baseline spread every
  // horizontal stroke across two pixel rows — a uniform stroke-lightness
  // error whose magnitude is the per-line snap phase, worst near .5.
  //
  // Suppressed under an ancestor CSS transform: Skia rounds in device space,
  // so a local-space snap under a scale/rotation would move glyphs AWAY from
  // Chrome's paint (see `pushBaselineSnapSuppression`).
  const baselineY = baselineSnapSuppressionDepth > 0
    ? y + ascent
    : Math.floor(y + ascent + 0.5);

  // DM-719: -webkit-text-stroke. Glyphs paint inside inner
  // `<g transform="scale(s,-s)">` groups where s = fontSize/unitsPerEm — a
  // tiny number (≈ 0.03 at 64px on a 2048-UPEM font). SVG strokes scale
  // with the transform, so a literal `stroke-width="2"` on the outer group
  // would render at 2 × 0.03 ≈ 0.06 user units. `vector-effect:
  // non-scaling-stroke` must be set on the actual graphics element, not a
  // parent (it doesn't inherit through `<use>` consistently). Instead,
  // pre-multiply the stroke width by the inverse scale so the post-
  // transform paint matches the requested CSS width.
  // DM-1984: synthetic bold + oblique in PATHS mode. Until now this branch
  // applied neither — a `font-weight: 700` run on a face with no bold cut
  // painted the thin natural outline, and a `font-style: italic` run on an
  // upright face painted it upright. Embedded mode has synthesized both since
  // DM-1693/DM-1695, and paths mode ships (the visual suites pin it, and it is
  // the always-correct fallback whenever a run cannot be embedded), so the
  // fidelity gap was real rather than theoretical.
  //
  // The WHETHER is the shared predicate — `faceNeedsSyntheticBold` /
  // `faceNeedsSyntheticOblique`, the same functions the embedded branch calls.
  // Only the HOW differs: embedded mode bakes the shear into the outline and
  // strokes the `<text>`; here the shear is a group transform and the frame
  // rides on the PER-RUN groups (see `textToPathMarkup`'s `fauxBold` parameter
  // for the measurement that settled the placement).
  let strokeAttr = "";
  if (wantsTextStroke) {
    const inverseScale = font.unitsPerEm / fontSize;
    // A stroked run keeps the outer-group treatment: the stroke attributes are
    // already spoken for, so the two stroke sources are resolved into one width
    // by the same per-platform mapping the embedded branch uses, taking the
    // PRIMARY font's synthesis decision. `emboldenFill` (Linux, stroke-first,
    // opaque fill) asks the FILL to carry the dilation with the stroke left at
    // its CSS width; paths mode cannot do that without re-keying every glyph
    // def, which is exactly the work the frame model removed — so take the
    // other arm of the same mapping and widen the stroke. Residual: the band
    // from the outline out to `extra/2` paints stroke-colored where Chrome
    // paints it fill-colored, under a quarter pixel at body sizes.
    const fakeBold = resolveFakeBoldTextStroke({
      strokeWidthPx: textStrokeWidth!,
      strokeFirst: paintOrder != null && /^\s*stroke(?:\s|$)/.test(paintOrder),
      fillIsTransparent: isFullyTransparentColor(fill),
      faceLacksWeight: faceNeedsSyntheticBold(font, weight, fontSynthesis),
      fontSizePx: fontSize,
    });
    const swPx = fakeBold.emboldenFill
      ? textStrokeWidth! + skiaFakeBoldStrokeExtraPx(fontSize)
      : fakeBold.strokeWidthPx;
    strokeAttr = ` stroke="${textStrokeColor}" stroke-width="${r2(swPx * inverseScale)}"`;
    if (paintOrder != null && /^\s*stroke(?:\s|$)/.test(paintOrder)) {
      strokeAttr += ` paint-order="stroke fill"`;
    }
  }

  // DM-1695 shear, as an SVG transform rather than a baked outline. Glyphs
  // paint inside inner `scale(s,-s)` groups, so the y axis is FLIPPED by the
  // time they reach this group's user space: a design-space `x += 0.25·y`
  // (y-up) is `x -= 0.25·y` here. `skewX` is expressed as a matrix so the
  // factor stays exact rather than round-tripping through tan(-14.036°).
  // Composed AFTER the translate, so the shear pivots on the baseline origin —
  // which is where Chrome's `SkFont.setSkewX` pivots too.
  const shear = faceNeedsSyntheticOblique(font, blinkRequestedSlopeDegrees(fontStyle), fontSynthesis)
    ? ` matrix(1,0,${-OBLIQUE_SHEAR},1,0,0)` : "";
  const degradedAttr = result.ownership.degradedGlyphs.length === 0
    ? ""
    : ` data-domotion-text-owner="source-partial" data-domotion-text-degraded-spans="${esc(result.ownership.degradedGlyphs.map((item) =>
      `${item.sourceSpan[0]}-${item.sourceSpan[1]}:${item.glyphId}:${item.disposition}`).join(","))}"`;
  return `<g transform="translate(${r2(x)},${r2(baselineY)})${shear}" fill="${fill}"${strokeAttr} role="img" aria-label="${esc(text)}"${degradedAttr}><title>${esc(text)}</title>${result.markup}</g>`;
}

/**
 * Check if text-to-path conversion is available for a font family.
 */
export function isTextToPathAvailable(fontFamily: string): boolean {
  return resolveFont(fontFamily, 400, 14) != null;
}


/** The decoration-specific CSS inputs to `getDecorationMetrics`. */
export interface DecorationStyleOptions {
  /** CSS `text-decoration-thickness` as captured from the computed style —
   *  `auto`, `from-font`, or a length/percentage (percent of font size). */
  thicknessOverride?: string;
  /** CSS `text-underline-offset` — `auto`, or a length/percentage (percent of
   *  font size). An EXPLICIT length also zeroes Blink's auto underline gap
   *  (`core/layout/text_decoration_offset.cc:22-29`, rev 7d859f27). */
  underlineOffsetCss?: string;
  /**
   * CSS `text-underline-position` (`auto` / `from-font` / `under` / `left` /
   * `right`, possibly space-combined). Horizontal-tb resolution mirrors
   * `ResolveUnderlinePosition` (`core/paint/text_decoration_info.cc:23-53`):
   * `under` wins, then `from-font`; `left`/`right` are vertical-only and
   * resolve to `auto` here.
   */
  underlinePositionCss?: string;
  /** Chromium's `FontMetrics::FloatAscent` for the METRICS font — the captured
   *  `fontAscent` (canvas `measureText().fontBoundingBoxAscent` IS FloatAscent
   *  at the alphabetic baseline — `core/html/canvas/text_metrics.cc:133-138`).
   *  Every decoration offset is anchored on it. Falls back to `0.8 × fontSize`
   *  when the capture carries no ascent (programmatic trees, unit tests). */
  fontAscent?: number;
  /** Chromium's `FloatDescent` — consulted only as the last-resort input to
   *  the normalized-typo-descent fallback for `text-underline-position: under`
   *  when the face has no usable OS/2 typo metrics
   *  (`platform/fonts/simple_font_data.cc:384-388`). */
  fontDescent?: number;
}

/** `LayoutUnit::FromFloatRound` — round to the nearest 1/64 CSS px. */
const LU = (v: number): number => Math.round(v * 64) / 64;
/** C `roundf` — round half AWAY FROM ZERO (JS `Math.round` rounds -1.5 → -1;
 *  `roundf(-1.5)` → -2, and text-underline-offset can be negative). */
const roundHalfAwayFromZero = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));

/**
 * A captured `text-decoration-thickness` / `text-underline-offset` computed
 * value in px. Lengths compute to px; percentages stay percentages and
 * resolve against the font size for BOTH properties
 * (`ComputeDecorationThickness` — `FloatValueForLength(len, used_font_size)`,
 * `core/paint/text_decoration_info.cc:88-90`; `StyleUnderlineOffsetToPixels`,
 * `core/layout/text_decoration_offset.cc:122-135`). `em` accepted for
 * robustness (computed styles serialize it to px). Returns null for keywords
 * or unparsable input.
 */
function decorationLengthPx(spec: string, fontSize: number): number | null {
  const m = /^(-?[\d.]+)(px|em|%)?$/.exec(spec.trim());
  if (m == null) return null;
  const v = parseFloat(m[1]);
  if (Number.isNaN(v)) return null;
  if (m[2] === "em") return v * fontSize;
  if (m[2] === "%") return (v / 100) * fontSize;
  return v;
}

/**
 * `NormalizedTypoDescent` in px (`platform/fonts/simple_font_data.cc:339-415`,
 * rev 7d859f27): OS/2 sTypoAscender/sTypoDescender (descender stored negative,
 * negated on read) normalized so the pair sums to the em size while keeping
 * their ratio; the normalized ascent is LayoutUnit-rounded and the descent is
 * `LU(em) − normalizedAscent`. Falls back to FloatAscent/FloatDescent when the
 * typo ascender is missing or non-positive, exactly as
 * `ComputeNormalizedTypoAscentAndDescent` does; 0 when nothing is usable.
 */
function normalizedTypoDescentPx(
  fontSize: number, font: FontInstance | null, ascF: number, descF: number,
): number {
  const tryNorm = (a: number, d: number): number | null => {
    const height = a + d;
    if (height <= 0 || a < 0 || a > height) return null;
    const normAsc = LU((a * fontSize) / height);
    return LU(fontSize) - normAsc;
  };
  const os2 = font?.["OS/2"];
  if (os2?.typoAscender != null && os2.typoDescender != null && os2.typoAscender > 0) {
    const ntd = tryNorm(os2.typoAscender, -os2.typoDescender);
    if (ntd != null) return ntd;
  }
  return tryNorm(ascF, descF) ?? 0;
}

/**
 * Text-decoration geometry, transcribed from Blink (Chromium rev 7d859f27) —
 * NOT fitted to pixels. The returned tops are relative to the text FRAGMENT
 * TOP (the line-over edge Blink anchors `local_origin_` at) and unsnapped;
 * the paint-time snap is applied at the emit site because it differs per
 * line style (`decoration_line_painter.cc` SnapYAxis for solid/double,
 * GetSnappedPointsForTextLine for dashed/dotted, none for wavy).
 *
 * Inputs: the ascent is Chromium's own captured FloatAscent (see
 * `DecorationStyleOptions.fontAscent`); only `from-font` (post table
 * underline position/thickness) and `under` (OS/2 typo metrics) read font
 * tables, through the same face the glyph path resolves — a condensed run's
 * decoration reads the condensed cut's metrics.
 *
 * Rules (fs = font size, t = resolved thickness, ascF = FloatAscent,
 * ascI = lroundf(ascF) — `FontMetrics::Ascent`, LU = LayoutUnit round):
 *   thickness   auto → fs/10; from-font → face underline thickness (or auto);
 *               length/% → roundf(px)  (`text_decoration_info.cc:65-92`);
 *               then max(1, t)  (`:449-451`)
 *   underline   auto: trunc(ascI + gap + roundf(extra)),
 *                 gap = extraIsAuto ? max(1, ceil(t/2)) : 0
 *                 (`text_decoration_offset.cc:16-35`)
 *               from-font: roundf(ascF + underlinePos + extra), underlinePos
 *                 positive below baseline (Skia `fUnderlinePosition`; macOS
 *                 negates `CTFontGetUnderlinePosition` —
 *                 `external/skia` `src/ports/SkScalerContext_mac_ct.cpp`,
 *                 rev ebf5052)  (`text_decoration_offset.cc:37-48`)
 *               under: floor(LU(ascF + NTD) + LU(extra)) + 1
 *                 (`text_decoration_offset.cc:52-89`,
 *                 `FontVerticalPositionType::BottomOfEmHeight` =
 *                 −NormalizedTypoDescent, `simple_font_data.cc:417-431`)
 *   overline    floor(LU(ascF − ascI)) − floor(t)   (TextTop, `:52-89`;
 *               text-underline-offset does NOT apply —
 *               `text_decoration_info.cc:357-370`)
 *   line-through 2·ascF/3 − t/2, unrounded  (`text_decoration_info.cc:385-386`)
 *
 * The former implementation carried empirically-fitted constants (thickness
 * `ceil(fs/20)`, gap `1.5·t`, strike `round(fs/3)+t/2`, overline `fs−t/2`)
 * that were tuned to compensate for the SVG-vs-HTML rasterization gap. Under
 * the project's parity boundary — identical to Chrome UP TO rasterization,
 * which the consumer's SVG renderer owns — those constants injected a
 * GEOMETRY error to offset a RASTER error we do not own. The geometry oracle
 * (`tools/decoration-oracle.ts`, `npm run decorations:oracle`) gates this
 * transcription; whole-fixture pixel-diff must not, because it structurally
 * rewards the fitted values.
 */
export function getDecorationMetrics(
  fontOptions: TextFontOptions,
  decoration: DecorationStyleOptions = {},
): DecorationMetrics {
  const { fontFamily, fontSize, fontStyle, fontStretch, variationSettings } = fontOptions;
  const { thicknessOverride, underlineOffsetCss, underlinePositionCss } = decoration;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretchPercent(fontStretch), fontOptions.lang);
  const upem = font?.unitsPerEm ?? 1000;
  const ascF = decoration.fontAscent ?? fontSize * 0.8;
  // `FontMetrics::Ascent()` = lroundf(FloatAscent) (`platform/fonts/font_metrics.h:109`).
  const ascI = Math.round(ascF);
  const descF = decoration.fontDescent ?? Math.max(0, fontSize - ascF);

  // Thickness — `ComputeDecorationThickness` (`text_decoration_info.cc:65-92`).
  const thSpec = (thicknessOverride ?? "auto").trim();
  let t: number;
  if (thSpec === "" || thSpec === "auto") {
    t = fontSize / 10;
  } else if (thSpec === "from-font") {
    // `UnderlineThickness().value_or(auto)` — fontkit's `post.underlineThickness`
    // in font units; a missing/zero metric means "not provided" and falls back.
    const fromFont = font != null ? (font.underlineThickness * fontSize) / upem : NaN;
    t = Number.isFinite(fromFont) && fromFont > 0 ? fromFont : fontSize / 10;
  } else {
    const px = decorationLengthPx(thSpec, fontSize);
    t = px != null ? roundHalfAwayFromZero(px) : fontSize / 10;
  }
  // `max(1, t)` for non-SVG text (`text_decoration_info.cc:449-451`).
  t = Math.max(1, t);

  // text-underline-offset — `StyleUnderlineOffsetToPixels`
  // (`text_decoration_offset.cc:122-135`; auto → 0, percent of font size).
  const offSpec = (underlineOffsetCss ?? "auto").trim();
  const offIsAuto = offSpec === "" || offSpec === "auto";
  const extra = offIsAuto ? 0 : (decorationLengthPx(offSpec, fontSize) ?? 0);

  // Underline position — `ResolveUnderlinePosition` for horizontal-tb
  // (`text_decoration_info.cc:23-53`): `under` wins, then `from-font`;
  // `left`/`right` resolve to auto.
  const posTokens = (underlinePositionCss ?? "").trim().toLowerCase().split(/\s+/);
  let underlineTop: number;
  if (posTokens.includes("under")) {
    // `ComputeUnderlineOffsetForUnder` with BottomOfEmHeight
    // (`text_decoration_offset.cc:52-89,112-118`): the LayoutUnit sum is
    // floored, then +1 on the line-under side.
    const ntd = normalizedTypoDescentPx(fontSize, font, ascF, descF);
    underlineTop = Math.floor(LU(ascF + ntd) + LU(extra)) + 1;
  } else if (posTokens.includes("from-font") && font != null && Number.isFinite(font.underlinePosition)) {
    // `ComputeUnderlineOffsetFromFont` (`text_decoration_offset.cc:37-48`).
    // fontkit's post value is negative below the baseline; Skia's
    // `fUnderlinePosition` is positive below, so negate.
    const posPx = (-font.underlinePosition * fontSize) / upem;
    underlineTop = roundHalfAwayFromZero(ascF + posPx + extra);
  } else {
    // `ComputeUnderlineOffsetAuto` (`text_decoration_offset.cc:16-35`) — also
    // the from-font fallback when the face metric is unavailable (`:103-107`).
    const gap = offIsAuto ? Math.max(1, Math.ceil(t / 2)) : 0;
    underlineTop = Math.trunc(ascI + gap + roundHalfAwayFromZero(extra));
  }

  // Overline — TextTop (`text_decoration_offset.cc:52-89`;
  // `VerticalPosition(TextTop)` = int Ascent, `simple_font_data.cc:417-424`).
  const overlineTop = Math.floor(LU(ascF - ascI)) - Math.floor(t);

  // Line-through (`text_decoration_info.cc:385-386`), unrounded.
  const lineThroughTop = (2 * ascF) / 3 - t / 2;

  return { thickness: t, underlineTop, overlineTop, lineThroughTop };
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
/**
 * Advance width (CSS px) of the space glyph in the resolved font. DM-1154: an
 * outside list marker's trailing suffix space is part of Blink's right-aligned
 * marker box (box end = content edge), but SVG drops trailing whitespace, so the
 * renderer must subtract the space's advance manually to place the visible glyph
 * where Chrome paints it.
 */
export function fontSpaceAdvancePx(fontOptions: TextFontOptions): number {
  const { fontFamily, fontSize, fontStyle, fontStretch, variationSettings } = fontOptions;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretchPercent(fontStretch), fontOptions.lang);
  if (font == null) return fontSize * 0.25;
  try {
    const g = font.layout(" ").glyphs[0] as { advanceWidth: number } | undefined;
    if (g == null) return fontSize * 0.25;
    return g.advanceWidth * (fontSize / font.unitsPerEm);
  } catch {
    return fontSize * 0.25;
  }
}

export function measureLastGlyphRsb(text: string, fontOptions: TextFontOptions): number {
  // Drop trailing whitespace — DM-789 probed that Chrome's SVG renderer
  // collapses / drops trailing whitespace despite `xml:space="preserve"`,
  // so the visible-rightmost glyph is the last NON-space character.
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") return 0;
  const { fontFamily, fontSize, fontStyle, fontStretch, variationSettings } = fontOptions;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretchPercent(fontStretch), fontOptions.lang);
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

/** Blink emphasis-mark metrics for the fallback-selected face at 50% size. */
export function measureEmphasisMarkMetrics(
  mark: string,
  fontOptions: TextFontOptions,
): { fontSize: number; ascent: number; descent: number; inkCenterX: number; inkCenterY: number } | null {
  const { fontFamily, fontSize, fontStyle, fontStretch, lang, variationSettings } = fontOptions;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const stretch = stretchPercent(fontStretch);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch, lang);
  if (primaryFont == null) return null;
  const primaryFontKey = resolveFontKey(fontFamily, lang);
  const runs = splitTextIntoFontRuns(
    mark, primaryFont, primaryFontKey, weight, fontSize, slant,
    variationSettings, lang, resolveFontKeyChain(fontFamily, lang),
    stackPrimaryIsSystemUi(fontFamily, fontOptions.lang), stretch, undefined, fontFamily,
  );
  const run = runs[0];
  if (run == null) return null;
  let glyph: { id: number; advanceWidth?: number; bbox?: { minX: number; maxX: number; minY: number; maxY: number } } | undefined;
  try { glyph = run.font.layout(run.text).glyphs[0]; } catch { return null; }
  if (glyph == null || glyph.id === 0) return null;
  // Blink shapes with the main Font first, then calls EmphasisMarkFontData on
  // that selected run. Scaling here (instead of resolving again at mark size)
  // preserves the selected face and its optical cut.
  const markFontSize = Math.round(fontSize * 0.5);
  const scale = markFontSize / run.font.unitsPerEm;
  const centerX = glyph.bbox != null
    ? (glyph.bbox.minX + glyph.bbox.maxX) / 2
    : (glyph.advanceWidth ?? run.font.unitsPerEm) / 2;
  const centerY = glyph.bbox != null
    ? -(glyph.bbox.minY + glyph.bbox.maxY) / 2
    : 0;
  return {
    fontSize: markFontSize,
    ascent: LU(run.font.ascent * scale),
    descent: LU(-run.font.descent * scale),
    inkCenterX: centerX * scale,
    inkCenterY: centerY * scale,
  };
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
  fontOptions: TextFontOptions,
): { inkAscent: number; inkDescent: number } | null {
  const { fontFamily, fontSize, fontStyle, fontStretch, lang, variationSettings, features } = fontOptions;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const stretch = stretchPercent(fontStretch);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch, lang);
  if (primaryFont == null) return null;
  const primaryFontKey = resolveFontKey(fontFamily, lang);
  const fontKeyChain = resolveFontKeyChain(fontFamily, lang);
  const runs = splitTextIntoFontRuns(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, stackPrimaryIsSystemUi(fontFamily, lang), stretch, undefined, fontFamily, features);
  let maxY = -Infinity; // ink top    (font units, y-up)
  let minY = Infinity;  // ink bottom (font units, y-up; negative = below baseline)
  for (const run of runs) {
    const scale = fontSize / run.font.unitsPerEm;
    let layout;
    try {
      const runDirection = run.shapingDirection ?? shapingDirectionAt(text, run.startIdx);
      layout = features != null && features.length > 0
        ? run.font.layout(run.text, fontkitFeatureList(features), undefined, lang, runDirection)
        : run.font.layout(run.text, undefined, undefined, lang, runDirection);
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
  fontOptions: TextFontOptions,
  fill: string,
): string | null {
  const ch = char.trim();
  if (ch === "" || boxH <= 0) return null;
  const cp = ch.codePointAt(0)!;
  const { fontFamily, fontSize, fontStyle, fontStretch } = fontOptions;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const stretch = stretchPercent(fontStretch);

  // Resolve a font that actually has the fence glyph via the shared per-codepoint
  // resolver (DM-1068). Uncovered → keep the primary (its `.notdef`); the caller
  // falls back to the synthesized path when the layout has no outline.
  const primaryFontKey = resolveFontKey(fontFamily, fontOptions.lang);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, undefined, stretch, fontOptions.lang);
  if (primaryFont == null) return null;
  const res = resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, undefined, fontOptions.lang,
    resolveFontKeyChain(fontFamily, fontOptions.lang), stackPrimaryIsSystemUi(fontFamily, fontOptions.lang), stretch, undefined, fontFamily);
  const useKey = res.covered ? res.key : primaryFontKey;
  const font = res.covered ? (res.fontOverride ?? getFontInstance(res.key, weight, fontSize, slant, undefined, stretch) ?? primaryFont) : primaryFont;

  let layout;
  try { layout = font.layout(ch); } catch { return null; }
  const glyph = layout.glyphs[0] as
    { id: number; path: { commands: Array<{ command: string; args: number[] }> }; bbox?: { minX: number; minY: number; maxX: number; maxY: number } } | undefined;
  if (glyph == null) return null;
  // CFF/CFF2 math faces can shape successfully while fontkit exposes an empty
  // path. Use the same native-helper fallback as ordinary glyph emission;
  // otherwise this dedicated stretchy branch returns null and the caller falls
  // through to baseline text, which is about 5 px too low for the row fence.
  const glyphCommands = commandsFor(glyph, useKey, weight, fontSize, slant);
  if (glyphCommands.length === 0) return null;
  let bbox = glyph.bbox;
  if (bbox == null || !(bbox.maxY > bbox.minY)) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const command of glyphCommands) {
      for (let i = 0; i + 1 < command.args.length; i += 2) {
        const px = command.args[i], py = command.args[i + 1];
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
    }
    if (maxY > minY) bbox = { minX, minY, maxX, maxY };
  }
  if (bbox == null || !(bbox.maxY > bbox.minY)) return null;

  const em = font.unitsPerEm;
  const defId = ensureGlyphDef(useKey, weight, fontSize, slant, glyph.id, glyphCommands, stretch);
  // Horizontal: natural scale, glyph origin anchored at the captured x (same as
  // the per-char baseline path). Vertical: map ink [minY,maxY] (font units,
  // y-up) onto [boxY, boxY+boxH] (SVG y-down) — `sy` is the stretch factor.
  // Scale factors need 5-decimal precision (em is ~1000-2048, so 2dp would be
  // a ~7% size error); the translate keeps `r2()`'s 2dp px precision.
  const sx = fontSize / em;
  const sy = boxH / (bbox.maxY - bbox.minY);
  const ty = boxY + sy * bbox.maxY;
  const sxStr = Number(sx.toFixed(5)).toString();
  const syStr = Number((-sy).toFixed(5)).toString();
  return `<g transform="translate(${r2(x)},${r2(ty)}) scale(${sxStr},${syStr})" fill="${fill}"><use href="#${defId}"/></g>`;
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
  fontOptions: TextFontOptions,
  fill: string,
): string | null {
  if (height <= 0 || width <= 0) return null;
  const cp = 0x221A; // √ SQUARE ROOT
  const { fontFamily, fontSize, fontStyle, fontStretch } = fontOptions;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const stretch = stretchPercent(fontStretch);

  // Resolve a font that has the √ glyph via the shared per-codepoint resolver
  // (DM-1068). Uncovered → keep the primary; the caller falls back to the
  // synthesized path when the layout has no outline.
  const primaryFontKey = resolveFontKey(fontFamily, fontOptions.lang);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, undefined, stretch, fontOptions.lang);
  if (primaryFont == null) return null;
  const res = resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, undefined, fontOptions.lang,
    resolveFontKeyChain(fontFamily, fontOptions.lang), stackPrimaryIsSystemUi(fontFamily, fontOptions.lang), stretch, undefined, fontFamily);
  const useKey = res.covered ? res.key : primaryFontKey;
  const font = res.covered ? (res.fontOverride ?? getFontInstance(res.key, weight, fontSize, slant, undefined, stretch) ?? primaryFont) : primaryFont;

  let layout;
  try { layout = font.layout("√"); } catch { return null; }
  const glyph = layout.glyphs[0] as
    { id: number; path: { commands: Array<{ command: string; args: number[] }> }; bbox?: { minX: number; minY: number; maxX: number; maxY: number } } | undefined;
  if (glyph == null || glyph.path.commands.length === 0) return null;
  const bbox = glyph.bbox;
  if (bbox == null || !(bbox.maxY > bbox.minY) || !(bbox.maxX > bbox.minX)) return null;

  const defId = ensureGlyphDef(useKey, weight, fontSize, slant, glyph.id, glyph.path.commands, stretch);
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
  const glyphMarkup = `<g transform="translate(${r2(tx)},${r2(ty)}) scale(${sStr},${negS})" fill="${fill}"><use href="#${defId}"/></g>`;

  // Overbar (vinculum): continue the glyph's top stub across the radicand to
  // the radical's right edge, at the SAME y the glyph ink-top was anchored to
  // so the stub and the extension form one continuous rule (a y mismatch here
  // is what showed up as a doubled overbar line). 1 px matches the default
  // rule thickness.
  const glyphRight = x + (bbox.maxX - bbox.minX) * s;
  const overbarRight = x + width;
  let overbar = "";
  if (overbarRight > glyphRight) {
    overbar = `<rect x="${r2(glyphRight)}" y="${r2(overbarY)}" width="${r2(overbarRight - glyphRight)}" height="1" fill="${fill}"/>`;
  }
  return glyphMarkup + overbar;
}

/** The decoration-geometry inputs to `computeSkipInkGaps`. */
export interface SkipInkOptions {
  decorationCenterYRel?: number;
  decorationThickness?: number;
  /** Horizontal dilation of each intercept, in px per side. Blink dilates by
   *  `min(LINE thickness, 13)` — `geometry.Thickness()`, never the intercept
   *  band's height (`core/paint/text_painter.cc:607-608`, rev 7d859f27) — so
   *  callers whose band is taller than the line (wavy: the stroke bounding
   *  rect of the wave; double: both bars plus the gap between them) must pass
   *  the line thickness here. Defaults to `min(decorationThickness, 13)`,
   *  which is exact when the band IS the line rect (solid). */
  interceptPad?: number;
  /** Chromium-measured run width — when set, intercepts are scaled to match
   *  so gaps line up with the painted glyph positions even when fontkit's
   *  layout disagrees with HarfBuzz at sub-px scale. */
  targetWidth?: number;
  /** Chromium-measured per-char x offsets, RELATIVE to the run start (same
   *  indexing as the run text's UTF-16 units). When present, each glyph's
   *  intercept is anchored at the captured offset of its first character
   *  instead of fontkit's accumulated advance — the accumulated positions
   *  drift a few px against Chrome's paint over a long run, which misplaced
   *  wavy-underline skip-ink gaps mid-run even after the proportional
   *  `targetWidth` rescale (the rescale can only fix the endpoints). */
  charXOffsets?: number[];
}

export function computeSkipInkGaps(
  text: string,
  fontOptions: TextFontOptions,
  skipInk: SkipInkOptions = {},
): Array<[number, number]> {
  const { fontFamily, fontSize, fontStyle, fontStretch, variationSettings, features } = fontOptions;
  const { decorationCenterYRel = 0, decorationThickness = 1, interceptPad, targetWidth, charXOffsets } = skipInk;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretchPercent(fontStretch), fontOptions.lang);
  if (font == null) return [];
  let layout;
  try { layout = font.layout(text, fontkitFeatureList(features)); } catch { return []; }
  const scale = fontSize / font.unitsPerEm;
  // Blink insets the decoration rect by 0.5px top and bottom before asking for
  // intercepts — "In order to ignore intersects less than 0.5px, inflate by
  // -0.5" (`core/paint/text_painter.cc:589-590`, Chromium rev 7d859f27). The
  // band is therefore one pixel SHORTER than the painted line, which is what
  // stops a glyph that merely grazes the line's edge from opening a gap. A
  // 1px-thick line degenerates to a zero-height band, and Blink accepts that.
  const yTop = decorationCenterYRel - decorationThickness / 2 + 0.5;
  const yBot = decorationCenterYRel + decorationThickness / 2 - 0.5;
  // Horizontal dilation of each intercept. Blink: `min(thickness, 13)`, applied
  // as `clip_rect.Outset(OutsetsF::VH(1.0, dilation))` — VH is (vertical,
  // horizontal), so the whole value goes on each horizontal side
  // (`text_painter.cc:607-608`, constant `kDecorationClipMaxDilation` at `:46`).
  //
  // This previously read `max(0.5, thickness * 0.5)` and cited a
  // `kIntersectionExtension` that does not exist anywhere in Chromium. The
  // fitted value is HALF the real one below the cap, so every gap was painted
  // narrower than Chrome paints it.
  const pad = interceptPad ?? Math.min(decorationThickness, 13);
  const rawGaps: Array<[number, number]> = [];
  const anchoredGaps: Array<[number, number]> = [];
  let xCursor = 0;
  let charCursor = 0; // UTF-16 cursor into `text` tracking each glyph's first char
  for (let i = 0; i < layout.glyphs.length; i++) {
    const glyph = layout.glyphs[i];
    const pos = layout.positions[i];
    const anchor = charXOffsets?.[charCursor];
    const fkGlyphX = xCursor + (pos.xOffset || 0) * scale;
    // Blink drops the intercepts of characters that may not skip ink, PER
    // CHARACTER rather than per run (`ShapeResultBloberizer::IsSkipInkException`,
    // `platform/fonts/shaping/shape_result_bloberizer.cc:228-234`) — so in
    // mixed text the Latin glyphs still open gaps while the CJK ones beside
    // them do not. The character is the glyph's own source character, which is
    // why this is read at `charCursor` rather than from the run.
    const srcCp = text.codePointAt(charCursor);
    const range = srcCp != null && !canTextDecorationSkipInk(srcCp)
      ? null
      : glyphPathIntercepts(glyph.path, fkGlyphX, scale, yTop, yBot);
    if (range != null) {
      rawGaps.push([range.minX - pad, range.maxX + pad]);
      // Anchored variant: shift this glyph's intercept so its pen origin sits
      // at the CAPTURED per-char offset (range extents stay fontkit-shaped —
      // the outline is the same; only the origin drifts).
      if (anchor != null) {
        const shift = anchor + (pos.xOffset || 0) * scale - fkGlyphX;
        anchoredGaps.push([range.minX + shift - pad, range.maxX + shift + pad]);
      }
    }
    xCursor += pos.xAdvance * scale;
    // Advance the char cursor by this glyph's source characters (UTF-16 units),
    // measured against the SOURCE TEXT.
    //
    // DM-1849: this is a THIRD source-span walk of the kind DM-1804 fixed — it
    // was summing `cp > 0xFFFF ? 2 : 1` over the glyph's own `codePoints`, so a
    // shared Glyph decided whether this position consumed one UTF-16 unit or
    // two. `.notdef` is always shared, and its cached codepoint is BMP whenever
    // the first miss in the process was BMP, so an astral character silently
    // advanced by 1 and every later cursor in the run was off by one.
    const cps: number[] | undefined = (glyph as { codePoints?: number[] }).codePoints;
    charCursor += sourceClusterSpan(text, charCursor, cps != null && cps.length > 0 ? cps.length : 1, false);
  }
  if (rawGaps.length === 0) return [];
  // When every intercepting glyph could be anchored at a captured offset, use
  // the anchored set verbatim — it already matches Chrome's paint. Otherwise
  // fall back to the proportional rescale of the fontkit-accumulated set.
  if (charXOffsets != null && anchoredGaps.length === rawGaps.length) {
    return mergeGaps(anchoredGaps);
  }
  if (targetWidth != null && xCursor > 0.5 && Math.abs(xCursor - targetWidth) > 0.5) {
    const factor = targetWidth / xCursor;
    for (const g of rawGaps) { g[0] *= factor; g[1] *= factor; }
  }
  return mergeGaps(rawGaps);
}
