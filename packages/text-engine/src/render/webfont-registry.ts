/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import * as fontkit from "fontkit";
import type { FontInstance } from "./font-instance.js";
import { webfontRegistry } from "./font-instance.js";
import type { WebfontSynthesisFace } from "./font-instance.js";
import type { WebfontVariant } from "./font-instance.js";
import { applyVariationAxes } from "./font-instance.js";

/** Legacy string callers retain their CSS-like quote normalization. Capture
 * and parsed FontFace descriptors pass decoded data explicitly, so quotes,
 * outer whitespace and empty names cannot be mistaken for syntax. */
export type RegisteredFontFamily = string | { readonly decodedName: string };

/**
 * Open a webfont buffer with fontkit and register it under the given family
 * name (case-insensitive). `weight` is a CSS numeric weight (100-900); 400
 * when omitted. `style` is "normal" / "italic" / "oblique" (already defaulted
 * to "normal" by the capture side when the descriptor is absent — see
 * `styleDesc` below); treated as italic for any non-normal value for the
 * legacy per-variant `italic` boolean used by variant SELECTION.
 *
 * `unicodeRange` mirrors the `@font-face { unicode-range: ... }` descriptor as
 * a list of inclusive `[from, to]` codepoint intervals. Google-Fonts-style
 * partitioning declares the same `(family, weight)` pair across multiple
 * `@font-face` rules, each with a distinct `unicode-range` (Latin, Latin Ext,
 * Cyrillic, Greek, Vietnamese, …). Without honoring the descriptor,
 * `pickWebfontVariant` may return the Cyrillic-only partition for a Latin
 * text run — the run lays out as .notdef tofu (DM-517).
 *
 * Buffers must be decompressed already — fontkit's `create()` reads TTF/OTF
 * directly. WOFF2/WOFF bytes are decompressed in `loadWebfont()` (capture.ts)
 * before they reach this function.
 *
 * `stretch` is the raw `@font-face { font-stretch: ... }` descriptor value
 * ("condensed", "75%", "50% 100%"); omitted/"auto"/unparseable registers the
 * variant with auto capabilities. See `parseFontStretchDescriptor`.
 *
 * `weightDesc` is the raw `@font-face { font-weight: ... }` descriptor value
 * ("bold", "700", "300 500"); omitted/"auto"/unparseable registers the
 * variant with auto weight capabilities. The scalar `weight` parameter stays
 * as the legacy pre-collapsed number (the capture side's
 * `parseWeightDescriptor`) for report rows; selection and instancing use the
 * descriptor capabilities. See `parseFontWeightDescriptor`.
 *
 * `styleDesc` is the RAW `@font-face { font-style: ... }` descriptor value
 * ("italic", "oblique 20deg", "oblique 10deg 20deg"; `""`/absent/"auto" =
 * auto). The exact same "needs a SEPARATE raw parameter" reasoning as
 * `weightDesc` applies here, for the exact same structural reason: `style`
 * above is ALREADY defaulted to "normal" by the capture side (used for
 * variant selection and the legacy `local()`-probe path, where "no
 * descriptor" and "declared normal" are the same CSS-selection outcome), so
 * it cannot tell those two cases apart — but `webfontSyntheticItalic`'s
 * variable-`slnt`-axis exemption is reachable ONLY for a genuinely-auto
 * descriptor (`IsRangeSetFromAuto()`), never for an explicit `normal`. See
 * `parseFontStyleDescriptor`.
 */
export function registerWebfont(
  family: RegisteredFontFamily,
  weight: number,
  style: string,
  buffer: Buffer,
  unicodeRange?: Array<[number, number]>,
  stretch?: string,
  weightDesc?: string,
  styleDesc?: string,
): boolean {
  const key =
    typeof family === "string" ? family.toLowerCase().replace(/^["']|["']$/g, "") : family.decodedName.toLowerCase();
  let font: FontInstance;
  try {
    const created = fontkit.create(buffer) as unknown;
    if (created == null) return false;
    font = created as FontInstance;
  } catch {
    return false; // unparseable: nothing registered, and the caller is told so
  }
  const italic = style != null && style !== "" && style.toLowerCase() !== "normal";
  const list = webfontRegistry.get(key) ?? [];
  const stretchCaps = parseFontStretchDescriptor(stretch);
  const weightCaps = parseFontWeightDescriptor(weightDesc);
  const styleCaps = parseFontStyleDescriptor(styleDesc);
  const slopeCaps = webfontSelectionSlopeCaps(styleCaps);
  // DM-652: retain the raw buffer so embedded-font mode can `@font-face`
  // it as a `data:` URI without re-reading from disk (webfonts have no
  // on-disk source path — they came down from a CDN during capture).
  font.webfontDeclarationOrder = list.length;
  list.push({
    weight,
    italic,
    font,
    unicodeRange,
    buffer,
    ...(stretchCaps != null ? { stretch: stretchCaps } : {}),
    ...(weightCaps != null ? { weightCaps } : {}),
    ...(slopeCaps != null ? { slopeCaps } : {}),
    ...(styleDesc === undefined ? { styleInferred: true } : {}),
    synthesisFace: buildWebfontSynthesisFace(font, weightCaps, styleCaps),
  });
  webfontRegistry.set(key, list);
  return true;
}

/** The CSS `font-stretch` keyword → percentage table, transcribed from Blink's
 *  width constants (`platform/fonts/font_selection_types.h:221-246`, identical
 *  at tag 147.0.7727.15 and rev 7d859f27). */
const FONT_STRETCH_KEYWORDS: Readonly<Record<string, number>> = {
  "ultra-condensed": 50,
  "extra-condensed": 62.5,
  condensed: 75,
  "semi-condensed": 87.5,
  normal: 100,
  "semi-expanded": 112.5,
  expanded: 125,
  "extra-expanded": 150,
  "ultra-expanded": 200,
};

/**
 * Parse an `@font-face` `font-stretch` DESCRIPTOR value into selection
 * capabilities `[min, max]`, or undefined for auto/absent/unparseable.
 *
 * Transcribed from `FontFace::GetFontSelectionCapabilities`
 * (`core/css/font_face.cc:666-…`, identical at tag 147.0.7727.15 and rev
 * 7d859f27): a keyword maps to its width constant as a single-value range; a
 * single percentage is `[v, v]`; two percentages are a range with the
 * endpoints SWAPPED when decreasing ("User agents must swap the computed value
 * of the startpoint and endpoint of the range in order to forbid decreasing
 * ranges", css-fonts-4). `auto` (and anything unparseable, which Blink's
 * parser would have rejected before it reached the descriptor) yields
 * undefined — normal-width capabilities flagged as set-from-auto, meaning the
 * INSTANCING clamp falls back to the font's own wdth axis range.
 */
export function parseFontStretchDescriptor(value: string | undefined): readonly [number, number] | undefined {
  if (value == null) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "auto") return undefined;
  const kw = FONT_STRETCH_KEYWORDS[v];
  if (kw != null) return [kw, kw];
  const m = /^([\d.]+)%(?:\s+([\d.]+)%)?$/.exec(v);
  if (m == null) return undefined;
  const a = parseFloat(m[1]);
  if (!Number.isFinite(a) || a < 0) return undefined;
  if (m[2] == null) return [a, a];
  const b = parseFloat(m[2]);
  if (!Number.isFinite(b) || b < 0) return undefined;
  return a < b ? [a, b] : [b, a];
}

/**
 * Parse an `@font-face` `font-weight` DESCRIPTOR value into selection
 * capabilities `[min, max]`, or undefined for auto/absent/unparseable.
 *
 * Transcribed from the weight section of `FontFace::GetFontSelectionCapabilities`
 * (`core/css/font_face.cc:860-930`, rev 7d859f27, checkout of 2026-06-27):
 * `normal` is `[400, 400]`, `bold` is `[700, 700]` (both set-explicitly — they
 * PIN the wght instancing, unlike auto); a single number in `[1, 1000]` is
 * `[v, v]`; a two-value range with both endpoints in `[1, 1000]` has decreasing
 * endpoints swapped ("User agents must swap the computed value of the
 * startpoint and endpoint of the range in order to forbid decreasing ranges",
 * css-fonts-4). `auto`, an absent descriptor, and anything out of range or
 * unparseable (Blink's parser rejects those before they are stored; its
 * defensive `return normal_capabilities` branches leave the weight range's
 * default `kSetFromAuto` type in place) yield undefined — normal-weight
 * capabilities flagged as set-from-auto, meaning selection scores the face as
 * exactly weight 400 and the INSTANCING clamp falls back to the font's own
 * wght axis range.
 */
export function parseFontWeightDescriptor(value: string | undefined): readonly [number, number] | undefined {
  if (value == null) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "auto") return undefined;
  if (v === "normal") return [400, 400];
  if (v === "bold") return [700, 700];
  const m = /^([\d.]+)(?:\s+([\d.]+))?$/.exec(v);
  if (m == null) return undefined;
  const a = parseFloat(m[1]);
  if (!Number.isFinite(a) || a < 1 || a > 1000) return undefined;
  if (m[2] == null) return [a, a];
  const b = parseFloat(m[2]);
  if (!Number.isFinite(b) || b < 1 || b > 1000) return undefined;
  return a < b ? [a, b] : [b, a];
}

/**
 * Parse an `@font-face` `font-style` DESCRIPTOR value into selection
 * capabilities `[min, max]` in Blink's slope-DEGREE convention, or undefined
 * for auto/absent/unparseable.
 *
 * Transcribed from `FontFace::GetFontSelectionCapabilities`
 * (`core/css/font_face.cc:776-858`, rev 7d859f27): `normal` is `[0, 0]`;
 * `italic` and bare `oblique` (no angle) are BOTH `[14, 14]` — Blink gives
 * `oblique` the italic sentinel slope, not zero; `oblique <angle>` is
 * `[a, a]`; `oblique <min> <max>` is the range, with decreasing endpoints
 * swapped ("User agents must swap the computed value of the startpoint and
 * endpoint of the range in order to forbid decreasing ranges", css-fonts-4).
 * `auto` (present for symmetry with `parseFontWeightDescriptor`; not itself a
 * valid `font-style` descriptor keyword) and anything unparseable yield
 * undefined — normal-style capabilities flagged as set-from-auto, meaning the
 * variable-`slnt`-axis exemption in `webfontSyntheticItalic` can fire.
 */
export function parseFontStyleDescriptor(value: string | undefined): readonly [number, number] | undefined {
  if (value == null) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "auto") return undefined;
  if (v === "normal") return [BLINK_NORMAL_SLOPE, BLINK_NORMAL_SLOPE];
  if (v === "italic") return [BLINK_ITALIC_SLOPE_VALUE, BLINK_ITALIC_SLOPE_VALUE];
  const m = /^oblique(?:\s+(-?[\d.]+)deg(?:\s+(-?[\d.]+)deg)?)?$/.exec(v);
  if (m == null) return undefined;
  if (m[1] == null) return [BLINK_ITALIC_SLOPE_VALUE, BLINK_ITALIC_SLOPE_VALUE]; // bare `oblique`
  const a = parseFloat(m[1]);
  if (!Number.isFinite(a)) return undefined;
  if (m[2] == null) return [a, a];
  const b = parseFloat(m[2]);
  if (!Number.isFinite(b)) return undefined;
  return a < b ? [a, b] : [b, a];
}

/** Blink's `kBoldThreshold` — the weight at or above which a run counts as a
 *  bold REQUEST (`platform/fonts/font_selection_types.h:182`, rev 7d859f27).
 *  600, not 700, and not the 500 the macOS SYSTEM-font rule uses. */
const BLINK_BOLD_THRESHOLD = 600;

/** Blink's `kNormalWeightValue` (`font_selection_types.h:201`, rev 7d859f27). */
const BLINK_NORMAL_WEIGHT = 400;

/** Blink's `kItalicSlopeValue` — the slope-request sentinel `italic` / bare
 *  `oblique` resolve to, and the EXACT value the Windows/Linux system-font
 *  synthetic-oblique rule tests for equality against
 *  (`font_selection_types.h:171`, rev 7d859f27). Exported for
 *  `synthesis-decision.ts`'s platform dispatch, which needs the same
 *  constant on the system-font side of the rule. */
export const BLINK_ITALIC_SLOPE_VALUE = 14;

/** Blink's `kNormalSlopeValue` (`font_selection_types.h:169`, rev 7d859f27). */
export const BLINK_NORMAL_SLOPE = 0;

/**
 * Whether Chrome paints a WEBFONT run synthetic-bold. This is a different rule
 * from the per-platform system-font predicates in `text-to-path.ts`, and it is
 * platform-INDEPENDENT: it lives entirely in the CSS/webfont layer, which Blink
 * compiles once for every platform.
 *
 * The rule is composed from two places (both verified byte-identical between
 * the local checkout at rev 7d859f27 and Chromium tag 147.0.7727.15, the
 * version Playwright pins — only palette-array plumbing differs in the second
 * file, well away from these lines):
 *
 *  1. `CSSSegmentedFontFace::GetFontData` (`core/css/css_segmented_font_face.cc:
 *     116-119`) decides the `bold` flag handed down:
 *
 *         requested_font_description.SetSyntheticBold(
 *             font_selection_capabilities_.weight.maximum < kBoldThreshold &&
 *             font_selection_request.weight >= kBoldThreshold &&
 *             font_description.SyntheticBoldAllowed());
 *
 *     Note what the first term reads: the `@font-face` font-weight DESCRIPTOR
 *     capabilities, NOT the font's axis range. An absent/auto descriptor is
 *     `[400, 400]` (`core/css/font_face.cc:669-672` builds `normal_capabilities`
 *     and the auto branch at 870-873 keeps it, flagged `kSetFromAuto`), so an
 *     auto-descriptor face is a bold-synthesis CANDIDATE for every request
 *     ≥ 600 — including a variable face whose axis reaches 900.
 *
 *  2. `FontCustomPlatformData::GetFontPlatformData`
 *     (`platform/fonts/font_custom_platform_data.cc:129-154, 289-293`) starts
 *     from `synthetic_bold = bold` and exempts exactly one case — a VARIABLE
 *     face (`kVariableTrueType` / `kVariableCFF2`) whose weight capabilities
 *     were set FROM AUTO and which exposes a valid `wght` axis:
 *
 *         bool has_bold_variations = wght_range.maximum > kNormalWeightValue;
 *         synthetic_bold = bold && !has_bold_variations &&
 *                          selection_request.weight >= kBoldThreshold;
 *
 *     …and finally gates the whole thing on the buffer's own boldness:
 *
 *         synthetic_bold && !base_typeface_->isBold()
 *
 *     `SkTypeface::isBold()` is `onGetFontStyle().weight() >= kSemiBold_Weight`
 *     (600) — Skia `src/core/SkTypeface.cpp:491-493`, `include/core/SkFontStyle.h:25`,
 *     rev ebf5052.
 *
 * The DECLARED-descriptor branch never reaches the exemption, which is the
 * whole point: a variable face declared `font-weight: 400` pins wght = 400 AND
 * paints emboldened, where the same file with no descriptor instances wght = 700
 * and paints plain.
 *
 * `SyntheticBoldAllowed()` (`font-synthesis-weight: auto`) is not modeled: the
 * `font-synthesis` property is not captured at all today, so every run is
 * treated as allowing synthesis — the same assumption the system-font faux-bold
 * seam already makes.
 */
/**
 * Snapshot the three per-variant constants `webfontSyntheticBold` needs, at
 * registration time, from the buffer fontkit just opened.
 *
 * `wghtAxisMax` is quantized onto the FontSelectionValue quarter grid (16.16
 * fixed point with two fractional bits, `platform/fonts/font_selection_types.h:
 * 40-105`) because that is what Blink's `FontSelectionValue(wght_parameters->max)`
 * does before comparing it to `kNormalWeightValue`; it is null when the buffer
 * has no `wght` axis, or when the axis range is degenerate (Blink's
 * `wght_range.IsValid()` guard — an invalid range skips the exemption block
 * entirely, leaving `synthetic_bold = bold`).
 *
 * `baseIsBold` mirrors `SkTypeface::isBold()` on the base typeface: the face's
 * own declared style weight ≥ 600. `OS/2.usWeightClass` is where that weight
 * comes from for a font opened from a buffer.
 */
function buildWebfontSynthesisFace(
  font: FontInstance,
  weightCaps: readonly [number, number] | undefined,
  styleCaps: readonly [number, number] | undefined,
): WebfontSynthesisFace {
  // A webfont instance is fontkit-backed, so it also carries fontkit's
  // `variationAxes` and the full OS/2 table beyond the FontInstance surface.
  const f = font as FontInstance & {
    variationAxes?: Record<string, { min?: number; max?: number }>;
    "OS/2"?: { usWeightClass?: number; fsSelection?: number | { italic?: boolean } };
  };
  const quantize = (x: number): number => Math.trunc(x * 4) / 4;
  const wght = f.variationAxes?.wght;
  const rawWghtMin = wght?.min,
    rawWghtMax = wght?.max;
  const wghtAxisMax =
    wght != null && typeof rawWghtMax === "number" && typeof rawWghtMin === "number" && rawWghtMin <= rawWghtMax
      ? quantize(rawWghtMax)
      : null;
  const slnt = f.variationAxes?.slnt;
  const rawSlntMin = slnt?.min,
    rawSlntMax = slnt?.max;
  const slntAxisMin =
    slnt != null && typeof rawSlntMin === "number" && typeof rawSlntMax === "number" && rawSlntMin <= rawSlntMax
      ? quantize(rawSlntMin)
      : null;
  const usWeight = f["OS/2"]?.usWeightClass;
  const fsSelection = f["OS/2"]?.fsSelection;
  const baseIsItalic =
    fsSelection == null
      ? false
      : typeof fsSelection === "number"
        ? (fsSelection & 0x01) !== 0
        : fsSelection.italic === true;
  return {
    declaredWeightCaps: weightCaps ?? null,
    wghtAxisMax,
    baseIsBold: typeof usWeight === "number" && usWeight >= BLINK_BOLD_THRESHOLD,
    declaredStyleCaps: styleCaps ?? null,
    slntAxisMin,
    baseIsItalic,
  };
}

export function webfontSyntheticBold(face: WebfontSynthesisFace, requestedWeight: number): boolean {
  // `capabilities.weight` for the matched face: the declared descriptor range,
  // or normal weight when the descriptor is auto/absent.
  const caps = face.declaredWeightCaps ?? [BLINK_NORMAL_WEIGHT, BLINK_NORMAL_WEIGHT];
  const bold = caps[1] < BLINK_BOLD_THRESHOLD && requestedWeight >= BLINK_BOLD_THRESHOLD;
  if (!bold) return false;
  // The auto-descriptor variable-face exemption. Only reachable when the
  // descriptor is auto (`IsRangeSetFromAuto()`) AND the buffer exposes a wght
  // axis — a declared descriptor keeps `synthetic_bold = bold` untouched.
  if (face.declaredWeightCaps == null && face.wghtAxisMax != null && face.wghtAxisMax > BLINK_NORMAL_WEIGHT) {
    return false;
  }
  return !face.baseIsBold;
}

/**
 * Whether Chrome paints a WEBFONT run synthetic-ITALIC. The mirror of
 * `webfontSyntheticBold` — platform-independent, lives entirely in the
 * CSS/webfont layer — composed from the same two places, transcribed at the
 * SAME two citations' style/slope counterparts:
 *
 *  1. `CSSSegmentedFontFace::GetFontData` (`core/css/css_segmented_font_face.cc:
 *     120-123`):
 *
 *         requested_font_description.SetSyntheticItalic(
 *             font_selection_capabilities_.slope.maximum < kItalicSlopeValue &&
 *             font_selection_request.slope >= kItalicSlopeValue &&
 *             font_description.SyntheticItalicAllowed());
 *
 *  2. `FontCustomPlatformData::GetFontPlatformData`
 *     (`platform/fonts/font_custom_platform_data.cc:130, 188-191, 291-292`)
 *     starts from `synthetic_italic = italic` and exempts a variable face
 *     whose style capabilities were set FROM AUTO and which exposes a valid
 *     `slnt` axis:
 *
 *         bool has_right_slanted_variations = slnt_range.minimum < kNormalSlopeValue;
 *         synthetic_italic = italic && !has_right_slanted_variations &&
 *                            selection_request.slope >= kItalicSlopeValue;
 *
 *     …then gates on the buffer's own italic-ness:
 *
 *         synthetic_italic && !base_typeface_->isItalic()
 *
 *     `slnt_range` is read in the axis's OWN (OpenType) sign convention —
 *     `RetrieveVariationDesignParametersByTag(base_typeface_, kSlntTag)` — so
 *     "minimum < 0" asks whether the axis extends to any RIGHT-leaning value,
 *     the opposite sign from CSS `oblique <angle>`'s positive-clockwise
 *     convention (`font_custom_platform_data.cc:170-174` documents the flip;
 *     it is why `slntAxisMin` is stored raw, not CSS-signed).
 *
 * `requestedSlopeDegrees` is Blink's `FontSelectionRequest.slope` in the SAME
 * CSS-degree convention `parseFontStyleDescriptor` returns: 0 for `normal`,
 * `BLINK_ITALIC_SLOPE_VALUE` (14) for `italic` / bare `oblique`, the literal
 * angle for `oblique <angle>`.
 */
export function webfontSyntheticItalic(face: WebfontSynthesisFace, requestedSlopeDegrees: number): boolean {
  const caps = face.declaredStyleCaps ?? [BLINK_NORMAL_SLOPE, BLINK_NORMAL_SLOPE];
  const italic = caps[1] < BLINK_ITALIC_SLOPE_VALUE && requestedSlopeDegrees >= BLINK_ITALIC_SLOPE_VALUE;
  if (!italic) return false;
  // The auto-descriptor variable-face exemption. Only reachable when the
  // descriptor is auto (`IsRangeSetFromAuto()`) AND the buffer exposes a
  // slnt axis whose range reaches a right-leaning (OT-negative) coordinate —
  // a declared descriptor keeps `synthetic_italic = italic` untouched.
  if (face.declaredStyleCaps == null && face.slntAxisMin != null && face.slntAxisMin < BLINK_NORMAL_SLOPE) {
    return false;
  }
  return !face.baseIsItalic;
}

/** True iff `cp` falls in any of the inclusive `[from, to]` intervals. */
export function unicodeRangeCovers(ranges: Array<[number, number]> | undefined, cp: number): boolean {
  if (ranges == null) return true; // no range = U+0..U+10FFFF (CSS default)
  for (const [from, to] of ranges) {
    if (cp >= from && cp <= to) return true;
  }
  return false;
}

/**
 * A value on Blink's FontSelectionValue grid, in float units:
 * `ClampTo<int16_t>(x * fractionalEntropy)` with `fractionalEntropy = 4`
 * (`platform/fonts/font_selection_types.h:52-61, 101`, rev 7d859f27). The
 * float-to-int conversion truncates toward zero, so `oblique 10.3deg` selects
 * as 10.25.
 */
export function quantizeFontSelectionValue(x: number): number {
  return Math.max(-32768, Math.min(32767, Math.trunc(x * 4))) / 4;
}

/**
 * The slope selection capabilities stored on a registered variant: the parsed
 * `font-style` descriptor, quantized onto the FontSelectionValue grid, or
 * undefined (auto, selecting as `[0, 0]`) when no descriptor applies. The
 * legacy `italic` flag of a descriptor-less registration never enters these
 * capabilities; see `webfontInferredItalicCost`.
 */
function webfontSelectionSlopeCaps(
  declared: readonly [number, number] | undefined,
): readonly [number, number] | undefined {
  if (declared == null) return undefined;
  return [quantizeFontSelectionValue(declared[0]), quantizeFontSelectionValue(declared[1])];
}

/**
 * Blink's `FontSelectionRequest.slope` for a picker call. `requestSlope` is
 * the CSS-degree slope when the caller has it (0 for `normal`, 14 for
 * `italic` / bare `oblique`, the angle for `oblique <angle>`, as
 * `StyleBuilderConverterBase::ConvertFontStyle` computes it). Without it, the
 * pickers' `slant` argument stands in. Every renderer producer collapses each
 * non-normal style to one nonzero `slant`, so the fallback maps nonzero to
 * `kItalicSlopeValue`. That is exact for `normal`, `italic`, bare `oblique`
 * and `oblique 14deg`, but not for other oblique angles.
 */
export function webfontRequestSlope(slant: number, requestSlope?: number): number {
  return quantizeFontSelectionValue(requestSlope ?? (slant !== 0 ? BLINK_ITALIC_SLOPE_VALUE : BLINK_NORMAL_SLOPE));
}

/** A variant's stretch SELECTION capabilities: the declared descriptor range,
 *  or normal width `[100, 100]` when the descriptor is auto/absent — Blink's
 *  `FontFace::GetFontSelectionCapabilities` selects an auto face as exactly
 *  normal width (`core/css/font_face.cc:666-…`, tag 147.0.7727.15). */
function variantStretchCaps(v: WebfontVariant): readonly [number, number] {
  return v.stretch ?? [100, 100];
}

/** A variant's slope SELECTION capabilities (see `webfontSelectionSlopeCaps`),
 *  or normal style `[0, 0]` when the descriptor is auto/absent
 *  (`core/css/font_face.cc:790-793`, rev 7d859f27). */
function variantSlopeCaps(v: WebfontVariant): readonly [number, number] {
  return v.slopeCaps ?? [BLINK_NORMAL_SLOPE, BLINK_NORMAL_SLOPE];
}

/** A variant's weight SELECTION capabilities: the declared `font-weight`
 *  descriptor range, or normal weight `[400, 400]` when the descriptor is
 *  auto/absent — Blink's `FontFace::GetFontSelectionCapabilities` selects an
 *  auto face as exactly normal weight (`core/css/font_face.cc:871-874`, rev
 *  7d859f27). */
function variantWeightCaps(v: WebfontVariant): readonly [number, number] {
  return v.weightCaps ?? [400, 400];
}

interface SelectionBound {
  readonly min: number;
  readonly max: number;
}

/**
 * The union of the family's capabilities: Blink's `capabilities_bounds_`,
 * built by `FontSelectionQueryResult::GetOrCreate` across every face of the
 * family (`core/css/font_face_cache.cc:242-245`, rev 7d859f27) and consulted
 * by the off-side thresholds of the three distance functions.
 *
 * Blink seeds the union with a default `FontSelectionCapabilities`, whose
 * ranges are `[0, 0]` (`font_selection_types.h:383-385`). Here the union
 * starts empty instead. That cannot change a comparison: the seed only lowers
 * a `min(request, bounds.minimum)` threshold for width and weight. Such a
 * threshold is shared by every face on that side of the request, and a face on
 * the other side still scores strictly lower. Slope thresholds always include
 * the request itself, which is already on the seed's side of zero.
 */
interface WebfontSelectionBounds {
  readonly stretch: SelectionBound;
  readonly slope: SelectionBound;
  readonly weight: SelectionBound;
}

function webfontSelectionBounds(variants: WebfontVariant[]): WebfontSelectionBounds {
  const union = (caps: (v: WebfontVariant) => readonly [number, number]): SelectionBound => {
    let min = Infinity,
      max = -Infinity;
    for (const v of variants) {
      const [lo, hi] = caps(v);
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
    return { min, max };
  };
  return { stretch: union(variantStretchCaps), slope: union(variantSlopeCaps), weight: union(variantWeightCaps) };
}

/**
 * Distance from a stretch request to a variant's capabilities, transcribed
 * from `FontSelectionAlgorithm::StretchDistance`
 * (`platform/fonts/font_selection_algorithm.cc:30-52`, byte-identical at tag
 * 147.0.7727.15 and rev 7d859f27):
 *
 *   - a range containing the request is distance 0;
 *   - a request above normal (100) prefers wider faces: a face entirely above
 *     the request scores its gap, a face entirely below scores from
 *     `max(request, bounds.max)` — pushing too-narrow faces behind every
 *     too-wide one;
 *   - a request at/below normal mirrors that, preferring narrower faces.
 *
 * Checked BEFORE style and weight, which is Blink's
 * `IsBetterMatchForRequest` order (stretch, then style, then weight).
 */
function webfontStretchDistance(caps: readonly [number, number], request: number, bounds: SelectionBound): number {
  const [lo, hi] = caps;
  if (request >= lo && request <= hi) return 0;
  if (request > 100) {
    if (lo > request) return lo - request;
    // hi < request
    return Math.max(request, bounds.max) - hi;
  }
  if (hi < request) return request - hi;
  // lo > request
  return lo - Math.min(request, bounds.min);
}

/**
 * Distance from a slope request to a variant's slope capabilities, transcribed
 * from `FontSelectionAlgorithm::StyleDistance`
 * (`platform/fonts/font_selection_algorithm.cc:53-96`, rev 7d859f27). Slopes
 * are CSS degrees (positive leans right); `kItalicThreshold` is 14
 * (`font_selection_types.h:160`).
 *
 *   - a range containing the request is distance 0;
 *   - request ≥ 14 (italic-like): a face entirely above scores its gap, a face
 *     entirely below scores from `max(request, bounds.max)`;
 *   - 0 ≤ request < 14: a face whose top is in `[0, request)` scores its gap,
 *     a face entirely above the request scores its OWN MINIMUM (not the gap,
 *     line 73), and a face entirely below zero scores from
 *     `max(request, bounds.max)`;
 *   - -14 < request < 0 mirrors that: a face whose bottom is in
 *     `(request, 0]` scores its gap, a face entirely below the request scores
 *     `-maximum` (line 84), and a face entirely above zero scores from
 *     `min(request, bounds.min)`;
 *   - request ≤ -14: a face entirely below scores its gap, a face entirely
 *     above scores from `min(request, bounds.min)`.
 *
 * Checked after stretch and before weight (`IsBetterMatchForRequest`,
 * lines 137-159).
 */
export function webfontStyleDistance(caps: readonly [number, number], request: number, bounds: SelectionBound): number {
  const [lo, hi] = caps;
  if (request >= lo && request <= hi) return 0;
  if (request >= BLINK_ITALIC_SLOPE_VALUE) {
    if (lo > request) return lo - request;
    // hi < request
    return Math.max(request, bounds.max) - hi;
  }
  if (request >= BLINK_NORMAL_SLOPE) {
    if (hi >= BLINK_NORMAL_SLOPE && hi < request) return request - hi;
    if (lo > request) return lo;
    // hi < 0
    return Math.max(request, bounds.max) - hi;
  }
  if (request > -BLINK_ITALIC_SLOPE_VALUE) {
    if (lo > request && lo <= BLINK_NORMAL_SLOPE) return lo - request;
    if (hi < request) return -hi;
    // lo > 0
    return lo - Math.min(request, bounds.min);
  }
  if (hi < request) return request - hi;
  // lo > request
  return lo - Math.min(request, bounds.min);
}

/**
 * Distance from a weight request to a variant's capabilities, transcribed from
 * `FontSelectionAlgorithm::WeightDistance`
 * (`platform/fonts/font_selection_algorithm.cc:98-135`, rev 7d859f27, checkout
 * of 2026-06-27):
 *
 *   - a range containing the request is distance 0;
 *   - a request in the `[400, 500]` search band prefers, in order: the nearest
 *     face at/under 500 above the request, then faces below the request
 *     (scored from the 500 threshold down), then faces above 500 (scored from
 *     `min(request, bounds.min)`);
 *   - a request under 400 prefers lighter faces — a face entirely below scores
 *     its gap, a face entirely above scores from `min(request, bounds.min)`;
 *   - a request over 500 mirrors that, preferring bolder faces (a too-light
 *     face scores from `max(request, bounds.max)`).
 *
 * Checked AFTER stretch and style, which is Blink's `IsBetterMatchForRequest`
 * order.
 */
function webfontWeightDistance(caps: readonly [number, number], request: number, bounds: SelectionBound): number {
  const [lo, hi] = caps;
  if (request >= lo && request <= hi) return 0;
  // kLowerWeightSearchThreshold = 400, kUpperWeightSearchThreshold = 500
  // (`platform/fonts/font_selection_types.h:215-219`, rev 7d859f27).
  if (request >= 400 && request <= 500) {
    if (lo > request && lo <= 500) return lo - request;
    if (hi < request) return 500 - hi;
    // lo > 500
    return lo - Math.min(request, bounds.min);
  }
  if (request < 400) {
    if (hi < request) return request - hi;
    // lo > request
    return lo - Math.min(request, bounds.min);
  }
  // request > 500
  if (lo > request) return lo - request;
  // hi < request
  return Math.max(request, bounds.max) - hi;
}

/**
 * Domotion's descriptor-less inference. It is a capture-inference necessity
 * for the CSS-less resource-discovery path (fonts found only via network
 * requests, no parseable CSS), which registers every face with auto
 * capabilities, so all of them select as `[100, 100]` / `[0, 0]` /
 * `[400, 400]`. Instead such a face carries its own OS/2 weight as the scalar
 * `weight` and its italic bit as the legacy `style`; without the inference a
 * bold or italic run would take whichever face declaration order prefers. It
 * is NOT a Blink behavior, so each term is confined to the input a descriptor
 * did not decide:
 *
 *   - `webfontInferredItalicCost` counts only for a variant registered with no
 *     `font-style` descriptor argument at all (`styleInferred`). A CSS face
 *     always passes one (`""` when absent), so an auto `@font-face` style is
 *     never re-scored by its defaulted `normal` flag. It joins the STYLE tier,
 *     above weight, exactly where the boolean rule it replaces sat, and it
 *     exceeds every Blink style distance (at most 180).
 *   - `webfontLegacyWeightTiebreak` counts only for a variant with no
 *     `font-weight` descriptor (`weightCaps` undefined), and only after Blink's
 *     WeightDistance ties.
 *
 * Neither term is part of the capabilities key, so faces that differ only in
 * inferred style or weight stay one group, as they share one key in Blink.
 */
const WEBFONT_INFERRED_ITALIC_MISMATCH = 1000;

function webfontInferredItalicCost(v: WebfontVariant, request: WebfontSelectionRequest): number {
  return v.styleInferred === true && v.italic !== (request.slope !== BLINK_NORMAL_SLOPE)
    ? WEBFONT_INFERRED_ITALIC_MISMATCH
    : 0;
}

/** See `WEBFONT_INFERRED_ITALIC_MISMATCH`. At most 999 for CSS weights. */
function webfontLegacyWeightTiebreak(v: WebfontVariant, request: WebfontSelectionRequest): number {
  return v.weightCaps != null ? 0 : Math.abs(v.weight - request.weight);
}

/** One picker request in Blink's `FontSelectionRequest` terms. */
interface WebfontSelectionRequest {
  readonly weight: number;
  readonly stretch: number;
  /** CSS degrees; see `webfontRequestSlope`. */
  readonly slope: number;
}

/**
 * A variant's ordering key: Blink's `IsBetterMatchForRequest` distances in
 * order (stretch, style, weight), with the inferred-italic cost in the style
 * tier and, only when `legacyWeight` is set, the legacy weight tie-break last.
 * Compare with `compareWebfontSelectionScores`; lower is better.
 */
function webfontSelectionScore(
  v: WebfontVariant,
  request: WebfontSelectionRequest,
  bounds: WebfontSelectionBounds,
  legacyWeight = true,
): readonly [number, number, number, number] {
  return [
    webfontStretchDistance(variantStretchCaps(v), request.stretch, bounds.stretch),
    webfontStyleDistance(variantSlopeCaps(v), request.slope, bounds.slope) + webfontInferredItalicCost(v, request),
    webfontWeightDistance(variantWeightCaps(v), request.weight, bounds.weight),
    legacyWeight ? webfontLegacyWeightTiebreak(v, request) : 0,
  ];
}
/** Lexicographic comparison of two `webfontSelectionScore` keys. */
function compareWebfontSelectionScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The exact `FontSelectionCapabilities` key a variant is grouped under. */
function webfontCapabilitiesKey(variant: WebfontVariant): string {
  return JSON.stringify([variantStretchCaps(variant), variantSlopeCaps(variant), variantWeightCaps(variant)]);
}

/** FontFaceCache selects one capabilities key before range iteration.
 * Preserve the callers' existing tie/inference policies; their cross-group
 * parity is a separate investigation (DM-M5E64N), not a Blink guarantee. */
function webfontDescriptorGroup(
  variants: WebfontVariant[],
  request: WebfontSelectionRequest,
  policy: "ordinary" | "segmented" = "ordinary",
): WebfontVariant[] {
  const bounds = webfontSelectionBounds(variants);
  let selected: WebfontVariant | undefined;
  let bestScore: readonly number[] | undefined;
  for (const variant of variants) {
    const score = webfontSelectionScore(variant, request, bounds, policy === "ordinary");
    const order = bestScore == null ? -1 : compareWebfontSelectionScores(score, bestScore);
    if (order < 0 || (policy === "ordinary" && order === 0)) {
      selected = variant;
      bestScore = score;
    }
  }
  if (selected == null) return [];
  const selectedKey = webfontCapabilitiesKey(selected);
  return variants.filter((variant) => webfontCapabilitiesKey(variant) === selectedKey);
}

/**
 * Choose one declaration inside an already-selected capability group. Every
 * member shares Blink's three distances, so only the Domotion descriptor-less
 * inference and the caller's optional `penalty` (the Latin-range preference)
 * can separate them. On an exact tie the LAST-declared accepted variant wins:
 * Blink appends a segmented family's faces in REVERSE declaration order
 * (`font_faces_->ForEachReverse`, `core/css/css_segmented_font_face.cc:125-136`,
 * rev 7d859f27) and takes the FIRST appended face that covers the character
 * (`SegmentedFontData::FontDataForCharacter`,
 * `platform/fonts/segmented_font_data.cc:33-40`), the CSS Fonts rule that
 * later `@font-face` declarations override earlier ones. Forward iteration
 * with `<=` is that same rule.
 */
function pickWithinWebfontGroup(
  group: WebfontVariant[],
  request: WebfontSelectionRequest,
  accept: (v: WebfontVariant) => boolean = () => true,
  penalty: (v: WebfontVariant) => number = () => 0,
): WebfontVariant | null {
  let best: WebfontVariant | null = null;
  let bestScore = Infinity;
  for (const v of group) {
    if (!accept(v)) continue;
    const score = penalty(v) + webfontInferredItalicCost(v, request) + webfontLegacyWeightTiebreak(v, request);
    if (score <= bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

/**
 * Codepoint-aware selection chooses descriptor capabilities first, then walks
 * only that group's unicode-range partitions in reverse declaration order.
 * A range miss returns null so the caller continues the CSS family stack;
 * it must not choose a different weight/style/stretch group for coverage.
 *
 * Used by the run-splitter in `textToPathMarkup` to route per-codepoint
 * within a Google-Fonts-style partitioned family (Geist@400 split across
 * Latin/Latin-Ext/Cyrillic/etc.). Without this, the Latin-biased
 * `pickWebfontVariant` is the single primary font for the whole text and
 * codepoints outside its range fall straight to system fonts — losing the
 * matching Cyrillic/Greek/Latin-Ext partition that's registered but
 * unselected.
 */
export function pickWebfontVariantForCodepoint(
  family: string,
  weight: number,
  fontSize: number,
  slant: number,
  codepoint: number,
  variationSettings?: Record<string, number>,
  /** CSS `font-stretch` percentage — a SELECTION axis (checked before style
   *  and weight, Blink's `IsBetterMatchForRequest` order) and the `wdth`-axis
   *  request for a variable webfont (see `applyVariationAxes`). */
  stretch: number = 100,
  /** Blink request slope in CSS degrees, when the caller has it; see
   *  `webfontRequestSlope`. */
  requestSlope?: number,
): FontInstance | null {
  const variants = webfontRegistry.get(family.toLowerCase());
  if (variants == null || variants.length === 0) return null;
  const request = { weight, stretch, slope: webfontRequestSlope(slant, requestSlope) };
  const best = pickWithinWebfontGroup(webfontDescriptorGroup(variants, request), request, (v) =>
    unicodeRangeCovers(v.unicodeRange, codepoint),
  );
  if (best == null) return null;
  return tagWebfontInstance(
    applyVariationAxes(best.font, weight, fontSize, slant, variationSettings, stretch, {
      wdthCapabilities: best.stretch ?? null,
      wdthAlways: true,
      wghtCapabilities: best.weightCaps ?? null,
    }),
    best,
  );
}

/** FontFallbackList's primary-font lookup chooses capabilities BEFORE testing
 * the selected segmented family's unicode-range (Chromium7d859f27,
 * FontFaceCache::Get and FontFallbackList::DeterminePrimarySimpleFontDataCore).
 * A missing range must walk the CSS family stack, not choose another weight.
 * Isolated metrics additionally require strict variation authentication. */
export function pickWebfontPrimaryForCharacter(
  family: string,
  weight: number,
  fontSize: number,
  slant: number,
  character: number,
  variationSettings?: Record<string, number>,
  stretch = 100,
  /** Blink request slope in CSS degrees; see `webfontRequestSlope`. */
  requestSlope?: number,
): FontInstance | null {
  const variants = webfontRegistry.get(family.toLowerCase());
  if (variants == null || variants.length === 0) return null;
  const request = { weight, stretch, slope: webfontRequestSlope(slant, requestSlope) };
  const group = webfontDescriptorGroup(variants, request);
  for (let index = group.length - 1; index >= 0; index--) {
    const variant = group[index];
    if (!unicodeRangeCovers(variant.unicodeRange, character)) continue;
    const instance = applyVariationAxes(variant.font, weight, fontSize, slant, variationSettings, stretch, {
      wdthCapabilities: variant.stretch ?? null,
      wdthAlways: true,
      wghtCapabilities: variant.weightCaps ?? null,
    });
    const axes = (variant.font as FontInstance & { variationAxes?: Record<string, unknown> }).variationAxes ?? {};
    // Blink gates automatic slnt pins on the descriptor's auto provenance
    // (font_custom_platform_data.cc:178-192). The ordinary text instancer
    // predates that distinction; leave this image metric unresolved instead.
    if (axes.slnt != null) throw new Error("isolated slant-axis metrics unavailable");
    if (
      instance._appliedVariationAxes == null &&
      (["wght", "wdth", "opsz"].some((tag) => axes[tag] != null) || (slant !== 0 && axes.slnt != null))
    ) {
      // The ordinary text route may degrade to the base face when fontkit
      // cannot instantiate a container. Isolated units must not claim that
      // base advance is the requested variable instance.
      throw new Error("isolated font variation instance unavailable");
    }
    return tagWebfontInstance(instance, variant);
  }
  return null;
}

/**
 * Materialize a segmented webfont family's faces in Blink's iteration order.
 * `CSSSegmentedFontFace::GetFontData` appends every valid declaration via
 * `ForEachReverse`; `FontFallbackIterator` subsequently filters those faces
 * against the CURRENT hint list. FontFaceCache first selects one exact
 * FontSelectionCapabilities group; score only to choose that group, then do
 * not collapse overlaps within it: a later declaration that shares both bytes
 * and unicode-range with an earlier one is still a distinct segmented face.
 */
export function webfontVariantsInDeclarationOrder(
  family: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings?: Record<string, number>,
  stretch: number = 100,
  /** Blink request slope in CSS degrees; see `webfontRequestSlope`. */
  requestSlope?: number,
): FontInstance[] {
  const variants = webfontRegistry.get(family.toLowerCase()) ?? [];
  if (variants.length === 0) return [];
  const request = { weight, stretch, slope: webfontRequestSlope(slant, requestSlope) };
  const group = webfontDescriptorGroup(variants, request, "segmented");
  const out: FontInstance[] = [];
  for (let i = group.length - 1; i >= 0; i--) {
    const variant = group[i];
    const instance = tagWebfontInstance(
      applyVariationAxes(variant.font, weight, fontSize, slant, variationSettings, stretch, {
        wdthCapabilities: variant.stretch ?? null,
        wdthAlways: true,
        wghtCapabilities: variant.weightCaps ?? null,
      }),
      variant,
    );
    instance.webfontDeclarationOrder = variants.indexOf(variant);
    out.push(instance);
  }
  return out;
}

/**
 * Stamp the matched variant's synthetic-bold face constants onto the instance
 * the renderer will use, so the faux-bold seam can tell a webfont run from a
 * system-font one (the two obey DIFFERENT Blink rules) without threading the
 * registry through.
 *
 * Mutation is safe here because every field is a per-variant CONSTANT: each
 * `registerWebfont` call opens its own fontkit `Font`, so no two variants share
 * an instance, and re-picking the same variant at another weight writes the
 * same values back.
 */
function tagWebfontInstance(instance: FontInstance, variant: WebfontVariant): FontInstance {
  if (variant.synthesisFace != null) instance.webfontFace = variant.synthesisFace;
  // DM-1964: carry the file's bytes so the HarfBuzz reroutes can open the face.
  if (variant.buffer != null) instance.webfontBuffer = variant.buffer;
  // Carry the variant's `unicode-range` so the cluster-granularity splitter can
  // clamp shaped-cluster verdicts to it (Blink's segmented-face range set).
  if (variant.unicodeRange != null) instance.webfontUnicodeRange = variant.unicodeRange;
  return instance;
}

/** The metadata the test-only meta pickers report for a chosen variant. */
interface WebfontVariantMeta {
  weight: number;
  italic: boolean;
  unicodeRange?: Array<[number, number]>;
  stretch?: readonly [number, number];
  weightCaps?: readonly [number, number];
  slopeCaps?: readonly [number, number];
  /** Index of the chosen variant in the family's registration order. */
  declarationIndex: number;
}

function webfontVariantMeta(family: string, best: WebfontVariant | null): WebfontVariantMeta | null {
  if (best == null) return null;
  return {
    weight: best.weight,
    italic: best.italic,
    unicodeRange: best.unicodeRange,
    stretch: best.stretch,
    weightCaps: best.weightCaps,
    slopeCaps: best.slopeCaps,
    declarationIndex: webfontRegistry.get(family.toLowerCase())?.indexOf(best) ?? -1,
  };
}

/**
 * Test-only: return metadata for the variant `pickWebfontVariant` would
 * choose, without resolving variation axes / returning a FontInstance. Lets
 * unit tests verify scoring (weight, italic, unicode-range) without needing
 * to introspect glyph paths. `italic` maps to a request slope of 14 unless
 * `requestSlope` gives the CSS-degree slope explicitly.
 */
export function __pickWebfontVariantMetaForTest(
  family: string,
  weight: number,
  italic: boolean,
  stretch: number = 100,
  requestSlope?: number,
): WebfontVariantMeta | null {
  return webfontVariantMeta(
    family,
    selectPrimaryWebfontVariant(family.toLowerCase(), weight, italic ? 1 : 0, stretch, requestSlope),
  );
}

/** Test-only meta variant for `pickWebfontVariantForCodepoint` (DM-557). */
export function __pickWebfontVariantMetaForCodepointForTest(
  family: string,
  weight: number,
  italic: boolean,
  codepoint: number,
  stretch: number = 100,
  requestSlope?: number,
): WebfontVariantMeta | null {
  const variants = webfontRegistry.get(family.toLowerCase());
  if (variants == null || variants.length === 0) return null;
  const request = { weight, stretch, slope: webfontRequestSlope(italic ? 1 : 0, requestSlope) };
  return webfontVariantMeta(
    family,
    pickWithinWebfontGroup(webfontDescriptorGroup(variants, request), request, (v) =>
      unicodeRangeCovers(v.unicodeRange, codepoint),
    ),
  );
}

/** Drop all registered webfonts. Call at the start of a fresh capture run. */
export function clearWebfonts(): void {
  webfontRegistry.clear();
  localFontAliasRegistry.clear();
}

/**
 * `@font-face { src: local(...) }` aliases. Maps a CSS family name (e.g.
 * `"TestSerif"`) to one or more resolved on-disk font keys per declared
 * (weight, style) variant. When the page declares an `@font-face` with
 * all-`local()` sources, capture.ts walks the local() list and registers the
 * first recognized system font name here, paired with the @font-face's own
 * `font-weight` / `font-style` descriptors — so the renderer can score the
 * declared variants like a webfont would (DM-360).
 *
 * Without per-variant tracking, a request for `bold + italic` against a family
 * that declared only `regular`, `italic`, and `bold` (no bold-italic) would
 * incorrectly resolve to Georgia Bold Italic on disk; Chrome instead picks the
 * closest declared variant (italic 400) and synthesizes from there. DM-303 /
 * DM-360.
 */
interface LocalFontAliasVariant {
  weight: number;
  italic: boolean;
  baseKey: string;
}

export const localFontAliasRegistry = new Map<string, LocalFontAliasVariant[]>();

/**
 * Opaque value snapshot of the caller-supplied font registrations. The text
 * engine facade uses this to give each engine session its own webfont and
 * local-alias environment while the resolver is still implemented by this
 * module. Variants are immutable after registration, so copying the map and
 * array spines is sufficient; font buffers and parsed font objects are shared.
 */
export interface FontRegistrationSnapshot {
  readonly webfonts: ReadonlyArray<readonly [string, readonly WebfontVariant[]]>;
  readonly localAliases: ReadonlyArray<readonly [string, readonly LocalFontAliasVariant[]]>;
}

/** Capture the complete caller-supplied font environment. */
export function snapshotFontRegistrations(): FontRegistrationSnapshot {
  return {
    webfonts: [...webfontRegistry].map(([family, variants]) => [family, [...variants]]),
    localAliases: [...localFontAliasRegistry].map(([family, variants]) => [family, [...variants]]),
  };
}

/** Replace the caller-supplied font environment with a prior snapshot. */
export function restoreFontRegistrations(snapshot: FontRegistrationSnapshot): void {
  webfontRegistry.clear();
  for (const [family, variants] of snapshot.webfonts) webfontRegistry.set(family, [...variants]);
  localFontAliasRegistry.clear();
  for (const [family, variants] of snapshot.localAliases) localFontAliasRegistry.set(family, [...variants]);
}

/** A reusable empty registration environment for a new text-engine session. */
export function emptyFontRegistrations(): FontRegistrationSnapshot {
  return { webfonts: [], localAliases: [] };
}

export function registerLocalFontAlias(
  family: RegisteredFontFamily,
  resolvedKey: string,
  weight: number = 400,
  italic: boolean = false,
): void {
  // Preserve the legacy string API's trim → strip quotes → lowercase order
  // (DM-1597). Explicit decoded data keeps every name character, matching the
  // shared CSSOM parser rather than reinterpreting data as CSS syntax.
  const key =
    typeof family === "string"
      ? family
          .trim()
          .replace(/^["']|["']$/g, "")
          .toLowerCase()
      : family.decodedName.toLowerCase();
  if ((typeof family === "string" && key === "") || resolvedKey === "") return;
  const list = localFontAliasRegistry.get(key) ?? [];
  list.push({ weight, italic, baseKey: resolvedKey });
  localFontAliasRegistry.set(key, list);
}

/** Pick the declared (weight, style) variant closest to the requested combo:
 * a legacy boolean italic match dominates |Δweight|. This is NOT the Blink
 * FontSelectionAlgorithm that `pickWebfontVariant` applies. Returns the
 * matched variant's resolved base key (e.g. `"georgia"`), or null when no
 * variants are registered for the family. */
export function pickLocalFontAliasVariant(
  family: string,
  weight: number,
  italic: boolean,
): LocalFontAliasVariant | null {
  const variants = localFontAliasRegistry.get(family);
  if (variants == null || variants.length === 0) return null;
  let best: LocalFontAliasVariant | null = null;
  let bestScore = Infinity;
  for (const v of variants) {
    const styleMismatch = v.italic === italic ? 0 : 1000;
    const score = styleMismatch + Math.abs(v.weight - weight);
    if (score < bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

/**
 * Test-only: the variant `pickLocalFontAliasVariant` would choose for a
 * `(family, weight, italic)` request, without touching real fonts. Mirrors
 * `__pickWebfontVariantMetaForTest` so the local-alias scoring (italic dominates
 * weight) can be unit-tested on any platform (DM-1597).
 */
export function __pickLocalFontAliasVariantForTest(
  family: RegisteredFontFamily,
  weight: number,
  italic: boolean,
): LocalFontAliasVariant | null {
  const key =
    typeof family === "string"
      ? family
          .trim()
          .replace(/^["']|["']$/g, "")
          .toLowerCase()
      : family.decodedName.toLowerCase();
  return pickLocalFontAliasVariant(key, weight, italic);
}

/** Penalty for a primary-partition candidate that misses Basic Latin. It
 *  exceeds every legacy weight tie-break (at most 999), so it dominates
 *  within a group without ever reaching across groups. */
const WEBFONT_RANGE_MISMATCH = 1e7;

/**
 * The variant `pickWebfontVariant` materializes: Blink's capability group
 * first, then, ONLY inside that group, the partition whose `unicode-range`
 * covers Basic Latin. Google-Fonts-style partitioning registers e.g. Geist@400
 * across 3 woff2 files (Cyrillic, Latin Ext, Latin Basic); without the
 * preference the first registered partition would win regardless of whether it
 * has glyphs for the rendered text, and Latin runs would lay out as .notdef
 * tofu (DM-517). This supplies a stable primary instance; per-codepoint and
 * shaped fallback select the actual partition. The preference never crosses
 * descriptors.
 */
function selectPrimaryWebfontVariant(
  familyKey: string,
  weight: number,
  slant: number,
  stretch: number,
  requestSlope: number | undefined,
): WebfontVariant | null {
  const variants = webfontRegistry.get(familyKey);
  if (variants == null || variants.length === 0) return null;
  const request = { weight, stretch, slope: webfontRequestSlope(slant, requestSlope) };
  const LATIN_PROBE = 0x0041; // 'A'
  return pickWithinWebfontGroup(webfontDescriptorGroup(variants, request), request, undefined, (v) =>
    unicodeRangeCovers(v.unicodeRange, LATIN_PROBE) ? 0 : WEBFONT_RANGE_MISMATCH,
  );
}

/**
 * Pick the closest matching registered variant for the given family +
 * weight/style, then drive any variation axes the file exposes (so a single
 * variable webfont — Inter Variable, Roboto Flex, Recursive — can serve
 * multiple weights / sizes / slants from one buffer instead of substituting
 * the registered base instance for every request).
 *
 * Used internally by `getFontInstance` for `webfont:<name>` keys. Selection is
 * Blink's `IsBetterMatchForRequest` over the descriptor capabilities: stretch,
 * then style (`webfontStyleDistance`), then weight.
 */
export function pickWebfontVariant(
  family: string,
  weight: number,
  fontSize: number,
  slant: number,
  variationSettings?: Record<string, number>,
  /** CSS `font-stretch` percentage. A SELECTION axis — scored against each
   *  variant's `font-stretch` DESCRIPTOR capabilities before style and weight
   *  (Blink's `IsBetterMatchForRequest` order) — and the `wdth`-axis request
   *  for a variable webfont, clamped to the matched variant's descriptor
   *  capabilities when one is declared, else to the font's own wdth range
   *  (`FontCustomPlatformData::GetFontPlatformData`,
   *  `font_custom_platform_data.cc:155-169`, tag 147.0.7727.15). */
  stretch: number = 100,
  /** Blink request slope in CSS degrees; see `webfontRequestSlope`. */
  requestSlope?: number,
): FontInstance | null {
  const best = selectPrimaryWebfontVariant(family, weight, slant, stretch, requestSlope);
  if (best == null) return null;
  return tagWebfontInstance(
    applyVariationAxes(best.font, weight, fontSize, slant, variationSettings, stretch, {
      wdthCapabilities: best.stretch ?? null,
      wdthAlways: true,
      wghtCapabilities: best.weightCaps ?? null,
    }),
    best,
  );
}
