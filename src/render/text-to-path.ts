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
import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import { createGlyphHelperFont, isGlyphHelperAvailable, resolveSystemFallbackFonts, resolveInstalledFont } from "./glyph-helper.js";
import { makeHarfbuzzShapingInstance } from "./harfbuzz-shaper.js";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss, trackGlyphInEmbedFont } from "./embedded-font-builder.js";
import { UNICODE_FONT_PATHS, UNICODE_FONT_RANGES } from "./unicode-font-routing.darwin.generated.js";
import { UNICODE_FONT_PATHS_LINUX, UNICODE_FONT_RANGES_LINUX } from "./unicode-font-routing.linux.generated.js";
import { UNICODE_FONT_FILES_WIN32, UNICODE_FONT_RANGES_WIN32 } from "./unicode-font-routing.win32.generated.js";
// Unicode-classification predicates (mathAlphaToBase, isRtlScriptCodepoint, isStretchyFenceChar, complex-shaper / matra / rtl ranges, …) moved to ./unicode-classification.ts (DM-1305).
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
  getFontInstance,
  glyphInkXRange,
  glyphPathIntercepts,
  haltInfoFor,
  isEmojiCodepoint,
  isPrivateUseCodepoint,
  mergeGaps,
  opticalCutOpszFor,
  pickWebfontVariantForCodepoint,
  r2,
  resolveDottedCircleHbRun,
  resolveFont,
  resolveFontForCodepoint,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontSpec,
  setRenderTextMode,
  syntheticMarkCenteringOffsetPx,
  win,
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
      const res = clusterRun != null ? null : resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
      // An UNCOVERED emoji must stay on the glyph-path terminal, NOT take the
      // resolver's system-fallback. Emoji are painted by the rasterGlyph overlay;
      // placing one on a system color font here would split it out of the
      // surrounding text run and break the overlay's advance pinning (the
      // embedded path, which has no overlay, does let the resolver place them).
      const emojiToTerminal = primaryFont.glyphForCodePoint(cp).id === 0 && isEmojiCodepoint(cp, nextCp);
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
            uses.push(`<use href="#${defId}" x="${r2(tx)}" y="${r2(ty)}"/>`);
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
        uses.push(`<use href="#${defId}" x="${r2(tx)}" y="${r2(ty)}"/>`);
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
        uses.push(`<path d="M${r2(x0)} ${r2(y0)} L${r2(x1)} ${r2(y0)} L${r2(x1)} ${r2(y1)} L${r2(x0)} ${r2(y1)} Z M${r2(ix0)} ${r2(iy0)} L${r2(ix0)} ${r2(iy1)} L${r2(ix1)} ${r2(iy1)} L${r2(ix1)} ${r2(iy0)} Z" fill-rule="evenodd"/>`);
      } else {
        // Degenerate (very thin advance) — fall back to a solid filled rect.
        uses.push(`<rect x="${r2(x0)}" y="${r2(y0)}" width="${r2(tofuW)}" height="${r2(tofuH)}"/>`);
      }
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

// DM-1158: drop ORPHANED, primary-uncovered default-ignorable code points (see
// `isStrippableOrphanIgnorable`) from `text` + `xOffsets` so neither the
// embedded-font nor the glyph-path branch emits the last-resort tofu Chrome
// never paints. "Orphaned" = no base char precedes it in the cluster: a
// variation selector that FOLLOWS a base (emoji presentation VS-16, CJK
// variation sequences) is meaningful, so it is left in place for the
// downstream emoji-overlay / shaping logic. Primary-covered selectors (a font
// that actually has the VS glyph) are also kept. A no-op for text with none.
export function stripOrphanedDefaultIgnorables(
  text: string, xOffsets: number[] | undefined,
  fontFamily: string, weight: number, fontSize: number, slant: number,
  variationSettings: Record<string, number> | undefined,
): { text: string; xOffsets: number[] | undefined } {
  let any = false;
  for (const ch of text) { if (isStrippableOrphanIgnorable(ch.codePointAt(0)!)) { any = true; break; } }
  if (!any) return { text, xOffsets };
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, variationSettings);
  if (primaryFont == null) return { text, xOffsets };
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
    if (isStrippableOrphanIgnorable(cp) && !clusterHasBase
        && primaryFont.glyphForCodePoint(cp).id === 0) {
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
      if (orphaned && wantUncoveredCircle
          && codepointResolvesToNotdef(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang)) {
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
          && primaryFont.glyphForCodePoint(cp).id !== 0
          && primaryFont.glyphForCodePoint(0x25CC).id !== 0
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
    const res = clusterRun != null ? null : resolveFontForCodepoint(cp, primaryFont, primaryFontKey, weight, fontSize, slant, variationSettings, lang, fontKeyChain);
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
        // DM-1184: nudge trimmed fullwidth-punctuation ink (see
        // cjkTrimShiftFontUnits). Only at a cluster's first glyph, gated on the
        // captured advance to the next char being trimmed (~half em).
        let trimShiftFU = 0;
        const cpCl = glyph.codePoints?.[0] ?? text.codePointAt(wholeTextIdx);
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
          // DM-1184: nudge trimmed fullwidth-punctuation ink (see
          // cjkTrimShiftFontUnits) in the fontkit-shaped embedded path too.
          const cp0 = glyph.codePoints?.[0] ?? text.codePointAt(wholeTextIdx);
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
      const glyphInkless = glyph.codePoints != null && glyph.codePoints.length > 0
        && glyph.codePoints.every((cp) => isLegitimatelyInklessCodepoint(cp));
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
    if (textStrokeWidth != null && textStrokeWidth > 0 && textStrokeColor != null && textStrokeColor !== "") {
      strokeAttr = ` stroke="${textStrokeColor}" stroke-width="${r2(textStrokeWidth)}"`;
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

  // DM-1158: hide orphaned, uncovered variation selectors / tags Chrome paints
  // nothing for (they otherwise fall through to the CoreText last-resort tofu).
  ({ text, xOffsets } = stripOrphanedDefaultIgnorables(
    text, xOffsets, fontFamily, weight, fontSize, slant, variationSettings));

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
/**
 * Advance width (CSS px) of the space glyph in the resolved font. DM-1154: an
 * outside list marker's trailing suffix space is part of Blink's right-aligned
 * marker box (box end = content edge), but SVG drops trailing whitespace, so the
 * renderer must subtract the space's advance manually to place the visible glyph
 * where Chrome paints it.
 */
export function fontSpaceAdvancePx(
  fontSize: number,
  fontFamily: string,
  fontWeight: string | number,
  fontStyle?: string,
): number {
  const weight = typeof fontWeight === "number" ? fontWeight : (parseInt(fontWeight) || 400);
  const slant = slantForStyle(fontStyle);
  const font = resolveFont(fontFamily, weight, fontSize, slant);
  if (font == null) return fontSize * 0.25;
  try {
    const g = font.layout(" ").glyphs[0] as { advanceWidth: number } | undefined;
    if (g == null) return fontSize * 0.25;
    return g.advanceWidth * (fontSize / font.unitsPerEm);
  } catch {
    return fontSize * 0.25;
  }
}

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

