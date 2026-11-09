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
import { readFileSync } from "node:fs";
import { resolveFont } from "./family-match.js";
import { getFontSourceInfo, type FontInstance } from "./font-instance.js";
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
  /** Blink's rounded `FontMetrics::LineSpacing` for `line-height: normal`. */
  lineSpacing: number | null;
}

type Metric = "x-height" | "cap-height" | "zero" | "water";

/**
 * macOS Skia reads CoreText ascent, descent, and leading; for file-backed
 * OpenType faces CoreText uses the hhea values exposed by fontkit. Blink rounds
 * each Skia component separately and adds its Times/Helvetica/Courier ascent
 * adjustment before storing LineSpacing (simple_font_data.cc:168-176 and
 * font_metrics.cc:102-144, Chromium 7d859f27; SkScalerContext_mac_ct.cpp:
 * 688-691, Skia 62efacd3). A helper-only face has no hhea answer here.
 * Linux FreeType uses OS/2 typo metrics when USE_TYPO_METRICS is set, otherwise
 * hhea; Blink can replace ascent/descent with a VDMX strike. Windows'
 * DirectWrite metrics remain unresolved.
 */
export function normalLineSpacing(font: FontInstance, fontSize: number, platform: string): number | null {
  if (platform !== "darwin" && platform !== "linux") return null;
  const face = font as FontInstance & {
    lineGap?: number;
    familyName?: string;
    "OS/2"?: {
      version?: number;
      fsSelection?: number | { useTypoMetrics?: boolean };
      typoAscender?: number;
      typoDescender?: number;
      typoLineGap?: number;
    };
  };
  const os2 = face["OS/2"];
  const useTypo =
    platform === "linux" &&
    os2?.version !== 0xffff &&
    (typeof os2?.fsSelection === "number" ? (os2.fsSelection & 0x80) !== 0 : os2?.fsSelection?.useTypoMetrics === true);
  const ascentUnits = useTypo ? os2?.typoAscender : face.ascent;
  const descentUnits = useTypo ? os2?.typoDescender : face.descent;
  const gapUnits = useTypo ? os2?.typoLineGap : face.lineGap;
  if (gapUnits == null || !Number.isFinite(gapUnits)) return null;
  if (ascentUnits == null || descentUnits == null || !(ascentUnits > 0) || !(descentUnits < 0)) return null;
  const scaled = (units: number): number => Math.fround((Math.fround(units) * Math.fround(fontSize)) / font.unitsPerEm);
  const rawAscent = scaled(ascentUnits);
  const rawDescent = scaled(-descentUnits);
  // Blink may retain subpixel ascent/descent instead of rounding at tiny sizes.
  if (rawAscent < 3 || rawAscent + rawDescent < 2) return null;
  let ascent = Math.round(rawAscent);
  const descent = Math.round(rawDescent);
  const leading = Math.round(scaled(platform === "linux" ? Math.max(0, gapUnits) : gapUnits));
  if (platform === "linux" && face.directory?.tables?.VDMX != null) {
    const table = face.directory.tables.VDMX as { offset?: number; length?: number };
    const source = getFontSourceInfo(font);
    if (source == null || table.offset == null || table.length == null || table.length >= 1024 * 1024) return null;
    try {
      const bytes = readFileSync(source.path).subarray(table.offset, table.offset + table.length);
      if (bytes.length !== table.length) return null;
      const strike = parseVdmxStrike(bytes, Math.floor(fontSize + 0.5));
      // Chromium reads VDMX only with normal/full hinting. The image-root
      // resolver has no browser launch flags, and our visual harness also
      // runs Chromium with hinting=none. If the strike changes line spacing,
      // neither answer is safe without that flag; leave it unresolved.
      if (strike != null && strike[0] + strike[1] !== ascent + descent) return null;
    } catch {
      return null;
    }
  }
  if (
    platform === "darwin" &&
    (face.familyName === "Times" || face.familyName === "Helvetica" || face.familyName === "Courier")
  ) {
    ascent += Math.floor(Math.fround((ascent + descent) * 0.15) + 0.5);
  }
  return ascent + descent + leading;
}

/** Blink's VDMX 1:1/default ratio lookup (vdmx_parser.cc, rev 7d859f27). */
export function parseVdmxStrike(bytes: Uint8Array, pixelSize: number): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number): number | null =>
    offset >= 0 && offset + 2 <= bytes.length ? view.getUint16(offset, false) : null;
  const i16 = (offset: number): number | null =>
    offset >= 0 && offset + 2 <= bytes.length ? view.getInt16(offset, false) : null;
  const ratios = u16(4);
  if (ratios == null) return null;
  for (let i = 0; i < ratios; i++) {
    const at = 6 + i * 4;
    if (at + 4 > bytes.length) return null;
    const x = bytes[at + 1];
    const y1 = bytes[at + 2];
    const y2 = bytes[at + 3];
    if (!((x === 1 && y1 <= 1 && y2 >= 1) || (x === 0 && y1 === 0 && y2 === 0))) continue;
    const group = u16(6 + ratios * 4 + i * 2);
    if (group == null) return null;
    const records = u16(group);
    if (records == null || u16(group + 2) == null) return null;
    for (let j = 0; j < records; j++) {
      const record = group + 4 + j * 6;
      const size = u16(record);
      if (size == null || size > pixelSize) return null;
      if (size !== pixelSize) continue;
      const yMax = i16(record + 2);
      const yMin = i16(record + 4);
      return yMax == null || yMin == null ? null : [yMax, -yMin];
    }
    return null;
  }
  return null;
}

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
      lineSpacing: normalLineSpacing(font, request.fontSize, platform),
    };
  } finally {
    restoreFontRegistrations(saved);
  }
}
