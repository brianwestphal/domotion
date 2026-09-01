/**
 * Linux target-size strike extraction.
 *
 * The cache is process-lifetime and keyed by immutable source identity
 * (path/member/name/axes/size). It intentionally survives ordinary memory trims
 * and font-environment invalidation, matching the contract in the font diagram.
 */

import { hostPlatform } from "./host-platform.js";
import { parseSvgPath, type PathCommand } from "./glyph-helper-outline.js";
import {
  callGlyphHelper as callHelper,
  isGlyphHelperAvailable,
} from "./glyph-helper-transport.js";

export interface LinuxTargetStrikeGlyph {
  id: number;
  /** The same FreeType face/gid in unscaled design units. */
  designCommands: PathCommand[];
  /** FreeType's hinted outline in 26.6 pixel coordinates, y-up. */
  commands: PathCommand[];
}

const linuxTargetStrikeCache = new Map<string, Map<number, LinuxTargetStrikeGlyph | null>>();

/**
 * Ask the Linux helper for Skia-equivalent target-size outlines. This is a
 * deliberately narrow terminal-mask seam: it does not select a host font at
 * playback, alter shaping, or consume hinted advances. The source face and gid
 * were already resolved at capture time; only its target-size outline is read.
 *
 * Returns null on non-Linux hosts, an unavailable/older helper, or any protocol
 * failure. Callers must preserve their existing embedded-font path in that case.
 */
export function linuxTargetStrikeGlyphs(
  spec: {
    postscriptName?: string;
    fontPath: string;
    faceIndex: number;
    variations?: Record<string, number> | null;
  },
  fontSizePx: number,
  glyphIds: number[],
): Map<number, LinuxTargetStrikeGlyph> | null {
  if (hostPlatform() !== "linux" || !isGlyphHelperAvailable() || !(fontSizePx > 0)) return null;
  const variationKey = spec.variations == null
    ? ""
    : Object.keys(spec.variations).sort().map((tag) => `${tag}=${spec.variations![tag]}`).join(",");
  const cacheKey = `${spec.fontPath}#${spec.faceIndex}|${spec.postscriptName ?? ""}|${fontSizePx}|${variationKey}|slight`;
  let cache = linuxTargetStrikeCache.get(cacheKey);
  if (cache == null) {
    cache = new Map();
    linuxTargetStrikeCache.set(cacheKey, cache);
  }
  const uniqueIds = [...new Set(glyphIds)];
  const missing = uniqueIds.filter((id) => !cache!.has(id));
  if (missing.length > 0) {
    try {
      const response = callHelper({
        fonts: [{
          ref: "f",
          postscriptName: spec.postscriptName,
          fontPath: spec.fontPath,
          size: fontSizePx,
          ...(spec.variations == null ? {} : { variations: spec.variations }),
        }],
        queries: [
          { type: "glyphs", fontRef: "f", glyphs: missing.map((id) => ({ id })) },
          {
            type: "hintedGlyphs",
            fontRef: "f",
            fontSizePx,
            hintStyle: "slight",
            forceAutoHint: false,
            useBitmaps: true,
            glyphs: missing.map((id) => ({ id })),
          },
        ],
      });
      const designResult = response.results[0];
      const result = response.results[1];
      if (designResult?.type !== "glyphs"
          || result?.type !== "hintedGlyphs" || result.error != null || result.glyphs == null
          || result.coordinateScale !== 64 || result.fontSizePx !== fontSizePx) return null;
      for (let index = 0; index < missing.length; index++) {
        const designGlyph = designResult.glyphs[index];
        const glyph = result.glyphs[index];
        cache.set(missing[index], glyph == null || designGlyph == null
          || glyph.id !== missing[index] || designGlyph.id !== missing[index]
          ? null
          : {
            id: glyph.id,
            designCommands: parseSvgPath(designGlyph.d),
            commands: parseSvgPath(glyph.d),
          });
      }
    } catch {
      return null;
    }
  }
  const out = new Map<number, LinuxTargetStrikeGlyph>();
  for (const id of uniqueIds) {
    const glyph = cache.get(id);
    if (glyph == null) return null;
    out.set(id, glyph);
  }
  return out;
}
