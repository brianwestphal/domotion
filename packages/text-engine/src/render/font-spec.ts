/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { hostPlatform } from "./host-platform.js";
import { LINUX_FONT_PATHS } from "./font-paths.linux.js";
import { WIN32_FONT_PATHS } from "./font-paths.win32.js";
import { FONT_PATHS } from "./font-paths.darwin.js";
import type { FontPath } from "./font-paths.darwin.js";
import { resolvedSpecCache } from "./font-paths.win32.js";
import { dynamicSystemFontPaths } from "./font-paths.win32.js";
import { resolveLinuxSpec } from "./font-paths.win32.js";
import { resolveWin32Spec } from "./font-paths.win32.js";
import { relocateMissingSpec } from "./font-paths.win32.js";
import type { CssFallbackDescription } from "./fallback-chain.js";
import { resolveSystemFallbackKeyForCp } from "./system-fallback-resolver.js";

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
    case "linux":
      return Object.keys(LINUX_FONT_PATHS);
    case "win32":
      return Object.keys(WIN32_FONT_PATHS);
    default:
      return Object.keys(FONT_PATHS);
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
      case "linux":
        resolved = resolveLinuxSpec(key);
        break;
      case "win32":
        resolved = resolveWin32Spec(key);
        break;
      default:
        resolved = FONT_PATHS[key] ?? null;
        break; // darwin + any other Unix with macOS-style paths
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
export const systemFallbackKeyCache = new Map<string, string | null>();

/** Test-only mutation witness for request-identity cache controls. */
export function __systemFallbackKeyCacheSizeForTest(): number {
  return systemFallbackKeyCache.size;
}

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
export let _systemFallbackResolutionEnabled =
  hostPlatform() === "darwin" ||
  (hostPlatform() === "linux" && process.env.DOMOTION_SYSTEM_FALLBACK !== "0") ||
  (hostPlatform() === "win32" && process.env.DOMOTION_SYSTEM_FALLBACK !== "0");
export function setSystemFallbackResolutionEnabled(on: boolean): void {
  _systemFallbackResolutionEnabled = on;
}

/** Test-only window into the platform path resolver (DM-258). Widened by
 *  DM-2017 to expose `linuxFallbackIsBold` / `linuxFallbackIsItalic` so a test
 *  can confirm the Linux `fcfallback` resolver's is_bold/is_italic bits
 *  actually reach the registered spec, without needing to open the (possibly
 *  off-host) font file they describe. */
export function __resolveFontSpecForTest(key: string): {
  path: string;
  postscriptName?: string;
  extractor?: string;
  optionalInstall?: boolean;
  linuxFallbackIsBold?: boolean;
  linuxFallbackIsItalic?: boolean;
} | null {
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
export function __resolveDarwinFontSpecForTest(key: string): {
  path: string;
  postscriptName?: string;
  extractor?: string;
  optionalInstall?: boolean;
} | null {
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
export const isHebrewBlock = (cp: number): boolean => (cp >= 0x0590 && cp <= 0x05ff) || (cp >= 0xfb1d && cp <= 0xfb4f);

export const isArabicBlock = (cp: number): boolean =>
  (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);

export const isDevanagariBlock = (cp: number): boolean => cp >= 0x0900 && cp <= 0x097f;

export const isThaiBlock = (cp: number): boolean => cp >= 0x0e00 && cp <= 0x0e7f;

export const isHangulBlock = (cp: number): boolean => (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff);

// CJK in the BMP: Symbols & Punctuation, Hiragana, Katakana (+ phonetic exts),
// Unified Ideographs + Ext A, and Compatibility Ideographs. (Hangul is its own
// block above; the supplementary-plane CJK extensions are darwin-only.)
export const isCjkBmpBlock = (cp: number): boolean =>
  (cp >= 0x3000 && cp <= 0x303f) ||
  (cp >= 0x3040 && cp <= 0x309f) ||
  (cp >= 0x30a0 && cp <= 0x30ff) ||
  (cp >= 0x31f0 && cp <= 0x31ff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0xf900 && cp <= 0xfaff);

export const isBoxDrawingBlock = (cp: number): boolean => cp >= 0x2500 && cp <= 0x259f;

export const isDingbatsBlock = (cp: number): boolean => cp >= 0x2700 && cp <= 0x27bf;

export const isMathAlphanumericBlock = (cp: number): boolean => cp >= 0x1d400 && cp <= 0x1d7ff;

export const isSuperSubscriptBlock = (cp: number): boolean => cp >= 0x2070 && cp <= 0x209f;

export const isLetterlikeBlock = (cp: number): boolean => cp >= 0x2100 && cp <= 0x214f;

export const isMathOperatorsBlock = (cp: number): boolean => cp >= 0x2200 && cp <= 0x22ff;

// Pictograph residue not caught by the color-emoji raster path (doc 15):
// Misc Symbols & Pictographs + Transport & Map Symbols.
export const isPictographResidueBlock = (cp: number): boolean =>
  (cp >= 0x1f300 && cp <= 0x1f5ff) || (cp >= 0x1f680 && cp <= 0x1f6ff);

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
export function linuxDeferOrStatic(
  cp: number,
  fallback: string[],
  /** DM-2017: the run's ACTUAL weight/slant/fontSize/primary/locale — this
   *  probe used to ask `resolveSystemFallbackKeyForCp` with just `cp` (weight
   *  400, no primary, no locale), a DIFFERENT question from the one the live
   *  resolver answers for real when it actually resolves the codepoint
   *  (`fallbackFontChain`'s caller passes weight/slant/primaryKey/lang in
   *  full — `resolveFontForCodepointInner`'s `liveFallback`). The gap is
   *  mostly harmless for WEIGHT (the fontconfig sorted set this resolver
   *  walks is keyed by locale, not by weight), but `lang` genuinely changes
   *  which sorted set gets consulted — a Han-unification-sensitive codepoint
   *  can be covered under one locale's sort and not another's, so probing
   *  under the wrong locale can defer (or fail to defer) on a DIFFERENT
   *  verdict than the real per-codepoint stage reaches a moment later. */
  primaryKey?: string,
  lang?: string,
  css?: CssFallbackDescription,
): string[] {
  // Linux-only runtime behavior: consult fc-match (Linux's system-fallback
  // backend). On a non-Linux host — the dev machine running the calibration
  // unit tests directly — return the static route so this stays host-agnostic
  // and `resolveSystemFallbackKeyForCp` (which would use CoreText/DirectWrite
  // off-Linux) is never consulted for Linux logic.
  if (
    hostPlatform() === "linux" &&
    _systemFallbackResolutionEnabled &&
    resolveSystemFallbackKeyForCp(
      cp,
      css?.weight,
      css?.slant,
      css?.fontSize,
      primaryKey,
      false,
      lang,
      css?.stretch,
      css?.fontVariantEmoji,
      css?.declaredFamily,
    ) != null
  ) {
    return [];
  }
  return fallback;
}
