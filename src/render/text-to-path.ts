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
import { createGlyphHelperFont, isGlyphHelperAvailable, resolveSystemFallbackFonts, resolveInstalledFont } from "./glyph-helper.js";
// The SHARED attribute escaper. Two local copies used to live in this file and
// escaped only the five XML metacharacters, so a codepoint the XML `Char`
// production forbids (U+FFFE / U+FFFF, a stray control, an unpaired surrogate)
// reached the accessible name verbatim and made the whole document unparseable
// — the consumer showed a broken-image icon rather than the drawing. Import the
// one implementation instead of restating it; see `esc` for the disposition.
import { esc as escAttr } from "./format.js";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss, trackGlyphInEmbedFont } from "./embedded-font-builder.js";
import { FAUX_BOLD_WEIGHT_DELTA, emboldenStrengthForFont, OBLIQUE_SHEAR, resolveFakeBoldTextStroke } from "./embolden-outline.js";
import { UNICODE_FONT_PATHS, UNICODE_FONT_RANGES } from "./unicode-font-routing.darwin.generated.js";
import { UNICODE_FONT_PATHS_LINUX, UNICODE_FONT_RANGES_LINUX } from "./unicode-font-routing.linux.generated.js";
import { UNICODE_FONT_FILES_WIN32, UNICODE_FONT_RANGES_WIN32 } from "./unicode-font-routing.win32.generated.js";
// Unicode-classification predicates (mathAlphaToBase, isRtlScriptCodepoint, isStretchyFenceChar, complex-shaper / matra / rtl ranges, …) moved to ./unicode-classification.ts (DM-1305).
import { bidiLevelsFor, needsSegmentation, segmentForShaping } from "./script-segmentation.js";
import { featureListNeedsHbShaping, fontkitFeatureList } from "./font-features.js";
import { mathAlphaToBase, isLegitimatelyInklessCodepoint, usesDedicatedShaper, isTrimmableCjkPunct, complexShaperBaseMarkDecomposition, isStrippableOrphanIgnorable, usesComplexShaperDottedCircle, isLeftReorderingMatra, isRtlScriptCodepoint } from "./unicode-classification.js";


import {
  DecorationMetrics,
  FontInstance,
  FontRun,
  ITALIC_SLNT,
  PathCommand,
  TextPathResult,
  codepointResolvesToNotdef,
  commandsFor,
  currentRenderTextMode,
  ensureGlyphDef,
  fallbackFontChain,
  fontAutoInsertsDottedCircle,
  fontFeatureValueShapingOverride,
  FontVariantEmojiOverride,
  isColorEmojiFontKey,
  isEmojiCharCp,
  getFontInstance,
  getFontSourceInfo,
  glyphInkXRange,
  glyphPathIntercepts,
  haltInfoFor,
  isEmojiCodepoint,
  isNonCharacterCodepoint,
  isPrivateUseCodepoint,
  mergeGaps,
  opticalCutOpszFor,
  pickWebfontVariantForCodepoint,
  r2,
  glyphIdForCp,
  resolveDottedCircleHbRun,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontSpec,
  setRenderTextMode,
  stretchPercent,
  syntheticMarkCenteringOffsetPx,
  win,
  stackPrimaryIsSystemUi,
  webfontSyntheticBold,
} from "./font-resolution.js";
export * from "./font-resolution.js";

function slantForStyle(style: string | undefined): number {
  if (style == null) return 0;
  const s = style.toLowerCase();
  return (s === "italic" || s.startsWith("oblique")) ? ITALIC_SLNT : 0;
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
): TextPathResult | null {
  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);
  const stretch = stretchPercent(fontStretch);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch);
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
      const res = clusterRun != null ? null : resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, stackPrimaryIsSystemUi(fontFamily), stretch, effFve);
      // An UNCOVERED emoji must stay on the glyph-path terminal, NOT take the
      // resolver's system-fallback. Emoji are painted by the rasterGlyph overlay;
      // placing one on a system color font here would split it out of the
      // surrounding text run and break the overlay's advance pinning (the
      // embedded path, which has no overlay, does let the resolver place them).
      // Under `font-variant-emoji: text` the terminal must NOT capture the
      // codepoint: Chrome's forced-VS15 cascade finds a monochrome face where
      // one exists (measured: U+26A1 → Apple Symbols, U+2B50 → STIX Two Math),
      // so the resolver — with the same suppression threaded — decides.
      const emojiToTerminal = glyphIdForCp(primaryFont, cp) === 0 && isEmojiCodepoint(cp, nextCp) && effFve !== "text";
      if (clusterRun != null) {
        emitCh = ch;
        useKey = clusterRun.key;
        useFontOverride = clusterRun.font;
        useDecomposed = true;
      } else if (res!.covered && !emojiToTerminal) {
        emitCh = res!.emitCh;
        useKey = res!.key;
        useFontOverride = res!.fontOverride;
        useDecomposed = res!.decomposed;
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
        // ...EXCEPT for private-use / noncharacter codepoints, where Blink's
        // terminal is the first candidate's `.notdef` and nothing else: it runs
        // no system fallback for them at all (`platform/fonts/font_cache.cc:242-244`,
        // rev 7d859f27), so the iterator falls through kSystemFonts to
        // `kFirstCandidateForNotdefGlyph` (`font_fallback_iterator.cc:159-164`).
        // Pinning those to the chain tail painted LastResort's glyph — a rounded
        // box with a `?`, 35.20px wide at 32px against Helvetica's 20.28px
        // `.notdef` — so the ink ran over the following character while the
        // ADVANCE (from the capture) stayed Chrome's. The rasterGlyph rationale
        // above doesn't reach here: an overlay is only pinned for emoji, and a
        // PUA or noncharacter codepoint is neither.
        //
        // GENERALISED: the terminal is the primary for EVERY uncovered
        // codepoint, not only the private-use ones. Blink's iterator ends at
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
        // The emoji case above still reaches this branch and still wants the
        // chain tail: `emojiToTerminal` routes an uncovered emoji here on
        // purpose so the captured rasterGlyph PNG overlay keeps its advance
        // pinning, which is the rationale the original comment gives. That is
        // the one caller for which the pin was ever the point.
        emitCh = ch;
        if (emojiToTerminal) {
          const chain = fallbackFontChain(cp, primaryFontKey, lang);
          useKey = chain.length > 0 ? chain[chain.length - 1] : primaryFontKey;
        } else {
          useKey = primaryFontKey;
        }
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
    return singleFontMarkup(runs[0].font, runs[0].fontKey, runs[0].text, weight, fontSize, slant, targetWidth, xOffsets, features, stretch);
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
          // For emoji codepoints whose layout returns a .notdef tofu (id=0,
          // hollow rectangle outline), suppress path emission. The capture
          // layer attached a raster <image> overlay that fills the visual;
          // emitting the tofu underneath leaves visible black edges around
          // the emoji where the raster's sub-pixel transparency exposes the
          // tofu's outline. (DM-334.)
          const nextI = i + ch.length;
          const nextCp = nextI < text.length ? text.codePointAt(nextI)! : 0;
          const isPua = isPrivateUseCodepoint(cp);
          // `font-variant-emoji` moves the raster-overlay boundary (explicit
          // VS15/VS16 wins — same guard as the resolver call above): under
          // `text`, an emoji routed to a MONOCHROME face by the suppressed
          // cascade paints as a path glyph (no overlay to cover for it), and
          // only one still routed to the color font keeps the suppression;
          // under `emoji`/`unicode`, every codepoint the override routed to the
          // color font is overlay-painted, `Emoji`-property extras included.
          const charFve = (nextCp === 0xFE0E || nextCp === 0xFE0F) ? undefined : fontVariantEmoji;
          const isEmoji = charFve == null
            ? isEmojiCodepoint(cp, nextCp)
            : charFve === "text"
              ? isEmojiCodepoint(cp, nextCp) && isColorEmojiFontKey(run.fontKey)
              : isEmojiCodepoint(cp, nextCp) || (isEmojiCharCp(cp) && isColorEmojiFontKey(run.fontKey));
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
            const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, g.id, gCmds, stretch);
            uses.push(`<use href="#${defId}" x="0" y="0"/>`);
          }
          if (uses.length > 0) {
            let cssX = Number(xOffsets[i].toFixed(3));
            // DM-1184: shift trimmed fullwidth-punctuation ink (see
            // cjkTrimShiftFontUnits / the embedded-font path for the rationale).
            if (isTrimmableCjkPunct(cp) && nextI < xOffsets.length && layout.glyphs.length === 1) {
              const shiftFU = cjkTrimShiftFontUnits(run.font, run.fontKey, layout.glyphs[0], cp,
                xOffsets[nextI] - xOffsets[i], fontSize, runScale);
              if (shiftFU !== 0) cssX = Number((cssX + shiftFU * runScale).toFixed(3));
            }
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
              groups.push(`<g transform="translate(${cssX},0) scale(${chScale},${-chScale})"><path d="M${r2(x0)} ${r2(y0)} L${r2(x1)} ${r2(y0)} L${r2(x1)} ${r2(y1)} L${r2(x0)} ${r2(y1)} Z M${r2(ix0)} ${r2(iy0)} L${r2(ix0)} ${r2(iy1)} L${r2(ix1)} ${r2(iy1)} L${r2(ix1)} ${r2(iy0)} Z" fill-rule="evenodd"/></g>`);
            } else {
              groups.push(`<g transform="translate(${cssX},0) scale(${chScale},${-chScale})"><rect x="${r2(x0)}" y="${r2(y0)}" width="${r2(tofuW)}" height="${r2(tofuH)}"/></g>`);
            }
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
        const segments = needsSegmentation(run.text, runLevels)
          ? segmentForShaping(run.text, runLevels)
          // A run with no direction BOUNDARY still has a direction — its single
          // embedding level. Hardcoding `rtl: false` here was latent: the value
          // reached the shaper as an explicit `dir`, and the platform helper
          // ignored it and inferred RTL correctly from the content, so a
          // uniformly-RTL run came out right for the wrong reason. It stops
          // being harmless the moment a shaper actually honours what it is told.
          : [{
            start: 0,
            end: run.text.length,
            script: "",
            rtl: runLevels != null && runLevels.length > 0 && (runLevels[0] & 1) === 1,
          }];

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
          // the direction we want, so the helper becomes usable — and it must be,
          // because macOS's Arabic and Latin faces (GeezaPro, Helvetica) carry
          // `morx` and no `GSUB` at all, and the vendored harfbuzzjs is built
          // `-DHB_TINY`, which chains to `HB_NO_AAT` (`hb-config.hh:44-46`,
          // `:95-96`, `:132-134`) and so cannot apply `morx`. On GeezaPro it
          // returns the ISOLATED forms — 900/902/1292/1415/647 against real
          // HarfBuzz's 900/700/1359/656/647 — because the only table that could
          // join them was compiled out.
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
          const layout = features != null && features.length > 0
            ? shapeFont.layout(shapeText, fontkitFeatureList(features), undefined, undefined, shapeDir)
            : shapeFont.layout(shapeText, undefined, undefined, undefined, shapeDir);
          const uses: string[] = [];
          let segFontUnits = 0;
          for (let gi = 0; gi < layout.glyphs.length; gi++) {
            const glyph = layout.glyphs[gi];
            const pos = layout.positions[gi];
            const glyphCmds = commandsFor(glyph, run.fontKey, weight, fontSize, slant);
            if (glyphCmds.length > 0) {
              const defId = ensureGlyphDef(run.fontKey, weight, fontSize, slant, glyph.id, glyphCmds, stretch);
              const tx = segFontUnits + pos.xOffset;
              const ty = -pos.yOffset;
              uses.push(`<use href="#${defId}" x="${r2(tx)}" y="${r2(ty)}"/>`);
            }
            segFontUnits += pos.xAdvance;
          }
          if (uses.length > 0) {
            const cssX = Number(segMinX.toFixed(3));
            groups.push(`<g transform="translate(${cssX},0) scale(${sc},${-sc})">${uses.join("")}</g>`);
            const segRight = segMinX + segFontUnits * runScale;
            if (segRight > rightEdge) rightEdge = segRight;
          }
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
      ? run.font.layout(run.text, fontkitFeatureList(features))
      : run.font.layout(run.text);
    const uses: string[] = [];
    let runX = 0;
    for (let i = 0; i < layout.glyphs.length; i++) {
      const glyph = layout.glyphs[i];
      const pos = layout.positions[i];
      const glyphCmds = commandsFor(glyph, run.fontKey, weight, fontSize, slant);
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
      groups.push(`<g transform="translate(${r2(xCss)},0) scale(${sc},${-sc})">${uses.join("")}</g>`);
    }
    xCss += runX * runScale;
  }
  return {
    markup: groups.length > 0 ? groups.join("") : "",
    width: xCss,
  };
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
  // Fallback (font can't report `halt`): classify by ink position.
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
      const dCmds = commandsFor(glyph, fontKey, weight, fontSize, slant);
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
      const cps = glyph.codePoints;
      textIdx += sourceClusterSpan(text, textIdx, cps != null && cps.length > 0 ? cps.length : 1, false);
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
    const eCmds = commandsFor(glyph, fontKey, weight, fontSize, slant);
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
        if (cp0 != null && i + 1 < xOffsets!.length && isTrimmableCjkPunct(cp0)) {
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
  }
  return {
    markup: uses.length > 0 ? `<g transform="scale(${sc},${-sc})">${uses.join("")}</g>` : "",
    width: usePerChar ? (xOffsets![xOffsets!.length - 1] + nativeWidth / run.glyphs.length) : (targetWidth ?? nativeWidth),
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
  const primaryFontKey = resolveFontKey(fontFamily);
  // The full declared stack, derived the same way the run splitters derive it —
  // the coverage probe below delegates to `resolveFontForCodepoint`, which walks
  // it (Blink's kFontFamily stage), so a mark covered only by a later-declared
  // family is "covered" here exactly when the emitter will paint it.
  const fontKeyChain = resolveFontKeyChain(fontFamily);
  const stretch = stretchPercent(fontStretch);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch);
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
    // DM-1126 / DM-1157 etc.: the capture layer probed Chrome's real shaper and
    // recorded which orphaned codepoints it circles (`coveredCircleSet`). When
    // that data is present it is the AUTHORITY — it both adds circles the static
    // block table misses (no-table blocks: Sogdian, Miao, Garay, … and category-
    // Lo cluster letters like Soyombo U+11A84) and VETOES ones it would wrongly
    // add (e.g. Sinhala U+0D81, which Chrome leaves blank). The block-table
    // heuristic (`usesComplexShaperDottedCircle`) is the fallback only for
    // captures with no probe data (older trees / the programmatic API).
    const probeFlagged = coveredCircleSet != null && coveredCircleSet.has(i);
    if (isMark || probeFlagged) {
      const orphaned = !clusterHasBase;
      const wantUncoveredCircle = coveredCircleSet != null ? probeFlagged : usesComplexShaperDottedCircle(cp);
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
      const runFontHasDottedCircle = glyphIdForCp(primaryFont, 0x25cc) !== 0;
      if (orphaned && wantUncoveredCircle && runFontHasDottedCircle
          && codepointResolvesToNotdef(cp, primaryFont, primaryFontKey, weight, fontSize, slant,
            variationSettings, lang, fontKeyChain, stackPrimaryIsSystemUi(fontFamily), stretch)) {
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
      if (isMark && orphaned && coveredCircleSet != null && coveredCircleSet.has(i)
          && glyphIdForCp(primaryFont, cp) !== 0
          && glyphIdForCp(primaryFont, 0x25CC) !== 0
          && !fontAutoInsertsDottedCircle(primaryFont, ch)
          // DM-1229: U+302A–302F (combining CJK/Hangul tone marks) must NOT take
          // this "◌ + centered-mark" path. Real HarfBuzz on the BARE mark in
          // Arial Unicode MS already reproduces Chrome exactly — it inserts the ◌
          // and orders the cluster as [mark, ◌] (mark to the LEFT of the circle).
          // Prepending an explicit ◌ here instead yields "◌ + mark" (◌ to the
          // left, dots to the right) — the reverse of Chrome. Leaving them bare
          // routes them through the DM-1215 dotted-circle HarfBuzz path (see
          // `resolveDottedCircleHbRun`), which matches.
          && !(cp >= 0x302a && cp <= 0x302f)
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
    const res = clusterRun != null ? null : resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, systemUiPrimary, stretch, effFve);
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
  /** Computed CSS `font-stretch` (e.g. `"75%"`). */
  fontStretch?: string,
  /** The run's `font-variant-emoji` override (`normal` = undefined). */
  fontVariantEmoji?: FontVariantEmojiOverride,
): string | null {
  const weight = parseInt(fontWeight) || 400;
  const slant = slantForStyle(fontStyle);
  const stretch = stretchPercent(fontStretch);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch);
  if (primaryFont == null) return null;
  const primaryFontKey = resolveFontKey(fontFamily);
  const fontKeyChain = resolveFontKeyChain(fontFamily);
  // DM-1103: the optical-cut opsz `resolveFont` pinned for the primary face,
  // folded into the per-instance embed key below so a cut-pinned run (e.g.
  // "SF Pro Text" → opsz 17) doesn't dedup-collide with a generic SF Pro run
  // that shares the collapsed `sf-pro` key at the same weight/slant.
  const primaryCutOpsz = opticalCutOpszFor(fontFamily);

  const runs = splitTextIntoFontRuns(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, stackPrimaryIsSystemUi(fontFamily), stretch, fontVariantEmoji);
  if (runs.length === 0) return null;

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

  // Per-run baseline: SVG `<text y=...>` puts the BASELINE at y. Use the
  // captured Chrome `fontBoundingBoxAscent` when provided (matches what
  // Chrome's text engine measured on the original page); else fall back
  // to the primary font's HHEA ascent scaled to fontSize.
  const scale = fontSize / primaryFont.unitsPerEm;
  const baselineAscent = ascentOverride != null ? ascentOverride : Math.round(primaryFont.ascent * scale);
  const baselineY = y + baselineAscent;

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
      layout = features != null && features.length > 0 ? run.font.layout(shapingText, fontkitFeatureList(features)) : run.font.layout(shapingText);
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
    const faceNaturalWeight = run.font.naturalWeight;
    // DM-1880: Blink's synthetic-bold predicate is DIFFERENT ON EACH PLATFORM.
    // There is no single "Blink rule" to transcribe here — all three read from
    // `external/chromium`, rev 7d859f27:
    //
    //   macOS   mac/font_cache_mac.mm:424-427
    //           desired_bold = Weight() > 500;
    //           synthetic = desired_bold && !(traits & kCTFontTraitBold)
    //
    //   Linux   skia/font_cache_skia.cc:333-339          (also Android/Fuchsia)
    //           Weight() > FontSelectionValue(200) + typeface->fontStyle().weight()
    //
    //   Windows win/font_cache_skia_win.cc:486-488
    //           Weight() >= kBoldThreshold && !typeface->isBold()
    //           (kBoldThreshold = 600, font_selection_types.h:182;
    //            Skia's isBold() is the face's own declared weight >= 600)
    //
    // A DELTA on Linux, a THRESHOLD PAIR on macOS and Windows, and the two
    // thresholds are not even the same number (500 vs 600).
    //
    // What shipped was the delta — which is exactly right for Linux and wrong
    // for the other two. The clean divergence is weight 600 on a 400 face:
    // macOS and Windows both synthesise (600 > 500; 600 >= 600, face not bold)
    // and the delta does not (600 - 400 = 200, not > 200), so `font-weight: 600`
    // on a static non-bold face painted the thin natural outline where Chrome
    // paints emboldened ink. It also fired the other way on a 500-weight face
    // that declares itself bold: the delta synthesises at 800 where macOS and
    // Windows, asking the face's own bold flag, synthesise nothing.
    //
    // Worth stating because the ticket asked to "port Blink's predicate", which
    // presumes one exists: porting the Windows rule everywhere would have broken
    // Linux, where the delta IS the transcription.
    //
    // Honest substitution: macOS's test is CoreText's `kCTFontTraitBold`
    // symbolic trait, which we cannot read here; `faceNaturalWeight >= 600` is
    // the stand-in, and it is the same line Skia draws for `isBold()`. Faces
    // whose declared weight and symbolic trait disagree will differ from Chrome.
    //
    // `hasWeightAxis` has no counterpart in Blink and is kept: a variable face
    // is instanced at the requested axis location before it reaches here, so it
    // already reports itself at that weight and there is nothing to synthesise.
    // DM-1880: the face's own BOLD flag, which is what macOS and Windows both
    // ask for. `faceIsBoldTrait` is the real thing — OS/2 `fsSelection` bit 5
    // for a fontkit face, CoreText's `kCTFontTraitBold` for a helper-backed one.
    // The weight comparison is only a fallback for a face that reports neither,
    // and it is the substitution that measurably regressed a fixture when it was
    // used as the primary signal, so it must not quietly become one again.
    const faceIsBold = run.font.faceIsBoldTrait
      ?? (faceNaturalWeight != null && faceNaturalWeight >= 600);
    // A run resolved through the `@font-face` registry obeys a DIFFERENT rule,
    // and a platform-independent one: Chrome's webfont synthetic bold is
    // decided in the CSS layer (whether the declared font-weight DESCRIPTOR
    // reaches bold, not whether the FILE does), so none of the per-platform
    // system-font predicates below apply. Measured over CDP + 1x ink at 100px
    // "Hamburgefonstiv": a variable webfont declared `font-weight: 400` and
    // requested at 700 paints Lexend-Regular at ink 25951.4 against 21568.9
    // for the same face at request 400 — a +20.3% dilation on an unchanged
    // advance (847.000 px both) and an unchanged reported face name, which is
    // why neither width nor `CSS.getPlatformFontsForNode` can see it.
    // Reusing macOS's `weight > 500` predicate here would also be wrong in the
    // other direction: a static webfont requested at 500 measured IDENTICAL to
    // its 400 control (ink 17510.0 both), because the webfont threshold is 600.
    const webfontFace = run.font.webfontFace;
    const faceLacksWeight = webfontFace != null
      ? webfontSyntheticBold(webfontFace, weight)
      : run.font.hasWeightAxis !== true &&
      faceNaturalWeight != null &&
      (hostPlatform() === "darwin"
        // macOS: `desired_bold = Weight() > 500`, then `&& !(traits & kCTFontTraitBold)`
        // (`mac/font_cache_mac.mm:424-427`). Note the threshold is 500, not the
        // 600 Windows uses — they are different numbers in Blink, not a typo here.
        ? weight > 500 && !faceIsBold
        : hostPlatform() === "win32"
        // Windows only, for now. Linux keeps the delta because the delta IS its
        // transcription. macOS is ALSO wrong today, and is deliberately left
        // wrong rather than half-fixed: its rule tests CoreText's
        // `kCTFontTraitBold` symbolic trait, and standing in
        // `faceNaturalWeight >= 600` for that regressed
        // `2070-209F-superscripts-and-subscripts` (0.0138 → 0.0574) with nothing
        // gained across 818 fixtures. A face declaring weight 500 that carries
        // the bold trait is treated as not-bold by the stand-in, so we synthesise
        // where Chrome does not. Fixing it properly means plumbing the real trait
        // out of the CoreText helper; until then the delta is the better wrong
        // answer, and saying so beats shipping a transcription that measures worse.
        ? weight >= 600 && !faceIsBold
        : weight - faceNaturalWeight > FAUX_BOLD_WEIGHT_DELTA);
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
    const instanceKey = `${run.fontKey}|${weightPart}|s=${slant}${fvsTuple}${cutTuple}${axesTuple}`;

    // DM-1695: faux-italic. When italic is requested (slant ≠ 0) but the resolved
    // face is UPRIGHT (no italic sibling was routed to, no `slnt` axis carried the
    // slant), Chrome synthesizes an oblique by shearing the glyph. Bake the same
    // shear into the embedded outline (the @font-face descriptor stays italic, so
    // the consumer synthesizes nothing). A shear is a pure affine transform, so —
    // unlike faux-bold — it reproduces Chrome's device-space skew exactly and is
    // safe on stroked runs too (no gate). `italicAngle` is the resolved face's
    // own slant: a real italic face (|angle| ≥ 1°) already leans, so skip it.
    // `isRoutedItalicCut` covers the faces that lean but under-report it — some
    // TTC members ship `post.italicAngle` 0 despite a visibly slanted outline,
    // and shearing those a second time doubled their lean.
    let shearFactor = 0;
    if (
      slant !== 0 &&
      run.font.hasSlantAxis !== true &&
      run.font.isRoutedItalicCut !== true &&
      (run.font.resolvedItalicAngle == null || Math.abs(run.font.resolvedItalicAngle) < 1)
    ) {
      shearFactor = OBLIQUE_SHEAR;
    }

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
        { italic: slant !== 0, weight, emboldenStrengthFU, shearFactor, hintedSource },
      );
      if (placement == null) { glyphFailed = true; break; }
      if (runCssFamily == null) runCssFamily = placement.cssFamily;

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
        if (cpCl != null && isTrimmableCjkPunct(cpCl) && xOffsets != null) {
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
          if (cp0 != null && isTrimmableCjkPunct(cp0)) {
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
      if (!glyphInkless) {
        perGlyph.push({ pua: String.fromCodePoint(placement.puaCodepoint), xCss, yCss, scale: glyphScale });
      }
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
    if (fakeBoldStroke.strokeWidthPx > 0 && textStrokeColor != null && textStrokeColor !== "") {
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

  if (segments.length === 0) return null;

  // Accessibility: wrap the per-font `<text>` segments in a labeled <g>
  // so screen readers + Find-In-Page see the ORIGINAL text. The visible
  // glyph stream is PUA codepoints, which AT would otherwise read as
  // garbage. The aria-label / <title> carry the human-readable form.
  return `<g role="img" aria-label="${esc(text)}"><title>${esc(text)}</title>${segments.join("")}</g>`;
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
}

/** Normalize `TextFontOptions.fontWeight` to the numeric CSS weight. */
export function cssWeightOf(fontWeight: string | number): number {
  return typeof fontWeight === "number" ? fontWeight : (parseInt(fontWeight) || 400);
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

/**
 * Render text as SVG markup using path outlines with <defs>/<use> deduplication.
 * Returns a <g> element containing <use> references, positioned at (x, y) top.
 */
export function renderTextAsPath(
  text: string,
  x: number,
  y: number,
  options: RenderTextOptions,
): string | null {
  const { fontSize, fontFamily, fill, targetWidth, fontStyle, ascentOverride,
    features, lang, variationSettings, textStrokeWidth, textStrokeColor,
    paintOrder, dottedCircleMarks, bidiOverride, fontStretch, fontVariantEmoji } = options;
  const fontWeight = String(options.fontWeight);
  let { xOffsets } = options;
  const weight = cssWeightOf(options.fontWeight);
  const slant = slantForStyle(fontStyle);
  const stretch = stretchPercent(fontStretch);
  const esc = escAttr;

  // DM-1026 / DM-1126: synthesize the dotted circle Chrome's HarfBuzz inserts
  // before an orphaned complex-shaper combining mark — for UNCOVERED marks
  // (no-font Brahmic blocks, detected here) and for CAPTURE-flagged COVERED marks
  // (`dottedCircleMarks`, e.g. Mukta Vedic). Run once at the funnel so both the
  // embedded-font and glyph-path branches below receive the augmented text +
  // xOffsets. A no-op for text with no combining marks.
  ({ text, xOffsets } = insertSyntheticDottedCircles(
    text, xOffsets, fontFamily, weight, fontSize, slant, variationSettings, lang, dottedCircleMarks, fontStretch));

  // DM-1158: hide orphaned variation selectors / tags Chrome paints nothing for
  // (they otherwise fall through to a last-resort tofu box).
  ({ text, xOffsets } = stripOrphanedDefaultIgnorables(text, xOffsets));

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
      textStrokeWidth, textStrokeColor, paintOrder, targetWidth, fontStretch, fontVariantEmoji);
    if (embedded != null) return embedded;
  }

  const result = textToPathMarkup(text, fontSize, fontFamily, fontWeight, targetWidth, xOffsets, fontStyle, features, lang, variationSettings, bidiOverride, fontStretch, fontVariantEmoji);
  if (result == null || result.markup === "") return null;

  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch);
  if (font == null) return null;

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
  let strokeAttr = "";
  if (textStrokeWidth != null && textStrokeWidth > 0 && textStrokeColor != null && textStrokeColor !== "") {
    const inverseScale = font.unitsPerEm / fontSize;
    const swInEm = textStrokeWidth * inverseScale;
    strokeAttr = ` stroke="${textStrokeColor}" stroke-width="${r2(swInEm)}"`;
    if (paintOrder != null && /^\s*stroke(?:\s|$)/.test(paintOrder)) {
      strokeAttr += ` paint-order="stroke fill"`;
    }
  }
  return `<g transform="translate(${r2(x)},${r2(baselineY)})" fill="${fill}"${strokeAttr} role="img" aria-label="${esc(text)}"><title>${esc(text)}</title>${result.markup}</g>`;
}

/**
 * Check if text-to-path conversion is available for a font family.
 */
export function isTextToPathAvailable(fontFamily: string): boolean {
  return resolveFont(fontFamily, 400, 14) != null;
}


/** The decoration-specific CSS inputs to `getDecorationMetrics`. */
export interface DecorationStyleOptions {
  /** CSS `text-decoration-thickness` — when set to a length value (e.g. "5px"),
   *  overrides the auto thickness. Pass `undefined` or `auto` to use the auto
   *  rule. DM-431. */
  thicknessOverride?: string;
  /** CSS `text-underline-offset` — when set to a length value, adds this much
   *  EXTRA distance below the baseline (on top of the auto offset). DM-431. */
  underlineOffsetCss?: string;
  /**
   * DM-1819/DM-1820: CSS `text-underline-position`. Captured since DM-936 but,
   * until now, read only by the VERTICAL text path — so in horizontal text
   * `under` rendered as `auto` and the underline cut straight through the
   * descenders instead of clearing them.
   *
   *   `auto` (default) / `from-font` — just below the alphabetic baseline (the
   *     empirical auto rule below; `from-font` would use the face's own
   *     `post.underlinePosition`, which for the faces we resolve lands within a
   *     rounding of the auto rule, so it is deliberately NOT special-cased).
   *   `under` — below ALL descenders, i.e. at the font's descent depth. This is
   *     what Chromium's `ComputeUnderlineOffsetForUnder` does: it drops the line
   *     to the under edge of the content box rather than offsetting from the
   *     baseline.
   *   `left` / `right` — vertical-writing-mode only; horizontally they behave as
   *     `auto` (handled by falling through).
   */
  underlinePositionCss?: string;
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
 *
 * Resolves the face at the run's `font-stretch` width, like the glyph path:
 * a condensed run's underline reads the condensed cut's metrics, not the
 * normal cut's.
 */
export function getDecorationMetrics(
  fontOptions: TextFontOptions,
  decoration: DecorationStyleOptions = {},
): DecorationMetrics {
  const { fontFamily, fontSize, fontStyle, fontStretch, variationSettings } = fontOptions;
  const { thicknessOverride, underlineOffsetCss, underlinePositionCss } = decoration;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretchPercent(fontStretch));
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
  let underlineOffsetY = 1.5 * thicknessPx + extraUnderlineOffset;
  // DM-1819/DM-1820: `under` drops the line clear of the descenders. The font's
  // descent IS that depth (it is the bottom of the em box below the baseline),
  // so use it in place of the baseline-relative auto gap; `text-underline-offset`
  // still applies on top, as it does for `auto`.
  const underlinePos = (underlinePositionCss ?? "").trim().toLowerCase();
  if (underlinePos.split(/\s+/).includes("under") && font != null) {
    const descentPx = Math.abs(font.descent) * (fontSize / font.unitsPerEm);
    if (descentPx > 0) underlineOffsetY = descentPx + thicknessPx + extraUnderlineOffset;
  }
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
  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretchPercent(fontStretch));
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
  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretchPercent(fontStretch));
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
  fontOptions: TextFontOptions,
): { inkAscent: number; inkDescent: number } | null {
  const { fontFamily, fontSize, fontStyle, fontStretch, lang, variationSettings, features } = fontOptions;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const stretch = stretchPercent(fontStretch);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretch);
  if (primaryFont == null) return null;
  const primaryFontKey = resolveFontKey(fontFamily);
  const fontKeyChain = resolveFontKeyChain(fontFamily);
  const runs = splitTextIntoFontRuns(text, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain, stackPrimaryIsSystemUi(fontFamily), stretch);
  let maxY = -Infinity; // ink top    (font units, y-up)
  let minY = Infinity;  // ink bottom (font units, y-up; negative = below baseline)
  for (const run of runs) {
    const scale = fontSize / run.font.unitsPerEm;
    let layout;
    try {
      layout = features != null && features.length > 0 ? run.font.layout(run.text, fontkitFeatureList(features)) : run.font.layout(run.text);
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
  const primaryFontKey = resolveFontKey(fontFamily);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, undefined, stretch);
  if (primaryFont == null) return null;
  const res = resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, undefined, undefined,
    resolveFontKeyChain(fontFamily), stackPrimaryIsSystemUi(fontFamily), stretch);
  const useKey = res.covered ? res.key : primaryFontKey;
  const font = res.covered ? (res.fontOverride ?? getFontInstance(res.key, weight, fontSize, slant, undefined, stretch) ?? primaryFont) : primaryFont;

  let layout;
  try { layout = font.layout(ch); } catch { return null; }
  const glyph = layout.glyphs[0] as
    { id: number; path: { commands: Array<{ command: string; args: number[] }> }; bbox?: { minX: number; minY: number; maxX: number; maxY: number } } | undefined;
  if (glyph == null || glyph.path.commands.length === 0) return null;
  const bbox = glyph.bbox;
  if (bbox == null || !(bbox.maxY > bbox.minY)) return null;

  const em = font.unitsPerEm;
  const defId = ensureGlyphDef(useKey, weight, fontSize, slant, glyph.id, glyph.path.commands, stretch);
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
  const primaryFontKey = resolveFontKey(fontFamily);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, undefined, stretch);
  if (primaryFont == null) return null;
  const res = resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, undefined, undefined,
    resolveFontKeyChain(fontFamily), stackPrimaryIsSystemUi(fontFamily), stretch);
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
  const { decorationCenterYRel = 0, decorationThickness = 1, targetWidth, charXOffsets } = skipInk;
  const weight = cssWeightOf(fontOptions.fontWeight);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant, variationSettings, stretchPercent(fontStretch));
  if (font == null) return [];
  let layout;
  try { layout = font.layout(text, fontkitFeatureList(features)); } catch { return []; }
  const scale = fontSize / font.unitsPerEm;
  const yTop = decorationCenterYRel - decorationThickness / 2;
  const yBot = decorationCenterYRel + decorationThickness / 2;
  const pad = Math.max(0.5, decorationThickness * 0.5);
  const rawGaps: Array<[number, number]> = [];
  const anchoredGaps: Array<[number, number]> = [];
  let xCursor = 0;
  let charCursor = 0; // UTF-16 cursor into `text` tracking each glyph's first char
  for (let i = 0; i < layout.glyphs.length; i++) {
    const glyph = layout.glyphs[i];
    const pos = layout.positions[i];
    const anchor = charXOffsets?.[charCursor];
    const fkGlyphX = xCursor + (pos.xOffset || 0) * scale;
    const range = glyphPathIntercepts(glyph.path, fkGlyphX, scale, yTop, yBot);
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

