import { createHash } from "node:crypto";
import { parseCssFontFamilyEntries } from "../font-family-stack.js";
import { getFontSourceInfo, type FontInstance } from "./font-instance.js";
import { callGlyphHelper, isGlyphHelperAvailable } from "./glyph-helper-transport.js";

export type FontRenderHinting = "none" | "slight" | "medium" | "full";

/** Capture and helper share the launch's exact Fontconfig environment.
 * Custom/remote browsers without that evidence omit this record. */
export interface LinuxFontRenderContext {
  source: "shared-fontconfig-v1";
  environmentKey: string;
  singleProcess: boolean;
  launchHinting?: FontRenderHinting;
  deviceScaleFactor: number;
  disableSubpixelPositioning: boolean;
}

export interface LinuxFontRenderStyle {
  hinting: FontRenderHinting;
  forceAutoHint: boolean;
}

/** Fontconfig's documented environment inputs; only their digest persists.
 * Recheck at render time so a changed host environment never reuses evidence. */
export function linuxFontEnvironmentKey(env: NodeJS.ProcessEnv = process.env): string {
  const entries = Object.entries({ ...env, FC_FONTATIONS: "1" })
    .filter(([key]) => /^(?:FONTCONFIG_|FC_|XDG_|LC_)/.test(key) || key === "HOME" || key === "LANG")
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

const styleCache = new WeakMap<FontInstance, Map<string, LinuxFontRenderStyle>>();

/** Resolve the effective font style, keeping unverified identities and older
 * helpers conservative. The family query uses the selected typeface's style,
 * as FontPlatformData::QuerySystemRenderStyle does, not synthetic CSS traits. */
export function linuxFontRenderStyle(
  font: FontInstance,
  request: { fontFamily: string; fontSize: number; fontWeight: number; italic: boolean },
  context: LinuxFontRenderContext | undefined,
): LinuxFontRenderStyle | null {
  if (
    context?.source !== "shared-fontconfig-v1" ||
    context.environmentKey !== linuxFontEnvironmentKey() ||
    !isGlyphHelperAvailable()
  )
    return null;
  if (!(context.deviceScaleFactor > 0) || !Number.isFinite(context.deviceScaleFactor)) return null;
  const key = JSON.stringify([request, context]);
  const cached = styleCache.get(font)?.get(key);
  if (cached != null) return cached;
  let family: string | undefined;
  let bold = false;
  let italic = false;
  try {
    if (!context.singleProcess) {
      const source = getFontSourceInfo(font);
      if (source == null || !source.nameMatched) return null;
      // A generic's concrete Settings family needs nomination provenance; do
      // not substitute the generic keyword into a Fontconfig render query.
      const entries = parseCssFontFamilyEntries(request.fontFamily);
      for (const entry of entries) {
        if (entry.type === "generic-family") return null;
        const response = callGlyphHelper({
          fonts: [],
          queries: [{ type: "familyMatch", family: entry.name, cssWeight: request.fontWeight, italic: request.italic }],
        }).results[0];
        if (response?.type !== "familyMatch" || !response.found) continue;
        if (response.path !== source.path || response.postscriptName !== font.postscriptName) return null;
        if (response.weight == null || response.italic == null) return null;
        family = entry.name;
        bold = response.weight >= 600;
        italic = response.italic;
        break;
      }
      if (family == null) return null;
    }
    const result = callGlyphHelper({
      fonts: [],
      queries: [
        {
          type: "fontRenderStyle",
          family,
          fontSizePx: request.fontSize,
          bold,
          italic,
          deviceScaleFactor: context.deviceScaleFactor,
          disableSubpixelPositioning: context.disableSubpixelPositioning,
        },
      ],
    }).results[0];
    if (
      result?.type !== "fontRenderStyle" ||
      result.error != null ||
      typeof result.forceAutoHint !== "boolean" ||
      result.environment == null ||
      linuxFontEnvironmentKey(result.environment) !== context.environmentKey
    )
      return null;
    const hinting = context.singleProcess ? context.launchHinting : result.hinting;
    if (hinting !== "none" && hinting !== "slight" && hinting !== "medium" && hinting !== "full") return null;
    const style = { hinting, forceAutoHint: result.forceAutoHint };
    const cache = styleCache.get(font) ?? new Map<string, LinuxFontRenderStyle>();
    cache.set(key, style);
    styleCache.set(font, cache);
    return style;
  } catch {
    return null;
  }
}
