import { hostPlatform } from "./host-platform.js";
import { invokeSynchronousCallback, type SynchronousCallback } from "./synchronous-scope.js";
import {
  beginFcFallbackRendererScope,
  endFcFallbackRendererScope,
  selectFcFallbackRendererScope,
} from "./glyph-helper.js";
import { isIdeographicCp } from "./unicode-classification.js";

/**
 * DM-1949: the macOS per-character fallback cache for ideographs — Blink's
 * `character_fallback_cache_`, modeled as DOCUMENT-scoped ordered state.
 *
 * Blink (mac/font_cache_mac.mm:330-372, checkout rev 7d859f27, byte-identical
 * at shipping tag 147.0.7727.15, where the `MacCharacterFallbackCache` runtime
 * feature is `status: "stable"` — i.e. ON in the Chrome we target): for a
 * codepoint with the Unicode property [:Ideographic=Yes:], the result of the
 * system-fallback ask (`GetAlternateFontPlatformData` — the CoreText cascade
 * plus the in-family traits/weight re-selection) is cached under
 * `CharacterFallbackKey` and returned for any LATER ideograph the cached face
 * covers, without re-asking CoreText. Blink's own comment names the cost: it
 * "can introduce context sensitivity of fallback for individual characters."
 * So Chrome's answer for an ideograph depends on which ideograph asked FIRST
 * in that renderer — and matching Chrome means modeling that order.
 *
 * Transcribed semantics, each load-bearing:
 *
 *  - KEY (`CharacterFallbackKey::Make`, mac/character_fallback_cache.mm:86-105):
 *    the BASE font's PostScript name + raw weight + raw style + orientation +
 *    effective font size. The base is the run's primary
 *    (`font_fallback_list_->PrimarySimpleFontDataWithSpace(...)`,
 *    shaping/font_fallback_iterator.cc:279-281 at tag 147.0.7727.15) — our
 *    `fallbackBaseFor(primaryKey).name`. The key retains the raw style slope
 *    and orientation independently of the compatibility slant bit used by
 *    other resolver paths.
 *  - NO KEY for dot-prefixed faces (`BuildIdentifierKey`,
 *    character_fallback_cache.mm:36-82): a `.`-PS-named font yields a key only
 *    when its descriptor carries BOTH `NSCTFontUIUsageAttribute` and
 *    `CTFontDescriptorLanguageAttribute`. Blink builds the UI font with
 *    `CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, size, nullptr)`
 *    (mac/font_matcher_mac.mm:540-588), and with a null language the descriptor
 *    has NO language attribute (probed with the identical API call: keys are
 *    ["NSCTFontUIUsageAttribute", "NSFontSizeAttribute"]) — so a `system-ui`
 *    base is NEVER cached in shipping Chrome, and must not be here either.
 *  - HIT = cached face covers the codepoint (`unicharToGlyph(character)`,
 *    font_cache_mac.mm:361-366) — a cmap check on the CACHED face, at the same
 *    weight/size/slant the key pins.
 *  - FIRST WRITER WINS: the insert is WTF `HashMap::insert`, which "does
 *    nothing if key is already present" (wtf/hash_map.h:184-188 at tag
 *    147.0.7727.15). A later ideograph the cached face does not cover re-asks
 *    CoreText every time and NEVER replaces the entry. Only successful asks
 *    insert (`if (!alternate_font) return nullptr` precedes it).
 *
 * SCOPE — the part that is deliberately different from every other cache in
 * this module. Blink's map lives on `FontCache` (font_cache.h:338), reached via
 * `FontCache::Get()` → `FontGlobalContext::GetFontCache()` (font_cache.cc:121)
 * — per renderer main thread, including same-renderer navigation. Modeling
 * it process-globally would make answers depend on unrelated sweep order;
 * an explicit FontRendererSession owns reuse across documents. Therefore:
 *
 *  - The map exists ONLY between `beginCharacterFallbackDocument()` /
 *    `endCharacterFallbackDocument()`. No active document → no lookup, no
 *    insert — the resolver stays context-free exactly as before.
 *  - A top-level render opens a fresh document scope (depth-counted,
 *    `finally`-paired). Without an owned renderer session it gets a fresh map;
 *    with one it reuses that session's map across document scopes. The animator
 *    opens one scope spanning its frames.
 *  - `clearFontResolutionCaches()` does NOT clear it: it is modeled state, not
 *    a memo — Chrome's cache is not dropped when our sweep trims memory. The
 *    entries are key strings; the faces they name re-materialize through the
 *    `dynamicSystemFontPaths` registry, which that reset also preserves. (`invalidateFontEnvironmentCaches` clears
 *    both, together.)
 *
 * The value stored is the final resolved `sysfb:` key — the post-re-selection
 * answer, exactly what Blink caches (the `FontPlatformData` AFTER
 * `GetAlternateFontPlatformData`'s in-family re-selection).
 *
 * Set `DOMOTION_MAC_CHAR_FALLBACK_CACHE=0` to disable the model for an A/B —
 * with it off, every ideograph resolves context-free (the pre-DM-1949
 * behavior), which is how "is this mechanism actually in the loop" is checked.
 */
const _macCharFallbackCacheEnabled = process.env.DOMOTION_MAC_CHAR_FALLBACK_CACHE !== "0";

export let _charFallbackDocCache: Map<string, string> | null = null;
// Blink's short-text shape result cache is held by the primary font data. A
// primary-only .notdef result can therefore outlive the element that shaped it.
// Keep the observed macOS and Windows compatibility-ideograph slices in the
// same explicit renderer/document lifetime as the character fallback model.
let primaryNotdefShapeCache: Set<string> | null = null;

let _charFallbackDocDepth = 0;

/** The renderer session the open document scope was begun under (null = anonymous). */
let _charFallbackDocSession: FontRendererSession | null = null;

export interface FontRendererSession {
  readonly _fontRendererSession: symbol;
}

export let _charFallbackRendererCaches = new WeakMap<FontRendererSession, Map<string, string>>();
let primaryNotdefRendererCaches = new WeakMap<FontRendererSession, Set<string>>();
export function resetCharacterFallbackRendererCaches(): void {
  _charFallbackRendererCaches = new WeakMap();
  primaryNotdefRendererCaches = new WeakMap();
}

let _requestedCharFallbackRendererSession: FontRendererSession | null = null;

export function createFontRendererSession(): FontRendererSession {
  return Object.freeze({ _fontRendererSession: Symbol("font-renderer-session") });
}

/** Select a renderer lifetime only for the synchronous render callback. */
export function withFontRendererSession<F extends () => unknown>(
  session: FontRendererSession,
  render: SynchronousCallback<F>,
): ReturnType<F> {
  // An open document already owns its fallback cache; a different session
  // requested inside it could only be ignored, so say so instead.
  if (_charFallbackDocDepth > 0 && _charFallbackDocSession !== session) {
    throw new Error("Cannot switch font renderer sessions inside an open character-fallback document");
  }
  const previous = _requestedCharFallbackRendererSession;
  _requestedCharFallbackRendererSession = session;
  try {
    return invokeSynchronousCallback("withFontRendererSession", render);
  } finally {
    _requestedCharFallbackRendererSession = previous;
  }
}

/** Open a document scope for the ideograph fallback cache (nested calls share
 *  the outermost scope). Pair with `endCharacterFallbackDocument` in `finally`. */
export function beginCharacterFallbackDocument(): void {
  if (_charFallbackDocDepth === 0) {
    const rendererSession = _requestedCharFallbackRendererSession;
    _charFallbackDocSession = rendererSession;
    if (rendererSession == null) {
      _charFallbackDocCache = new Map();
      primaryNotdefShapeCache = new Set();
    } else {
      let cache = _charFallbackRendererCaches.get(rendererSession);
      if (cache == null) {
        cache = new Map();
        _charFallbackRendererCaches.set(rendererSession, cache);
      }
      _charFallbackDocCache = cache;
      let shapeCache = primaryNotdefRendererCaches.get(rendererSession);
      if (shapeCache == null) {
        shapeCache = new Set();
        primaryNotdefRendererCaches.set(rendererSession, shapeCache);
      }
      primaryNotdefShapeCache = shapeCache;
    }
    beginFcFallbackRendererScope();
  }
  _charFallbackDocDepth++;
}

/** Close the current document scope; the outermost close drops the state. */
export function endCharacterFallbackDocument(): void {
  if (_charFallbackDocDepth > 0) _charFallbackDocDepth--;
  if (_charFallbackDocDepth === 0) {
    _charFallbackDocCache = null;
    primaryNotdefShapeCache = null;
    _charFallbackDocSession = null;
    endFcFallbackRendererScope();
  }
}

/** Only the observed one-scalar canonical CJK compatibility forms enter this
 * model. Other primary-missing text awaits direct browser transition evidence. */
export function primaryNotdefShapeKey(
  text: string,
  primaryIdentity: string,
  weight: number,
  fontSize: number,
  slant: number,
  stretch: number,
  variationSettings: Record<string, number> | undefined,
  features: string[] | undefined,
  direction: "ltr" | "rtl" = "ltr",
): string | null {
  const platform = hostPlatform();
  if ((platform !== "darwin" && platform !== "win32") || primaryNotdefShapeCache == null) return null;
  // Chromium 147's NGShapeCache lives on SimpleFontData, splits LTR/RTL maps,
  // and only admits text up to 30 UTF-16 units with initial font features.
  // `chws` is Blink's default Text 4 spacing feature in this renderer, so it
  // does not by itself make the feature set noninitial.
  if (text.length > 30 || features?.some((feature) => feature !== "chws")) return null;
  // The macOS same-page matrix found the transition for three generics. The
  // hosted Windows forward/reverse/fresh-context matrix established it for
  // system-ui; other Windows generics remain outside this measured slice.
  if (platform === "darwin") {
    if (!/^(?:system-ui|fantasy|monospace)\|/.test(primaryIdentity)) return null;
  } else if (!primaryIdentity.startsWith("system-ui|")) {
    return null;
  }
  const cp = text.codePointAt(0);
  if (cp == null || String.fromCodePoint(cp) !== text) return null;
  if (!((cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f))) return null;
  const canonical = text.normalize("NFD");
  if (canonical === text || [...canonical].length !== 1) return null;
  return JSON.stringify([
    primaryIdentity,
    weight,
    fontSize,
    slant,
    stretch,
    variationSettings ?? null,
    direction,
    text,
  ]);
}

export function hasPrimaryNotdefShape(key: string | null): boolean {
  return key != null && (primaryNotdefShapeCache?.has(key) ?? false);
}

export function recordPrimaryNotdefShape(key: string | null): void {
  if (key != null) primaryNotdefShapeCache?.add(key);
}

/** Conformance-only mirror of an explicit Chromium GC after old probe cells
 * are removed. The macOS character-fallback cache is independent and remains
 * live across this reset. */
export function clearPrimaryNotdefShapesAfterOracleGc(): void {
  primaryNotdefShapeCache?.clear();
}

/** Oracle seam: select the renderer cache corresponding to an isolated context. */
export function selectCharacterFallbackRendererScope(key: string): void {
  // The named scope is retained for the Linux fontconfig oracle. Darwin
  // production rendering uses owned FontRendererSession objects above.
  selectFcFallbackRendererScope(key);
}

/** Test/oracle lifecycle: discard all remembered renderer identities. */
export function clearCharacterFallbackRendererScopesForTest(): void {
  _requestedCharFallbackRendererSession = null;
}

/** Test-only window into the active document cache (null when none is open). */
export function __characterFallbackDocumentCacheForTest(): Map<string, string> | null {
  return _charFallbackDocCache;
}

/**
 * The `CharacterFallbackKey` for this ask, or null when Blink would not cache:
 * no open document, feature off, not [:Ideographic=Yes:], not the darwin path,
 * or a base whose key `BuildIdentifierKey` declines (dot-prefixed / UI font —
 * see the block comment above for the probe establishing the UI font has no
 * language attribute, hence no key).
 */
function characterFallbackIdentity(
  baseName: string,
  weight: number,
  rawSlope: number,
  orientation: number,
  fontSize: number,
): string {
  // FontSelectionValue is a signed quarter-unit fixed-point value. Preserve
  // that raw identity so distinct oblique angles cannot share Blink's entry.
  const rawWeight = fontSelectionRawValue(weight);
  const rawStyle = fontSelectionRawValue(rawSlope);
  return `${baseName}|${rawWeight}|${rawStyle}|${orientation}|${fontSize}`;
}

function fontSelectionRawValue(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value * 4)));
}

/** Pure key seam for the pinned CharacterFallbackKey mutation matrix. */
export function __characterFallbackIdentityForTest(
  baseName: string,
  weight: number,
  rawSlope: number,
  orientation: number,
  fontSize: number,
): string {
  return characterFallbackIdentity(baseName, weight, rawSlope, orientation, fontSize);
}

export function characterFallbackDocKey(
  cp: number,
  baseName: string,
  useSystemUiBase: boolean,
  weight: number,
  rawSlope: number,
  orientation: number,
  fontSize: number,
): string | null {
  if (_charFallbackDocCache == null || !_macCharFallbackCacheEnabled) return null;
  if (hostPlatform() !== "darwin") return null;
  if (useSystemUiBase || baseName.startsWith(".")) return null;
  if (!isIdeographicCp(cp)) return null;
  return characterFallbackIdentity(baseName, weight, rawSlope, orientation, fontSize);
}
