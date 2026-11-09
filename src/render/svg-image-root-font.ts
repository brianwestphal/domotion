/**
 * The font-metric units (`ex` / `cap` / `ch` / `ic` / `lh` and their root
 * forms) of an `<img>` SVG document's root, for its CSS transform
 * (chromium 7d859f27).
 *
 * `CSSToLengthConversionData::FontSizes` and `LineHeightSize`
 * (`core/css/css_to_length_conversion_data.cc:101-228`) read the element's
 * primary font. At the document root the `r`-prefixed forms equal the plain
 * ones (the root style is the element's own). The root of an SVG image has no
 * parent, so its font comes from its own declarations or the initial values:
 * the standard family and `medium` from the Settings the image page copies
 * (`IsolatedSVGDocumentHost::CopySettingsFrom`,
 * `core/svg/graphics/isolated_svg_document_host.cc:178-189`).
 *
 * The metrics come from the text engine's primary face
 * (`isolatedPrimaryFontMetrics`): `ex` is the x-height and `cap` the cap
 * height, each unresolved when the platform value is not reproducible from
 * the font file; `ch` is the advance of `0`, or half the em without one; `ic`
 * the advance of U+6C34, or the em without one. `lh` is
 * `ComputedStyle::ComputedLineHeight` (`core/style/computed_style.cc:
 * 2413-2429`) over the line height `StyleBuilderConverter::ConvertLineHeight`
 * computes (`core/css/resolver/style_builder_converter.cc:2198-2233`).
 * `line-height: normal` uses the primary face's LineSpacing when its native
 * metrics can be reproduced; otherwise it remains unresolved.
 */
import { isolatedPrimaryFontMetrics, type LinuxFontRenderContext } from "./font-resolution.js";
import { parseImageFontShorthand } from "./svg-image-font-shorthand.js";

/** The root's font declarations, attribute and inline style merged (style wins). */
export interface ImageRootFontDeclarations {
  get(name: string): string | null;
}

/** Font properties that change the primary face's metrics but are not resolved here. */
const UNSUPPORTED_FONT_PROPERTIES = [
  "font",
  "font-stretch",
  "font-variation-settings",
  "font-size-adjust",
  "font-optical-sizing",
] as const;

const ABSOLUTE_PX: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 4 / 3,
  pc: 16,
};

/** The supported static `font` shorthand subset, expanded at its cascade position. */
export function parseImageRootFontShorthand(value: string): ReadonlyMap<string, string> | null {
  const v = value.trim();
  if (/^(?:initial|inherit|unset|revert)$/i.test(v)) {
    return new Map([
      ["font-size", "medium"],
      ["font-family", "initial"],
      ["font-weight", "normal"],
      ["font-style", "normal"],
      ["line-height", "normal"],
      ["font-stretch", "normal"],
      ["font-variant-caps", "normal"],
    ]);
  }
  const match = parseImageFontShorthand(v);
  if (match == null) return null;
  return new Map([
    ["font-size", match.size],
    ["font-family", match.family],
    ["font-weight", match.weight],
    ["font-style", match.style],
    ["line-height", match.lineHeight],
    ["font-stretch", match.stretch],
    ["font-variant-caps", match.variant],
  ]);
}

/** `LayoutUnit(float)`: truncation to 1/64 px. */
const layoutUnit = (n: number): number => Math.trunc(Math.fround(n) * 64) / 64;

function isInitial(value: string | null): boolean {
  if (value == null) return true;
  const v = value.trim().toLowerCase();
  return v === "" || v === "initial" || v === "inherit" || v === "unset" || v === "revert" || v === "normal";
}

/** The computed `font-weight` of a parent-less root, or null when unsupported. */
function rootFontWeight(value: string | null): number | null {
  if (isInitial(value)) return 400;
  const v = (value ?? "").trim().toLowerCase();
  if (v === "bold") return 700;
  // Relative to the initial 400 (FontDescription::BolderWeight / LighterWeight).
  if (v === "bolder") return 700;
  if (v === "lighter") return 100;
  const n = Number(v);
  return /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(v) && n >= 1 && n <= 1000 ? n : null;
}

/** Whether the root is italic / oblique, or null when unsupported. */
function rootItalic(value: string | null): boolean | null {
  if (isInitial(value)) return false;
  const v = (value ?? "").trim().toLowerCase();
  if (v === "italic" || v === "oblique") return true;
  const angle = /^oblique\s+([-+]?(?:\d+\.?\d*|\.\d+))deg$/.exec(v);
  return angle == null ? null : Number(angle[1]) !== 0;
}

/**
 * The root's `lh` in px over its computed font size, or null when it cannot
 * be resolved exactly (`normal`, or a unit this module does not resolve).
 */
export function rootLineHeight(value: string | null, fontSize: number): number | null {
  if (value == null) return null;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "normal" || v === "initial" || v === "inherit" || v === "unset" || v === "revert") return null;
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))(%|[a-z]+)?$/.exec(v);
  if (m == null) return null;
  const n = Number(m[1]);
  if (n < 0) return null;
  const unit = m[2];
  if (unit == null) {
    // A number is stored as a percentage and resolved against the font
    // size as a LayoutUnit (MinimumValueForLength, length_functions.cc:64-68).
    const percent = Math.fround(n * 100);
    return layoutUnit(Math.fround((layoutUnit(fontSize) * percent) / 100));
  }
  // A percentage is a fixed length over an integer-clamped percent.
  if (unit === "%") return Math.fround((Math.fround(fontSize) * Math.trunc(n)) / 100);
  if (unit in ABSOLUTE_PX) return Math.fround(n * ABSOLUTE_PX[unit]);
  if (unit === "em" || unit === "rem") return Math.fround(n * fontSize);
  return null;
}

/**
 * A resolver for the root's font-metric units, or null when the root's font
 * cannot be known exactly (no font size, or a font declaration this module
 * does not resolve). The primary face is looked up only on first use.
 */
export function imageRootFontMetricUnits(
  declarations: ImageRootFontDeclarations,
  fontSize: number | null,
  lang: string | null,
  linuxFontRenderContext?: LinuxFontRenderContext,
): ((unit: string) => number | null) | null {
  if (fontSize == null || !(fontSize > 0)) return null;
  for (const name of UNSUPPORTED_FONT_PROPERTIES) {
    const value = declarations.get(name);
    if (value != null && !isInitial(value)) return null;
  }
  // `ch` / `ic` take vertical advances for an upright vertical font
  // (`ZeroInlineSize` / `IdeographicInlineSize`, simple_font_data.cc:459-471,
  // 557-575), which are not resolved here.
  const writingMode = (declarations.get("writing-mode") ?? "").trim().toLowerCase();
  const vertical =
    writingMode.startsWith("vertical") ||
    writingMode.startsWith("sideways") ||
    writingMode === "tb" ||
    writingMode === "tb-rl";
  if (vertical && (declarations.get("text-orientation") ?? "").trim().toLowerCase() === "upright") return null;
  const weight = rootFontWeight(declarations.get("font-weight"));
  const italic = rootItalic(declarations.get("font-style"));
  if (weight == null || italic == null) return null;
  const familyValue = declarations.get("font-family");
  const fontFamily = familyValue == null || isInitial(familyValue) ? "" : familyValue.trim();
  let resolved: ReturnType<typeof isolatedPrimaryFontMetrics> | undefined;
  const metrics = (): ReturnType<typeof isolatedPrimaryFontMetrics> => {
    if (!isInitial(declarations.get("font-variant-caps"))) return null;
    // FontPlatformData::QuerySystemRenderStyle disables hinting for
    // geometricPrecision (7d859f27:249-257). The native Fontconfig query
    // cannot stand in for that root style. Preserve explicit lh lengths.
    const rendering = declarations.get("text-rendering")?.trim().toLowerCase() ?? "";
    if (!isInitial(rendering) && rendering !== "auto") return null;
    if (resolved === undefined) {
      resolved = isolatedPrimaryFontMetrics({
        fontFamily,
        fontSize,
        fontWeight: weight,
        italic,
        ...(linuxFontRenderContext != null ? { linuxFontRenderContext } : {}),
        ...(lang != null && lang !== "" ? { lang } : {}),
      });
    }
    return resolved;
  };
  const lineHeightValue = declarations.get("line-height");
  const lineHeight = rootLineHeight(lineHeightValue, fontSize);
  return (unit: string): number | null => {
    switch (unit) {
      case "ex":
      case "rex":
        return metrics()?.xHeight ?? null;
      case "cap":
      case "rcap":
        return metrics()?.capHeight ?? null;
      case "ch":
      case "rch": {
        const m = metrics();
        return m == null ? null : (m.zeroWidth ?? fontSize / 2);
      }
      case "ic":
      case "ric": {
        const m = metrics();
        return m == null ? null : (m.ideographicAdvance ?? fontSize);
      }
      case "lh":
      case "rlh":
        return lineHeight ?? (isInitial(lineHeightValue) ? (metrics()?.lineSpacing ?? null) : null);
      default:
        return null;
    }
  };
}
