import { getFontSourceInfo, type FontInstance } from "./font-instance.js";
import type { MetaResponse } from "./glyph-helper-outline.js";
import { callGlyphHelper, isGlyphHelperAvailable } from "./glyph-helper-transport.js";

/** Decode only a size/face-authenticated, CSS-pixel CoreText answer. */
export function coreTextNormalLineSpacing(
  meta: MetaResponse,
  request: { fontSize: number; postscriptName: string; unitsPerEm: number },
): number | null {
  const metrics = meta.coreTextMetrics;
  if (
    metrics == null ||
    metrics.fontRef !== "normal-line-spacing" ||
    metrics.units !== "css-px" ||
    metrics.fontSizePx !== request.fontSize ||
    metrics.actualSizePx !== Math.fround(request.fontSize) ||
    metrics.nameMatched !== true ||
    meta.nameMatched === false ||
    metrics.postscriptName !== request.postscriptName ||
    meta.postscriptName !== request.postscriptName ||
    metrics.unitsPerEm !== request.unitsPerEm ||
    meta.unitsPerEm !== request.unitsPerEm ||
    typeof metrics.familyName !== "string" ||
    metrics.familyName.length === 0 ||
    !Number.isFinite(request.fontSize) ||
    !(request.fontSize > 0) ||
    !Number.isFinite(metrics.actualSizePx) ||
    !(metrics.actualSizePx > 0)
  )
    return null;
  const { ascent: rawAscent, descent: rawDescent, leading } = metrics;
  // The helper emits SkScalar values, not rounded design-unit metrics.
  if (![rawAscent, rawDescent, leading].every((n) => Number.isFinite(n) && Math.fround(n) === n)) return null;
  if (!(rawAscent >= 0) || !(rawDescent >= 0)) return null;

  // FontMetrics::AscentDescentWithHacks and SimpleFontData::PlatformInit,
  // Chromium 7d859f27. Isolated CSS layout uses the default FontDescription
  // subpixel_ascent_descent=false; the tiny-font exception is for Canvas's
  // explicitly enabled subpixel baseline metrics, not CSS normal line boxes.
  const scalarRound = (n: number): number => Math.floor(Math.fround(n + 0.5));
  let ascent = scalarRound(rawAscent);
  const descent = scalarRound(rawDescent);
  if (metrics.familyName === "Times" || metrics.familyName === "Helvetica" || metrics.familyName === "Courier") {
    const sum = Math.fround(ascent + descent);
    const adjustment = Math.floor(Math.fround(Math.fround(sum * Math.fround(0.15)) + 0.5));
    ascent = Math.fround(ascent + adjustment);
  }
  // lroundf rounds halfway away from zero (leading need not be positive).
  const lround = (n: number): number => (n < 0 ? -Math.floor(-n + 0.5) : Math.floor(n + 0.5));
  const spacing = lround(ascent) + lround(descent) + lround(leading);
  return Number.isSafeInteger(spacing) && spacing >= 0 ? spacing : null;
}

const cache = new WeakMap<FontInstance, Map<number, number>>();

/** CoreText's live CSS-size metrics, including helper-only and optical faces. */
export function darwinNormalLineSpacing(font: FontInstance, fontSize: number): number | null {
  const actualSize = Math.fround(fontSize);
  if (!Number.isFinite(actualSize) || actualSize <= 0) return null;
  const source = getFontSourceInfo(font);
  if (source == null || !source.nameMatched || !isGlyphHelperAvailable()) return null;
  // Base file routes may omit a requested PS name; the selected fontkit
  // member still supplies one, which the native file-open must verify.
  const postscriptName = source.postscriptName ?? font.postscriptName;
  if (postscriptName == null || postscriptName === "") return null;
  const cached = cache.get(font)?.get(actualSize);
  if (cached != null) return cached;
  try {
    // PingFang's installed named handle differs from its reserved physical
    // TTC member, as in nativeMacMetrics. Keep hidden names on the file route.
    const namedPingFang = postscriptName.startsWith("PingFangSC-");
    const response = callGlyphHelper({
      fonts: [
        {
          ref: "normal-line-spacing",
          fontPath: namedPingFang ? undefined : source.path,
          postscriptName,
          variations: namedPingFang ? undefined : (source.variationAxes ?? undefined),
          size: actualSize,
        },
      ],
      queries: [{ type: "meta", fontRef: "normal-line-spacing", fontSizePx: fontSize }],
    });
    const meta = response.results[0];
    if (meta?.type !== "meta") return null;
    const spacing = coreTextNormalLineSpacing(meta, {
      fontSize,
      postscriptName,
      unitsPerEm: font.unitsPerEm,
    });
    if (spacing != null) {
      const sizes = cache.get(font) ?? new Map<number, number>();
      if (sizes.size >= 32) sizes.clear();
      sizes.set(actualSize, spacing);
      cache.set(font, sizes);
    }
    return spacing;
  } catch {
    // Older/unavailable helpers leave the existing file-metric fallback intact.
    return null;
  }
}
