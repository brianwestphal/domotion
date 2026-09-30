/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { hostPlatform } from "./host-platform.js";
import { isGlyphHelperAvailable, resolveInstalledFont } from "./glyph-helper.js";
import { hbShapingBaseOf, makeHarfbuzzShapingInstance, registerHbBufferSource } from "./harfbuzz-shaper.js";
import { usesDedicatedShaper, usesHarfbuzzShaping } from "./unicode-classification.js";
import { isIcuHelperAvailable } from "./icu-helper.js";
import type { FontInstance } from "./font-instance.js";
import type { FontFallbackSemanticContext } from "./fallback-chain.js";
import { createFontFallbackSemanticContext } from "./fallback-chain.js";
import { resolveFontForCodepoint } from "./codepoint-resolver.js";
import { getFontInstance } from "./font-instance.js";
import { glyphIdForCp } from "./font-instance.js";
import { getFontSourceInfo } from "./font-instance.js";
import { shapingFaceFor } from "./font-instance.js";
import { logicalFontSize } from "./font-instance.js";
import type { FontVariantEmojiOverride } from "./emoji-presentation.js";
import { registerDynamicSystemFont } from "./font-paths.win32.js";
import { fontSourceMap } from "./font-instance.js";

// ── Text Rendering ──

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
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
  fontKeyChain: string[],
  rawSlope?: number,
  orientation?: number,
  declaredFamily?: string,
  semanticContext: FontFallbackSemanticContext = createFontFallbackSemanticContext(declaredFamily),
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
  const r = resolveFontForCodepoint(
    markCp,
    primaryFont,
    primaryFontKey,
    weight,
    fontSize,
    slant,
    variationSettings,
    lang,
    fontKeyChain,
    false,
    100,
    undefined,
    declaredFamily,
    rawSlope,
    orientation,
    semanticContext,
  );
  if (!r.covered) return null;
  const markKey = r.key;
  const markFont =
    r.fontOverride ?? (markKey === primaryFontKey ? primaryFont : getFontInstance(markKey, weight, fontSize, slant));
  if (markFont == null) return null;
  if (glyphIdForCp(markFont, 0x25cc) === 0) return null; // ◌ must come from the mark's font, like Chrome
  // The concrete instance is authoritative here, just as it is in the shaped
  // fallback loop's `hbFaceFor`.  A declared family can be discovered at
  // runtime by the platform helper without having a static FONT_PATHS entry
  // (the Unicode fixtures' installed Mukta is the representative case on CI).
  // Looking up only by `markKey` therefore found the glyph-bearing native
  // instance above, then failed to reopen that very face for HarfBuzz and
  // silently returned null.  Blink does not redo a family-name lookup between
  // fallback selection and shaping: the selected `SimpleFontData` supplies the
  // `HarfBuzzFace`.  Preserve that identity by preferring the instance source,
  // including its TTC face and resolved variable axes, and use the key lookup
  // only as the degraded fallback.
  const src = getFontSourceInfo(markFont);
  // This is the already-selected glyph-bearing instance, not a fresh request
  // by family name. A fontkit-opened collection can legitimately report
  // nameMatched=false after falling back to member zero while still recording
  // the exact member that supplied these outlines. Requiring the requested
  // alias to match discarded that authoritative face on CI's Arial Unicode
  // Vedic route and made the dotted-circle handoff silently return null.
  const hbFace =
    src != null && src.faceIndex != null
      ? { path: src.path, faceIndex: src.faceIndex, axes: src.variationAxes ?? null }
      : shapingFaceFor(markKey, weight, fontSize, slant, variationSettings);
  if (hbFace == null) return null;
  const hbInst = makeHarfbuzzShapingInstance(
    markFont,
    hbFace.path,
    hbFace.faceIndex,
    logicalFontSize(variationSettings, fontSize),
    hbFace.axes,
  );
  if (hbInst === markFont) return null; // HarfBuzz couldn't open the file
  // The pin owns one concrete resolver-selected face. Preserve that face's
  // source/member/axes on the shaping proxy so the embedded emitter subsets
  // the same instance that supplied HarfBuzz's dotted-circle glyph.
  carryFontInstanceMetadata(hbInst, markFont);
  return { key: markKey, font: hbInst };
}

export interface AlternateHalfWidthInfo {
  halved: boolean;
  xOffset: number;
  yOffset: number;
  feature: "halt" | "vhal";
}

const HALT_INFO_CACHE = new Map<string, AlternateHalfWidthInfo>();

export function haltInfoFor(
  font: FontInstance,
  fontKey: string,
  cp: number,
  orientation: "horizontal" | "vertical" = "horizontal",
): AlternateHalfWidthInfo {
  const feature = orientation === "vertical" ? "vhal" : "halt";
  const key = `${fontKey}|${cp}|${feature}`;
  const hit = HALT_INFO_CACHE.get(key);
  if (hit !== undefined) return hit;
  let info: AlternateHalfWidthInfo = { halved: false, xOffset: 0, yOffset: 0, feature };
  try {
    const ch = String.fromCodePoint(cp);
    const def = font.layout(ch);
    const halt = font.layout(ch, [feature]);
    if (def.positions.length === 1 && halt.positions.length === 1 && def.glyphs[0]?.id === halt.glyphs[0]?.id) {
      const dAdv = Math.abs(orientation === "vertical" ? def.positions[0].yAdvance : def.positions[0].xAdvance);
      const hAdv = Math.abs(orientation === "vertical" ? halt.positions[0].yAdvance : halt.positions[0].xAdvance);
      // The selected feature must genuinely narrow this glyph
      // while keeping the SAME outline (pure GPOS) — otherwise it isn't the
      // fullwidth-punctuation trim case and we leave the glyph alone.
      // Deliberate detection, not a port: Blink applies `halt` / `vhal` to the ranges its `HanKerning`
      // pass selects (`platform/fonts/shaping/han_kerning.cc:330-337`, rev 7d859f27) and takes the
      // resulting advance, so it never asks whether the form is "narrow enough". This asks it here
      // because the caller reaches this only for glyphs the capture says were trimmed, and a `halt` that
      // barely moves the advance is a different adjustment (e.g. a proportional tweak). 0.6 is not a
      // Blink constant.
      if (hAdv > 0 && dAdv > 0 && hAdv <= dAdv * 0.6) {
        info = {
          halved: true,
          xOffset: halt.positions[0].xOffset,
          yOffset: halt.positions[0].yOffset,
          feature,
        };
      }
    }
  } catch {
    /* leave default (not halt-able) */
  }
  HALT_INFO_CACHE.set(key, info);
  return info;
}

// Ink x-extent (font units) of a glyph from its outline commands. Used as the
// fallback opening-vs-closing classifier when a font instance can't report its
// `halt` adjustment.
export function glyphInkXRange(glyph: {
  path?: { commands: Array<{ command: string; args: number[] }> };
}): { min: number; max: number } | null {
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
  cp: number,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  lang: string | undefined,
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
  rawSlope?: number,
  orientation?: number,
  declaredFamily?: string,
  semanticContext: FontFallbackSemanticContext = createFontFallbackSemanticContext(declaredFamily),
): boolean {
  return !resolveFontForCodepoint(
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
  ).covered;
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
export interface FontResolution {
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

export function sfProCoverageOtfKey(): string | null {
  if (_sfProCoverageKey !== undefined) return _sfProCoverageKey;
  _sfProCoverageKey = null;
  try {
    const cut = resolveInstalledFont("SF Pro Text");
    if (cut != null) {
      const key = `sysfb:${cut.postscriptName}`;
      registerDynamicSystemFont(key, cut.path, cut.postscriptName, "fontkit");
      _sfProCoverageKey = key;
    }
  } catch {
    /* helper unavailable — keep null */
  }
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
const LINUX_UNIFONT_DEFAULT_SHAPER_RANGES: ReadonlyArray<readonly [number, number]> = [
  // Telugu. Noble's Arial / Times New Roman / Monospace stacks all resolve
  // U+0C15 to Unifont, whose GSUB has DFLT and no tel3/tel2/telu. HarfBuzz's
  // Telugu request order therefore lands on DFLT and selects DEFAULT. The
  // FreeSans / FreeSerif controls expose tel2 and select INDIC instead.
  [0x0c00, 0x0c7f],
  // Myanmar. Noble's production stacks resolve U+1000 to Unifont DFLT, which
  // hb_ot_shaper_categorize sends to DEFAULT; a Noto Myanmar face selecting
  // modern `mym2` stays on HarfBuzz's Myanmar shaper.
  [0x1000, 0x109f],
  [0x0f00, 0x0fff],
  [0x07c0, 0x07ff],
  [0x0840, 0x085f],
  [0xa840, 0xa87f],
  [0x1b00, 0x1b7f],
  [0xa980, 0xa9df],
  [0x11080, 0x110cf],
  [0x11000, 0x1107f],
  [0x1e900, 0x1e95f],
  [0x10a00, 0x10a5f],
];

/**
 * Face-aware addition to the script-wide HarfBuzz routing. Noble Linux's
 * Unifont / Unifont Upper GSUB selects DFLT for these scripts, so HarfBuzz
 * rev 4de187d `hb_ot_shaper_categorize` dispatches its DEFAULT shaper rather
 * than USE. Routing the measured resolved face through real HarfBuzz expresses
 * that decision; a pure codepoint table cannot. Other faces (for example
 * FreeSerif selecting `sinh`) retain their script-specific plan.
 */
export function resolvedFaceNeedsHarfbuzzShaping(
  cp: number,
  fontKey: string,
  platform: NodeJS.Platform = hostPlatform(),
): boolean {
  // Chromium shapes every supported run with HarfBuzz. Once both native
  // companions are present, route every assigned/unassigned scalar through
  // the same engine rather than selecting scripts from Domotion-owned ranges.
  // The proxy keeps outlines on the resolved platform face, so this changes
  // shaping decisions without changing the platform raster-outline source.
  if (isGlyphHelperAvailable() && isIcuHelperAvailable()) return true;
  if (resolvedFaceUsesDefaultOpenTypeShaper(cp, fontKey, platform)) return true;
  return usesHarfbuzzShaping(cp);
}

/** Whether the measured resolved face selects DFLT/latn and is consequently
 * categorized as DEFAULT by HarfBuzz rather than by its script's nominal
 * dedicated shaper. Kept separate from the broader reroute predicate so tests
 * can distinguish Telugu Unifont (DFLT → DEFAULT) from FreeSans (tel2 → INDIC),
 * even though both already route through HarfBuzz for Telugu cluster fidelity. */
export function resolvedFaceUsesDefaultOpenTypeShaper(
  cp: number,
  fontKey: string,
  platform: NodeJS.Platform = hostPlatform(),
): boolean {
  if (platform !== "linux" || (fontKey !== "u-unifont" && fontKey !== "u-unifont-upper")) return false;
  return LINUX_UNIFONT_DEFAULT_SHAPER_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function harfbuzzShapedScriptOverride(
  cp: number,
  res: FontResolution,
  primaryFont: FontInstance,
  primaryFontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
): FontResolution {
  if (!res.covered || !resolvedFaceNeedsHarfbuzzShaping(cp, res.key)) return res;
  const fvs = res.key === primaryFontKey ? variationSettings : undefined;
  const base =
    res.fontOverride ??
    (res.key === primaryFontKey ? primaryFont : getFontInstance(res.key, weight, fontSize, slant, fvs));
  if (base == null) return res;
  // Already HarfBuzz-shaped (a decomposition/webfont override that is itself a
  // proxy): wrapping again would stack proxies, and the inner one has no
  // `getGlyph`, so the outlines would silently move to HarfBuzz's own
  // `glyphToPath`.
  if (base.shapesWithHarfbuzz === true) return res;
  const hbFace = shapingFaceFor(res.key, weight, fontSize, slant, fvs);
  if (hbFace == null) return res;
  const hbInst = makeHarfbuzzShapingInstance(
    base,
    hbFace.path,
    hbFace.faceIndex,
    logicalFontSize(variationSettings, fontSize),
    hbFace.axes,
    { outlinesFromBase: true },
  );
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
 * `@font-face` registry) to decide synthetic bold, `faceIsItalicTrait` /
 * `resolvedItalicAngle` / `isRoutedItalicCut` for synthetic oblique, and
 * looks the instance up in
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
  proxy.faceIsItalicTrait = base.faceIsItalicTrait;
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
 * Production run shaper, applied after the shaped-cluster splitter selects a
 * concrete face and fallback boundary.
 *
 * Same construction as the per-codepoint form: HarfBuzz supplies ids,
 * positions and clusters; the base instance keeps the outlines
 * (`outlinesFromBase`) and its metadata (`carryFontInstanceMetadata`). The
 * face is resolved the way `fontFeatureValueShapingOverride` resolves it —
 * the instance's own source file first, so shaper and outlines agree by
 * construction; the key's base spec next; the retained `@font-face` bytes
 * last, so webfont runs route too. Every supported run uses this path;
 * native/fontkit instances remain outline and metric providers. It declines
 * only when no concrete face is openable.
 */
export function harfbuzzShapedRunOverride(
  base: FontInstance,
  fontKey: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings: Record<string, number> | undefined,
  runText: string,
  features?: string[],
): FontInstance {
  if (base.shapesWithHarfbuzz === true) {
    if (features == null || features.length === 0) return base;
    base = hbShapingBaseOf(base);
  }
  void runText;
  const src = getFontSourceInfo(base);
  const hbFace =
    src != null && src.nameMatched && src.faceIndex != null
      ? { path: src.path, faceIndex: src.faceIndex, axes: src.variationAxes ?? null }
      : (shapingFaceFor(fontKey, weight, fontSize, slant, variationSettings) ?? webfontShapingFace(base));
  if (hbFace == null || hbFace.faceIndex == null) return base;
  const hbInst = makeHarfbuzzShapingInstance(
    base,
    hbFace.path,
    hbFace.faceIndex,
    logicalFontSize(variationSettings, fontSize),
    hbFace.axes,
    { outlinesFromBase: true, features },
  );
  if (hbInst === base) return base; // HarfBuzz declined the file
  carryFontInstanceMetadata(hbInst, base);
  return hbInst;
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
export function webfontShapingFace(
  base: FontInstance,
): { path: string; faceIndex: number; axes: Record<string, number> | null } | null {
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
  // A run the script reroute (or the system stage) already wrapped hands in
  // the hb PROXY. Build the feature-bound proxy over the TRUE base instead of
  // stacking — the proxy exposes no `getGlyph`, so a stacked wrap would
  // silently move the outlines to HarfBuzz's own `glyphToPath`. Everything
  // the script wrap provided is subsumed: the feature proxy shapes the whole
  // run through HarfBuzz too.
  base = hbShapingBaseOf(base);
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
  const hbFace =
    src != null && src.nameMatched && src.faceIndex != null
      ? { path: src.path, faceIndex: src.faceIndex, axes: src.variationAxes ?? null }
      : (shapingFaceFor(fontKey, weight, fontSize, slant, variationSettings) ??
        // DM-1964: a webfont has no on-disk file, so both derivations above come
        // back empty and the reroute used to decline — leaving the run on fontkit's
        // enable-only shaping, i.e. dropping the very disable this function exists
        // to express. The bytes are the same thing a path would have been read into.
        webfontShapingFace(base));
  if (hbFace == null) return base;
  const hbInst = makeHarfbuzzShapingInstance(
    base,
    hbFace.path,
    hbFace.faceIndex,
    logicalFontSize(variationSettings, fontSize),
    hbFace.axes,
    { outlinesFromBase: true, features },
  );
  if (hbInst === base) return base; // HarfBuzz declined the file
  carryFontInstanceMetadata(hbInst, base);
  return hbInst;
}
