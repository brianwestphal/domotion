/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { hostPlatform } from "./host-platform.js";
import { invokeSynchronousCallback, type SynchronousCallback } from "./synchronous-scope.js";
import {
  resolveSystemFallbackFonts,
  resolveInstalledFont,
  resolveFcFallbackFonts,
  resolveSystemUiFamily,
  type SystemUiCloneRequest,
} from "./glyph-helper.js";
import { blinkWinFallbackLocale } from "./win-font-fallback.js";
import { _systemFallbackResolutionEnabled, setSystemFallbackResolutionEnabled } from "./font-spec.js";
import { resolveEffectiveCutKey } from "./font-instance.js";
import { resolveFontSpec } from "./font-spec.js";
import { getFontInstance } from "./font-instance.js";
import {
  DARWIN_INITIAL_FONT_DESCRIPTION,
  hasWarmDarwinSystemUiAlias,
  type DarwinFontDescription,
} from "./darwin-font-data-lifetime.js";
import { getFontSourceInfo } from "./font-instance.js";
import { splitFontFamilyNames } from "./font-instance.js";
import { declaredFamilyForKey, matchFamilyNameToKey } from "./family-match.js";
import type { FontVariantEmojiOverride } from "./emoji-presentation.js";
import { isEmojiCharCp } from "./emoji-presentation.js";
import { declaredFamilyHeadIdentity } from "./fallback-chain.js";
import { glyphIdForCp } from "./font-instance.js";
import { systemFallbackKeyCache } from "./font-spec.js";
import { isEmojiPresentationCp } from "./emoji-presentation.js";
import { registerDynamicSystemFont } from "./font-paths.win32.js";
import { registerDarwinHandleAxes } from "./font-instance.js";
import { darwinHandleAxesCompatible, darwinHandleStateSignature } from "./font-instance.js";
import { fileFamilyNameForKey } from "./family-match.js";
import { win32FallbackChainWithPriority } from "./fallback-chain.win32.js";
import { fontCoversCp } from "./font-instance.js";
import { fcLangProperty } from "./emoji-presentation.js";
import { fcMatch } from "./font-paths.win32.js";
import { openFontkitFace } from "./font-instance.js";
import { logicalFontSize, opticalSizingDisabled } from "./font-instance.js";
import type { FontInstance } from "./font-instance.js";

/** The author settings alone can trigger Blink's UI-primary clone. Keep their
 * axis request separate from helper-only size/optical metadata. */
function uiCloneForAuthorVariation(
  settings: Record<string, number> | undefined,
  fontSize: number,
): SystemUiCloneRequest | undefined {
  if (settings == null) return undefined;
  const axes = Object.fromEntries(
    Object.entries(settings)
      .filter(([tag, value]) => /^[\x20-\x7e]{4}$/.test(tag) && typeof value === "number" && Number.isFinite(value))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  if (Object.keys(axes).length === 0) return undefined;
  return {
    axes,
    ...(opticalSizingDisabled(settings) ? {} : { opticalSize: logicalFontSize(settings, fontSize) }),
  };
}

/**
 * Test/perf hook to toggle the CoreText per-codepoint fallback resolver. This is
 * a PROCESS-GLOBAL: a caller that flips it without restoring silently changes
 * the fallback behavior of every later render in the same process. For a
 * temporary toggle around one render, prefer `withSystemFallbackResolution()`
 * (guaranteed save/restore) over a bare `set` (DM-1350).
 */
export function setSystemFallbackResolution(on: boolean): void {
  setSystemFallbackResolutionEnabled(on);
}

/** Read the current process-global toggle (so callers can save/restore it). */
export function getSystemFallbackResolution(): boolean {
  return _systemFallbackResolutionEnabled;
}

/** A CoreText substitute is an already-selected face, whereas a declared
 * family key is a request to run the CSS style matcher. Both historically used
 * `sysfb:<PostScript name>`, so a prior declared primary could make a later
 * fallback to that same face silently reopen a different cut. Give only that
 * collision an exact-face key; other platform keys and fallback answers keep
 * their existing identity. */
export function exactDarwinFallbackKey(key: string): string {
  if (hostPlatform() !== "darwin" || !key.startsWith("sysfb:") || !declaredFamilyForKey.has(key)) return key;
  const spec = resolveFontSpec(key);
  if (spec == null || spec.path === "" || spec.postscriptName == null) return key;
  const exactKey = `sysfb:exact:${spec.postscriptName}`;
  registerDynamicSystemFont(
    exactKey,
    spec.path,
    spec.postscriptName,
    spec.extractor,
    spec.resolvedAxes,
    spec.ctAxes,
    spec.linuxFallbackIsBold,
    spec.linuxFallbackIsItalic,
    spec.faceIndex,
  );
  return exactKey;
}

/**
 * Run `fn` with the CoreText per-codepoint fallback resolver toggled to `on`,
 * restoring the prior value afterward — even if `fn` throws. Use this instead of
 * a bare `setSystemFallbackResolution(...)` for a temporary toggle so the change
 * can't leak into the next render in the same process (DM-1350). Synchronous:
 * scopes a synchronous render — the resolver runs during synchronous text
 * emission. Async/Promise-like callbacks are rejected at the type boundary and
 * at runtime because the toggle cannot safely span an `await` (DM-2637).
 */
export function withSystemFallbackResolution<F extends () => unknown>(
  on: boolean,
  fn: SynchronousCallback<F>,
): ReturnType<F> {
  const prev = _systemFallbackResolutionEnabled;
  setSystemFallbackResolutionEnabled(on);
  try {
    return invokeSynchronousCallback("withSystemFallbackResolution", fn);
  } finally {
    setSystemFallbackResolutionEnabled(prev);
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
export const fallbackBaseCache = new Map<string, { name: string; path?: string; data?: Buffer }>();

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

/** DM-2059 A/B: restore the Times stand-in for in-memory webfonts. */
const _webfontFallbackBaseEnabled = process.env.DOMOTION_WEBFONT_FALLBACK_BASE !== "0";

function fallbackBaseFor(
  primaryKey: string | undefined,
  weight: number = 400,
  fontSize: number = 16,
  slant: number = 0,
  stretch: number = 100,
): { name: string; path?: string; data?: Buffer } {
  if (!_fallbackBaseFromPrimary || primaryKey == null) return { name: "Helvetica" };
  const cacheKey = `${hostPlatform()}|${primaryKey}|${weight}|${fontSize}|${slant !== 0 ? 1 : 0}|${stretch}`;
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
  const cutKey = isRegistryKey ? primaryKey : resolveEffectiveCutKey(primaryKey, weight, slant, stretch).key;
  const spec = resolveFontSpec(cutKey) ?? resolveFontSpec(primaryKey);
  let base: { name: string; path?: string; data?: Buffer };
  if (spec?.postscriptName == null || spec.postscriptName === "") {
    const resolvedInstance = getFontInstance(primaryKey, weight, fontSize, slant, undefined, stretch);
    const resolvedName = resolvedInstance?.instantiatedPostscriptName ?? resolvedInstance?.postscriptName;
    // A static single-face path may omit its optional PostScript-name hint.
    // It is still a normal CoreText-backed declared face, not an in-memory
    // webfont. Blink asks fallback from the instantiated current font, so use
    // the identity the opened instance reports instead of substituting Times.
    if (spec != null && resolvedName != null && resolvedName !== "") {
      base = { name: resolvedName, path: getFontSourceInfo(resolvedInstance)?.path ?? spec.path };
      fallbackBaseCache.set(cacheKey, base);
      return base;
    }
    // A primary with no on-disk spec of its own — a webfont / local-alias
    // registry key, i.e. exactly the faces for which Blink's `ct_font` is
    // null (FreeType-backed webfonts, some color fonts). `GetSubstituteFont`
    // then substitutes from a **Times** base, not Helvetica:
    // `CTFontCreateWithName(CFSTR("Times"), size, nullptr)` handed to
    // `CTFontCreateForString` (`mac/font_cache_mac.mm:137-147`, rev
    // 7d859f27, quoting the "default value of standard font from user
    // settings"). `Times-Roman` is the face the "Times" family name
    // instantiates.
    base =
      _webfontFallbackBaseEnabled && resolvedInstance?.webfontBuffer != null
        ? { name: resolvedInstance.postscriptName ?? "", data: resolvedInstance.webfontBuffer }
        : { name: "Times-Roman" };
  } else {
    base = { name: spec.postscriptName, path: spec.path };
    if (_fallbackBaseCutEnabled && !isRegistryKey && (weight !== 400 || slant !== 0 || stretch !== 100)) {
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
 * name would answer "not color emoji" for every system-ui run and silently
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
export const _trakHbShapingEnabled = process.env.DOMOTION_TRAK_HB_SHAPING !== "0";

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
export const _liveFallbackFirst = hostPlatform() !== "win32" && process.env.DOMOTION_LIVE_FALLBACK_FIRST !== "0";

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
 * Matches the first EFFECTIVE family in the stack. Unavailable names (including
 * `-apple-system` and Blink-unrecognized pseudo-generics such as
 * `ui-sans-serif`) fall through via the same matcher as primary resolution;
 * when the next available family is `system-ui`, that family entered Blink's
 * MatchSystemUIFont path and must retain the axis/cascade signal.
 */
export function stackPrimaryIsSystemUi(
  fontFamily: string | undefined,
  lang?: string,
  description: DarwinFontDescription = DARWIN_INITIAL_FONT_DESCRIPTION,
): boolean {
  if (fontFamily == null || fontFamily === "") return false;
  for (const entry of splitFontFamilyNames(fontFamily)) {
    // These two names enter Blink's system-font path before ordinary family
    // matching. The intercept is case-sensitive but applies to a quoted
    // `"system-ui"` too; `canonicalSystemUiName` preserves that distinction.
    if (entry.canonicalSystemUiName || entry.lookupName === "BlinkMacSystemFont") return true;

    // A prior system-ui lookup populates Blink's Darwin platform-font cache.
    // After that, a case-variant literal such as `"System-ui"` resolves to the
    // cached UI font even though it did not enter the canonical-name branch.
    // Its fallback still walks the UI font's private cascade. The family
    // matcher mirrors the warmed primary; carry the same state into the
    // fallback-base signal rather than reopening plain SFNS.ttf by path.
    if (hostPlatform() === "darwin" && hasWarmDarwinSystemUiAlias(description) && entry.name === "system-ui")
      return true;

    // Mirror the same nomination walk `resolveFont` / `resolveFontKey` use.
    // An unavailable name is not the primary merely because it appears first
    // in the declaration: Blink walks past it. This is load-bearing for common
    // stacks such as `ui-sans-serif, system-ui`, because Blink does not
    // recognize `ui-sans-serif` as a generic keyword and therefore reaches the
    // platform UI font (and its private CoreText cascade) on the next entry.
    const key = matchFamilyNameToKey(
      entry.name,
      entry.generic,
      lang,
      entry.canonicalSystemUiName,
      entry.lookupName,
      description,
    );
    if (key != null) return false;
  }
  return false;
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

import { _charFallbackDocCache, characterFallbackDocKey } from "./character-fallback-cache.js";
export * from "./character-fallback-cache.js";
import type { FontRequest } from "./font-request.js";

/** Keep the public positional resolver API at the package edge. */
export function resolveSystemFallbackKeyForRequest(request: FontRequest): string | null {
  return resolveSystemFallbackKeyForCp(
    request.cp,
    request.weight,
    request.slant,
    request.fontSize,
    request.primaryFontKey,
    request.systemUiPrimary,
    request.lang,
    request.stretch,
    request.fontVariantEmoji,
    request.semanticContext.declaredFamily,
    request.rawSlope,
    request.orientation,
    request.variationSettings,
  );
}

export function resolveSystemFallbackKeyForCp(
  cp: number,
  weight: number = 400,
  slant: number = 0,
  fontSize: number = 16,
  primaryKey?: string,
  systemUiPrimary: boolean = false,
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
  /** DM-2017: the run's RAW CSS `font-family` stack (Chrome's unresolved,
   *  comma-separated `getComputedStyle()` value), consulted ONLY by the Linux
   *  standard-style retry below — see the comment there for why `primaryKey`
   *  (the already-matched key) is the wrong thing to retry with. Optional so
   *  the many direct callers of this function (tests, the darwin/win32 paths)
   *  keep their exact behavior; omitted → the retry trusts `primaryKey`, which
   *  is only wrong when the stack's first declared name was itself rejected. */
  declaredFamily?: string,
  /** Blink's full requested slope in CSS degrees. The native font ask still
   * uses `slant`; this value owns CharacterFallbackKey identity only. */
  rawSlope: number = slant !== 0 ? 14 : 0,
  /** Numeric Blink FontOrientation (horizontal=0, vertical-upright=3). */
  orientation: number = 0,
  variationSettings?: Record<string, number>,
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
  const uiClone =
    hostPlatform() === "darwin" && useSystemUiBase ? uiCloneForAuthorVariation(variationSettings, fontSize) : undefined;
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
  // cross-platform test could assert Linux behavior and be reading a poisoned
  // memo. That is the same hazard the base and locale components already carry,
  // one axis over, and it is invisible in production precisely because nothing
  // in production varies it.
  // The linux and win32 arms consult `primaryKey` beyond what `base.name`
  // captures — the Linux standard-style retry re-instantiates the key itself,
  // and the win32 arm derives the DirectWrite base family from it — and
  // `fallbackBaseFor` is not injective in the key (every registry key shares
  // one cascade-base name), so those arms key the memo on the primary key too.
  // darwin reads `primaryKey` only through `base.name` / `useSystemUiBase`,
  // both already components, and stays unkeyed so its memo behavior (and the
  // committed conformance baseline) is untouched.
  const primaryKeyComponent = hostPlatform() === "darwin" ? "" : (primaryKey ?? "");
  const darwinDescription = hostPlatform() === "darwin" ? `|${rawSlope}|${orientation}` : "";
  // Linux's rejected-head retry and Windows' DirectWrite base nomination read
  // the unresolved declared head. It is therefore part of this memo's input,
  // including whether the node was a generic or a quoted/named family.
  const declaredHeadComponent = hostPlatform() === "darwin" ? "" : declaredFamilyHeadIdentity(declaredFamily);
  const cacheKey = `${hostPlatform()}|${cp}|${weight}|${slant !== 0 ? 1 : 0}${darwinDescription}|${fontSize}|${base.name}|${useSystemUiBase ? "ui" : ""}|${lang ?? ""}|${suppressEmojiPresentation ? "t" : ""}|${primaryKeyComponent}|${declaredHeadComponent}|${uiClone == null ? "" : JSON.stringify(uiClone)}`;
  // DM-1949: the ideograph document cache (Blink's character_fallback_cache_,
  // font_cache_mac.mm:352-366) is consulted BEFORE any ask — including the
  // process-global memo below, which is a memo of the context-FREE ask and
  // therefore must not answer for a codepoint the document's cached face
  // covers. Hit condition transcribed: the CACHED face has a cmap glyph for
  // this codepoint, at the weight/size/slant the key pins.
  const docKey = characterFallbackDocKey(cp, base.name, useSystemUiBase, weight, rawSlope, orientation, fontSize);
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
      // Via `isEmojiPresentationCp` rather than the property test inlined here
      // before. The two had drifted: that copy read `Emoji_Presentation` and so
      // missed the emoji-modifier BASES, which Blink's categoriser classifies
      // ahead of the presentation property — leaving 250 mismatching rows in a
      // 5M-comparison slice where Chrome painted Apple Color Emoji for U+261D /
      // U+26F9 / U+270C / U+270D and we painted HiraMinProN or STIX Two Math.
      // One predicate, one place, so the next correction cannot reach one copy
      // and not the other; the shared one also excludes lone regional
      // indicators, which this site never did.
      if (!suppressEmojiPresentation && isEmojiPresentationCp(cp)) {
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
        weight,
        italic: slant !== 0,
        fontSize,
        basePath: base.path,
        baseData: base.data,
        // DM-1859: a `system-ui` run's cascade is walked from the platform UI
        // font, which the helper builds with `CTFontCreateUIFontForLanguage` the
        // way `MatchSystemUIFont` does. Not expressible as a path — the UI font
        // carries its own cascade list, and that list is what reaches Apple's
        // hidden `.…UI` variants.
        ...(useSystemUiBase ? { systemUi: true } : {}),
        ...(uiClone != null ? { uiClone } : {}),
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
      // whose color-ness contradicts the request is reported as
      // `kUnmatchedVSGlyphId` and skipped (`shaping/harfbuzz_face.cc:191-204`),
      // and an exhausted walk restarts once with `kIgnoreVariationSelector`
      // (`shaping/harfbuzz_shaper.cc:1008-1019`). We model none of that; the
      // full mirror is tracked separately.
      //
      // What we model is the one consequence that reaches this seam: when the
      // re-ask lands back on an Apple color emoji face, the replacement found
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
      if (wantMonoEmojiReplacement && resolved != null && isAppleColorEmojiFamily(resolved.familyName)) {
        const unreplaced = resolveSystemFallbackFonts([cp], base.name, {
          weight,
          italic: slant !== 0,
          fontSize,
          basePath: base.path,
          baseData: base.data,
          ...(useSystemUiBase ? { systemUi: true } : {}),
          ...(uiClone != null ? { uiClone } : {}),
        }).get(cp);
        if (unreplaced != null && unreplaced.path !== "") resolved = unreplaced;
      }
      if (resolved != null && resolved.path !== "") {
        key = `sysfb:${resolved.postscriptName}`;
        // The same face can come back with a DIFFERENT handle state depending on
        // the cascade base: at U+0D00 / 16 px a Times base yields an
        // `.SFMalayalam-Regular` handle with `opsz` already at 17 (Blink's
        // `axes_reconfigured` guard never clones it, so Chrome reports the base
        // name), while the UI-font base yields one at the default `opsz`, which
        // Blink clones to 17 (`_opsz110000_wght`). The handle state is recorded
        // per (key, weight, size, slant) and the memo above holds only the key,
        // so a shared key let whichever route asked first decide the instance
        // for both. A route whose state differs from the recorded one gets its
        // own key, named by that state, so each route keeps its own handle.
        if (
          resolved.ctAxes != null &&
          resolved.ctAxes.length > 0 &&
          !darwinHandleAxesCompatible(key, weight, fontSize, slant, resolved.ctAxes)
        ) {
          key = `sysfb:handle:${resolved.postscriptName}#${darwinHandleStateSignature(resolved.ctAxes)}`;
        }
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
      // requested family and synthesizes the bold. That is a family change, not
      // a weight change — far more visible than the thing it is standing in for.
      //
      // Emoji-presentation runs are excluded exactly as Blink excludes them:
      // their fallback is a color-emoji font, and retrying the text family at
      // regular weight would find a monochrome glyph and stop there.
      //
      // `kBoldThreshold` is 600 (`font_description.h`), the same constant the
      // helper already uses for the synthetic-bold trait.
      if (
        (suppressEmojiPresentation || !isEmojiPresentationCp(cp)) &&
        (slant !== 0 || weight >= 600) &&
        primaryKey != null
      ) {
        // DM-2017: Blink's retry is `FontFaceCreationParams(substitute_description
        // .Family().FamilyName())` — the LITERAL first name in the CSS
        // `font-family` stack (`skia/font_cache_skia.cc:126-127`), asked
        // independently of whatever the whole-stack walk settled on. `primaryKey`
        // is that walk's RESULT, not its first token — the two diverge exactly
        // when the page declares a family the matcher rejects (not installed, no
        // acceptable fontconfig substitute) followed by one it accepts, e.g.
        // `font-family: Verdana, Georgia` on a host without Verdana: `primaryKey`
        // is Georgia's key, but Blink is still asking about Verdana specifically
        // and, finding no acceptable match for IT, fails through to system
        // fallback — it does not retry Georgia's regular cut. Re-matching just
        // the head token (not the whole stack) against the SAME accept/reject
        // predicate `resolveFontKey` used tells us which case this is: equal to
        // `primaryKey` means the head token IS what produced it (the common
        // case — retry is faithful), anything else means Blink would be asking
        // about a family we never resolved, so we fail through exactly as it
        // does rather than substitute a different family's regular cut.
        const declaredHead = declaredFamily != null ? splitFontFamilyNames(declaredFamily)[0] : undefined;
        const headMatchesPrimary =
          declaredHead == null || matchFamilyNameToKey(declaredHead.name, declaredHead.generic, lang) === primaryKey;
        if (headMatchesPrimary) {
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
      // the native (helper) extractor, like darwin. Before returning, the helper
      // mirrors Blink's `UpdateFromSkiaFontStyle` + family reopen and applies its
      // HasCharacter guard to that FINAL face, so a face only registers when it
      // actually covers `cp`. Default-on (DM-1424); the flag
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
      // Blink passes `font_description.Family().FamilyName()` verbatim
      // (`win/font_cache_skia_win.cc:234-240`). That is the first DECLARED CSS
      // family, not the family name of the face the preceding stack walk
      // resolved. They differ for generics, missing names followed by an
      // installed family, and aliases — precisely the cases where feeding
      // DirectWrite the resolved file family changes its fallback cascade.
      const declaredHead = declaredFamily != null ? splitFontFamilyNames(declaredFamily)[0]?.name : undefined;
      const primaryFamily =
        declaredHead ??
        (primaryKey == null
          ? undefined
          : ((primaryKey === "sf-pro"
              ? (resolveSystemUiFamily() ?? fileFamilyNameForKey(primaryKey))
              : fileFamilyNameForKey(primaryKey)) ?? undefined));
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
        weight,
        italic: slant !== 0,
        fontSize,
        ...(primaryFamily != null ? { baseFamilyName: primaryFamily } : {}),
        ...(dwLocale !== "" ? { locale: dwLocale } : {}),
      }).get(cp);
      if (resolved != null && resolved.path !== "") {
        key = `sysfb:${resolved.postscriptName}`;
        // DM-1721: carry DirectWrite's resolved axis values (variable faces
        // only) into the dynamic spec so the hinted-subset pin can adopt them.
        registerDynamicSystemFont(key, resolved.path, resolved.postscriptName, "native", resolved.resolvedAxes);
        // Same as the darwin branch above: the helper already decided coverage
        // while it held the face open, so the caller need not re-ask over IPC.
        // On Windows the field is exact rather than optimistic — the extractor
        // reports it only after Blink's post-MapCharacters family reopen and
        // `HasCharacter(cp)` both succeed.
        if (resolved.covered !== undefined) _sysfbCoverage.set(`${key}|${cp}`, resolved.covered);
      }
    }
  } catch {
    key = null;
  }
  systemFallbackKeyCache.set(cacheKey, key);
  docInsert(key);
  return key;
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
export function resolveColorEmojiKeyForCp(
  cp: number,
  weight: number,
  fontSize: number,
  slant: number,
  lang: string | undefined,
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
      for (const k of win32FallbackChainWithPriority(cp, "emoji-emoji", lang)) {
        key = k;
        break;
      }
    }
  } catch {
    key = null;
  }
  if (key == null) return null;
  // Blink's fallback iterator only uses a stage's font when it actually has a
  // glyph for the character; a non-covering color font falls through to the
  // reset. The keycap bases are the measured example of covered-but-unexpected:
  // Apple Color Emoji's cmap really does map a plain digit.
  const inst = getFontInstance(key, weight, fontSize, slant);
  // DM-1986: the CMAP question, not the outline one. A bitmap-only color font
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
  cp: number,
  lang?: string,
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
  cp: number,
  lang?: string,
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
  // fontconfig toward a color font instead of toward the page's language.
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
    // DM-2017: fontconfig's own is_bold/is_italic classification of THIS
    // candidate, threaded through so the synthetic-bold/italic decision below
    // can apply Blink's fallback-specific binary rule
    // (`linux/font_cache_linux.cc:106-125`) instead of the general Linux delta
    // rule, which is right for a DECLARED family but not for this stage — see
    // `FontInstance.linuxFallbackIsBold` for the full rationale.
    registerDynamicSystemFont(
      key,
      viaHelper.path,
      name,
      "fontkit",
      undefined,
      undefined,
      viaHelper.isBold,
      viaHelper.isItalic,
      viaHelper.index,
    );
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
  const opened = openFontkitFace(path, { postscriptName });
  if (opened == null) return false;
  try {
    return (
      typeof opened.face.glyphForCodePoint === "function" &&
      glyphIdForCp(opened.face as unknown as FontInstance, cp) !== 0
    );
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
export function fallbackFamilyCutKey(
  candidate: string,
  cp: number,
  weight: number,
  slant: number,
  fontSize: number,
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
      weight,
      italic: slant !== 0,
      fontSize,
      basePath: spec.path,
    }).get(cp);
    if (resolved != null && resolved.path !== "" && resolved.postscriptName !== base) {
      key = `sysfb:${resolved.postscriptName}`;
      registerDynamicSystemFont(key, resolved.path, resolved.postscriptName);
    }
  } catch {
    key = null;
  }
  fallbackFamilyCutCache.set(cacheKey, key);
  return key;
}

// Memo for `fallbackFamilyCutKey`, keyed on the candidate family + codepoint +
// CSS description. Process-global, like the other font caches.
export const fallbackFamilyCutCache = new Map<string, string | null>();

/**
 * Coverage answers the platform helper volunteered alongside a nomination.
 *
 * Keyed per (face key, codepoint) and therefore UNBOUNDED in the codepoint
 * universe, like the other per-codepoint memos in this file — so it is dropped
 * by `clearFontResolutionCaches()` with them. That is not a detail: an
 * unbounded per-codepoint map with no caller clearing it is exactly what made a
 * full-corpus sweep exhaust the heap earlier in this cycle.
 */
export const _sysfbCoverage = new Map<string, boolean>();

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
  cp: number,
  weight = 400,
  slant = 0,
  fontSize = 16,
  primaryKey?: string,
  systemUiPrimary = false,
  lang?: string,
  stretch = 100,
  fontVariantEmoji?: FontVariantEmojiOverride,
  declaredFamily?: string,
  rawSlope: number = slant !== 0 ? 14 : 0,
  orientation: number = 0,
  variationSettings?: Record<string, number>,
): string | null {
  return resolveSystemFallbackKeyForCp(
    cp,
    weight,
    slant,
    fontSize,
    primaryKey,
    systemUiPrimary,
    lang,
    stretch,
    fontVariantEmoji,
    declaredFamily,
    rawSlope,
    orientation,
    variationSettings,
  );
}
