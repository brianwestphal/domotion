/**
 * The primary font metrics of an element in an isolated document (an `<img>`
 * SVG image), for the font-relative units `ex` / `cap` / `ch` / `ic`
 * (chromium 7d859f27).
 *
 * `CSSToLengthConversionData::FontSizes` (`core/css/css_to_length_conversion_
 * data.cc:101-195`) reads them from `Font::PrimaryFont()` /
 * `PrimaryFontWithDigitZero()` / `PrimaryFontWithCjkWater()`. For system fonts
 * all three are the first font data of the family list
 * (`FontFallbackList::DeterminePrimarySimpleFontDataCore`, `platform/fonts/
 * font_fallback_list.cc:88-128`: the lookup character only skips a
 * `unicode-range` segment), i.e. the same face `resolveFont` gives the text
 * pipeline. An SVG image's page has none of the embedding page's `@font-face`
 * rules, so the family list is resolved with no registered webfonts or local
 * aliases; the generic families follow the session's settings, which the
 * image page copies (`IsolatedSVGDocumentHost::CopySettingsFrom`,
 * `core/svg/graphics/isolated_svg_document_host.cc:178-189`).
 */
import { resolveFont } from "./family-match.js";
import type { FontInstance } from "./font-instance.js";
import { ITALIC_SLNT } from "./font-paths.darwin.js";
import { hostPlatform } from "./host-platform.js";
import { emptyFontRegistrations, restoreFontRegistrations, snapshotFontRegistrations } from "./webfont-registry.js";

export interface IsolatedPrimaryFontRequest {
  /** The computed `font-family` list (empty for the initial standard family). */
  fontFamily: string;
  /** The computed font size in px. */
  fontSize: number;
  /** The computed `font-weight` as a number (400 = normal). */
  fontWeight: number;
  /** True for `italic` / `oblique`. */
  italic: boolean;
  /** The element's content language, when it has one. */
  lang?: string;
}

/**
 * The primary font's metrics in px. `xHeight` / `capHeight` are null when the
 * platform value is not reproducible from the font file (the caller must not
 * guess); `zeroWidth` / `ideographicAdvance` are null when the face has no
 * glyph for `0` / U+6C34, where Blink's own fallbacks apply.
 */
export interface IsolatedPrimaryFontMetrics {
  /** `FontMetrics::XHeight`. */
  xHeight: number | null;
  /** `FontMetrics::CapHeight`. */
  capHeight: number | null;
  /** The advance of the `0` glyph (`ZeroInlineSize`). */
  zeroWidth: number | null;
  /** The horizontal advance of U+6C34 (`IdeographicAdvanceWidth`). */
  ideographicAdvance: number | null;
}

type Metric = "x-height" | "cap-height" | "zero" | "water";

interface Os2Heights {
  version?: number;
  xHeight?: number;
  capHeight?: number;
}

/**
 * One metric in font units, transcribed from the platform's Skia scaler at
 * the revision chromium 7d859f27 pins (skia 62efacd3):
 * - Apple: Skia takes OS/2 v2 `sxHeight` / `sCapHeight` when nonzero and below
 *   2 upem, else `CTFontGetXHeight` / `CTFontGetCapHeight`
 *   (`SkScalerContext_mac_ct.cpp:696-738`). Blink then replaces a nonzero
 *   x-height with the top of the `x` glyph's path bounds
 *   (`simple_font_data.cc:145-161`, `skia/skia_text_metrics.cc:125-146`).
 *   CoreText's own values are not derivable from the file, so a face without
 *   the OS/2 v2 value has no cap height here.
 * - FreeType: `sxHeight` (any OS/2 version), else the `x` outline's top; OS/2
 *   v2 `sCapHeight`, else the `H` outline's top (`SkFontHost_FreeType.cpp:
 *   1576-1634`). Skia reads a hinted control box; this reads the unhinted
 *   outline bounds.
 * - DirectWrite: `DWRITE_FONT_METRICS` (`SkScalerContext_win_dw.cpp:1873-1874`),
 *   which this reads from OS/2 v2 only.
 * - `0` / U+6C34: the glyph's advance (`ZeroInlineSize`, `IdeographicAdvanceWidth`,
 *   `simple_font_data.cc:435-445, 557-575`).
 */
function metricUnits(font: FontInstance, metric: Metric, platform: string): number | null {
  const glyph = (codePoint: number) => {
    const found = font.glyphForCodePoint(codePoint) as {
      id: number;
      bbox?: { maxY: number };
      advanceWidth?: number;
    } | null;
    return found != null && found.id !== 0 ? found : null;
  };
  const positive = (n: number | undefined): number | null =>
    n != null && Number.isFinite(n) && n > 0 && n < 2 * font.unitsPerEm ? n : null;
  const os2 = (font as { "OS/2"?: Os2Heights })["OS/2"];
  const v2 = os2 != null && os2.version != null && os2.version >= 2 && os2.version !== 0xffff;
  switch (metric) {
    case "x-height":
      if (platform === "darwin") return positive(glyph(0x78)?.bbox?.maxY);
      if (platform === "win32") return v2 ? positive(os2?.xHeight) : null;
      return positive(os2?.xHeight) ?? positive(glyph(0x78)?.bbox?.maxY);
    case "cap-height":
      if (platform === "darwin" || platform === "win32") return v2 ? positive(os2?.capHeight) : null;
      return (v2 ? positive(os2?.capHeight) : null) ?? positive(glyph(0x48)?.bbox?.maxY);
    case "zero":
      return positive(glyph(0x30)?.advanceWidth);
    case "water":
      return positive(glyph(0x6c34)?.advanceWidth);
  }
}

/** Resolve the primary face of `request` with no caller-registered fonts, or
 *  null when no face resolves. */
export function isolatedPrimaryFontMetrics(request: IsolatedPrimaryFontRequest): IsolatedPrimaryFontMetrics | null {
  const saved = snapshotFontRegistrations();
  restoreFontRegistrations(emptyFontRegistrations());
  try {
    const font = resolveFont(
      request.fontFamily,
      request.fontWeight,
      request.fontSize,
      request.italic ? ITALIC_SLNT : 0,
      undefined,
      100,
      request.lang,
    );
    if (font == null) return null;
    if (!(font.unitsPerEm > 0)) return null;
    const platform = hostPlatform();
    const px = (metric: Metric): number | null => {
      const units = metricUnits(font, metric, platform);
      return units == null ? null : (units / font.unitsPerEm) * request.fontSize;
    };
    return {
      xHeight: px("x-height"),
      capHeight: px("cap-height"),
      zeroWidth: px("zero"),
      ideographicAdvance: px("water"),
    };
  } finally {
    restoreFontRegistrations(saved);
  }
}
