/**
 * Process-wide font-spec registry: the per-platform resolved-spec memo and the
 * dynamic `sysfb:` / `winfam:` keys the live resolvers register at runtime.
 * Shared by every platform's resolution path; kept as a leaf module (type-only
 * imports) so the platform path tables, `font-spec.ts`, and the resolvers can
 * all depend on it without an import cycle.
 */
import type { FontPath } from "./font-paths.darwin.js";
import type { DarwinHandleAxis } from "./font-instance.js";

// Resolved-path cache, keyed `<platform>|<logical font key>` (see
// `resolvedSpecMemoKey`). Holds the platform-specific FontPath (or null when the
// key has no mapping / file on this host). The fc-match shell-out on Linux is
// the main thing this avoids repeating.
export const resolvedSpecCache = new Map<string, FontPath | null>();

/** The `resolvedSpecCache` key for `key` as resolved for `platform`. The answer
 *  is per-platform, so the platform is part of the key; see `resolveFontSpec`. */
export function resolvedSpecMemoKey(platform: string, key: string): string {
  return `${platform}|${key}`;
}

/**
 * Forget every platform's memoized answer for `key`.
 *
 * Deleting the bare `key` matched nothing, because entries are stored under
 * `resolvedSpecMemoKey(platform, key)`: a `sysfb:` key resolved (to `null`)
 * before its face was registered stayed `null` for the rest of the process.
 * The platform component is never a `|`-containing string, so the logical key
 * is everything after the first `|`.
 */
export function forgetResolvedSpec(key: string): void {
  for (const memoKey of resolvedSpecCache.keys()) {
    const bar = memoKey.indexOf("|");
    if (bar >= 0 && memoKey.slice(bar + 1) === key) resolvedSpecCache.delete(memoKey);
  }
}

// DM-1018: dynamic font specs registered at runtime by the CoreText system-
// fallback resolver (`resolveSystemFallbackKeyForCp`). Keyed `sysfb:<psName>`.
// These point at on-disk fonts CTFontCreateForString picked that aren't in the
// static FONT_PATHS table (e.g. Mplus 1p for Kana Supplement). Checked by
// resolveFontSpec before the platform tables so the dynamic key resolves.
export const dynamicSystemFontPaths = new Map<string, FontPath>();

/** DM-1018: register a CoreText-resolved on-disk font under a `sysfb:<psName>`
 *  key so getFontInstance / resolveFontSpec can open it. `extractor: native`
 *  routes through the CoreText helper (handles hvgl / GSUB-crashing faces and
 *  the `.notdef` extraction), and the path lets the helper open the exact file
 *  CoreText chose. No-op if already registered. */
export function registerDynamicSystemFont(
  key: string,
  path: string,
  postscriptName: string,
  extractor: "fontkit" | "native" = "native",
  resolvedAxes?: Record<string, number>,
  ctAxes?: DarwinHandleAxis[],
  /** DM-2017: fontconfig's own bold/italic classification of this face, from
   *  the Linux `fcfallback` live resolver only — see
   *  `FontPath.linuxFallbackIsBold` / `linuxFallbackIsItalic`. */
  linuxFallbackIsBold?: boolean,
  linuxFallbackIsItalic?: boolean,
  faceIndex?: number,
): void {
  if (dynamicSystemFontPaths.has(key)) return;
  dynamicSystemFontPaths.set(key, {
    path,
    postscriptName,
    extractor,
    resolvedAxes,
    ctAxes,
    linuxFallbackIsBold,
    linuxFallbackIsItalic,
    faceIndex,
  });
  forgetResolvedSpec(key); // in case a prior null was cached, under any platform
}
