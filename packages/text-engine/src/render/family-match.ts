/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostPlatform } from "./host-platform.js";
import { invokeSynchronousCallback, type SynchronousCallback } from "./synchronous-scope.js";
import { type BlinkGenericFamily } from "../font-family-stack.js";
import {
  isGlyphHelperAvailable,
  resolveInstalledFont,
  resolveFamilyStyleMatch,
  resolveFamilyStyleMatchWithStatus,
  resolveLinuxFamilyMatch,
  type LinuxFamilyMatch,
} from "./glyph-helper.js";
import { win32FamilySuffixAdjustment } from "./win32-family-suffix.js";
import {
  firstAvailableOrFirst,
  localeToScriptCodeForFontSelection,
  perScriptGenericFamily,
} from "./generic-script-families.js";
import { winFallbackPriorityForTextRun } from "./win-font-fallback.js";
import { isIcuHelperAvailable } from "./icu-helper.js";
import { resolveFontSpec } from "./font-spec.js";
import { openFontkitFace } from "./font-instance.js";
import { registerDynamicSystemFont } from "./font-paths.win32.js";
import { _systemFallbackResolutionEnabled } from "./font-spec.js";
import { skiaLastResortInitialFamily } from "./fallback-chain.js";
import { LINUX_FONT_PATHS } from "./font-paths.linux.js";
import type { FontFallbackSemanticContext } from "./fallback-chain.js";
import { createFontFallbackSemanticContext } from "./fallback-chain.js";
import type { CssFallbackDescription } from "./fallback-chain.js";
import { win32FamilyKeyCache } from "./fallback-chain.linux.js";
import type { FontVariantEmojiOverride } from "./emoji-presentation.js";
import { isEmojiCharCp } from "./emoji-presentation.js";
import { isEmojiPresentationCp } from "./emoji-presentation.js";
import { _famAvailCache } from "./font-instance.js";
import { BLINK_GENERIC_FAMILY_SPELLINGS } from "./font-instance.js";
import { webfontRegistry } from "./font-instance.js";
import { localFontAliasRegistry } from "./webfont-registry.js";
import {
  DARWIN_INITIAL_FONT_DESCRIPTION,
  hasWarmDarwinSystemUiAlias,
  warmDarwinSystemUiAlias,
  type DarwinFontDescription,
} from "./darwin-font-data-lifetime.js";
import { fcMatch } from "./font-paths.win32.js";
import { win32SuffixDeclaredForKey } from "./fallback-chain.linux.js";
import { resolveFaceInfoForFile } from "./font-instance.js";
import { splitFontFamilyNames } from "./font-instance.js";
import type { FontInstance } from "./font-instance.js";
import { computedFontSize } from "./font-instance.js";
import { getFontInstance } from "./font-instance.js";
import { stackPrimaryIsSystemUi } from "./system-fallback-resolver.js";

let _win32FamilyKeyOverride: ((family: string, css?: CssFallbackDescription) => string | null) | null = null;

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
  "courier",
  "courier-new",
  "menlo",
  "monaco",
  "sf-mono",
  "times",
  "times-new-roman",
  "georgia",
  "source-serif-pro",
  "playfair-display",
  "hiragino-mincho",
  "hiragino-jp",
  "u-arial-unicode-ms",
  "apple-chancery",
  "snell",
  "papyrus",
  "helvetica",
  "helvetica-neue",
  "arial",
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
export const declaredFamilyForKey = new Map<string, string>();

/** Memo for `darwinPrimaryCutKey`, keyed on the key AND the full style it
 *  answers for — weight, italic and width. A style-blind key would serve
 *  whichever weight asked first; a width-blind one would serve a normal-width
 *  answer to a `font-stretch: condensed` run, which is the same defect one
 *  axis over. */
export const darwinPrimaryCutCache = new Map<string, { key: string; italic: boolean } | null>();

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
    const opened = openFontkitFace(spec.path);
    if (opened == null) return null;
    const p = opened.face.postscriptName;
    psName = typeof p === "string" ? p : undefined;
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
 *
 * Null therefore means "could not ask", never "the base face is right": when
 * the matcher answers the base face itself, that answer is returned as the
 * base KEY so it replaces whatever sibling/ladder seed the caller holds.
 */
export function darwinPrimaryCutKey(
  key: string,
  weight: number,
  slant: number,
  stretch: number = 100,
  declaredFamilyOverride?: string,
): { key: string; italic: boolean } | null {
  if (hostPlatform() !== "darwin" || !isGlyphHelperAvailable()) return null;
  const declaredFamily = declaredFamilyForKey.get(key);
  if (declaredFamilyOverride == null && declaredFamily == null && !DARWIN_DECLARED_FAMILY_KEYS.has(key)) return null;

  const italicRequested = slant !== 0;
  const cacheKey = `${hostPlatform()}|${key}|${declaredFamilyOverride ?? declaredFamily ?? ""}|${weight}|${italicRequested ? 1 : 0}|${stretch}`;
  const cached = darwinPrimaryCutCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: { key: string; italic: boolean } | null = null;
  try {
    const family = declaredFamilyOverride ?? declaredFamily ?? darwinCoreTextFamilyForKey(key);
    if (family != null) {
      const resolution = resolveFamilyStyleMatchWithStatus(family, {
        weight,
        italic: italicRequested,
        stretch,
      });
      if (!resolution.cacheable) return null;
      const match = resolution.match;
      const base = resolveFontSpec(key)?.postscriptName;
      if (match != null && match.postscriptName === base) {
        // The matcher answered the very face the key already resolves to.
        // That is an ANSWER, not an abstention: Blink runs no weight ladder
        // behind `BestStyleMatchForFamilyNS`, so the sibling/ladder routing
        // the caller pre-seeded must be replaced by the base face rather than
        // left standing. Conflating this with the null "could not ask" return
        // was a measured divergence: declared "Hiragino Sans" at CSS 510-590
        // painted HiraginoSans-W5 where Chrome paints W4 — the tag's
        // `BetterChoiceCT` rejects W5 on its unwanted AppKit bold trait
        // (`font_matcher_mac.mm:186-196` at tag 147.0.7727.15 names exactly
        // this face in its comment), the matcher answered the W4 base entry,
        // and the null return let the nearest-`usWeightClass` ladder override
        // it with W5.
        result = { key, italic: match.italic };
      } else if (match != null) {
        const installed = resolveInstalledFont(match.postscriptName);
        if (installed != null && installed.path !== "") {
          const cutKey = `sysfb:${match.postscriptName}`;
          // The BASE key's extractor is preserved: this changes WHICH face is
          // opened, not how its outlines are read, and flipping a fontkit face
          // onto the native path would move the outlines for reasons that have
          // nothing to do with style matching.
          registerDynamicSystemFont(
            cutKey,
            installed.path,
            match.postscriptName,
            resolveFontSpec(key)?.extractor ?? "fontkit",
            installed.resolvedAxes,
            installed.ctAxes,
          );
          if (resolveFontSpec(cutKey) != null) result = { key: cutKey, italic: match.italic };
        }
      }
    }
  } catch {
    result = null;
  }
  darwinPrimaryCutCache.set(cacheKey, result);
  return result;
}

/** Test seam for the declared-family memo's transient-failure contract. */
export function __darwinPrimaryCutKeyForTest(
  key: string,
  weight: number,
  slant: number,
  stretch: number,
  declaredFamily: string,
): { key: string; italic: boolean } | null {
  return darwinPrimaryCutKey(key, weight, slant, stretch, declaredFamily);
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
 * browser-side `GenericFontFamilySettings` values, mapped to the value each
 * setting carries in the CAPTURE SESSION on Linux.
 *
 * The mechanism is `FontSelector::FamilyNameFromSettings`
 * (`font_selector.cc:73-91`, rev 7d859f27): serif → `settings.Serif(script)`,
 * sans-serif → `settings.SansSerif(script)`, cursive →
 * `settings.Cursive(script)`, fantasy → `settings.Fantasy(script)`,
 * monospace → `settings.Fixed(script)`, math → `settings.Math(script)`, and
 * `-webkit-standard` / a `kWebkitBodyFamily` description →
 * `settings.Standard(script)`.
 *
 * The VALUES are populated by PLAYWRIGHT, not by Chrome's prefs layer: on
 * every non-headful launch it calls CDP `Page.setFontFamilies` with its own
 * vendored per-platform table (`playwright-core/lib/server/chromium/
 * crPage.js:436-437,814-816` + `defaultFontFamilies.js`, playwright-core
 * 1.59.1). Its Linux row: standard/serif "Times New Roman", sansSerif
 * "Arial", fixed "Monospace", cursive "Comic Sans MS", fantasy "Impact" —
 * key-for-key equal to Chrome's own Linux defaults in
 * `chrome/app/resources/locale_settings_linux.grd` (rev 7d859f27), which is
 * the table's upstream provenance. `math` has NO Playwright key, so the
 * `blink::web_pref::WebPreferences` constructor default survives: "Latin
 * Modern Math" (`third_party/blink/common/web_preferences/
 * web_preferences.cc:41`, rev 7d859f27). Playwright's Linux row also has NO
 * `forScripts` per-script entries (unlike mac/win), so on Linux the content
 * script must never move a generic's family.
 *
 * The settings name then goes through the SAME family lookup as any declared
 * name — `SkFontConfigInterfaceDirect::matchFamilyName` with the acceptance
 * filter (Skia rev 62efacd3, the revision Chromium tag 147.0.7727.15's DEPS
 * pins) — so a name fontconfig can only satisfy with a foreign substitute
 * ("Comic Sans MS" → WenQuanYi Zen Hei) is REJECTED, the family is
 * unavailable, and the stack walks on to its terminal, the standard family.
 * That rejection path is what makes bare `cursive` / `fantasy` paint
 * Liberation Serif (via standard = "Times New Roman") on the noble image.
 *
 * `system-ui` is NOT here: it resolves through
 * `FontCache::SystemFontFamily()`, a different browser-side mechanism, and
 * stays on its measured static route. When the session probe is armed
 * the default-on session probe supersedes this table —
 * they measure the same Playwright layer from inside the live session.
 */
const LINUX_GENERIC_FAMILY_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ["serif", "Times New Roman"],
  ["sans-serif", "Arial"],
  ["monospace", "Monospace"],
  ["cursive", "Comic Sans MS"],
  ["fantasy", "Impact"],
  ["math", "Latin Modern Math"],
  ["-webkit-standard", "Times New Roman"],
  ["-webkit-body", "Times New Roman"],
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
  name: string,
  style: { weight: number; italic?: boolean; stretch?: number },
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
  return (
    hostPlatform() === "linux" &&
    _systemFallbackResolutionEnabled &&
    isGlyphHelperAvailable() &&
    resolveLinuxFamilyMatch("sans", { weight: 400 }) != null
  );
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
 * (`SkFontMgr_FontConfigInterface.cpp:253-256`, Skia rev 62efacd3 — the
 * revision `external/chromium` DEPS:330 pins at rev 7d859f27). An empty
 * family builds a pattern with no FC_FAMILY term, which fontconfig matches
 * against everything and `IsFallbackFontAllowed` accepts — so on any host
 * with one valid font the FIRST rung terminates, and the later rungs are
 * defense-in-depth exactly as they are in Blink. Each rung is a
 * `kLastResort` lookup, and `FontMatchAliasesAsLastResort` is stable at the
 * tag, so each rung also gets the alias retry ("Arial" → "Helvetica").
 *
 * The first rung is descriptor state, not face state. Blink derives it from
 * `FontDescription::GenericFamily` even after every family/settings value has
 * been exhausted. `system-ui` and `math` do not occupy that legacy enum, so
 * they preserve an earlier legacy generic or leave it at `kNoFamily` (the
 * empty-name request). The later rungs are generic-independent.
 */
function linuxLastResortMatch(
  style: { weight: number; italic?: boolean; stretch?: number },
  genericFamily: BlinkGenericFamily,
): { match: LinuxFamilyMatch; acceptedFamily: string } | null {
  const initialFamily = skiaLastResortInitialFamily(genericFamily);
  for (const rung of [initialFamily, "Sans", "Arial", ""]) {
    const hit =
      rung === ""
        ? (() => {
            const m = resolveLinuxFamilyMatch("", style);
            return m != null ? { match: m, acceptedFamily: "" } : null;
          })()
        : linuxFamilyMatchWithAlternate(rung, style);
    if (hit != null) return hit;
  }
  return null;
}

/**
 * Memo for `linuxPrimaryCutKey`. A normal by-name selection is keyed only by
 * concrete key + style; an exhausted selection is additionally keyed by the
 * source-selected terminal family. Thus the generic descriptor can distinguish
 * the one decision it owns without contaminating the selected-face cache.
 */
export const linuxPrimaryCutCache = new Map<string, { key: string; italic: boolean } | null>();

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
 * → `SkFontConfigInterfaceDirect::matchFamilyName` (Skia rev 62efacd3, the
 * revision the local Chromium checkout's DEPS:330 pins at rev 7d859f27). The
 * transcription lives in the Linux glyph helper's `familyMatch` query;
 * `resolveLinuxFamilyMatch` is the Node call.
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
export function linuxPrimaryCutKey(
  key: string,
  weight: number,
  slant: number,
  stretch: number = 100,
  semanticContext: FontFallbackSemanticContext = createFontFallbackSemanticContext(),
): { key: string; italic: boolean } | null {
  if (hostPlatform() !== "linux" || !_systemFallbackResolutionEnabled || !isGlyphHelperAvailable()) return null;
  const declaredFamily = declaredFamilyForKey.get(key);
  if (declaredFamily == null && !DARWIN_DECLARED_FAMILY_KEYS.has(key)) return null;

  const italicRequested = slant !== 0;
  const primaryCacheKey = `${key}|${weight}|${italicRequested ? 1 : 0}|${stretch}`;
  if (linuxPrimaryCutCache.has(primaryCacheKey)) {
    return linuxPrimaryCutCache.get(primaryCacheKey)!;
  }
  const terminalFamily = skiaLastResortInitialFamily(semanticContext.genericFamily);
  const terminalCacheKey = `${primaryCacheKey}|terminal:${terminalFamily}`;
  if (linuxPrimaryCutCache.has(terminalCacheKey)) {
    return linuxPrimaryCutCache.get(terminalCacheKey)!;
  }

  let result: { key: string; italic: boolean } | null = null;
  let usedLastResort = false;
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
    let nominated = family != null ? linuxFamilyMatchWithAlternate(family, style) : null;
    if (nominated == null) {
      usedLastResort = true;
      nominated = linuxLastResortMatch(style, semanticContext.genericFamily);
    }
    if (nominated != null) {
      const match: LinuxFamilyMatch | null = nominated.match;
      const baseSpec = resolveFontSpec(key);
      const matchIsBaseFace =
        match != null &&
        baseSpec != null &&
        baseSpec.path === match.path &&
        (baseSpec.postscriptName == null || baseSpec.postscriptName === match.postscriptName);
      if (matchIsBaseFace) {
        // The style score picked the very face the key already resolves to.
        // An answer, not an abstention — same contract as the macOS matcher:
        // Blink runs no sibling table behind `matchFamilyName`, so the
        // caller's pre-seeded `-bold` sibling routing must be replaced by the
        // base face rather than left standing. (Null stays reserved for
        // "could not ask" — helper missing / flag off — where the sibling
        // table is the documented degraded tier.)
        result = { key, italic: match.italic };
      } else if (match != null && match.path !== "") {
        // The PostScript name selects the TTC member downstream (fontkit's
        // `getFont`); a face that declares none can only be addressed as the
        // file's first face, so only single-face files are adoptable then.
        const psName =
          match.postscriptName !== ""
            ? match.postscriptName
            : match.index === 0
              ? (match.path.split("/").pop() ?? match.path)
              : "";
        if (psName !== "") {
          // Registered under the `sysfb:` prefix like the macOS matcher's
          // answer — it is the same kind of key (an OS-discovered concrete
          // face), and `resolveFontSpec` serves dynamic registrations only for
          // the prefixes it knows.
          const cutKey = `sysfb:${psName}`;
          // The BASE key's extractor is preserved — this changes WHICH face is
          // opened, not how its outlines are read.
          registerDynamicSystemFont(
            cutKey,
            match.path,
            match.postscriptName !== "" ? match.postscriptName : psName,
            baseSpec?.extractor ?? "fontkit",
          );
          if (resolveFontSpec(cutKey) != null) result = { key: cutKey, italic: match.italic };
        }
      }
    }
  } catch {
    result = null;
  }
  linuxPrimaryCutCache.set(usedLastResort ? terminalCacheKey : primaryCacheKey, result);
  return result;
}

/** The family name recorded inside the file a key maps to, or null. */
export function fileFamilyNameForKey(key: string): string | null {
  const spec = resolveFontSpec(key);
  if (spec?.path == null || spec.path === "") return null;
  const fam = openFontkitFace(spec.path, { postscriptName: spec.postscriptName })?.face.familyName;
  return typeof fam === "string" && fam !== "" ? fam : null;
}

export function win32FamilyKey(family: string, css?: CssFallbackDescription): string | null {
  if (_win32FamilyKeyOverride != null) return _win32FamilyKeyOverride(family, css);
  const cacheKey =
    css == null
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

/** Keep the sampled Windows range only in degraded mode.
 *
 * The generated table is a snapshot of one host's DirectWrite answers, not a
 * Blink stage. Supported rendering runs Blink's hardcoded nomination above,
 * then live DirectWrite in `walkFontFallbackStages`; a DirectWrite miss reaches
 * the iterator terminal rather than consulting another machine's inventory.
 */
export function win32DeferOrStatic(fallback: string[]): string[] {
  // A sampled DirectWrite answer is never a supported-path fallback stage.
  // Blink asks its hardcoded family table (assembled above), then asks live
  // DirectWrite, then reaches the iterator terminal. The generated range is
  // retained only for helper-absent/explicitly-disabled best effort.
  if (
    hostPlatform() === "win32" &&
    _systemFallbackResolutionEnabled &&
    isGlyphHelperAvailable() &&
    isIcuHelperAvailable()
  ) {
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
 * The request-scoped `CssFallbackDescription.genericFamily` supplies
 * `FontDescription::GenericFamily()`, which changes an answer only through
 * `FindMonospaceFontForScript` (monospace + Arabic/Hebrew → Courier New).
 * Concrete face keys deliberately do not own that semantic: named Courier is
 * non-monospace, while a settings-mapped monospace generic may resolve to a
 * non-Courier key.
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
export function winFallbackPriority(
  cp: number,
  fve: FontVariantEmojiOverride | undefined,
): "text" | "emoji-text" | "emoji-emoji" {
  if (fve === "text" && isEmojiCharCp(cp)) return "emoji-text";
  if (fve === "emoji" && isEmojiCharCp(cp)) return "emoji-emoji";
  if (fve === "unicode" && isEmojiPresentationCp(cp)) return "emoji-emoji";
  if (isEmojiPresentationCp(cp)) return "emoji-emoji";
  return winFallbackPriorityForTextRun(cp);
}

// ── Skia's family-identity acceptance (the Linux helper-less tier) ──
//
// Transcribed from the DEPS-pinned Skia the pinned Chrome builds with
// (`62efacd3:src/ports/SkFontConfigInterface_direct.cpp`). `MatchFont`
// (`:553-590`) accepts fontconfig's pick for a named request iff one of the
// pick's family names (`FC_FAMILY` ids 0..254) equals — `strcasecmp`, i.e.
// byte-wise with ASCII case folding — the post-config-substitution request
// family or the requested family itself, or the REQUESTED and matched names
// share a metric-equivalence class (`IsMetricCompatibleReplacement`,
// `:330-336`, over the hardcoded `kFontEquivMap`, `:214-313`).
//
// The implementation this replaced canonicalized names by stripping `[-_ ]`
// and a trailing `regular|mt|psmt|ps|roman|book` — no upstream analogue, and
// wrong in both directions: it accepted names Skia rejects ("Arial MT"
// answered by Arial) and rejected names Skia accepts ("Times New Roman"
// answered by Liberation Serif on a Liberation-only host, a SERIF-class
// metric replacement).

/** `strcasecmp == 0`: byte comparison with ASCII-only case folding (C locale). */
function asciiCaseEqual(a: string, b: string): boolean {
  const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  return fold(a) === fold(b);
}

/** `kFontEquivMap`, verbatim (`62efacd3:src/ports/SkFontConfigInterface_direct.cpp:214-313`).
 *  ORDER IS LOAD-BEARING: `GetFontEquivClass` returns the first name match, so
 *  a name listed under two classes ("Noto Serif CJK JP" under PMINCHO and
 *  MINCHO) belongs to the FIRST — MS PMincho ↔ Noto Serif CJK JP are
 *  compatible, MS Mincho ↔ Noto Serif CJK JP are not, exactly as upstream. */
const SKIA_FONT_EQUIV_MAP: ReadonlyArray<readonly [clazz: string, name: string]> = [
  ["SANS", "Arial"],
  ["SANS", "Arimo"],
  ["SANS", "Liberation Sans"],
  ["SERIF", "Times New Roman"],
  ["SERIF", "Tinos"],
  ["SERIF", "Liberation Serif"],
  ["MONO", "Courier New"],
  ["MONO", "Cousine"],
  ["MONO", "Liberation Mono"],
  ["SYMBOL", "Symbol"],
  ["SYMBOL", "Symbol Neu"],
  ["PGOTHIC", "MS PGothic"],
  ["PGOTHIC", "ＭＳ Ｐゴシック"],
  ["PGOTHIC", "Noto Sans CJK JP"],
  ["PGOTHIC", "IPAPGothic"],
  ["PGOTHIC", "MotoyaG04Gothic"],
  ["GOTHIC", "MS Gothic"],
  ["GOTHIC", "ＭＳ ゴシック"],
  ["GOTHIC", "Noto Sans Mono CJK JP"],
  ["GOTHIC", "IPAGothic"],
  ["GOTHIC", "MotoyaG04GothicMono"],
  ["PMINCHO", "MS PMincho"],
  ["PMINCHO", "ＭＳ Ｐ明朝"],
  ["PMINCHO", "Noto Serif CJK JP"],
  ["PMINCHO", "IPAPMincho"],
  ["PMINCHO", "MotoyaG04Mincho"],
  ["MINCHO", "MS Mincho"],
  ["MINCHO", "ＭＳ 明朝"],
  ["MINCHO", "Noto Serif CJK JP"],
  ["MINCHO", "IPAMincho"],
  ["MINCHO", "MotoyaG04MinchoMono"],
  ["SIMSUN", "Simsun"],
  ["SIMSUN", "宋体"],
  ["SIMSUN", "Noto Serif CJK SC"],
  ["SIMSUN", "MSung GB18030"],
  ["SIMSUN", "Song ASC"],
  ["NSIMSUN", "NSimsun"],
  ["NSIMSUN", "新宋体"],
  ["NSIMSUN", "Noto Serif CJK SC"],
  ["NSIMSUN", "MSung GB18030"],
  ["NSIMSUN", "N Song ASC"],
  ["SIMHEI", "Simhei"],
  ["SIMHEI", "黑体"],
  ["SIMHEI", "Noto Sans CJK SC"],
  ["SIMHEI", "MYingHeiGB18030"],
  ["SIMHEI", "MYingHeiB5HK"],
  ["PMINGLIU", "PMingLiU"],
  ["PMINGLIU", "新細明體"],
  ["PMINGLIU", "Noto Serif CJK TC"],
  ["PMINGLIU", "MSung B5HK"],
  ["MINGLIU", "MingLiU"],
  ["MINGLIU", "細明體"],
  ["MINGLIU", "Noto Serif CJK TC"],
  ["MINGLIU", "MSung B5HK"],
  ["PMINGLIUHK", "PMingLiU_HKSCS"],
  ["PMINGLIUHK", "新細明體_HKSCS"],
  ["PMINGLIUHK", "Noto Serif CJK TC"],
  ["PMINGLIUHK", "MSung B5HK"],
  ["MINGLIUHK", "MingLiU_HKSCS"],
  ["MINGLIUHK", "細明體_HKSCS"],
  ["MINGLIUHK", "Noto Serif CJK TC"],
  ["MINGLIUHK", "MSung B5HK"],
  ["CAMBRIA", "Cambria"],
  ["CAMBRIA", "Caladea"],
  ["CALIBRI", "Calibri"],
  ["CALIBRI", "Carlito"],
];

/** `GetFontEquivClass`: the FIRST map entry whose name strcasecmp-matches, or
 *  null (upstream's `OTHER`). */
function skiaFontEquivClass(name: string): string | null {
  for (const [clazz, n] of SKIA_FONT_EQUIV_MAP) if (asciiCaseEqual(n, name)) return clazz;
  return null;
}

/** `IsMetricCompatibleReplacement` (`:330-336`): same non-OTHER class. */
function skiaMetricCompatibleReplacement(a: string, b: string): boolean {
  const ca = skiaFontEquivClass(a);
  return ca != null && ca === skiaFontEquivClass(b);
}

/**
 * `MatchFont`'s acceptable-substitute walk (`:567-587`), factored pure so the
 * rule can be unit-tested without fontconfig. Exported for tests only (not in
 * the package barrel).
 */
export function skiaFamilyMatchAcceptable(
  requestedFamily: string,
  postConfigFamily: string,
  matchFamilies: readonly string[],
): boolean {
  for (const mf of matchFamilies) {
    if (
      asciiCaseEqual(postConfigFamily, mf) ||
      asciiCaseEqual(requestedFamily, mf) ||
      skiaMetricCompatibleReplacement(requestedFamily, mf)
    )
      return true;
  }
  return false;
}

/** All family names fontconfig's pick declares (`FC_FAMILY`, every id), the
 *  set Skia walks in `MatchFont`. */
function fcMatchFamilies(name: string): string[] | null {
  try {
    const out = execFileSync("fc-match", ["-f", "%{family}", name], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out.split(",");
  } catch {
    return null;
  }
}

/** The request family AFTER config substitution — what Skia reads back as
 *  `post_config_family` (`:655-659`) having run `FcConfigSubstitute` +
 *  `FcDefaultSubstitute` (`:623-624`), which `fc-pattern -c` reproduces. This
 *  clause is what accepts a user/distro alias (an `Arial` → `Liberation Sans`
 *  preference rewrites the pattern, so the pick equals the post-config name
 *  even where it equals neither the request nor an equivalence class). Falls
 *  back to the requested name when `fc-pattern` is unavailable — clauses two
 *  and three still decide. */
function fcPostConfigFamily(name: string): string | null {
  try {
    const out = execFileSync("fc-pattern", ["-c", "-f", "%{family[0]}", name], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

export function __authorFamilyAvailableForTest(name: string): boolean {
  // Availability is an answer from a platform font environment, not a
  // property of the spelling alone. Tests and oracle replays can switch the
  // modeled host in-process; sharing a bare-name entry across those contexts
  // made the first platform queried win for every later platform.
  const cacheKey = `${hostPlatform()}\u0000${name}`;
  const cached = _famAvailCache.get(cacheKey);
  if (cached != null) return cached;
  let avail: boolean;
  if (resolveInstalledFont(name) != null) {
    avail = true; // native helper (macOS/Windows) found the exact family
  } else if (hostPlatform() === "linux") {
    const fams = fcMatchFamilies(name);
    avail = fams != null && skiaFamilyMatchAcceptable(name, fcPostConfigFamily(name) ?? name, fams);
  } else {
    avail = false;
  }
  _famAvailCache.set(cacheKey, avail);
  return avail;
}

const authorFamilyAvailable = __authorFamilyAvailableForTest;

/** Test-only view: availability memo identities, without exposing answers. */
export function __familyAvailabilityCacheKeysForTest(): string[] {
  return [..._famAvailCache.keys()].sort();
}

/** Materialize the concrete face Chromium reported for a session setting.
 * Prefer this over sending a PostScript name back through the curated family
 * table: that table intentionally collapses families, while the browser has
 * already completed style selection and told us the exact cut. */
function sessionProbedFaceKey(faceName: string): string | null {
  const installed = resolveInstalledFont(faceName);
  if (installed == null || installed.path === "" || installed.postscriptName === "") return null;
  const key = `sysfb:${installed.postscriptName}`;
  registerDynamicSystemFont(
    key,
    installed.path,
    installed.postscriptName,
    "native",
    installed.resolvedAxes,
    installed.ctAxes,
  );
  if (installed.familyName !== "" && !installed.familyName.startsWith(".")) {
    declaredFamilyForKey.set(key, installed.familyName);
  }
  return key;
}

/** A dot-prefixed macOS probe answer is a CoreText FALLBACK face, not a
 * declared-family setting. Blink refuses these names in
 * `FontCache::CreateFontPlatformData` (`IsSystemFontName` → nullptr), then
 * reaches the face only through `CTFontCreateForString` from the current
 * primary. Preserve that stage boundary by replaying the captured Common
 * generic as the primary; the ordinary fallback resolver can then ask
 * CoreText from the same base Chrome used. */
function sessionScriptPrimaryFace(scriptFace: string, settingsName: string): string {
  if (hostPlatform() !== "darwin" || !scriptFace.startsWith(".")) return scriptFace;
  return sessionGenericFamilyOverrides?.common.get(settingsName) ?? scriptFace;
}

function sessionScriptFaceIsFallbackOwned(name: string, generic: boolean, lang?: string): boolean {
  if (!generic || lang == null || hostPlatform() !== "darwin") return false;
  const script = localeToScriptCodeForFontSelection(lang);
  return (
    sessionGenericFamilyOverrides?.byScript.get(script)?.get(genericSettingsFamilyName(name))?.startsWith(".") === true
  );
}

// ── Session generic-family overrides (live browser authority) ──
// The concrete family behind a CSS generic keyword is a property of the
// LAUNCHED browser session, not of Chromium's source: Playwright applies its
// own vendored per-platform table via CDP `Page.setFontFamilies` to every
// non-headful launch (`playwright-core/lib/server/chromium/crPage.js`,
// `_setDefaultFontFamilies`), overriding blink's `WebPreferences` constructor
// defaults (`third_party/blink/common/web_preferences/web_preferences.cc:25-41`,
// rev 7d859f27); headed launches skip that and get the full binary's chrome
// prefs layer (`locale_settings_<platform>.grd`) instead. Capture serializes
// the exact Page's painted faces on its tree; `elementTreeToSvgInner` scopes
// those answers here for that one synchronous render. The calibrated static
// routes below are only the explicit/failure/legacy-tree fallback.
const SESSION_PROBED_GENERICS = new Set(["standard", "serif", "sans-serif", "monospace", "cursive", "fantasy", "math"]);

export interface SessionGenericFamilyOverrides {
  common: ReadonlyMap<string, string>;
  /** UScriptCode name → generic keyword → painted family. */
  byScript: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

let sessionGenericFamilyOverrides: SessionGenericFamilyOverrides | null = null;

/** Explicit oracle/compatibility override. Production captured trees use
 *  `withSessionGenericFamilyOverrides` instead, so independently captured
 *  Pages never share this process-global slot. */
export function setSessionGenericFamilyOverrides(overrides: SessionGenericFamilyOverrides | null): void {
  sessionGenericFamilyOverrides = overrides;
}

/** Test/introspection accessor for the installed session overrides. */
export function getSessionGenericFamilyOverrides(): SessionGenericFamilyOverrides | null {
  return sessionGenericFamilyOverrides;
}

/** Select captured page settings only for one synchronous render. Saving and
 * restoring the prior explicit/oracle setting makes independently captured
 * trees order-independent. Async/Promise-like callbacks are rejected at the
 * type boundary and at runtime rather than escaping this process-global scope
 * across an `await` (DM-2637). */
export function withSessionGenericFamilyOverrides<F extends () => unknown>(
  overrides: SessionGenericFamilyOverrides,
  render: SynchronousCallback<F>,
): ReturnType<F> {
  const previous = sessionGenericFamilyOverrides;
  sessionGenericFamilyOverrides = overrides;
  try {
    return invokeSynchronousCallback("withSessionGenericFamilyOverrides", render);
  } finally {
    sessionGenericFamilyOverrides = previous;
  }
}

/** Blink aliases both legacy WebKit standard-family spellings to one setting. */
export function genericSettingsFamilyName(name: string): string {
  return name === "-webkit-standard" || name === "-webkit-body" ? "standard" : name;
}

/**
 * `generic`: whether this occurrence of `name` is a CSS `<generic-family>`
 * KEYWORD (unquoted, canonical lowercase — see `splitFontFamilyNames`) rather
 * than a literal family name that shares the spelling. Blink keeps the two
 * apart end-to-end: a quoted `"monospace"` never reaches
 * `FamilyNameFromSettings`' settings substitution
 * (`platform/fonts/font_selector.cc:25-32`, rev 7d859f27) and is looked up as
 * an ordinary family — not installed on macOS/win32, so the walk continues to
 * the next declared name (`font-family: "monospace", Menlo` paints Menlo, not
 * Courier). Every generic-keyword route below is therefore gated on this bit.
 * The default classifies a bare lower-case spelling as the keyword, matching
 * the pre-existing single-name callers (probes, tests, head-name comparisons).
 */
function matchFamilyCandidateToKey(
  name: string,
  generic: boolean = BLINK_GENERIC_FAMILY_SPELLINGS.has(name),
  lang?: string,
  canonicalSystemUiName: boolean = name === "system-ui",
  lookupName: string = name,
  description: DarwinFontDescription = DARWIN_INITIAL_FONT_DESCRIPTION,
): string | null {
  if (name === "" || name === "doesnotexist") return null;
  const settingsName = genericSettingsFamilyName(name);
  // ── Per-script generic-family settings (Playwright forScripts, mac/win) ──
  // Blink keys every settings-mapped generic on the run's content script:
  // `FamilyNameFromSettings` consults `settings.<Generic>(script)` with
  // `font_description.GetScript()` (`font_selector.cc:72-91`, rev 7d859f27),
  // and the capture session's per-script maps are Playwright's `forScripts`
  // entries (mac: jpan/hang/hans/hant; win: +cyrl/arab/grek; linux: none) —
  // see `src/render/generic-script-families.ts` for the full transcription
  // chain (locale → UScriptCode → settings entry → FirstAvailableOrFirst).
  // A per-script entry EXISTS: nominate its family — resolve it as a literal
  // name, and when it does not resolve on this host return null so the stack
  // walks on, exactly as a failed typeface creation does in Blink. No entry:
  // fall through to the Common-script routes below
  // (`generic_font_family_settings.cc:105-107`). Ordered ahead of the
  // session probe's Common answer. A probed answer for this exact script wins
  // over the static transcription because it includes live host availability
  // and substitution.
  if (generic && lang != null) {
    const script = localeToScriptCodeForFontSelection(lang);
    const probed = sessionGenericFamilyOverrides?.byScript.get(script)?.get(settingsName);
    if (probed != null) {
      const primary = sessionScriptPrimaryFace(probed, settingsName);
      const exact = sessionProbedFaceKey(primary);
      if (exact != null) return exact;
      const key = matchFamilyNameToKey(primary.toLowerCase(), false, undefined, undefined, undefined, description);
      if (key != null) return key;
    }
    const scriptValue = perScriptGenericFamily(hostPlatform(), lang, name);
    if (scriptValue != null) {
      const first = firstAvailableOrFirst(scriptValue, (fam) => authorFamilyAvailable(fam));
      if (first !== "") {
        // Blink looks the settings value up as a PLAIN family name, so probe
        // the exact installed family first — the curated arms must not
        // re-route it to a calibrated sibling. Measured: Chrome paints
        // HiraKakuProN-W3 for lang=ja sans-serif (the literal "Hiragino Kaku
        // Gothic ProN" family), where the curated "hiragino-jp" key carries
        // the Hiragino SANS faces — 215/215 oracle rows moved on that one
        // difference. The registration mirrors the uncurated tail below.
        const installed = resolveInstalledFont(first);
        if (installed != null) {
          const key = `sysfb:${installed.postscriptName}`;
          registerDynamicSystemFont(
            key,
            installed.path,
            installed.postscriptName,
            "native",
            installed.resolvedAxes,
            installed.ctAxes,
          );
          if (hostPlatform() === "darwin" && installed.familyName !== "" && !installed.familyName.startsWith(".")) {
            declaredFamilyForKey.set(key, installed.familyName);
          }
          return key;
        }
        // Degraded tier (no native helper): fall back to the curated arms so
        // the nominated family still lands on the closest calibrated face.
        const firstLower = first.toLowerCase();
        if (firstLower !== name)
          return matchFamilyNameToKey(firstLower, false, undefined, undefined, undefined, description);
      }
      return null;
    }
  }
  // Session-probed generic route (see setSessionGenericFamilyOverrides): when
  // the capture session has been asked what it paints for a generic keyword,
  // route the keyword to that family. The probed name is a concrete platform
  // family (never a generic keyword), so the recursion is single-step; if it
  // doesn't resolve to a key on this host, fall through to the static routes.
  // Quoted spellings are literal family names, so they bypass this route.
  if (generic && sessionGenericFamilyOverrides != null && SESSION_PROBED_GENERICS.has(settingsName)) {
    const probed = sessionGenericFamilyOverrides.common.get(settingsName);
    if (probed != null) {
      const exact = sessionProbedFaceKey(probed);
      if (exact != null) return exact;
      const probedName = probed.toLowerCase();
      if (probedName !== name) {
        const key = matchFamilyNameToKey(probedName, undefined, undefined, undefined, undefined, description);
        if (key != null) return key;
      }
    }
  }
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
  // `familyMatch` transcription, Skia rev 62efacd3); on rejection the cache
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
  // The settings-mapped generic keywords go through the SAME walk, after
  // `FontSelector::FamilyNameFromSettings` (`font_selector.cc:73-91`, rev
  // 7d859f27) swaps in the browser-side settings value — Playwright's
  // vendored table in the capture session (equal to the grd defaults on
  // Linux), see `LINUX_GENERIC_FAMILY_DEFAULTS`. A settings value the matcher
  // REJECTS ("Comic Sans MS" / "Impact" on the noble image, where
  // fontconfig offers WenQuanYi Zen Hei and the acceptance filter refuses
  // it) makes the family unavailable, exactly like a rejected author name:
  // return null, the caller continues the declared stack, and an exhausted
  // stack terminates at `resolveFontKey`'s standard-family terminal
  // (`times` → "Times New Roman" → Liberation Serif on the image) — never
  // at "no font at all". `system-ui` stays excluded: its concrete family
  // comes from `FontCache::SystemFontFamily()`, not a grd setting, so it
  // remains on the measured static route (un-transcribed in doc 110).
  // Gated like the rest of the live Linux resolver (helper +
  // DOMOTION_SYSTEM_FALLBACK), degrading to the calibrated tables when
  // disarmed — including when the helper predates the `familyMatch` query
  // (the armed probe), since a walk that cannot ask the matcher must not
  // declare rejections. Only the generic KEYWORD gets the settings
  // substitution: a quoted `"cursive"` is a literal family name Blink
  // nominates verbatim. `system-ui` stays off the walk in BOTH spellings —
  // Blink's intercept is keyed on the family NAME, not the generic bit
  // (`GetFontPlatformData` routes `creation_params.Family() ==
  // font_family_names::kSystemUi` to `SystemFontPlatformData` before any
  // fontconfig lookup, `platform/fonts/font_cache.cc:161-166`, rev
  // 7d859f27), so a quoted `"system-ui"` resolves the platform UI font
  // exactly like the keyword. Verified against the live oracle: Chrome
  // paints .SFNS-Regular for `font-family: "system-ui", Georgia` on macOS.
  if (name !== "system-ui" && linuxNominationWalkArmed()) {
    const nominated = generic ? (LINUX_GENERIC_FAMILY_DEFAULTS.get(name) ?? name) : name;
    const walked = linuxFamilyMatchWithAlternate(nominated, { weight: 400 });
    if (walked == null) return null; // Chrome walks past this family
    const { match, acceptedFamily } = walked;
    // The PostScript name selects the TTC member downstream; a face that
    // declares none can only be addressed as the file's first face. An
    // unaddressable face falls THROUGH to the calibrated tables rather
    // than dropping a family Chrome would paint.
    const psName =
      match.postscriptName !== ""
        ? match.postscriptName
        : match.index === 0
          ? (match.path.split("/").pop() ?? match.path)
          : "";
    if (psName !== "") {
      const key = `sysfb:${psName}`;
      registerDynamicSystemFont(
        key,
        match.path,
        match.postscriptName !== "" ? match.postscriptName : psName,
        "fontkit",
      );
      // Two requested spellings can accept onto the same face (e.g.
      // "Arial" directly and "Helvetica" via its alias) — they then agree
      // on the accepted spelling, or land on the same family's cuts, so
      // the last write is safe.
      declaredFamilyForKey.set(key, acceptedFamily);
      return key;
    }
  }
  // The capture harness's `monospace` resolves to Courier because PLAYWRIGHT
  // says so, not Chromium. Identified end-to-end (previously "unidentified"):
  // Playwright applies its own vendored per-platform generic-family table to
  // every non-headful page via CDP `Page.setFontFamilies`
  // (`playwright-core/lib/server/chromium/crPage.js`,
  // `_setDefaultFontFamilies`, gated on `!options.headful`;
  // `defaultFontFamilies.js` — mac: standard/serif "Times", fixed "Courier",
  // sans-serif "Helvetica", cursive "Apple Chancery", fantasy "Papyrus", no
  // math key, plus per-script jpan/hang/hans/hant entries). That call
  // overrides the browser's own layer, which is otherwise:
  //
  //     kMonospaceFamily
  //       -> font_family_names::kMonospace          (font_builder.cc:90-91)
  //       -> FontSelector::FamilyNameFromSettings   -> settings.Fixed(script)
  //       -> headless shell: WebPreferences constructor defaults ONLY
  //          (web_preferences.cc:25-41, rev 7d859f27 — fixed "Menlo" on mac;
  //          headless/lib has zero font-preference code)
  //       -> full binary + chrome prefs layer: IDS_FIXED_FONT_FAMILY
  //          (prefs_tab_helper.cc:149, locale_settings_mac.grd — "Menlo")
  //
  // Measured in the harness's own launch path (headless shell, Chromium
  // 147.0.7727.15): monospace paints Courier — Playwright's table, matching
  // NEITHER Chromium layer (both say Menlo on mac). Mapping this to Menlo
  // was tried and measured (5,031,450-comparison conformance slice) at
  // **+35,583 mismatches**, 3.354% -> 4.062%, and reverted — the oracle's
  // Chrome runs under Playwright's table too.
  //
  // The earlier "Chrome's generics differ BY MACHINE" observation (this Mac
  // Courier / Helvetica / Times, CI runner sometimes Menlo / Arial / Times
  // New Roman, all three shifting together) is the same mechanism: the CI
  // states are exactly (a) Playwright's table applied vs (b) the
  // WebPreferences constructor defaults showing through when the CDP
  // `Page.setFontFamilies` -> renderer pref update loses the race against
  // first layout on a loaded runner (see tools/probe-sans-serif-flip.mjs —
  // its two recorded flip states are byte-exact these two tables). Static
  // routes here therefore encode only the degraded applied-table state; the
  // default-on session probe asks the live session instead.
  //
  // For author-named monospaces we map to whatever the author asked for if
  // we have it on disk; SF Mono is only used when explicitly requested.
  //
  // `Consolas` gets NO pin: Blink looks the name up like any other family —
  // it has no `AlternateFamilyName` alias (`alternate_font_family.h:72-105`,
  // rev 7d859f27) — so when it isn't installed Chrome walks PAST it to the
  // next family in the stack (`Consolas, Menlo, monospace` paints Menlo, not
  // Courier). When it IS installed (an MS Office Mac, or any Windows host),
  // the `resolveInstalledFont` tail below matches it exactly like Chrome
  // does. The old "fidelity-of-intent" pin to Courier painted a face Chrome
  // never picks on either kind of host.
  //
  // `ui-monospace` is NOT recognized by Chrome on macOS (DM-269 probe:
  // painted T width = 9.77, q = 8.0 — same as Times, not Courier or SF
  // Mono). Chrome falls through to the standard-font default (Times). It
  // intentionally falls through here so the last-resort `times` mapping
  // at the bottom catches it.
  if ((generic && name === "monospace") || name === "courier") return "courier";
  // `Courier New` is its own installed face (Supplemental on macOS, cour.ttf
  // on Windows, fontconfig's Liberation Mono metric substitute on Linux) and
  // Chrome resolves the name DIRECTLY when the lookup succeeds. The Courier
  // alias fires only on lookup FAILURE — the retry lives in
  // `FontPlatformDataCache::GetOrCreateFontPlatformData`
  // (`font_platform_data_cache.cc:74-105`, rev 7d859f27), and the New→plain
  // direction of `AlternateFamilyName` is `!IS_WIN`
  // (`alternate_font_family.h:78-85`) — so the alias must not pre-empt a
  // successful match. Mirror both halves: the dedicated key when the face
  // resolves on this host, the platform-correct failure path otherwise.
  if (name === "courier new") {
    const spec = resolveFontSpec("courier-new");
    if (spec?.path != null && spec.path !== "" && existsSync(spec.path)) return "courier-new";
    return hostPlatform() === "win32" ? null : "courier";
  }
  if (name === "menlo") return authorFamilyAvailable("Menlo") ? "menlo" : null;
  if (name === "monaco") return authorFamilyAvailable("Monaco") ? "monaco" : null;
  if (name === "sf mono" || name === "sfmono-regular" || name === "sf-mono") {
    return authorFamilyAvailable("SF Mono") ? "sf-mono" : null;
  }
  // `Times New Roman` resolves to the Microsoft TNR face (separate file from
  // Apple's Times.ttc); bare `Times` / `serif` / the UA default resolve to
  // Apple Times (DM-330). The two have identical metrics but visibly
  // different em-dash glyphs in bold weights. (`ui-serif` is NOT here: it is
  // an unrecognized name Chrome walks past — see the null-return list below.)
  if (name === "times new roman") return "times-new-roman";
  if ((generic && name === "serif") || name === "times") return "times";
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
  // generic `serif` keyword stays Songti. Like every author-named family, the
  // name must actually resolve on the modeled host. The old unconditional
  // logical-key mapping made a missing macOS family become SimSun on Windows,
  // pre-empting both the following CSS `serif` family and Blink's hardcoded
  // Windows fallback stage. Chromium instead walks past the missing name;
  // Han is then nominated from the locale-dependent Microsoft YaHei list and
  // kana from the Japanese Yu Gothic list (`FontFallbackIterator::Next` and
  // `GetFallbackFamilyNameFromHardcodedChoices`, Chromium rev 7d859f27).
  if (
    name === "hiragino mincho pron" ||
    name === "hiragino mincho pro" ||
    name === "hiragino mincho" ||
    name === "ヒラギノ明朝 pron" ||
    name === "hiraminpron" ||
    name === "hiraminpro"
  ) {
    return authorFamilyAvailable(lookupName) ? "hiragino-mincho" : null;
  }
  // Chrome on macOS resolves the CSS `cursive` generic keyword to Apple
  // Chancery (per the empirical probe — bare `cursive` paints at exactly
  // Apple Chancery's advance, NOT Snell Roundhand's, on macOS Sonoma+).
  // Author-named "Snell Roundhand" / "Brush Script MT" still get their
  // explicit families.
  if ((generic && name === "cursive") || name === "apple chancery") return "apple-chancery";
  if (name === "snell roundhand" || name === "brush script mt") return "snell";
  // Chrome on macOS resolves the CSS `fantasy` generic to Papyrus
  // (empirical probe: 313.94px = Papyrus's exact advance on the sample).
  //
  // Both keys are LOGICAL and resolve per platform through the three path
  // tables — on Windows `apple-chancery` is `comic.ttf` and `papyrus` is
  // `impact.ttf`, which are Chrome's Windows defaults. The macOS-flavoured
  // key names are a naming wart, not a routing one.
  if ((generic && name === "fantasy") || name === "papyrus") return "papyrus";
  // DM-1189 / DM-1199 / DM-1196 / DM-1183: `Helvetica Neue` is its OWN face,
  // NOT plain Helvetica. Verified with Chrome's `getPlatformFontsForNode`:
  // `font-family: 'Helvetica Neue'` paints from Helvetica Neue (HelveticaNeue.ttc),
  // while `sans-serif`/`Helvetica` paint from Helvetica (Helvetica.ttc). The two
  // differ (e.g. the bold U+212E ℮, the script U+2113 ℓ, archaic Latin/Cyrillic),
  // so collapsing them lost those glyphs. Map it to its own key.
  if (name === "helvetica neue" || name === "helveticaneue") {
    return authorFamilyAvailable("Helvetica Neue") ? "helvetica-neue" : null;
  }
  // Chrome on macOS resolves the generic `sans-serif` keyword (and a literal
  // `Helvetica`) to Helvetica (Blink: font_cache_mac.mm + font_fallback_list.cc
  // — the generic is hardcoded to Helvetica on macOS, not SF Pro). Matching this
  // exactly is critical: SF Pro has different glyph shapes (notably the `1`, `R`,
  // `g`) and ~2% wider metrics than Helvetica at the same em size, so substituting
  // it produces visible drift on every page that uses the default sans-serif.
  if ((generic && name === "sans-serif") || name === "helvetica") return "helvetica";
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
  // `system-ui` on Linux comes from the browser's RendererPreferences, not
  // the generic-family settings. In Domotion's supported headless launch,
  // `RenderViewHostImpl::GetPlatformSpecificPrefs` reads
  // `gfx::Font().GetFontName()`. With no LinuxUi installed, PlatformFontSkia
  // starts from its source-defined fallback family "sans" and resolves that
  // name live through the host's Skia/fontconfig manager. Ask that identical
  // host-dependent question here; do not freeze the painted Latin cut from a
  // probe, because it does not carry the UI family's fallback behavior.
  //
  // Deliberately NO walk-past branch for an unresolvable system-ui. Blink
  // does have one — `FontCache::SystemFontPlatformData` returns
  // nullptr when the browser-side system font family is empty or literally
  // "system-ui", and the stack walks on — but that return is inside
  // `#if !BUILDFLAG(IS_MAC)` and further gated to
  // IS_LINUX/IS_CHROMEOS/IS_FUCHSIA/IS_IOS (`platform/fonts/
  // font_cache.cc:139-152`, rev 7d859f27; on win32 the same condition is a
  // DCHECK, i.e. assumed unreachable, and macOS resolves system-ui in
  // font_cache_mac.mm and never takes this path). So a walk-past on darwin
  // or win32 would CONTRADICT Blink. On Linux the branch exists but the
  // measured capture environment never fires it — the runner's paint for
  // `system-ui, sans-serif` is WenQuanYi (the system-ui answer itself),
  // not the next declared family, so its system font family is non-empty —
  // and the VALUE that would decide it is browser-side and un-transcribed.
  //
  // The platform matcher dispatches the exact canonical NAME `system-ui`,
  // independently of the generic bit: quoted `"system-ui"` therefore takes
  // the system-font route on every platform. The comparison itself remains
  // case-sensitive (`AtomicString`): `"System-ui"` is an ordinary literal
  // family and must walk on. `splitFontFamilyNames` preserves that one bit
  // before lower-casing names for ordinary case-insensitive family lookup.
  if (name === "system-ui" && canonicalSystemUiName) {
    if (hostPlatform() === "darwin") warmDarwinSystemUiAlias(description);
    if (hostPlatform() === "linux" && _systemFallbackResolutionEnabled) {
      const matched = fcMatch("sans");
      if (matched != null) {
        const psName = matched.postscriptName ?? matched.path.split("/").pop() ?? "system-ui";
        const key = `sysfb:${psName}`;
        registerDynamicSystemFont(key, matched.path, matched.postscriptName ?? psName, "fontkit");
        // Preserve the browser-supplied fontconfig question beside the
        // dynamic key. Otherwise `linuxPrimaryCutKey` treats `sysfb:*` as an
        // already-final fallback face and never re-asks for bold/italic/
        // stretch cuts; alternate inventories then keep their regular UI
        // face where Chromium selects (for example) DejaVuSans-Bold.
        declaredFamilyForKey.set(key, "sans");
        return key;
      }
    }
    return "sf-pro";
  }
  if (name === "system-ui" && hostPlatform() === "darwin" && hasWarmDarwinSystemUiAlias(description)) {
    return "sf-pro";
  }
  // `BlinkMacSystemFont` is rewritten to `system-ui` only on macOS — the
  // rewrite in `StyleBuilderConverterBase::ConvertFontFamilyName` is
  // `#if BUILDFLAG(IS_MAC)` (`core/css/resolver/style_builder_converter.cc:552-563`,
  // rev 7d859f27). Off macOS it is an ordinary family name no host installs,
  // so Chrome walks past it to the next family in the stack —
  // `BlinkMacSystemFont, Georgia` paints Georgia on win32, not Segoe UI.
  // (The canonical `-apple-system, BlinkMacSystemFont, "Segoe UI", …` stack
  // hid this: it converges on the same answer either way.)
  if (name === "blinkmacsystemfont") {
    return hostPlatform() === "darwin" ? "sf-pro" : null;
  }
  if (name === "sf pro") return "sf-pro";
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
  // ground truth. The calibrated candidate is still `sf-pro`; the generic
  // exact-descriptor preservation in `matchFamilyNameToKey` subsequently
  // replaces it with the installed static member Chromium returned.
  // This nomination holds ONLY when the named family actually resolves on
  // THIS machine. Chrome can paint "SF Pro Text" (from its SFNS system cut)
  // only if the font is installed; on a stock macOS install / the GitHub CI
  // runner without Apple's downloadable `/Library/Fonts/SF-Pro-*.otf`, Chrome
  // cannot resolve the name and falls THROUGH to the next CSS family. Mapping
  // it to `sf-pro` (SFNS, always present) there would paint a face Chrome
  // never uses — the root of a pervasive CI-macOS divergence where the "SF Pro
  // Text"-stack fixtures had CI-Chrome fall to Helvetica while Domotion jumped
  // to SFNS (verified: the runner ships SFNS.ttf but no SF-Pro-*.otf; the comma
  // is straight in SFNS vs curved in Chrome's fallback). Mirror Chrome: return
  // `sf-pro` as the calibrated seed when the named font resolves, else null
  // so the stack walk continues. DM-2422's post-check preserves the exact
  // `SFProText-Regular` / `SFProDisplay-Regular` descriptor when installed.
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
  if (
    name === "hiragino sans" ||
    name === "hiragino kaku gothic pron" ||
    name === "hiragino kaku gothic pro" ||
    name === "ヒラギノ角ゴシック" ||
    name === "hiragino maru gothic pron"
  ) {
    return authorFamilyAvailable("Hiragino Sans") ? "hiragino-jp" : null;
  }
  // Names Chrome WALKS PAST, for two different reasons:
  //
  // (a) `ui-monospace`, `ui-serif`, `ui-sans-serif`, `ui-rounded`, `emoji`,
  // `fangsong` are NOT keywords to Chrome at all: none is in Blink's
  // `<generic-family>` block (`css_value_keywords.json5:173-181`, rev
  // 7d859f27) and `ConsumeGenericFamily` only spans serif..math
  // (`css_parsing_utils.cc:6344-6346`), so Chrome treats each as an
  // uninstalled family name and walks past it to the next name in the
  // stack. DM-269 probe confirmed bare `ui-monospace` paints with Times
  // metrics (q=8.0, T=9.77), but `ui-monospace, Menlo, monospace` paints in
  // Menlo — proving Chrome doesn't pin these keywords, it skips them.
  // (DM-302: textarea code editor used `font: ui-monospace, Menlo, …` and
  // we wrongly pinned to Times, painting code in a serif face. `ui-serif`
  // had the same defect until it moved here: a probe of BARE `ui-serif`
  // painting Times metrics cannot discriminate a pin from
  // skip-then-terminal — only a stack with a later family can, and there
  // Chrome paints the later family.)
  //
  // (b) `math` IS a Blink generic (`settings.Math(script)`,
  // `font_selector.cc:88-90`, rev 7d859f27) — but in the capture session
  // its settings value is the `WebPreferences` constructor default "Latin
  // Modern Math" (`web_preferences.cc:41`; Playwright's
  // `Page.setFontFamilies` table carries no math key, so the constructor
  // value survives). That family is not installed on any calibrated host
  // (this class of Mac, the noble container, the CI runners), so Chrome's
  // lookup fails and the stack walks on — measured in the harness's own
  // launch path: bare `math` paints Times on macOS, Liberation Serif on
  // Linux, both the standard-family terminal. Returning null reproduces
  // exactly that. Do NOT route `math` to `stix-math`: STIX Two Math is
  // what the HEADED full Chrome binary's prefs layer picks, not our render
  // target, and routing it measured as a conformance regression. (A host
  // that HAS Latin Modern Math installed would paint it; only the session
  // live session probe gets that case right.)
  //
  // Either way: `continue` past them so the rest of the stack (Menlo,
  // monospace, …) gets a chance to match; the last-resort `times` at the
  // bottom of this function catches the no-match case.
  if (
    name === "ui-monospace" ||
    name === "ui-serif" ||
    name === "ui-rounded" ||
    name === "ui-sans-serif" ||
    name === "math" ||
    name === "emoji" ||
    name === "fangsong" ||
    name === "-apple-system"
  )
    return null;
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
  // Blink does not ask CoreText whether a family name resolves to a face and
  // then verify that face's returned family name. It asks MatchFontFamily,
  // whose first operation on macOS is AppKit's
  // `availableMembersOfFontFamily` (case-insensitive) followed by Blink's
  // family-member comparator (`font_matcher_mac.mm:599-765`, rev 7d859f27).
  // Those questions differ for aliases/hidden families. In particular, on
  // the macOS CI image AppKit accepts the ordinary literal family
  // `System-ui` and returns .SFNS-Regular, while CTFont reports the resolved
  // family as `.SF NS`; the old identity check rejected it and walked to
  // Menlo. Ask the already-transcribed family matcher first, then open its
  // chosen PostScript face. If AppKit has no members, preserve the existing
  // exact-name probe as the degraded/unique-name path.
  const darwinFamilyMatch =
    hostPlatform() === "darwin"
      ? resolveFamilyStyleMatch(lookupName, { weight: 400, italic: false, stretch: 100 })
      : null;
  // AppKit can hand Blink a protected system-font member that CoreText will
  // not let another client reopen by its dot-prefixed PostScript name. Blink
  // keeps that NSFont/CTFont handle; our equivalent is the existing SFNS file
  // key. Keep `stackPrimaryIsSystemUi` false for this route: it came through
  // MatchFontFamily, not MatchSystemUIFont, even though both selected SFNS.
  if (darwinFamilyMatch?.postscriptName.startsWith(".SFNS-") === true) {
    return "sf-pro";
  }
  const installed =
    darwinFamilyMatch != null
      ? resolveInstalledFont(darwinFamilyMatch.postscriptName)
      : resolveInstalledFont(lookupName);
  if (installed != null) {
    const key = `sysfb:${installed.postscriptName}`;
    // DM-1721: `resolvedAxes` carries DirectWrite's pinned axis values for
    // variable-face matches (e.g. "Segoe UI Variable Text" → opsz 10.5 at
    // every size) so the hinted-subset pin embeds the instance Chrome paints.
    // On macOS `ctAxes` carries the CoreText handle's own position instead.
    registerDynamicSystemFont(
      key,
      installed.path,
      installed.postscriptName,
      "native",
      installed.resolvedAxes,
      installed.ctAxes,
    );
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
  // when fontconfig genuinely HAS the family (`authorFamilyAvailable` grades
  // the `fc-match` result with Skia's own acceptance rule — strcasecmp plus
  // the metric-equivalence classes — so a fontconfig SUBSTITUTE for a miss
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
        registerDynamicSystemFont(
          key,
          installedAdj.path,
          installedAdj.postscriptName,
          "native",
          installedAdj.resolvedAxes,
        );
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

/** One family-stack candidate to its logical platform key. */
export function matchFamilyNameToKey(
  name: string,
  generic: boolean = BLINK_GENERIC_FAMILY_SPELLINGS.has(name),
  lang?: string,
  canonicalSystemUiName: boolean = name === "system-ui",
  lookupName: string = name,
  description: DarwinFontDescription = DARWIN_INITIAL_FONT_DESCRIPTION,
): string | null {
  const key = matchFamilyCandidateToKey(name, generic, lang, canonicalSystemUiName, lookupName, description);
  if (key == null) return null;

  // macOS declared-family identity is the CTFont/NSFont descriptor Blink
  // matched, not the calibrated logical key that happened to nominate it.
  // `FontFallbackIterator::Next` exhausts every kFontGroupFonts entry before
  // entering kSystemFonts (`font_fallback_iterator.cc:120-178`, Chromium
  // 7d859f271c), and `MatchFontFamily` returns the exact family/PostScript
  // member selected for that entry (`mac/font_matcher_mac.mm:591-705`). Keep
  // that member addressable through the whole declared-family walk. Otherwise
  // two public families that share a calibrated backing key collapse before
  // fallback: "Hiragino Kaku Gothic ProN" becomes HiraginoSans-W4 through
  // `hiragino-jp`, and an installed "SF Pro Text" becomes .SFNS-Regular
  // through `sf-pro` whenever a caller materializes the key instead of using
  // `resolveFont`'s primary instance.
  //
  // This is deliberately a family decision, with no character/range input.
  // Generic keywords keep their platform/settings routes, as do webfonts and
  // local() aliases. The platform matcher already answered availability; an
  // unavailable family therefore still returns the calibrated candidate's
  // existing null/fall-through result above.
  if (
    hostPlatform() !== "darwin" ||
    generic ||
    key.startsWith("webfont:") ||
    key.startsWith("localalias:") ||
    (name === "system-ui" && canonicalSystemUiName)
  ) {
    return key;
  }

  const match = resolveFamilyStyleMatch(lookupName, {
    weight: 400,
    italic: false,
    stretch: 100,
  });
  if (match == null) return key;

  const nominatedSpec = resolveFontSpec(key);
  const nominatedPostscriptName =
    nominatedSpec?.postscriptName ??
    (nominatedSpec?.path != null && nominatedSpec.path !== ""
      ? (resolveFaceInfoForFile(nominatedSpec.path).memberPostscriptName ?? undefined)
      : undefined);
  if (nominatedPostscriptName === match.postscriptName) return key;

  const installed = resolveInstalledFont(match.postscriptName);
  if (installed == null || installed.path === "") return key;
  const exactKey = `sysfb:${match.postscriptName}`;
  registerDynamicSystemFont(
    exactKey,
    installed.path,
    match.postscriptName,
    nominatedSpec?.extractor ?? "native",
    installed.resolvedAxes,
    installed.ctAxes,
  );
  // Presence in this map distinguishes a declared-family dynamic key from a
  // CTFontCreateForString system-fallback key. Per-run weight/slant/stretch
  // selection must therefore stay in MatchFontFamily, not be reclassified as
  // fallback-family re-selection merely because both registries use `sysfb:`.
  declaredFamilyForKey.set(
    exactKey,
    installed.familyName !== "" && !installed.familyName.startsWith(".") ? installed.familyName : lookupName,
  );
  return exactKey;
}

export function resolveFontKey(
  fontFamily: string,
  lang?: string,
  description: DarwinFontDescription = DARWIN_INITIAL_FONT_DESCRIPTION,
): string {
  // Walk the comma-separated stack — Chrome's getComputedStyle returns the
  // unresolved list (e.g. `"DoesNotExist", Georgia, "Times New Roman", serif`)
  // not the matched font. Pick the first name we recognize, mirroring how
  // Chrome falls through the stack until something loads. `lang` is the
  // element's content locale; it moves the settings-mapped generics on
  // mac/win via Playwright's per-script tables (see matchFamilyNameToKey).
  for (const entry of splitFontFamilyNames(fontFamily)) {
    const key = matchFamilyNameToKey(
      entry.name,
      entry.generic,
      lang,
      entry.canonicalSystemUiName,
      entry.lookupName,
      description,
    );
    if (key != null) return key;
  }
  // Last-resort fallback when no family in the stack matched: Blink falls to
  // the standard font — `FamilyNameFromSettings` with kStandardFamily →
  // `settings.Standard(script)` (`font_selector.cc:55-61,74-76`, rev
  // 7d859f27) — and the standard entry is SCRIPT-KEYED like every other
  // setting. Measured: a bare `monospace` stack under lang=ja exhausts
  // (Osaka-Mono is not installed) and Chrome paints HiraKakuProN-W3 — the
  // jpan STANDARD entry — for every codepoint, not Times. Consult the
  // per-script standard entry first; no entry (Common script, Linux, no
  // lang) keeps the calibrated Times default.
  const std = matchFamilyNameToKey("-webkit-standard", true, lang, undefined, undefined, description);
  if (std != null) return std;
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
 * misses — see the probe in `tools/probe-2f800-facewalk.mjs`). Ordinarily the final entry
 * is Blink's preferred STANDARD family, which is still part of
 * `kFontGroupFonts`; platform system fallback and the notdef last-resort come
 * later. A protected dot-prefixed Page probe answer is the observable exception:
 * it identifies the later platform-fallback face, so inserting STANDARD ahead
 * of that stage would contradict the authenticated paint.
 */
export function resolveFontKeyChain(
  fontFamily: string,
  lang?: string,
  description: DarwinFontDescription = DARWIN_INITIAL_FONT_DESCRIPTION,
): string[] {
  const out: string[] = [];
  const entries = splitFontFamilyNames(fontFamily);
  let protectedScriptFallback = false;
  for (const entry of entries) {
    protectedScriptFallback ||= sessionScriptFaceIsFallbackOwned(entry.name, entry.generic, lang);
    const key = matchFamilyNameToKey(
      entry.name,
      entry.generic,
      lang,
      entry.canonicalSystemUiName,
      entry.lookupName,
      description,
    );
    if (key != null && !out.includes(key)) out.push(key);
  }
  // Blink's family list ends with the STANDARD family: a codepoint no
  // declared family covers is asked of `GetFallbackFontFamily` →
  // `settings.Standard(script)` BEFORE the per-codepoint system fallback
  // (`font_fallback_iterator.cc:167-179` walks `FontFallbackList::FontDataAt`
  // until it is exhausted, and that list's final entry is the standard
  // family). `times` is that stage for the Common/default script, but when the
  // content locale keys a per-script standard entry, the script-keyed face
  // takes the position instead.
  // Measured: lang=zh-Hant `monospace` paints Han from PingFang TC (the hant
  // standard, first-available of ",PingFang TC,Heiti TC") while Latin stays
  // Courier — 253 of 253 oracle rows in the 4E00-4EFF slice moved on exactly
  // this stage.
  // A protected dot-prefixed script answer is evidence for the platform
  // fallback selected from this generic's Common primary, not a declared
  // family. Appending the script STANDARD face here would consume the scalar
  // at kFontFamily (Times covers Hebrew) before Blink's CoreText stage can
  // produce that authenticated hidden face.
  if (!protectedScriptFallback) {
    const std = matchFamilyNameToKey("-webkit-standard", true, lang, undefined, undefined, description) ?? "times";
    if (!out.includes(std)) out.push(std);
  }
  return out;
}

// DM-1103: macOS "optical cut" families. `SFNS.ttf` is one variable font with an
// `opsz` axis (17–96, default 28); the downloadable SF Pro exposes the optical
// cuts as their own families. When CSS explicitly names a cut — `"SF Pro
// Text"` / `"SF Pro Display"` — Chrome paints that cut's FIXED design at every
// size, and the pin is Blink's outcome BY CONSTRUCTION, not a special case:
//
//   - Blink applies `font-optical-sizing: auto`'s size-derived `opsz` only when
//     the matched typeface reports current variation coordinates —
//     `FontPlatformDataFromCTFont` returns the typeface untouched on
//     `existing_axes <= 0` (`font_platform_data_mac.mm:155-160`, rev 7d859f27,
//     identical at tag 147.0.7727.15) before the opsz clone loop is reached.
//   - The face CoreText matches for the named cut is the STATIC per-cut font
//     (CDP `getPlatformFontsForNode`: `SFProText-Regular` at 13/16/24/30/48px,
//     `SFProDisplay-Regular` at 13/30px), and a typeface without CT variation
//     axes reports none — Skia's `onGetVariationDesignPosition` returns -1
//     (`62efacd3:src/ports/SkTypeface_mac_ct.cpp:741-757`, the DEPS-pinned
//     revision) — so the early return takes and no opsz is ever applied.
//
// So pin-vs-clamp is settled by source AND by a discriminating measurement
// above the axis floor, where the two rules disagree (they agree at ≤17, which
// is all the original DM-1103 fixture could see). Probe 2026-08-08, advance of
// a 35-char run vs fontkit instances of SFNS: Chrome "SF Pro Text" at
// 24/30/48px = 445.250/556.563/890.484px, SFNS@opsz17 = 445.242/556.553/
// 890.484 (match, <0.02px), SFNS@opsz=size = 407.53/498.94/798.31 (9-11% off).
//
// Our pipeline paints these cuts from the variable SFNS file, so each entry
// records the SFNS opsz whose design is the named cut: Text = 17 (the axis
// floor; also verified by the DM-1103 diacritic fixture) and Display = 28 (the
// file default; Chrome "SF Pro Display" at 13px and 30px = 216.219/498.953,
// SFNS@28 = 216.21/498.94 — while opsz=size at 13px would paint the Text
// design, 241.17, ~11% wide). The generic `"SF Pro"` / `system-ui` /
// `-apple-system` path keeps `opsz = size`: there Blink DOES reach the clone
// loop (the system-ui CTFont carries variation coordinates), which is the
// clamp mechanism documented at `resolveDarwinAxisLocation`.
const OPTICAL_CUT_OPSZ: Record<string, number> = {
  "sf pro text": 17,
  ".sfnstext": 17,
  "sf pro display": 28,
  ".sfnsdisplay": 28,
};

/**
 * The pinned `opsz` for an explicitly-named macOS optical-cut family, or null
 * when the resolved family isn't a named cut (→ keep the `opsz = size` default).
 * Mirrors `resolveFontKey`'s walk: the FIRST name in the stack that resolves to
 * an installed key decides — if that name is a named cut, return its opsz; if
 * it's any other installed face, the cut doesn't apply.
 */
export function opticalCutOpszFor(fontFamily: string, lang?: string): number | null {
  for (const entry of splitFontFamilyNames(fontFamily)) {
    if (matchFamilyNameToKey(entry.name, entry.generic, lang) == null) continue; // unrecognized — skip, like resolveFontKey
    return entry.name in OPTICAL_CUT_OPSZ ? OPTICAL_CUT_OPSZ[entry.name] : null;
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
  fontFamily: string,
  fontWeight: number,
  fontSize: number,
  slant: number = 0,
  variationSettings?: Record<string, number>,
  /** CSS `font-stretch` as a percentage, 100 = `normal`. */
  stretch: number = 100,
  /** BCP-47 content locale — moves the settings-mapped generics on mac/win
   *  via Playwright's per-script tables (see `resolveFontKey`). */
  lang?: string,
): FontInstance | null {
  const matchSize = computedFontSize(variationSettings, fontSize);
  const description = { weight: fontWeight, size: matchSize, slant, stretch, variationSettings };
  const semanticContext = createFontFallbackSemanticContext(fontFamily);
  // A generated family-name table can recognize a face that is absent from
  // this particular host inventory. Blink's kFontFamily stage keeps walking
  // the authored CSS stack when matching/loading that face fails; do the same
  // here rather than returning null from the first recognized snapshot entry.
  for (const entry of splitFontFamilyNames(fontFamily)) {
    const key = matchFamilyNameToKey(
      entry.name,
      entry.generic,
      lang,
      entry.canonicalSystemUiName,
      entry.lookupName,
      description,
    );
    if (key == null) continue;
    const cutOpsz = OPTICAL_CUT_OPSZ[entry.name];
    const settings =
      cutOpsz != null && (variationSettings == null || variationSettings.opsz == null)
        ? { ...(variationSettings ?? {}), opsz: cutOpsz }
        : variationSettings;
    const instance = getFontInstance(
      key,
      fontWeight,
      matchSize,
      slant,
      settings,
      stretch,
      stackPrimaryIsSystemUi(entry.name, undefined, description),
      undefined,
      semanticContext,
    );
    if (instance != null) return instance;
  }

  const standardKey =
    matchFamilyNameToKey("-webkit-standard", true, lang, undefined, undefined, description) ?? "times";
  return getFontInstance(
    standardKey,
    fontWeight,
    matchSize,
    slant,
    variationSettings,
    stretch,
    false,
    undefined,
    semanticContext,
  );
}
