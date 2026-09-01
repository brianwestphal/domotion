/**
 * Public native-helper facade and platform fallback/cache ownership.
 *
 * Process transport lives in `glyph-helper-transport.ts`; typed wire envelopes
 * in `glyph-helper-protocol.ts`; pure path/metric conversion in
 * `glyph-helper-outline.ts`; fontkit-compatible adapter construction in
 * `glyph-helper-font.ts`; and Linux target-size strikes in
 * `linux-target-strike.ts`. Existing callers import this facade so the split is
 * internal and does not create a second public routing surface.
 */

import { hostPlatform } from "./host-platform.js";
import type { MetaResponse } from "./glyph-helper-outline.js";
import type {
  FamilyResponse,
  HelperRequest,
  HelperResponse,
} from "./glyph-helper-protocol.js";
import {
  callGlyphHelper as callHelper,
  clearGlyphHelperTransport,
  isGlyphHelperAvailable,
} from "./glyph-helper-transport.js";

export {
  OFFSET_PROBE_GLYPHS,
  measureOutlineOffsetY,
} from "./glyph-helper-outline.js";
export type { GlyphRasterRepresentation } from "./glyph-helper-outline.js";
export {
  __helperBinaryForPlatform,
  isGlyphHelperAvailable,
  resolvedGlyphHelperPathForEvidence,
} from "./glyph-helper-transport.js";
export {
  buildGlyphHelperFontProbeEnvelope,
  createGlyphHelperFont,
} from "./glyph-helper-font.js";
export type {
  GlyphHelperFontInstance,
  ShapedRunFallback,
} from "./glyph-helper-font.js";
export { linuxTargetStrikeGlyphs } from "./linux-target-strike.js";
export type { LinuxTargetStrikeGlyph } from "./linux-target-strike.js";

/** Resolved system fallback font for a codepoint Chrome would substitute via
 *  CoreText's `CTFontCreateForString` cascade. `null` when CoreText falls
 *  through to LastResort (Chrome paints its own last-resort tofu there). */
export interface SystemFallbackFont {
  postscriptName: string;
  familyName: string;
  path: string;
  /** DM-1721: the axis location the platform matcher resolved the face to,
   *  when it is a variable-font instance (win32 DirectWrite helper ≥0.2.0
   *  reports this; macOS/Linux resolvers don't). See
   *  `FallbackResponseEntry.axes`. */
  resolvedAxes?: Record<string, number>;
  /** macOS only: the substituted handle's variation axes + CURRENT position —
   *  the state Blink's clone gate (`VariableAxisChangeEffective`) compares
   *  against. See `FallbackResponseEntry.ctAxes`. */
  ctAxes?: Array<{ tag: string; min: number; def: number; max: number; value: number }>;
  /** Whether this face covers the codepoint it was resolved for, answered by the
   *  helper alongside the nomination. `undefined` on a binary that predates the
   *  field — the caller then probes as it always did. */
  covered?: boolean;
}

// Keyed on `<basePostscriptName>\u0000<cp>\u0000<weight>\u0000<italic>\u0000<size>`,
// NOT on the codepoint alone. CoreText's cascade depends on the font you ask
// FROM — asking for U+20BF from SF Pro Text answers SF Pro Text, while asking
// from Helvetica answers .NewYork. A cp-only key therefore served whichever base
// happened to ask first to every later caller, silently, for the rest of the
// process. The CSS description joins the key for the same reason: the in-family
// re-selection below makes the answer weight- and style-dependent.
const _systemFallbackCache = new Map<string, SystemFallbackFont | null>();
const fallbackCacheKey = (base: string, cp: number, req?: SystemFallbackRequest): string =>
  req == null
    ? `${base}\u0000${cp}`
    // DM-1859: `systemUi` and `stretch` join the key for the same reason the rest
    // of the description did — they change which base the cascade is walked FROM,
    // so a key blind to them would serve a named-family answer to a system-ui run.
    // DM-1871: `baseFamilyName` too — on Windows the answer is a function of the
    // run's primary family, so a key blind to it would serve whichever primary
    // asked first to every later caller. Same hazard the cascade base already
    // documents, one platform over.
    // DM-1896: `locale` too, and this one is the sharpest of the set — a unified
    // Han ideograph resolves to a Japanese face under `ja` and a Chinese one
    // under `zh-Hans`, so a locale-blind key on a multilingual page serves
    // whichever language asked first to every later run. Wrong quietly, in a way
    // that reads as a font-inventory problem rather than as a cache defect.
    // `monoEmojiReplacement` joins for the same reason the rest of the
    // description does: it changes the answer (Apple Color Emoji vs the
    // monochrome cascade), so a key blind to it would serve a color answer
    // to a forced-text ask or vice versa.
    : `${base}\u0000${cp}\u0000${req.weight}\u0000${req.italic ? 1 : 0}\u0000${req.fontSize}\u0000${req.basePath ?? ""}\u0000${req.systemUi ? 1 : 0}\u0000${req.stretch ?? 100}\u0000${req.baseFamilyName ?? ""}\u0000${req.locale ?? ""}\u0000${req.monoEmojiReplacement === true ? 1 : 0}`;

/** The CSS description the fallback answer depends on. CoreText nominates one
 *  face per family for a character; Blink then re-selects WITHIN that family at
 *  the requested traits + weight (`GetAlternateFontPlatformData`,
 *  font_cache_mac.mm), so two runs differing only in weight resolve to different
 *  cuts of the same family. Measured: at weight 700 that moves 8,121 of a
 *  27,790-codepoint stride (29%) off the face CoreText nominated. */
export interface SystemFallbackRequest {
  /**
   * DM-1871: the run's PRIMARY family name, for Windows.
   *
   * Blink passes it as `MapCharacters`' `baseFamilyName` —
   * `GetDWriteFallbackFamily` takes `font_description.Family().FamilyName()`
   * and Skia forwards it (`win/font_cache_skia_win.cc:234-240` →
   * `SkFontMgr_win_dw.cpp:928-939`, rev 7d859f27). It is what lets the primary
   * family's own font linking participate in DirectWrite's answer, so a null
   * base asks a different question than Chrome asks.
   *
   * Ignored on macOS and Linux, whose fallback APIs take no such argument.
   */
  baseFamilyName?: string;
  /**
   * DM-1896: the BCP-47 tag the fallback query is asked with, for Windows.
   *
   * Blink resolves it per codepoint with `FallbackLocaleForCharacter` and pushes
   * `LocaleForSkFontMgr()` of the result into `matchFamilyStyleCharacter`'s
   * one-element bcp47 vector (`win/font_cache_skia_win.cc:228-240`, rev
   * 7d859f27); Skia hands it to `MapCharacters` as the analysis source's locale
   * name. It is what disambiguates unified Han: the same ideograph resolves to a
   * different face under `ja` than under `zh-Hans`.
   *
   * NOT the raw CSS `lang` — the reduction is Blink's, and it drops the region
   * while keeping the script (`zh-CN` → `zh-Hans`). Produce it with
   * `blinkWinFallbackLocale`; passing a hand-built tag risks the failure mode
   * Skia documents at the call site, where bare `zh` "misses completely and may
   * produce a Japanese font".
   *
   * Ignored on macOS (CoreText's cascade takes no locale) and on Linux (whose
   * fontconfig query carries its own, differently-shaped, `:lang=` tag).
   */
  locale?: string;
  /** CSS `font-weight` (1..1000). */
  weight: number;
  /** CSS `font-style: italic | oblique`. */
  italic: boolean;
  /** Computed pixel size — what Blink hands CoreText for both the cascade walk
   *  and the in-family re-selection. */
  fontSize: number;
  /** On-disk file of the cascade base, when the caller knows it. REQUIRED for
   *  Apple's hidden `.`-prefixed faces: CoreText refuses to resolve those by
   *  name and hands back Times New Roman WITHOUT erroring, so a name-only lookup
   *  would silently walk the wrong font's cascade. With a path the helper opens
   *  the exact face out of the file. */
  basePath?: string;
  /** Raw sfnt bytes for an in-memory webfont cascade base (macOS only). */
  baseData?: Buffer;
  /** DM-1859: the run's primary is the CSS `system-ui` / `BlinkMacSystemFont`
   *  keyword, i.e. the platform UI font.
   *
   *  Blink does not resolve that through family matching — `CreateFontPlatformData`
   *  routes it to `MatchSystemUIFont` (`mac/font_cache_mac.mm:409-412`), which
   *  builds the base with `CTFontCreateUIFontForLanguage`. The UI font carries its
   *  OWN cascade list, the one that reaches Apple's hidden `.…UI` variants, and
   *  only that API returns it: measured, opening `/System/Library/Fonts/SFNS.ttf`
   *  by path answers U+6F22 with `PingFangSC-Regular` at every size, while Chrome
   *  answers `.PingFangUITextSC-Regular` at 13px and `.PingFangUIDisplaySC-Regular`
   *  at 20px. So this is not expressible as a `basePath` — it needs the helper's
   *  `systemUI` base mode.
   *
   *  `stretch` rides along because `MatchSystemUIFont` takes it: at weight 400 and
   *  width 100 it returns the traited font directly, and otherwise applies clamped
   *  `wght`/`wdth` variation axes. */
  systemUi?: boolean;
  /** CSS `font-stretch` as a percentage (100 = normal). Only consulted for the
   *  `systemUi` base, mirroring `MatchSystemUIFont`'s `desired_width`. */
  stretch?: number;
  /** macOS only: apply Blink's monochrome-emoji replacement inside the helper —
   *  when the cascade answers "Apple Color Emoji" for this ask, re-ask
   *  `CTFontCreateForString` from an "Apple Symbols" base carrying the color
   *  font's default cascade list (`GetSubstituteFont`,
   *  `mac/font_cache_mac.mm:156-184`, rev 7d859f27). The caller sets it where
   *  Blink's gate holds: a non-emoji-presentation (kText-priority) ask on a
   *  `Character::IsEmoji` codepoint — today that is the `font-variant-emoji:
   *  text` override. An older helper binary ignores the field and answers the
   *  color font (the pre-override behavior). */
  monoEmojiReplacement?: boolean;
}

/** Authoritative per-codepoint system font fallback, matching Chrome-on-macOS.
 *
 *  Blink's `font_cache_mac.mm::PlatformFallbackFontForCharacter` →
 *  `GetSubstituteFont` calls `CTFontCreateForString(baseFont, str, range)` to
 *  walk CoreText's system cascade and find the font that renders a character
 *  the primary font lacks (returning null when the result is LastResort). This
 *  exposes the same call so the renderer can resolve fallback fonts the way
 *  Chrome actually does, instead of relying on the sampled per-block table.
 *
 *  `GetSubstituteFont` is only half of what Blink does: the cascade nominates
 *  one face per family regardless of the weight the CSS asked for, and
 *  `GetAlternateFontPlatformData` then re-selects within that family at the
 *  requested traits + weight. Pass `req` to get that second half — the helper
 *  runs the same `CTFontCreateWithFontDescriptor` call Blink runs, so a
 *  weight-700 run resolves Songti SC Bold where a weight-400 run resolves Songti
 *  SC Regular. Omitting `req` keeps the nominated face (the pre-DM-1854
 *  behavior), which is what the Windows helper — whose DirectWrite path does its
 *  own weight matching — still wants.
 *
 *  Returns a map from codepoint to the resolved font (or null for LastResort).
 *  Results are memoized process-wide; `basePostscriptName` selects the cascade
 *  base (defaults to Helvetica — a neutral sans base whose system cascade is
 *  what an un-styled element resolves through). Returns an empty map when the
 *  helper binary isn't available (non-macOS / unbuilt). */
/** One fontconfig sort-and-walk answer (DM-1886, Linux only). */
export interface FcFallbackFont {
  path: string;
  /** TTC member index. Blink creates the face by file + index, so a `.ttc`
   *  member is only addressable with it (`font_cache_linux.cc:99-104`). */
  index: number;
  /** Blink reads these back and MUTATES the FontDescription with them — a bold
   *  face raises a sub-bold request; a non-bold face under a bold request turns
   *  on SYNTHETIC bold (`font_cache_linux.cc:106-129`). */
  isBold: boolean;
  isItalic: boolean;
  family?: string;
}

export interface FcFallbackDiagnostic {
  before: string;
  after: string;
  fingerprint: string;
  candidates: Array<{
    rank: number; path: string; index: number; family?: string;
    postscriptName?: string; covers: number[];
  }>;
}

/** Diagnostics only: serialize Blink's effective Fontconfig fallback question. */
export function resolveFcFallbackDiagnostic(
  cps: number[], lang: string = "en",
): FcFallbackDiagnostic | null {
  if (hostPlatform() !== "linux" || !isGlyphHelperAvailable() || cps.length === 0) return null;
  try {
    const resp = callHelper({ fonts: [], queries: [{ type: "fcdiagnostic", lang, cps }] });
    const r = resp.results[0] as unknown as (FcFallbackDiagnostic & { type?: string; error?: string }) | undefined;
    if (r?.type !== "fcdiagnostic" || r.error != null || !Array.isArray(r.candidates)) return null;
    return { before: r.before, after: r.after, fingerprint: r.fingerprint, candidates: r.candidates };
  } catch {
    return null; // older helper / unavailable diagnostics must not affect resolution
  }
}

/**
 * Per-codepoint fallback via fontconfig, the way Chrome asks it (DM-1886).
 *
 * Linux only. Returns an empty map when the helper is unavailable OR when it is
 * an older binary that doesn't know the query — the caller then keeps the
 * `fc-match` path. Absence of an answer is never a reason to invent one: a
 * codepoint no font covers reports `found:false` and maps to `null`, which is
 * what Chrome does (`GetFontForCharacter` returns false → the caller keeps its
 * last resort).
 *
 * The helper walks a locale-sorted set and filters by real charset coverage, so
 * unlike `fc-match ":charset="` it cannot return a non-covering face — see the
 * `fcfallback` comment in `tools/linux-glyph-extractor/src/main.cpp`.
 */
const _fcFallbackCache = new Map<string, FcFallbackFont | null>();
let _fcFallbackRendererDepth = 0;
let _fcFallbackRendererKey = "default";
const _fcFallbackRendererCaches = new Map<string, Map<number, FcFallbackFont | null>>();

export function beginFcFallbackRendererScope(key: string = "default"): void {
  if (_fcFallbackRendererDepth === 0) _fcFallbackRendererCaches.clear();
  _fcFallbackRendererDepth++;
  _fcFallbackRendererKey = key;
  if (!_fcFallbackRendererCaches.has(key)) _fcFallbackRendererCaches.set(key, new Map());
}

export function selectFcFallbackRendererScope(key: string): void {
  if (_fcFallbackRendererDepth === 0) return;
  _fcFallbackRendererKey = key;
  if (!_fcFallbackRendererCaches.has(key)) _fcFallbackRendererCaches.set(key, new Map());
}

export function endFcFallbackRendererScope(): void {
  if (_fcFallbackRendererDepth > 0) _fcFallbackRendererDepth--;
  if (_fcFallbackRendererDepth === 0) _fcFallbackRendererCaches.clear();
}

/** Test-only view of the active codepoint-only Linux renderer cache. */
export function __fcFallbackRendererCacheForTest(): Map<number, FcFallbackFont | null> | null {
  if (_fcFallbackRendererDepth === 0) return null;
  return _fcFallbackRendererCaches.get(_fcFallbackRendererKey) ?? null;
}

export function resolveFcFallbackFonts(
  cps: number[], lang: string = "en",
): Map<number, FcFallbackFont | null> {
  const out = new Map<number, FcFallbackFont | null>();
  if (hostPlatform() !== "linux" || !isGlyphHelperAvailable() || cps.length === 0) return out;
  // Chromium's renderer sandbox cache is codepoint-only and first-query-wins;
  // locale affects only the miss that populates it. Outside an explicit
  // renderer scope retain the legacy (lang, cp) memo for low-level callers.
  const rendererCache = _fcFallbackRendererDepth > 0
    ? _fcFallbackRendererCaches.get(_fcFallbackRendererKey)!
    : null;
  const need: number[] = [];
  for (const cp of cps) {
    const k = `${lang}\u0000${cp}`;
    if (rendererCache?.has(cp)) out.set(cp, rendererCache.get(cp)!);
    else if (rendererCache == null && _fcFallbackCache.has(k)) out.set(cp, _fcFallbackCache.get(k)!);
    else need.push(cp);
  }
  if (need.length === 0) return out;
  try {
    const resp = callHelper({ fonts: [], queries: [{ type: "fcfallback", lang, cps: need }] });
    const r: any = resp.results[0];
    // An older helper answers `{error:"unknown query type"}`; treat that as "no
    // helper for this question" rather than as "no font", so the caller falls
    // back instead of tofuing every codepoint.
    if (r == null || r.type !== "fcfallback" || !Array.isArray(r.fonts)) return out;
    for (const e of r.fonts) {
      if (e == null || typeof e.cp !== "number") continue;
      const resolved = e.found === true && typeof e.path === "string" && e.path !== ""
        ? {
            path: e.path,
            index: typeof e.index === "number" ? e.index : 0,
            isBold: e.isBold === true,
            isItalic: e.isItalic === true,
            family: typeof e.family === "string" ? e.family : undefined,
          }
        : null;
      out.set(e.cp, resolved);
      if (rendererCache != null) rendererCache.set(e.cp, resolved);
      else _fcFallbackCache.set(`${lang}\u0000${e.cp}`, resolved);
    }
  } catch {
    return new Map();
  }
  return out;
}

/**
 * The request envelope for a per-codepoint system-fallback query.
 *
 * Split out and platform-parameterised so the one decision that differs between
 * platforms — whether to declare a base font — is explicit and testable rather
 * than an inline branch. That decision was wrong on Windows for a long time, in
 * a way nothing caught (DM-1889).
 *
 * **macOS/Linux declare a base; Windows must not.** The platforms ask genuinely
 * different questions. `CTFontCreateForString` resolves *from* a base face, so on
 * macOS the answer depends on it and omitting it would change results. DirectWrite
 * takes no base at all: the win32 helper's `runFallbackQuery(query, factory)` is
 * not even handed the envelope's font map, so the entry could only ever be inert.
 *
 * It was worse than inert. The base is named ("Helvetica") with no `fontPath`,
 * the win32 helper cannot open a font by family name, and one-shot mode treats an
 * unopenable *declared* font as fatal — it dies before running a single query.
 * With the persistent channel disabled on Windows because a spawned pipe has no
 * OS fd there, one-shot was the ONLY path, so every call came back as an error
 * envelope with no `results` and the caller read that as "no fallback font" for
 * every codepoint.
 *
 * So the live DirectWrite per-codepoint resolver was shipped default-on and never
 * actually answered on Windows; that platform's conformance numbers were scoring
 * the static fallback chain alone. Verified on a Windows 11 host: the identical
 * envelope answers correctly over the persistent channel — where an unopenable
 * ref is merely absent — and errors out one-shot.
 */
export function buildFallbackEnvelope(
  basePostscriptName: string,
  cps: number[],
  req: SystemFallbackRequest | undefined,
  platform: NodeJS.Platform,
): HelperRequest {
  return {
    fonts: platform === "win32" ? [] : [{
      ref: "base", postscriptName: basePostscriptName, size: req?.fontSize ?? 16,
      ...(req?.basePath != null ? { fontPath: req.basePath } : {}),
      ...(req?.baseData != null ? { fontData: req.baseData.toString("base64") } : {}),
      // CoreText's cascade base belongs to the current run. The persistent
      // helper may cache ordinary opened faces, but sharing this CTFontRef
      // between envelopes lets its cascade state leak into later Han queries.
      ...(platform === "darwin" ? { requestScoped: true } : {}),
      // DM-1859: the platform UI font, built the way `MatchSystemUIFont` builds
      // it. The helper derives the symbolic traits from these CSS values itself
      // (Blink's `kBoldThreshold` is 600 and lives on that side), so pass the
      // numbers rather than pre-computed booleans.
      ...(req?.systemUi === true
        ? {
          systemUI: true,
          cssWeight: req.weight,
          cssSlant: req.italic ? 1 : 0,
          cssWidth: req.stretch ?? 100,
        }
        : {}),
    }],
    queries: [{
      // `fontRef` is kept even on Windows, where no base is declared: the helper
      // ignores it for this query, and the macOS/Linux helpers require it. One
      // query shape for all three.
      type: "fallback", fontRef: "base", cps,
      ...(req != null
        // `bold` mirrors Blink's `platform_data.synthetic_bold_` OR: our base
        // font stands in for the run primary at its regular cut, so a bold
        // request arrives as the synthetic trait rather than in the face.
        ? {
          cssWeight: req.weight, bold: req.weight >= 600, italic: req.italic,
          // DM-1871: Windows only — the macOS and Linux helpers ignore it.
          ...(req.baseFamilyName != null && req.baseFamilyName !== ""
            ? { baseFamilyName: req.baseFamilyName } : {}),
          // DM-1896: Windows only, same reason. An absent field leaves the
          // helper on its own `en-us` default, which is what it did before —
          // so an older Node side against a newer helper degrades to the
          // previous behavior rather than to no locale at all.
          ...(req.locale != null && req.locale !== "" ? { locale: req.locale } : {}),
          // macOS only — Blink's monochrome-emoji replacement inside
          // `GetSubstituteFont` (see `SystemFallbackRequest.monoEmojiReplacement`).
          // An older helper ignores the field and answers the color font.
          ...(req.monoEmojiReplacement === true ? { monoEmoji: true } : {}),
        }
        : {}),
    }],
  };
}

export function resolveSystemFallbackFonts(
  cps: number[],
  basePostscriptName: string = "Helvetica",
  req?: SystemFallbackRequest,
): Map<number, SystemFallbackFont | null> {
  const out = new Map<number, SystemFallbackFont | null>();
  if (!isGlyphHelperAvailable()) return out;
  const need: number[] = [];
  for (const cp of cps) {
    if (_systemFallbackCache.has(fallbackCacheKey(basePostscriptName, cp, req))) out.set(cp, _systemFallbackCache.get(fallbackCacheKey(basePostscriptName, cp, req))!);
    else need.push(cp);
  }
  if (need.length === 0) return out;
  let resp: HelperResponse;
  try {
    resp = callHelper(buildFallbackEnvelope(basePostscriptName, need, req, hostPlatform()));
  } catch {
    // Helper failure → treat all as unresolved this call (don't poison cache).
    for (const cp of need) out.set(cp, null);
    return out;
  }
  const r = resp.results[0];
  if (r == null || r.type !== "fallback") {
    for (const cp of need) out.set(cp, null);
    return out;
  }
  // DM-1893: walk the response, but only trust entries we ASKED about.
  //
  // The loop used to iterate `r.fonts` and write whatever came back, which
  // trusted the response to be both complete and in-domain and checked neither.
  // Two distinct hazards, and the first is shaped like a live bug: a batch that
  // half-populates leaves the missing codepoints to fall through to the lazy
  // path, which is a different ask order — and ask order is exactly what this
  // area has already been bitten by (an under-keyed helper cache made the
  // answer a function of which spec asked first). A partial response would have
  // been silent.
  const asked = new Set(need);
  let outOfDomain = 0;
  for (const e of r.fonts) {
    if (!asked.has(e.cp)) { outOfDomain++; continue; }
    const resolved: SystemFallbackFont | null = e.found && e.path && e.postscriptName
      ? { postscriptName: e.postscriptName, familyName: e.familyName ?? "", path: e.path, resolvedAxes: e.axes, ctAxes: e.ctAxes, covered: e.covered }
      : null;
    _systemFallbackCache.set(fallbackCacheKey(basePostscriptName, e.cp, req), resolved);
    out.set(e.cp, resolved);
  }
  // Anything asked for and not answered is left OUT of both the cache and the
  // result rather than cached as null: `undefined` reads as "ask again", which
  // is the recoverable state. Caching a null here would turn one short response
  // into a permanently wrong answer for those codepoints.
  const missing = need.reduce((n, cp) => n + (out.has(cp) ? 0 : 1), 0);
  if (missing > 0 || outOfDomain > 0) {
    _fallbackResponseAnomalies.push({ asked: need.length, answered: r.fonts.length, missing, outOfDomain });
  }
  return out;
}

/** DM-1893: short or out-of-domain fallback responses, in call order.
 *
 *  Recorded rather than thrown because a short response is recoverable — the
 *  unanswered codepoints simply get asked again lazily. But it is NOT harmless:
 *  an unanswered codepoint gets re-asked later, in a different order, and this
 *  area has been bitten by ask-order dependence before.
 *
 *  Historical note (DM-1893): this was instrumented while chasing the
 *  conformance oracle disagreeing with itself run to run, where a silent
 *  partial response was a leading candidate. Measured at zero anomalies across
 *  batch sizes 64–8192; the disagreement itself turned out to be Chrome's own
 *  answers flipping among CJK cousin faces between runs, now detected by the
 *  oracle's per-face `chromeFaceCounts` baseline comparison.
 *
 *  Read with `takeFallbackResponseAnomalies()`; a run that reports none has
 *  eliminated the short-response candidate rather than merely not looked. */
interface FallbackResponseAnomaly { asked: number; answered: number; missing: number; outOfDomain: number }
const _fallbackResponseAnomalies: FallbackResponseAnomaly[] = [];

/** Drain the recorded anomalies. Empty means every call answered exactly what
 *  it was asked. */
export function takeFallbackResponseAnomalies(): FallbackResponseAnomaly[] {
  return _fallbackResponseAnomalies.splice(0, _fallbackResponseAnomalies.length);
}

/** A real installed font resolved by name via CoreText (macOS) or the
 *  DirectWrite system font collection (Windows, DM-1721). */
export interface InstalledFont {
  postscriptName: string;
  familyName: string;
  path: string;
  /** DM-1721: axis location the matcher resolved a VARIABLE face to (win32
   *  helper ≥0.2.0). For named optical subfamilies ("Segoe UI Variable Text")
   *  this carries the fixed opsz DirectWrite pins at every font size. */
  resolvedAxes?: Record<string, number>;
  /** macOS: the resolved handle's variation axes + CURRENT position (see
   *  `FamilyResponse.ctAxes`). The face's own coordinates — what a declared
   *  family's axis location must pin instead of a CSS-derived `wght`, since
   *  Blink's mac path applies only `opsz` + font-variation-settings on top of
   *  the matched face (font_platform_data_mac.mm:113-208, tag 147.0.7727.15). */
  ctAxes?: Array<{ tag: string; min: number; def: number; max: number; value: number }>;
}

const _installedFontCache = new Map<string, InstalledFont | null>();

/** Resolve a CSS font-family NAME to a real installed font, the way Blink's
 *  FontFallbackList picks `first_candidate_` — the first family in the stack
 *  that actually loads (font_fallback_iterator.cc). Backed by
 *  `CTFontCreateWithName` on macOS (with a name-match guard so a substituted
 *  default doesn't masquerade as the requested family) and, since DM-1721, by
 *  the DirectWrite system font collection's exact `FindFamilyName` lookup on
 *  Windows (win32 helper ≥0.2.0; older binaries answer the query with an
 *  error → null, preserving the previous fall-through). Returns null when the
 *  name isn't a real installed font (caller keeps walking the stack), or when
 *  the helper binary isn't available (Linux / unbuilt). Memoized
 *  process-wide. */
/**
 * Families to pretend are not installed, from `DOMOTION_HIDE_FAMILIES`
 * (comma-separated, case-insensitive).
 *
 * Font selection is only correct when it matches what Chrome paints ON THE SAME
 * MACHINE, and machines genuinely differ: a developer Mac carrying Apple's
 * downloadable SF Pro and Google's Noto Sans resolves a stack quite differently
 * from a stock install or a CI runner. That asymmetry made a whole class of
 * "wrong font" failures reproduce only on CI, which is a terrible place to
 * debug — every iteration is a push and a sweep.
 *
 * This makes the leaner machine reproducible on the richer one:
 *
 *   DOMOTION_HIDE_FAMILIES="SF Pro Text,SF Pro Display,SF Pro,Noto Sans" \
 *     npx tsx tests/html-test-suite.tsx --only 0400-04FF-cyrillic
 *
 * It hides families from *our* resolver only — Chrome still sees them, so the
 * expected paint is unchanged. That makes it a debugging instrument for "what
 * would our resolver pick without this font", NOT a simulation of the runner
 * (whose Chrome also lacks them). Read the two sides accordingly.
 */
function hiddenFamilies(): Set<string> {
  const raw = process.env.DOMOTION_HIDE_FAMILIES;
  if (raw == null || raw.trim() === "") return new Set();
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== ""));
}

/**
 * The run's CSS style, for callers that want the FACE a family resolves to
 * rather than merely whether the family exists (DM-1878).
 *
 * These are two different Blink calls with the same API, and conflating them is
 * what made a weight-700 Windows run paint the regular cut:
 *
 *  - `IsFontPresent` is `matchFamilyStyle(name, SkFontStyle())` — the DEFAULT
 *    style (`win/font_fallback_win.cc:54-59`). Omit `style` for this.
 *  - face selection is `matchFamilyStyle(name, font_description.SkiaFontStyle())`
 *    — the run's real style (`fonts/skia/font_cache_skia.cc:293-295`, reached
 *    from `CreateTypeface`). Pass `style` for this.
 *
 * Windows only in practice: DirectWrite picks the cut inside the family lookup,
 * whereas the macOS helper's `family` query is a CoreText name resolution with
 * its own in-family re-selection step downstream. (Chromium rev 7d859f27.)
 */
export interface InstalledFontStyle {
  /** CSS `font-weight`, 1–1000. Blink clamps outside that to normal. */
  weight?: number;
  /** Italic FLAG, for the common case where the renderer has no angle. */
  italic?: boolean;
  /** CSS `font-style` angle when known; >0 italic, >14 oblique. */
  slant?: number;
  /** CSS `font-stretch` percentage; 100 is normal. */
  stretch?: number;
}

/** Exact logical face selected by the platform-owned CSS `system-ui` route. */
export interface SystemUiFontFace {
  route: "coretext-ui-font" | "renderer-system-family" | "windows-menu-font";
  familyName: string;
  postscriptName: string;
  /** The browser-supplied family question on Linux, or the OS menu family on Windows. */
  systemFamily: string | null;
  /** Current CoreText coordinates for the matched UI handle (macOS only). */
  ctAxes?: Array<{ tag: string; min: number; def: number; max: number; value: number }>;
  /** DirectWrite-resolved variable coordinates (Windows only). */
  axes?: Record<string, number>;
}

let _systemUiFamily: string | null | undefined;

/**
 * The OS's UI font family — what CSS `system-ui` means on this host.
 *
 * DM-1881. Blink does not carry a literal here: `FontCache::SystemFontFamily()`
 * returns `MenuFontFamily()` (`win/font_cache_skia_win.cc:130-133`, rev
 * 7d859f27), and `CreateTypeface` asserts `DCHECK_NE(family, kSystemUi)` —
 * `system-ui` never reaches font matching as a name, it is replaced by whatever
 * the OS reports. So we ask the OS too, through the helper's `systemfont` query
 * (`SystemParametersInfo(SPI_GETNONCLIENTMETRICS)`), rather than baking in
 * "Segoe UI": that literal is correct on current Windows 11 and wrong by
 * construction, surviving only until a differently-configured host runs it.
 *
 * Memoized within one font-environment generation — it does not change during
 * a render, while `invalidateFontEnvironmentCaches()` drops it after an OS
 * preference change. `null` when the helper cannot answer, which leaves the
 * caller on its existing filename-table path rather than failing.
 */
export function resolveSystemUiFamily(): string | null {
  if (_systemUiFamily !== undefined) return _systemUiFamily;
  _systemUiFamily = null;
  if (hostPlatform() !== "win32" || !isGlyphHelperAvailable()) return _systemUiFamily;
  try {
    const resp = callHelper({ fonts: [], queries: [{ type: "systemfont" }] });
    const r = resp.results[0];
    if (r?.type === "systemfont" && r.found === true && typeof r.family === "string" && r.family !== "") {
      _systemUiFamily = r.family;
    }
  } catch {
    // An older helper answers "unknown query type"; keep null and let the
    // caller degrade to the table, which is the pre-DM-1881 behaviour.
  }
  return _systemUiFamily;
}

/** Test seam: drop the memoised system-ui family. */
export function __clearSystemUiFamilyForTest(): void {
  _systemUiFamily = undefined;
}

/** Test-only cache state: `undefined` means the OS menu metric will be re-read. */
export function __systemUiFamilyCacheForTest(): string | null | undefined {
  return _systemUiFamily;
}

/** Test-only seed for the environment-invalidation postcondition. */
export function __seedSystemUiFamilyForTest(family: string): void {
  _systemUiFamily = family;
}

export function resolveInstalledFont(
  name: string, style?: InstalledFontStyle,
): InstalledFont | null {
  const nameKey = name.toLowerCase();
  if (hiddenFamilies().has(nameKey)) return null;
  // The style joins the cache key for the same reason the cascade base does in
  // `systemFallbackKeyCache`: the answer is a function of the style you ask
  // with, so a style-blind key would serve whichever style asked FIRST to every
  // later caller — and the presence probe (no style) usually asks first.
  const key = style == null
    ? nameKey
    : `${nameKey}|${style.weight ?? 400}|${style.italic === true ? 1 : 0}|${style.slant ?? 0}|${style.stretch ?? 100}`;
  if (_installedFontCache.has(key)) return _installedFontCache.get(key)!;
  let resolved: InstalledFont | null = null;
  if (isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({ fonts: [], queries: [{
        type: "family", name,
        // Omitted entirely when there is no style, so the request is
        // byte-identical to the pre-DM-1878 one and an older helper binary
        // behaves exactly as before.
        ...(style != null ? {
          cssWeight: style.weight ?? 400,
          italic: style.italic === true,
          cssSlant: style.slant ?? 0,
          cssStretch: style.stretch ?? 100,
        } : {}),
      }] });
      const r = resp.results[0];
      if (r != null && r.type === "family" && r.found && r.path && r.postscriptName) {
        resolved = { postscriptName: r.postscriptName, familyName: r.familyName ?? "", path: r.path, resolvedAxes: r.axes, ctAxes: r.ctAxes };
      }
    } catch { resolved = null; }
  }
  _installedFontCache.set(key, resolved);
  return resolved;
}

/**
 * Resolve the face behind CSS `system-ui` through the same native question
 * Blink asks on this platform.
 *
 * This is intentionally separate from generic-family preferences. macOS opens
 * `CTFontCreateUIFontForLanguage` and applies Blink's UI weight/width/trait
 * mutations; Linux receives a browser-owned renderer family string and passes
 * it to Skia/fontconfig; Windows reads the live menu font metric and asks
 * DirectWrite for that family's requested cut. The optional Linux family is
 * the value transported in `RendererPreferences` (the oracle supplies the
 * controlled `--system-font-family` value); production's ordinary route is
 * the source-defined `sans` fallback.
 */
export function resolveSystemUiFontFace(
  style: InstalledFontStyle & { size?: number } = {},
  linuxRendererSystemFamily?: string,
): SystemUiFontFace | null {
  const weight = style.weight ?? 400;
  const italic = style.italic === true || (style.slant ?? 0) !== 0;
  const slant = style.slant ?? (italic ? 1 : 0);
  const stretch = style.stretch ?? 100;

  if (hostPlatform() === "darwin") {
    if (!isGlyphHelperAvailable()) return null;
    try {
      const resp = callHelper({
        fonts: [{
          ref: "system-ui",
          size: style.size ?? 16,
          systemUI: true,
          cssWeight: weight,
          cssSlant: slant,
          cssWidth: stretch,
        }],
        queries: [{ type: "meta", fontRef: "system-ui" }],
      });
      const r = resp.results[0];
      if (r?.type !== "meta" || r.resolution !== "systemUI"
          || r.postscriptName == null || r.postscriptName === "") return null;
      return {
        route: "coretext-ui-font",
        familyName: r.familyName ?? "",
        postscriptName: r.postscriptName,
        systemFamily: null,
        ...(r.ctAxes != null ? { ctAxes: r.ctAxes } : {}),
      };
    } catch {
      return null;
    }
  }

  if (hostPlatform() === "linux") {
    const systemFamily = linuxRendererSystemFamily?.trim() || "sans";
    const matched = resolveLinuxFamilyMatch(systemFamily, { weight, italic, stretch });
    if (matched == null || matched.postscriptName === "") return null;
    return {
      route: "renderer-system-family",
      familyName: matched.family,
      postscriptName: matched.postscriptName,
      systemFamily,
    };
  }

  if (hostPlatform() === "win32") {
    const systemFamily = resolveSystemUiFamily();
    if (systemFamily == null || systemFamily === "") return null;
    const matched = resolveInstalledFont(systemFamily, { weight, italic, slant, stretch });
    if (matched == null || matched.postscriptName === "") return null;
    return {
      route: "windows-menu-font",
      familyName: matched.familyName || systemFamily,
      postscriptName: matched.postscriptName,
      systemFamily,
      ...(matched.resolvedAxes != null ? { axes: matched.resolvedAxes } : {}),
    };
  }

  return null;
}

/** The face a declared CSS family resolves to at one style. */
export interface FamilyStyleMatch {
  /** PostScript name of the chosen family member. */
  postscriptName: string;
  /** The CSS weight the matcher scored the chosen member at. */
  weight: number;
  /** True when the chosen member carries CoreText's italic symbolic trait. */
  italic: boolean;
}

/** `kCTFontTraitItalic` — bit 0 of `CTFontSymbolicTraits`. */
const CT_TRAIT_ITALIC = 1 << 0;

const _familyStyleMatchCache = new Map<string, FamilyStyleMatch | null>();

/**
 * Which CUT of a declared CSS family a run at this style opens — macOS only.
 *
 * Blink runs a candidate scan over the family's AppKit members and picks with
 * its own comparator: `BestStyleMatchForFamilyNS` (`:231-277`) →
 * `BetterChoiceCT` (`:172-220`), in
 * `platform/fonts/mac/font_matcher_mac.mm` at Chromium tag 147.0.7727.15 —
 * the Chrome build Playwright pins, which is what every capture runs against.
 * (The local `external/chromium` checkout carries a newer, directional
 * comparator that the shipping build does not have; the helper transcribes
 * the tag, not the checkout.) That algorithm lives in the helper (Swift,
 * where AppKit and CoreText are reachable); this is the Node side of the
 * call.
 *
 * It is a DIFFERENT question from `resolveInstalledFont`, which resolves a name
 * to a face and, on macOS, does not run the style match at all. It is also a
 * different question from the per-codepoint fallback's in-family re-selection
 * (`GetAlternateFontPlatformData`, CoreText's own nearest-weight walk), which
 * is not this algorithm and measurably disagrees with it — asked for PingFang
 * SC at CSS 300, CoreText re-selection answers Light where Chrome paints Thin.
 *
 * Returns null when the helper is unavailable, the platform is not macOS, or
 * the family has no AppKit members — in every case the caller must keep the
 * selection it already had.
 *
 * The cache key carries the family AND the style — weight, italic and WIDTH,
 * because the answer is a function of all three: a style-blind key would serve
 * whichever weight asked first to every later caller, which is exactly the
 * defect this call exists to fix.
 */
export function resolveFamilyStyleMatch(
  family: string, style?: { weight?: number; italic?: boolean; stretch?: number },
): FamilyStyleMatch | null {
  if (hostPlatform() !== "darwin" || family === "") return null;
  const weight = style?.weight ?? 400;
  const italic = style?.italic === true;
  // CSS `font-stretch` as a percentage, 100 = `normal`. It reaches the helper as
  // `cssWidth` and lands in Blink's `ComputeDesiredTraits`
  // (`mac/font_matcher_mac.mm:185-202`, rev 7d859f27), which turns any width
  // below 100 into the condensed symbolic trait and any width above it into the
  // expanded one. `BetterChoiceCT` compares condensed before either of its other
  // two masks, so this is the FIRST thing the comparator looks at — a stack
  // asking for a condensed face and a matcher that never hears about it do not
  // disagree slightly, they disagree about which cut of the family to open.
  const stretch = style?.stretch ?? 100;
  const key = `${family.toLowerCase()}|${weight}|${italic ? 1 : 0}|${stretch}`;
  const cached = _familyStyleMatchCache.get(key);
  if (cached !== undefined) return cached;
  let resolved: FamilyStyleMatch | null = null;
  if (isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({ fonts: [], queries: [{ type: "familyMatch", family, cssWeight: weight, italic, cssWidth: stretch }] });
      const r = resp.results[0];
      if (r != null && r.type === "familyMatch" && r.found && r.postscriptName != null && r.postscriptName !== "") {
        const chosen = (r.candidates ?? []).find((c) => c.name === r.postscriptName);
        resolved = {
          postscriptName: r.postscriptName,
          weight: r.weight ?? weight,
          italic: ((chosen?.traits ?? 0) & CT_TRAIT_ITALIC) !== 0,
        };
      }
    } catch {
      // An older helper answers "unknown query type"; keep null so the caller
      // degrades to its existing selection rather than failing.
      resolved = null;
    }
  }
  _familyStyleMatchCache.set(key, resolved);
  return resolved;
}

/** The face a declared family resolves to at one style on Linux (fontconfig). */
export interface LinuxFamilyMatch {
  /** Resolved font file. */
  path: string;
  /** TTC member index — Blink opens the face by file + index. */
  index: number;
  /** PostScript name of the matched face ("" when the face declares none). */
  postscriptName: string;
  /** The matched family name (`FC_FAMILY[0]` of the match). */
  family: string;
  /** The matched face's weight in CSS space, as Skia reports `outStyle`. */
  weight: number;
  /** True when the matched face's fontconfig slant is italic/oblique. */
  italic: boolean;
}

const _linuxFamilyMatchCache = new Map<string, LinuxFamilyMatch | null>();

/**
 * Which CUT of a declared family a run at this style opens — Linux only.
 *
 * This is the same question `resolveFamilyStyleMatch` answers on macOS, decided
 * by entirely different code in Blink: on Linux `FontCache::CreateTypeface`
 * reduces to `skia::DefaultFontMgr()->matchFamilyStyle(name,
 * font_description.SkiaFontStyle())` (`fonts/skia/font_cache_skia.cc`, tag
 * 147.0.7727.15), the Linux font manager is fontconfig-backed
 * (`SkFontMgr_New_FCI`, `skia/ext/font_utils.cc:86-89`), and the whole decision
 * lives in `SkFontConfigInterfaceDirect::matchFamilyName` (Skia rev 62efacd3 —
 * the revision the local Chromium checkout's DEPS:330 pins at rev 7d859f27 —
 * `src/ports/SkFontConfigInterface_direct.cpp:592-713`).
 * The Linux glyph helper carries the transcription (`familyMatch` query,
 * `tools/linux-glyph-extractor/src/main.cpp`); this is the Node side of the call.
 *
 * Returns null when the platform is not Linux, the helper is unavailable or too
 * old to know the query, or the matcher REJECTED the family (fontconfig always
 * returns *something*, so Skia accepts only a face whose family list matches the
 * request, the post-substitution name, or a metric-compatible replacement —
 * rejection is how Blink walks to the next CSS family). In every null case the
 * caller must keep the selection it already had.
 */
export function resolveLinuxFamilyMatch(
  family: string, style?: { weight?: number; italic?: boolean; stretch?: number },
): LinuxFamilyMatch | null {
  // An EMPTY family is a real Blink request, not junk: the terminal rung of
  // `FontCache::GetLastResortFallbackFont` is `legacyMakeTypeface(nullptr,
  // style)` (`fonts/skia/font_cache_skia.cc`, tag 147.0.7727.15), which the
  // FCI font manager forwards to `matchFamilyName(nullptr, …)`
  // (`SkFontMgr_FontConfigInterface.cpp:253-256`, Skia rev 62efacd3) — a
  // pattern with no FC_FAMILY term, which fontconfig matches against
  // everything and `IsFallbackFontAllowed("")` then accepts. The helper's
  // `familyMatch` query mirrors that when `family` is "".
  if (hostPlatform() !== "linux") return null;
  const weight = style?.weight ?? 400;
  const italic = style?.italic === true;
  const stretch = style?.stretch ?? 100;
  const key = `${family.toLowerCase()}|${weight}|${italic ? 1 : 0}|${stretch}`;
  const cached = _linuxFamilyMatchCache.get(key);
  if (cached !== undefined) return cached;
  let resolved: LinuxFamilyMatch | null = null;
  if (isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({ fonts: [], queries: [{ type: "familyMatch", family, cssWeight: weight, italic, cssWidth: stretch }] });
      const r = resp.results[0];
      if (r != null && r.type === "familyMatch" && r.found
          && typeof r.path === "string" && r.path !== "") {
        resolved = {
          path: r.path,
          index: typeof r.index === "number" ? r.index : 0,
          postscriptName: r.postscriptName ?? "",
          family: r.family ?? "",
          weight: r.weight ?? weight,
          italic: r.italic === true,
        };
      }
    } catch {
      // An older helper answers "unknown query type"; keep null so the caller
      // degrades to its existing selection rather than failing.
      resolved = null;
    }
  }
  _linuxFamilyMatchCache.set(key, resolved);
  return resolved;
}

/**
 * Test-only: the RAW `meta` response for a face, so a suite can tell a stale
 * helper binary from a font regression (DM-1873).
 *
 * The binary is a gitignored build artifact, and `isGlyphHelperAvailable()`
 * answers "is one resolvable", not "does it speak the interface this Node side
 * reads" — a fresh worktree resolves the downloaded RELEASE ASSET, which can
 * predate fields added since. When that happens the helper suites do not skip;
 * they run and fail on missing data, and the failures read as a font regression.
 * `--version` cannot distinguish them: it reports a binary version that was not
 * bumped when `nameMatched` / `resolution` were added.
 *
 * Not part of the runtime contract — the renderer treats every field here as
 * optional and degrades correctly on an older binary (see `MetaResponse`).
 */
export function __helperMetaForTest(postscriptName: string): MetaResponse | null {
  if (!isGlyphHelperAvailable()) return null;
  try {
    const resp = callHelper({
      fonts: [{ ref: "f", postscriptName, size: 16 }],
      queries: [{ type: "meta", fontRef: "f" }],
    });
    const r = resp.results[0];
    return r != null && r.type === "meta" ? (r as unknown as MetaResponse) : null;
  } catch {
    return null;
  }
}

/**
 * CoreText's `kCTFontTraitBold` for a face, which is the exact bit Blink's
 * macOS synthetic-bold rule tests: `Weight() > 500 && !(traits & kCTFontTraitBold)`
 * (`mac/font_cache_mac.mm:424-427`, rev 7d859f27).
 *
 * This exists because OS/2 `fsSelection` bit 5 is NOT the same fact, however
 * much it looks like it. `/System/Library/Fonts/Times.ttc` is the case that
 * proved it: every face in the container — Roman, **Bold**, Italic, BoldItalic —
 * reports `fsSelection.regular = true` and `fsSelection.bold = false`, which the
 * OpenType spec forbids (REGULAR is mutually exclusive with BOLD and ITALIC).
 * CoreText answers `traitBold: true` for `Times-Bold` regardless, because it
 * derives the trait from the font's registered traits rather than from that bit.
 *
 * Reading the bit instead made every `serif` heading paint synthetic bold ON TOP
 * of the real Times-Bold cut — visibly heavier than Chrome, 9 diff regions on
 * `20-font-style-variant`.
 *
 * Returns null when the helper is unavailable or the face is unknown, so the
 * caller keeps its previous signal rather than assuming "not bold".
 *
 * **The echoed name is checked, and that check is load-bearing.** CoreText
 * restricts access to the dot-prefixed system faces and silently substitutes
 * `TimesNewRomanPSMT` for them — passing the containing file's path does not
 * lift the restriction. Measured: asking for `.LucidaGrandeUI-Bold`,
 * `.HiraKakuInterface-W7` or `.PingFangUITextSC-Regular` returns Times New
 * Roman's metrics under Times New Roman's name, with `traitBold: false`. Taking
 * that at face value would report 17 genuinely-bold system faces as not-bold and
 * synthesise bold over them — the same defect this function exists to fix, just
 * pointed at a different set of faces. So an answer is only accepted when the
 * helper hands back the face that was asked for.
 */
const _traitBoldCache = new Map<string, boolean | null>();
export function resolveFaceTraitBold(
  postscriptName: string, path?: string,
): boolean | null {
  if (postscriptName === "") return null;
  const key = `${path ?? ""}\0${postscriptName}`;
  const hit = _traitBoldCache.get(key);
  if (hit !== undefined) return hit;
  let out: boolean | null = null;
  if (isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({
        fonts: [{ ref: "f", postscriptName, ...(path != null && path !== "" ? { path } : {}), size: 16 }],
        queries: [{ type: "meta", fontRef: "f" }],
      });
      const r = resp.results[0];
      if (r != null && r.type === "meta") {
        const meta = r as unknown as MetaResponse & { postscriptName?: string };
        const got = meta.postscriptName;
        // Only trust the trait when CoreText opened the face we named. A
        // mismatch means it substituted (see the dot-prefixed note above).
        if (got === postscriptName && typeof meta.traitBold === "boolean") {
          out = meta.traitBold;
        }
      }
    } catch { /* helper failed — keep null so the caller falls back */ }
  }
  _traitBoldCache.set(key, out);
  return out;
}

/**
 * CoreText's `kCTFontTraitItalic` for a face — the mirror of
 * `resolveFaceTraitBold` for the bit Blink's macOS synthetic-oblique rule
 * tests: `matched_font_traits & kCTFontTraitItalic`
 * (`mac/font_cache_mac.mm:431-436`, rev 7d859f27).
 *
 * Same rationale as the bold trait (OS/2 `fsSelection` bit 0 is not
 * trustworthy on its own, and the same dot-prefixed-name substitution risk
 * applies), same echoed-name guard, same null-on-unavailable contract so the
 * caller falls back to its own outline-derived heuristic rather than
 * assuming "not italic".
 */
const _traitItalicCache = new Map<string, boolean | null>();
export function resolveFaceTraitItalic(
  postscriptName: string, path?: string,
): boolean | null {
  if (postscriptName === "") return null;
  const key = `${path ?? ""} ${postscriptName}`;
  const hit = _traitItalicCache.get(key);
  if (hit !== undefined) return hit;
  let out: boolean | null = null;
  if (isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({
        fonts: [{ ref: "f", postscriptName, ...(path != null && path !== "" ? { path } : {}), size: 16 }],
        queries: [{ type: "meta", fontRef: "f" }],
      });
      const r = resp.results[0];
      if (r != null && r.type === "meta") {
        const meta = r as unknown as MetaResponse & { postscriptName?: string };
        const got = meta.postscriptName;
        // Only trust the trait when CoreText opened the face we named. A
        // mismatch means it substituted (see `resolveFaceTraitBold`'s note).
        if (got === postscriptName && typeof meta.traitItalic === "boolean") {
          out = meta.traitItalic;
        }
      }
    } catch { /* helper failed — keep null so the caller falls back */ }
  }
  _traitItalicCache.set(key, out);
  return out;
}

/**
 * Drop ONLY the two memos keyed per codepoint — the CoreText cascade answers and
 * the fontconfig fallback answers.
 *
 * Everything else this module memoizes is keyed by family or by face, so it is
 * bounded by the host's font inventory (hundreds of entries). These two are
 * keyed by `(base face, codepoint, …)` and are therefore unbounded in the
 * codepoint universe: one entry per codepoint per distinct base, kept for the
 * life of the process.
 *
 * That is fine for a render, which touches the codepoints on one page. It is not
 * fine for an exhaustive sweep. Measured: the font-conformance oracle's
 * full-corpus macOS run put 22 stacks × 292,466 codepoints through one process
 * and **four of twenty shards died with `JavaScript heap out of memory`**, while
 * the canonical six-stack slice — one stack per shard, so 292k entries rather
 * than 6.4M — had never shown it. The oracle already trimmed the memos
 * `font-resolution.ts` owns every batch; the ones actually holding the bytes sat
 * one module below and had no caller outside the unit tests.
 *
 * Separate from `clearGlyphHelperCache()` because that one also forgets which
 * helper binary was resolved, which would re-probe the filesystem on every
 * trim. Every dropped entry is a pure function of its key, so this costs
 * re-queries and never a different answer.
 */
export function clearGlyphHelperCodepointMemos(): void {
  _systemFallbackCache.clear();
  _fcFallbackCache.clear();
}

/**
 * How many per-codepoint memo entries are currently retained.
 *
 * Diagnostic only — it exists so "these memos are bounded across a batch reset"
 * is assertable rather than argued. A test that merely calls the clear function
 * and checks nothing would pass against the defect it is guarding, which is how
 * this grew unbounded with a clear function already sitting in the file.
 */
export function glyphHelperCodepointMemoSize(): number {
  let scoped = 0;
  for (const cache of _fcFallbackRendererCaches.values()) scoped += cache.size;
  return _systemFallbackCache.size + _fcFallbackCache.size + scoped;
}

/**
 * Invalidate host-environment-dependent helper state.
 *
 * Resolver memos stay in this facade; helper discovery and the selected
 * persistent/one-shot carrier reset through the transport boundary. Per-font
 * glyph/shape caches die with their adapter instances. The Linux target-strike
 * cache deliberately remains process-lifetime because its key contains exact
 * immutable source identity; see the canonical font-resolution diagram.
 */
export function clearGlyphHelperCache(): void {
  _traitBoldCache.clear();
  _traitItalicCache.clear();
  // Unlike family/style answers, the Windows system-ui family is an OS
  // preference, not a stable inventory fact. `invalidateFontEnvironmentCaches`
  // promises to observe preference-generation changes, so its helper reset must
  // force the next route through SPI_GETNONCLIENTMETRICS again.
  _systemUiFamily = undefined;
  clearGlyphHelperTransport();
  clearGlyphHelperCodepointMemos();
  _installedFontCache.clear();
  _familyStyleMatchCache.clear();
  _linuxFamilyMatchCache.clear();
}
