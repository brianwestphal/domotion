/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { hostPlatform } from "./host-platform.js";
import { isGlyphHelperAvailable } from "./glyph-helper.js";
import { makeHarfbuzzShapingInstance } from "./harfbuzz-shaper.js";
import {
  isHarfbuzzSameFontSpaceFallback,
  harfbuzzCanonicalDecompositionCandidates,
  complexShaperBaseMarkDecomposition,
  nfdBaseMarkDecomposition,
} from "./unicode-classification.js";
import { isIcuHelperAvailable } from "./icu-helper.js";
import type { FontInstance } from "./font-instance.js";
import type { FontVariantEmojiOverride } from "./emoji-presentation.js";
import type { FontFallbackSemanticContext } from "./fallback-chain.js";
import { createFontFallbackSemanticContext } from "./fallback-chain.js";
import type { FontResolution } from "./shaping-route.js";
import { harfbuzzShapedScriptOverride } from "./shaping-route.js";
import { glyphIdForCp } from "./font-instance.js";
import { shapingFaceFor } from "./font-instance.js";
import { logicalFontSize } from "./font-instance.js";
import { fontHasSupportedColorTable } from "./emoji-presentation.js";
import { fontCoversCp } from "./font-instance.js";
import { nativeFaceCoversCp } from "./font-instance.js";
import { sfProCoverageOtfKey } from "./shaping-route.js";
import { getFontInstance } from "./font-instance.js";
import { pickWebfontVariantForCodepoint } from "./webfont-registry.js";
import { systemFallbackResolutionEnabled } from "./font-spec.js";
import { exactDarwinFallbackKey, resolveSystemFallbackKeyForRequest } from "./system-fallback-resolver.js";
import { systemFallbackCoverage } from "./system-fallback-resolver.js";
import { fallbackFontChain } from "./fallback-chain.js";
import { fallbackFamilyCutKey } from "./system-fallback-resolver.js";
import { isPrivateUseCodepoint } from "./fallback-chain.js";
import { isNonCharacterCodepoint } from "./fallback-chain.js";
import { isEmojiCharCp } from "./emoji-presentation.js";
import { isEmojiPresentationCp } from "./emoji-presentation.js";
import { splitFontFamilyNames } from "./font-instance.js";
import { matchFamilyNameToKey } from "./family-match.js";
import { liveFallbackFirst } from "./system-fallback-resolver.js";
import { decomposeMathAlphaRun } from "./fallback-chain.js";
import { resolveFontKey } from "./family-match.js";
import { resolveFont } from "./family-match.js";
import { resolveFontKeyChain } from "./family-match.js";
import type { FontRequest } from "./font-request.js";

/**
 * Stage-attribution counters for the per-codepoint resolver. Investigation
 * instrumentation for the shaped-cluster-granularity design work (docs/113):
 * the question "now that the live system-fallback resolvers are default-on,
 * how often does the static per-block chain still answer at all?" decides
 * whether the sampled chains can be retired, and it can only be answered by
 * counting at the decision sites. Unconditional cheap increments; no behavior
 * change. Read with `__getFontStageStatsForTest()`, reset with `__resetFontStageStatsForTest()`.
 */
export interface FontStageStats {
  /** Total `resolveFontForCodepoint` decisions. */
  calls: number;
  /** Answered by the primary literal fast path (step 0). */
  fastPathPrimary: number;
  /** Reached the kSystemFonts stand-in (live resolver and/or static chain). */
  systemStageReached: number;
  /** Live resolver consulted / answered. */
  liveAsked: number;
  liveAnswered: number;
  /** Static chain consulted / answered. */
  staticAsked: number;
  staticAnswered: number;
  /** Private-use / noncharacter early terminal (no system fallback, per Blink). */
  noSystemFallback: number;
  /** Fell all the way through to the uncovered terminal. */
  uncovered: number;
  /** candidate key → count, for the static-chain answers only. */
  staticKeyTally: Map<string, number>;
  /** primary font key → count, for the static-chain answers only. */
  staticPrimaryTally: Map<string, number>;
  /** Sample of codepoints the static chain answered for (capped). */
  staticCpSample: number[];
}

const _stageStats: FontStageStats = {
  calls: 0,
  fastPathPrimary: 0,
  systemStageReached: 0,
  liveAsked: 0,
  liveAnswered: 0,
  staticAsked: 0,
  staticAnswered: 0,
  noSystemFallback: 0,
  uncovered: 0,
  staticKeyTally: new Map(),
  staticPrimaryTally: new Map(),
  staticCpSample: [],
};

const STATIC_CP_SAMPLE_CAP = 20000;

export function __getFontStageStatsForTest(): FontStageStats {
  return {
    ..._stageStats,
    staticKeyTally: new Map(_stageStats.staticKeyTally),
    staticPrimaryTally: new Map(_stageStats.staticPrimaryTally),
    staticCpSample: [..._stageStats.staticCpSample],
  };
}

export function __resetFontStageStatsForTest(): void {
  _stageStats.calls = 0;
  _stageStats.fastPathPrimary = 0;
  _stageStats.systemStageReached = 0;
  _stageStats.liveAsked = 0;
  _stageStats.liveAnswered = 0;
  _stageStats.staticAsked = 0;
  _stageStats.staticAnswered = 0;
  _stageStats.noSystemFallback = 0;
  _stageStats.uncovered = 0;
  _stageStats.staticKeyTally.clear();
  _stageStats.staticPrimaryTally.clear();
  _stageStats.staticCpSample.length = 0;
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
  /** DM-2017: the run's RAW CSS `font-family` stack, passed through to the
   *  Linux live resolver's standard-style retry — see
   *  `resolveSystemFallbackKeyForCp`'s `declaredFamily` param. Optional; the
   *  many direct callers of this function (unit tests, calibration harnesses)
   *  keep their exact behavior when they omit it. */
  declaredFamily?: string,
  rawSlope: number = slant !== 0 ? 14 : 0,
  orientation: number = 0,
  semanticContext: FontFallbackSemanticContext = createFontFallbackSemanticContext(declaredFamily),
): FontResolution {
  const request: FontRequest = {
    cp,
    primaryFont,
    primaryFontKey,
    weight,
    fontSize,
    slant,
    variationSettings,
    lang,
    fontKeyChain,
    systemUiPrimary,
    stretch,
    fontVariantEmoji,
    declaredFamily,
    rawSlope,
    orientation,
    semanticContext,
  };
  return harfbuzzShapedScriptOverride(
    cp,
    resolveFontForCodepointInner(request),
    primaryFont,
    primaryFontKey,
    weight,
    fontSize,
    slant,
    variationSettings,
  );
}

/** Construct the common successful result emitted by every fallback stage. */
export function coveredFontResolution(
  key: string,
  fontOverride: FontInstance | null,
  emitCh: string,
  decomposed: boolean = false,
): FontResolution {
  return { key, fontOverride, emitCh, decomposed, covered: true };
}

function walkFontFallbackStages(request: FontRequest): FontResolution {
  const {
    cp,
    primaryFont,
    primaryFontKey,
    weight,
    fontSize,
    slant,
    variationSettings,
    lang,
    fontKeyChain,
    systemUiPrimary,
    stretch,
    fontVariantEmoji,
    semanticContext,
  } = request;
  // From this point the serialized request carrier is the sole owner. Keeping
  // the legacy scalar only in the public signature preserves call compatibility
  // without allowing hardcoded and live stages to answer different stacks.
  const declaredFamily = semanticContext.declaredFamily;
  _stageStats.calls++;
  const ch = String.fromCodePoint(cp);
  const helperBacked = isGlyphHelperAvailable() && isIcuHelperAvailable();
  const linux = hostPlatform() === "linux";
  const cover = (key: string, fontOverride: FontInstance | null, emitCh = ch, decomposed = false): FontResolution =>
    coveredFontResolution(key, fontOverride, emitCh, decomposed);

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
  const csDecomp = helperBacked ? null : complexShaperBaseMarkDecomposition(cp);
  if (csDecomp != null) {
    const dcps = [...csDecomp].map((c) => c.codePointAt(0)!);
    if (dcps.every((d) => glyphIdForCp(primaryFont, d) !== 0)) {
      const hbFace = shapingFaceFor(primaryFontKey, weight, fontSize, slant, variationSettings);
      if (hbFace != null) {
        const hbInst = makeHarfbuzzShapingInstance(
          primaryFont,
          hbFace.path,
          hbFace.faceIndex,
          logicalFontSize(variationSettings, fontSize),
          hbFace.axes,
        );
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
  //
  // On a helper-backed primary this is one IPC round trip PER CODEPOINT and it
  // dominates the whole resolver: a stack-traced Windows walk over 4000
  // codepoints issued 4353 glyph probes, 4000 of them from right here (92%).
  //
  // The bitset is consulted in ONE DIRECTION ONLY — it can prove the face does
  // NOT cover the codepoint (skip the probe), but a positive still has to be
  // confirmed by the platform. Reading it both ways is not answer-neutral, and
  // the asymmetry is not theoretical: a full-corpus macOS slice moved 364
  // comparisons out of agree-exact, every one of them a chain walk stopping
  // early at Arial Unicode MS because the FILE's cmap claimed a codepoint its
  // CoreText probe reported as uncovered. A helper face is resolved by
  // PostScript NAME on macOS, and CoreText may hand back a different face than
  // the path we recorded ("Client requested name X, it will get Y"), so the
  // file's cmap is not necessarily the table Chrome consulted. Non-coverage
  // survives that gap — the walk has to keep going either way — which is also
  // where nearly all the probes are: Arial's cmap holds 3,506 of 292,466
  // assigned codepoints, so the negative answer is the common one.
  const primaryCovers = fontHasSupportedColorTable(primaryFont, primaryFontKey)
    ? fontCoversCp(primaryFont, cp)
    : glyphIdForCp(primaryFont, cp) !== 0;
  if (nativeFaceCoversCp(primaryFont, cp) !== false && primaryCovers) {
    _stageStats.fastPathPrimary++;
    return cover(primaryFontKey, null);
  }

  // HarfBuzz can normalize a canonical alias to another composed scalar in
  // this same face before font fallback. Greek oxia letters (U+1F71 → U+03AC),
  // GREEK QUESTION MARK (U+037E → ';'), and KELVIN SIGN (U+212A → 'K') all
  // exercise this on noble. A literal fontconfig query picks another family.
  const canonical = ch.normalize("NFC");
  const canonicalCp = canonical.codePointAt(0);
  if (
    linux &&
    canonical !== ch &&
    canonicalCp != null &&
    String.fromCodePoint(canonicalCp) === canonical &&
    glyphIdForCp(primaryFont, canonicalCp) !== 0
  ) {
    _stageStats.fastPathPrimary++;
    return cover(primaryFontKey, null, canonical, true);
  }

  // HarfBuzz's normalizer substitutes U+2010 from the current face for the
  // non-breaking hyphen when that face has no U+2011 glyph. Chromium therefore
  // keeps this character in the declared family rather than asking fontconfig
  // for a face with a literal U+2011 cmap entry.
  if (linux && cp === 0x2011 && glyphIdForCp(primaryFont, 0x2010) !== 0) {
    _stageStats.fastPathPrimary++;
    return cover(primaryFontKey, null, "\u2010", true);
  }

  // Blink treats the Unicode line and paragraph separators as layout breaks.
  // Its font-use report attributes their empty glyph cell to the declared
  // face; letting a literal-cmap probe reach fontconfig instead selects
  // FreeSans and can emit a visible replacement glyph. A space from the same
  // face keeps the cell inkless while captured advances own its positioning.
  if (linux && (cp === 0x2028 || cp === 0x2029)) {
    _stageStats.fastPathPrimary++;
    return cover(primaryFontKey, null, " ", true);
  }

  // HarfBuzz keeps these spaces in the CURRENT font when their literal cmap
  // entry is absent: it substitutes that face's U+0020 glyph and synthesizes
  // the requested advance (`decompose_current_character`,
  // hb-ot-shape-normalize.cc:174-185, rev 4de187d). Our text positions already
  // come from Chromium, so emitting U+0020 preserves the same invisible glyph
  // while avoiding a false family fallback. U+3000 is excluded by the predicate
  // because Blink explicitly requeues its synthesized space.
  const primaryCoversSpace = fontHasSupportedColorTable(primaryFont, primaryFontKey)
    ? fontCoversCp(primaryFont, 0x20)
    : glyphIdForCp(primaryFont, 0x20) !== 0;
  if (isHarfbuzzSameFontSpaceFallback(cp) && primaryCoversSpace) {
    _stageStats.fastPathPrimary++;
    return cover(primaryFontKey, null, " ");
  }

  // DM-1659: SF Pro Text/Display and the system font resolve to SFNS (matching
  // Chrome's PAINTED glyph shapes — see matchFamilyNameToKey). But SFNS lacks a
  // few glyphs the standalone `/Library/Fonts/SF-Pro-*.otf` carries (the two-digit
  // enclosed alphanumerics U+2469–2473 / U+24EB–24F4, Enclosed-CJK circled 21–50).
  // For those, Chrome's CoreText cascades from SFNS to the standalone OTF (which it
  // still reports as "SF Pro Text"). Mirror that per-codepoint: an sf-pro run whose
  // codepoint SFNS doesn't cover falls to the standalone OTF BEFORE the declared
  // chain — else it hits a LATER author family (Arial Unicode MS's full-em circled
  // numbers, a visibly larger glyph than Chrome's condensed SF Pro one, DM-1127).
  //
  // Only an explicitly-named SF Pro family reaches the OTF this way: Blink sends
  // that name to `MatchFontFamily`, which finds the installed OTF itself. A
  // `system-ui` / `BlinkMacSystemFont` primary goes to `MatchSystemUIFont`
  // instead (`mac/font_cache_mac.mm:409-417`, Chromium rev 7d859f27), and its
  // per-codepoint fallback is `CTFontCreateForString` over the UI font's own
  // cascade list, which does not contain the standalone OTF — Chrome paints
  // `system-ui` U+2469 from `.HiraKakuInterface-W4` on a Mac that has the OTF
  // installed. That route belongs to the live resolver's `systemUi` base below.
  if (!systemUiPrimary && (primaryFontKey === "sf-pro" || primaryFontKey === "sf-pro-italic")) {
    const otfKey = sfProCoverageOtfKey();
    if (otfKey != null) {
      const otf = getFontInstance(otfKey, weight, fontSize, slant);
      if (otf != null && glyphIdForCp(otf, cp) !== 0) return cover(otfKey, otf);
    }
  }

  // Canonical NFD singleton (e.g. U+2F800→U+4E3D). null when `cp` has no
  // single-codepoint canonical decomposition — multi-char decompositions are not
  // a font-substitution case here.
  const nfd = helperBacked ? ch : ch.normalize("NFD");
  const dcp0 = nfd.codePointAt(0);
  const singleton = dcp0 != null && dcp0 !== cp && String.fromCodePoint(dcp0) === nfd ? dcp0 : null;

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
  const canonicalCandidates = singleton == null ? harfbuzzCanonicalDecompositionCandidates(cp) : [];
  // Keep the established base+mark gate for ordinary cases, but add mark-only
  // decompositions such as U+0344 that HarfBuzz normalizes by the same rule.
  const decompositionCandidates = baseMarkNfd != null || canonicalCandidates.length > 0 ? canonicalCandidates : [];

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

  // 0b. The primary's DECOMPOSITION checks, when the chain cannot give them.
  //
  // Step 0 above tests the primary for LITERAL coverage only; the singleton and
  // base+mark paths live in the chain walk below. So a font received those two
  // checks only if it also appeared in `fontKeyChain` — and the primary is
  // absent from the chain exactly when the chain is EMPTY. That equivalence is
  // structural, not incidental: `resolveFontKey` returns the first name that
  // matches and `resolveFontKeyChain` collects every name that matches, so if
  // any name matched at all the key is in the chain. The primary is only
  // outside it when nothing matched and `resolveFontKey`'s standard-font
  // terminal supplied the answer (`:7536-7539`), which `resolveFontKeyChain`
  // deliberately excludes ("callers append their own terminal").
  //
  // Measured on the darwin conformance corpus: 9 of 450 stacks reach here —
  // bare `math` / `emoji` / `fangsong` / `ui-monospace` / `ui-rounded` /
  // `ui-sans-serif`, and named families that are not installed. Every one has
  // an empty chain, so there is nothing to order against and this cannot
  // reorder a declared family.
  //
  // Blink has no analogue of "decomposition applies only to chain members": it
  // consults each family through the same machinery however the family entered
  // the list, and HarfBuzz's normalizer decides per FONT, with no notion of how
  // that font was reached. `decompose_current_character`
  // (`hb-ot-shape-normalize.cc:150-201`, rev 4de187d) takes the composed glyph
  // when `c->font->get_nominal_glyph (u, &glyph, …)` finds one and otherwise
  // calls `decompose`, whose every branch is gated on that same per-font lookup
  // of the PIECES (`:108-147` — `font->get_nominal_glyph (b, &b_glyph)` for the
  // mark, `has_a` for the base). That is the literal-then-decompose order we
  // give the chain, applied to whatever font is current.
  //
  // The asymmetry was ours, and it surfaced as +5 conformance mismatches the
  // moment a correct `ui-serif` classification moved that stack onto the
  // terminal.
  if (fontKeyChain.length === 0) {
    if (singleton != null && glyphIdForCp(primaryFont, singleton) !== 0) {
      return cover(primaryFontKey, null, String.fromCodePoint(singleton), true);
    }
    if (decompositionCandidates.some((candidate) => candidate.every((d) => glyphIdForCp(primaryFont, d) !== 0))) {
      const hbFace = shapingFaceFor(primaryFontKey, weight, fontSize, slant, variationSettings);
      if (hbFace != null) {
        const hbInst = makeHarfbuzzShapingInstance(
          primaryFont,
          hbFace.path,
          hbFace.faceIndex,
          logicalFontSize(variationSettings, fontSize),
          hbFace.axes,
        );
        if (hbInst !== primaryFont) return cover(primaryFontKey, hbInst, ch, true);
      }
    }
  }

  // 1. kFontFamily — walk the declared families (literal, then in-font decomp).
  for (const key of fontKeyChain) {
    const inst = instanceFor(key);
    if (inst == null) continue;
    // Same prove-non-coverage-only use of the bitset as the primary fast-path
    // above — see the reasoning there for why a positive is never taken from
    // the file. Both sites need it, not just one: the primary probe used to
    // warm the helper instance's per-codepoint cache, so skipping it up there
    // merely MOVED the round trip down here (measured — 4000 probes left the
    // fast path and 3912 reappeared on this line).
    if (nativeFaceCoversCp(inst, cp) !== false && glyphIdForCp(inst, cp) !== 0) {
      return cover(key, key === primaryFontKey ? null : inst);
    }
    if (linux && cp === 0x2011 && glyphIdForCp(inst, 0x2010) !== 0) {
      return cover(key, key === primaryFontKey ? null : inst, "\u2010", true);
    }
    if (singleton != null && glyphIdForCp(inst, singleton) !== 0) {
      return cover(key, key === primaryFontKey ? null : inst, String.fromCodePoint(singleton), true);
    }
    // Base+mark NFD within this same font (Linux — see baseMarkNfd above). The
    // run keeps the SOURCE char (HarfBuzz decomposes internally, like Chrome),
    // so clusters / xOffsets stay aligned; `decomposed: true` routes the
    // glyph-path emitter to its run-shaping branch. Falls through when the key
    // has no on-disk file HarfBuzz can open.
    if (decompositionCandidates.some((candidate) => candidate.every((d) => glyphIdForCp(inst, d) !== 0))) {
      const hbFace = shapingFaceFor(key, weight, fontSize, slant, variationSettings);
      if (hbFace != null) {
        const hbInst = makeHarfbuzzShapingInstance(
          inst,
          hbFace.path,
          hbFace.faceIndex,
          logicalFontSize(variationSettings, fontSize),
          hbFace.axes,
        );
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
  // So the OS goes first, and the static chain is a DEGRADED-MODE net on
  // macOS and Linux — not a competitor and not a second-chance stage. Blink
  // runs no such stage at all, so when the live resolver is in the loop the
  // chain must not answer. Measured before the gate: over the darwin
  // conformance corpus the chain was ASKED 492,624 times (~64% of the
  // resolver's coverage probes) and ANSWERED 6 of 916,119 system-stage
  // decisions — every answer a variation selector U+FE0x routed to
  // `u-noto-sans`, a divergence from Chrome, not coverage (on Linux: 0
  // answers in 779,964). The chain still earns its keep exactly where the
  // live resolver cannot run — a host without the helper binary
  // (`DOMOTION_DISABLE_HELPER`, or an npm install with no prebuilt helper) or
  // a resolver flagged off (`DOMOTION_SYSTEM_FALLBACK=0`) — and outright
  // deletion would drop every fallback answer on such a host, so the gate is
  // the availability predicate itself rather than a removal.
  //
  // win32 is EXCLUDED from the gate on purpose: there the hardcoded table IS
  // Blink's mechanism — `PlatformFallbackFontForCharacter` consults
  // `GetFallbackFamilyNameFromHardcodedChoices` BEFORE DirectWrite and only
  // falls through on a miss (`win/font_cache_skia_win.cc:286-296`, rev
  // 7d859f27) — so the win32 chain runs unconditionally, and first
  // (`liveFallbackFirst` is false on win32). Its generated per-block tail is
  // separately deferred behind the live resolver by `win32DeferOrStatic`.
  // `DOMOTION_LIVE_FALLBACK_FIRST=0` restores the old chain-first order for an
  // A/B; see the flag's declaration for the measurement that set the default.
  const liveFallback = (): FontResolution | null => {
    if (!systemFallbackResolutionEnabled) return null;
    _stageStats.liveAsked++;
    const nominatedKey = resolveSystemFallbackKeyForRequest(request);
    if (nominatedKey == null) return null;
    const sysKey = exactDarwinFallbackKey(nominatedKey);
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
    if (systemFallbackCoverage.get(`${nominatedKey}|${cp}`) ?? fontCoversCp(sf, cp)) {
      _stageStats.liveAnswered++;
      return cover(sysKey, null);
    }
    if (singleton != null && fontCoversCp(sf, singleton)) {
      _stageStats.liveAnswered++;
      return cover(sysKey, null, String.fromCodePoint(singleton), true);
    }
    return null;
  };
  const recordStaticAnswer = (candidateKey: string): void => {
    _stageStats.staticAnswered++;
    _stageStats.staticKeyTally.set(candidateKey, (_stageStats.staticKeyTally.get(candidateKey) ?? 0) + 1);
    _stageStats.staticPrimaryTally.set(primaryFontKey, (_stageStats.staticPrimaryTally.get(primaryFontKey) ?? 0) + 1);
    if (_stageStats.staticCpSample.length < STATIC_CP_SAMPLE_CAP) _stageStats.staticCpSample.push(cp);
  };
  // Degraded-mode gate (see the block comment above): on darwin/linux the
  // static chain answers ONLY when the live resolver is out of the loop — no
  // helper binary, or the resolver flagged off. On win32 the chain is Blink's
  // own hardcoded stage and is never gated.
  const staticChainArmed = hostPlatform() === "win32" || !isGlyphHelperAvailable() || !systemFallbackResolutionEnabled;
  const staticChain = (): FontResolution | null => {
    if (!staticChainArmed) return null;
    // Counted only when armed: an unarmed call does no probing, and the
    // retirement measurement this feeds is about probe cost.
    _stageStats.staticAsked++;
    // DM-1985: the run's `font-variant-emoji` reaches the chain, because on
    // Windows it decides which arm of `GetFallbackFamily` the codepoint takes.
    for (const candidate of fallbackFontChain(cp, primaryFontKey, lang, {
      weight,
      slant,
      fontSize,
      fontVariantEmoji,
      ...semanticContext,
    })) {
      if (candidate === "last-resort") continue;
      const cf = getFontInstance(candidate, weight, fontSize, slant);
      // The coverage test, answered from a local cmap bitset when the face can
      // be identified in its file and from the helper otherwise. This walk is
      // where ~64% of the resolver's coverage probes come from — 4.43 per
      // codepoint on Windows — and each one is a round trip whose answer the
      // font file already holds. `nativeFaceCoversCp` returns null rather than
      // guessing when it cannot name the face, so the helper stays the
      // authority for exactly the cases it is needed for.
      // Blink's Windows guard is `CreateSkFont().unicharToGlyph(character)`
      // (`font_platform_data.cc:219-221`), so a cmap entry that resolves to
      // glyph zero is NOT coverage. The bitset is only a fast negative here;
      // the glyph-id check is the source-equivalent positive predicate.
      if (cf != null && nativeFaceCoversCp(cf, cp) !== false && glyphIdForCp(cf, cp) !== 0) {
        const cut = fallbackFamilyCutKey(candidate, cp, weight, slant, fontSize);
        if (cut != null) {
          const cutFont = getFontInstance(cut, weight, fontSize, slant);
          if (cutFont != null && nativeFaceCoversCp(cutFont, cp) !== false && glyphIdForCp(cutFont, cp) !== 0) {
            recordStaticAnswer(cut);
            return cover(cut, null);
          }
        }
        recordStaticAnswer(candidate);
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
    _stageStats.noSystemFallback++;
    // A null platform-fallback answer advances the iterator to its explicit
    // last-resort face BEFORE `kFirstCandidateForNotdefGlyph`
    // (`font_fallback_iterator.cc:143-162`, rev 7d859f27). On macOS that face
    // is Times, then Lucida Grande only if Times cannot be opened
    // (`mac/font_cache_mac.mm:376-393`). This is observable for U+F8FF: a
    // Japanese serif primary lacks it, but Times carries the Apple-logo glyph,
    // so Chrome paints Times rather than the primary's `.notdef`. When Times
    // lacks the codepoint too, fall through to the first candidate exactly as
    // before.
    if (hostPlatform() === "darwin") {
      for (const lastResortKey of ["times", "lucida-grande"]) {
        const lastResort = getFontInstance(lastResortKey, weight, fontSize, slant);
        if (lastResort != null && glyphIdForCp(lastResort, cp) !== 0) {
          return cover(lastResortKey, lastResort);
        }
        if (lastResortKey === "times" && lastResort != null) break;
      }
    }
    return { key: primaryFontKey, fontOverride: null, emitCh: ch, decomposed: false, covered: false };
  }

  _stageStats.systemStageReached++;
  // Windows stage 1 of `PlatformFallbackFontForCharacter` — "First try the
  // specified font with standard style & weight"
  // (`win/font_cache_skia_win.cc:270-277`, rev 7d859f27):
  //
  //     if (!IsEmojiPresentationEmoji(fallback_priority) &&
  //         (font_description.Style() == kItalicSlopeValue ||
  //          font_description.Weight() >= kBoldWeightValue)) {
  //       const SimpleFontData* font_data =
  //           FallbackOnStandardFontStyle(font_description, character);
  //       if (font_data)
  //         return font_data;
  //     }
  //
  // It runs BEFORE the hardcoded table — which is `staticChain` here, and
  // win32 is the platform where the chain runs first — so this is its own
  // stage rather than a branch inside the live resolver's win32 arm: placed
  // there it would run after the table and invert Blink's order for exactly
  // the case that makes it measurable (a family whose bold/italic cut lacks a
  // glyph its regular cut has, on a codepoint the table routes).
  //
  // The threshold is `kBoldWeightValue = 700` (`font_selection_types.h:193`)
  // — NOT the `kBoldThreshold = 600` (`:182`) the Linux copy of this stage
  // uses (`linux/font_cache_linux.cc:80-87` spells `kBoldThreshold`); the two
  // constants sit eleven lines apart and grabbing the Linux one is the easy
  // mistake.
  //
  // `FallbackOnStandardFontStyle` itself (`skia/font_cache_skia.cc:119-137`)
  // retries the LITERAL first declared family name at normal style and weight
  // and accepts only a face that contains the character. The head-token check
  // mirrors the Linux transcription in `resolveSystemFallbackKeyForCp`: when
  // the stack's first declared name is not what produced `primaryFontKey`,
  // Blink is asking about a family we never resolved, so fail through exactly
  // as it does. Blink returns the standard-style face with synthetic
  // bold/italic set from the ORIGINAL description
  // (`SetSyntheticBold(weight >= kBoldThreshold …)`); the standard-style
  // instance travels as `fontOverride`, and the renderer derives synthesis
  // from the requested weight/slant against that face, keeping the predicate
  // in one place.
  if (
    hostPlatform() === "win32" &&
    ((fontVariantEmoji === "text" && isEmojiCharCp(cp)) || !isEmojiPresentationCp(cp)) &&
    (slant !== 0 || weight >= 700)
  ) {
    const declaredHead = declaredFamily != null ? splitFontFamilyNames(declaredFamily)[0] : undefined;
    if (
      declaredHead == null ||
      matchFamilyNameToKey(declaredHead.name, declaredHead.generic, lang) === primaryFontKey
    ) {
      // Style and weight reset to normal; the run's STRETCH is preserved —
      // `substitute_description` is a copy and only `SetStyle` / `SetWeight`
      // run on it (`skia/font_cache_skia.cc:122-124`).
      const standard = getFontInstance(primaryFontKey, 400, fontSize, 0, undefined, stretch);
      if (standard != null && glyphIdForCp(standard, cp) !== 0) {
        return cover(primaryFontKey, standard);
      }
    }
  }

  if (liveFallbackFirst) {
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

  // 3. Helper-absent compatibility only. Chromium never rewrites a Math
  // Alphanumeric scalar after system fallback; it shapes the source scalar
  // and reaches kOutOfLuck if no face covers it. Keep the historical FreeFont
  // synthesis solely as the documented best-effort path when the native
  // helper cannot provide Chromium's platform fallback/shaping stack.
  if (!helperBacked) {
    const decomp = decomposeMathAlphaRun(
      cp,
      fallbackFontChain(cp, primaryFontKey, lang, {
        weight,
        slant,
        fontSize,
        ...semanticContext,
      }),
      weight,
      fontSize,
    );
    if (decomp != null) return cover(decomp.key, decomp.font, decomp.ch, true);
  }

  // 4. kOutOfLuck — nothing covers it; caller applies its own uncovered terminal.
  _stageStats.uncovered++;
  return { key: primaryFontKey, fontOverride: null, emitCh: ch, decomposed: false, covered: false };
}

/** Per-codepoint fallback coordinator; ordered Blink stages live above. */
function resolveFontForCodepointInner(request: FontRequest): FontResolution {
  return walkFontFallbackStages(request);
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
  const description = { weight, size: fontSize, slant, stretch: 100 };
  const primaryFontKey = resolveFontKey(fontFamily, lang, description);
  const primaryFont = resolveFont(fontFamily, weight, fontSize, slant, undefined, 100, lang);
  if (primaryFont == null) return null;
  const r = resolveFontForCodepoint(
    cp,
    primaryFont,
    primaryFontKey,
    weight,
    fontSize,
    slant,
    undefined,
    lang,
    resolveFontKeyChain(fontFamily, lang, description),
    false,
    100,
    undefined,
    fontFamily,
  );
  return { key: r.key, decomposed: r.decomposed, covered: r.covered };
}

export interface FontRun {
  fontKey: string;
  font: FontInstance;
  text: string;
  startIdx: number;
  endIdx: number;
  isPrimary: boolean;
  /** Direction of the Blink shaping item that produced this run. The shaped
   *  fallback path records it before same-face assembly so a bidi boundary is
   *  not lost when adjacent items select the same font. Legacy callers omit it
   *  and retain the source-text lookup used before the shaped splitter. */
  shapingDirection?: "ltr" | "rtl";
  /** ISO 15924 script tag resolved by Blink-style itemization before fallback
   *  (for example `Deva`). This must travel with the selected face: leaving an
   *  Inherited mark for HarfBuzz to guess as Common changes the selected
   *  syllabic shaper and can suppress its broken-cluster dotted circle. */
  shapingScript?: string;
  /** Selection owner recorded by the renderer-facing provenance oracle. */
  routeMechanism?:
    | "declared-family"
    | "priority-emoji"
    | "system-resolver"
    | "last-resort"
    | "first-candidate-notdef"
    | "cluster-disabled-legacy";
  /** The run's `text` is not the source slice `[startIdx, endIdx)`. This is a
   * legacy-flag-only compatibility surface: default shaped fallback leaves the
   * source intact and lets HarfBuzz own canonical decomposition and inserted
   * dotted circles. */
  decomposed?: boolean;
}
