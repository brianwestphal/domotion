import { getFontSourceInfo, type FontInstance } from "./font-instance.js";
import type { DirectWriteFontMetrics } from "./glyph-helper-outline.js";
import { callGlyphHelper, isGlyphHelperAvailable } from "./glyph-helper-transport.js";

/** Blink simple_font_data.cc:168-176 + Skia's float metric arithmetic. */
export function directWriteLineSpacing(
  metrics: DirectWriteFontMetrics | undefined,
  fontSize: number,
  unitsPerEm: number,
  postscriptName?: string,
): number | null {
  if (
    metrics == null ||
    !Number.isFinite(fontSize) ||
    !(fontSize > 0) ||
    metrics.fontSizePx !== fontSize ||
    metrics.unitsPerEm !== unitsPerEm ||
    !(unitsPerEm > 0) ||
    typeof metrics.postscriptName !== "string" ||
    metrics.postscriptName.length === 0 ||
    (postscriptName != null && metrics.postscriptName !== postscriptName) ||
    !["natural", "gdi-classic"].includes(metrics.measuringMode) ||
    !Number.isFinite(metrics.renderSizePx) ||
    !(metrics.renderSizePx > 0) ||
    !Number.isFinite(metrics.ascent) ||
    !(metrics.ascent > 0) ||
    !Number.isFinite(metrics.descent) ||
    !(metrics.descent <= 0) ||
    !Number.isFinite(metrics.lineGap)
  )
    return null;
  const scale = (value: number): number =>
    Math.fround(Math.fround(Math.fround(metrics.renderSizePx) * Math.fround(value)) / Math.fround(unitsPerEm));
  const ascent = scale(metrics.ascent);
  const descent = scale(-metrics.descent);
  const leading = scale(metrics.lineGap);
  if (![ascent, descent, leading].every(Number.isFinite)) return null;
  // Preserve the existing conservative fallback for Blink's tiny-font branch.
  if (ascent < 3 || ascent + descent < 2) return null;
  // Line gap uses lroundf, which rounds a negative half away from zero.
  const roundedLeading = leading < 0 ? -Math.round(-leading) : Math.round(leading);
  // sk_float_round casts its float input to double before adding 0.5.
  return Math.round(ascent) + Math.round(descent) + roundedLeading;
}

const cache = new WeakMap<FontInstance, Map<number, DirectWriteFontMetrics>>();

/** Native metrics retain helper-only and bitmap faces without a fontkit reopen. */
export function windowsNativeLineSpacing(font: FontInstance, fontSize: number): number | null {
  if (!Number.isFinite(fontSize) || !(fontSize > 0)) return null;
  const read = (metrics: DirectWriteFontMetrics | undefined): number | null =>
    directWriteLineSpacing(metrics, fontSize, font.unitsPerEm, font.postscriptName);
  const attached = read(font.directWriteMetrics);
  if (attached != null) return attached;
  const hit = read(cache.get(font)?.get(fontSize));
  if (hit != null) return hit;
  const source = getFontSourceInfo(font);
  if (source == null || !source.nameMatched || !isGlyphHelperAvailable()) return null;
  // Canonical single-file routes need not name a PS member in their path spec;
  // fontkit still identifies the face it actually opened.
  const expectedName = source.postscriptName ?? font.postscriptName;
  if (expectedName == null || expectedName === "") return null;
  try {
    const response = callGlyphHelper({
      fonts: [
        {
          ref: "primary",
          fontPath: source.path,
          postscriptName: expectedName,
          size: font.unitsPerEm,
          ...(source.variationAxes == null ? {} : { variations: source.variationAxes }),
        },
      ],
      queries: [{ type: "meta", fontRef: "primary", fontSizePx: fontSize }],
    });
    const meta = response.results[0];
    if (
      meta?.type !== "meta" ||
      meta.nameMatched === false ||
      meta.postscriptName !== expectedName ||
      meta.unitsPerEm !== font.unitsPerEm
    )
      return null;
    const value = read(meta.directWriteMetrics);
    if (value == null || meta.directWriteMetrics == null) return null;
    let bySize = cache.get(font);
    if (bySize == null) cache.set(font, (bySize = new Map()));
    bySize.set(fontSize, meta.directWriteMetrics);
    return value;
  } catch {
    // Older helpers leave the existing exact-file/conservative fallback intact.
    return null;
  }
}
