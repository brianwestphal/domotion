// Font-synthesis DECISIONS — "does this resolved face need a synthetic bold /
// oblique?" — shared by both render modes (DM-1984).
//
// The two predicates below used to live inline in `renderTextAsEmbedded`, which
// meant paths mode had no synthesis at all and any attempt to add it would have
// re-derived them. A second derivation of a font decision is the failure mode
// this area keeps producing (the sampled per-block routing table, the two
// disagreeing bold rules), so they live here once and both call sites read
// them. The HOW differs per mode — embedded mode bakes a shear into the
// outline and emits the frame as a `<text>` stroke, paths mode emits a group
// `skewX` and a group stroke — but the WHETHER must not.
//
// What is NOT here: `resolveFakeBoldTextStroke` (embolden-outline.ts), which
// turns "yes, synthesize" into the actual stroke width, and is likewise shared.

import { webfontSyntheticBold, type FontInstance } from "./font-resolution.js";
import { hostPlatform } from "./host-platform.js";
import { FAUX_BOLD_WEIGHT_DELTA } from "./embolden-outline.js";

/**
 * CSS `font-synthesis` longhand permissions, as captured. Absent = `auto`
 * (permitted); `false` = the author wrote `none` for that longhand.
 *
 * Blink treats these as hard VETOES rather than preferences —
 * `FontDescription::SyntheticBoldAllowed()` / `SyntheticItalicAllowed()` /
 * `SyntheticSmallCapsAllowed()` (`platform/fonts/font_description.h:312-320`,
 * checkout 7d859f27) are ANDed into every synthesis site.
 */
export interface FontSynthesisAllowance {
  /** `font-synthesis-weight` — gates faux-bold (fill bake AND stroke). */
  weight?: boolean;
  /** `font-synthesis-style` — gates faux-oblique (the shear). */
  style?: boolean;
  /** `font-synthesis-small-caps` — gates SYNTHESIZED small caps, i.e. the
   *  scaled-lowercase stand-in taken when the face has no `smcp`. A face that
   *  really carries `smcp` is unaffected: that is a real feature, not a
   *  synthesis. */
  smallCaps?: boolean;
}

/** Read one `font-synthesis` permission, defaulting to permitted (`auto`). */
export function synthesisAllowed(
  a: FontSynthesisAllowance | undefined, kind: keyof FontSynthesisAllowance,
): boolean {
  return a?.[kind] !== false;
}

/** The `FontInstance` fields the two predicates read — spelled out so a caller
 *  holding a partial instance (or a test fixture) can pass one without
 *  fabricating a whole font. */
export type SynthesisFace = Pick<FontInstance,
  "naturalWeight" | "faceIsBoldTrait" | "webfontFace"
  | "hasSlantAxis" | "isRoutedItalicCut" | "resolvedItalicAngle">;

/**
 * Whether Chrome would synthesize BOLD for this resolved face at this weight.
 *
 * DM-1880: Blink's synthetic-bold predicate is DIFFERENT ON EACH PLATFORM.
 * There is no single "Blink rule" to transcribe here — all three read from
 * `external/chromium`, rev 7d859f27:
 *
 *   macOS   mac/font_cache_mac.mm:424-427
 *           desired_bold = Weight() > 500;
 *           synthetic = desired_bold && !(traits & kCTFontTraitBold)
 *
 *   Linux   skia/font_cache_skia.cc:333-339          (also Android/Fuchsia)
 *           Weight() > FontSelectionValue(200) + typeface->fontStyle().weight()
 *
 *   Windows win/font_cache_skia_win.cc:486-488
 *           Weight() >= kBoldThreshold && !typeface->isBold()
 *           (kBoldThreshold = 600, font_selection_types.h:182;
 *            Skia's isBold() is the face's own declared weight >= 600)
 *
 * A DELTA on Linux, a THRESHOLD PAIR on macOS and Windows, and the two
 * thresholds are not even the same number (500 vs 600). Porting the Windows
 * rule everywhere would BREAK Linux, where the delta IS the transcription.
 *
 * A run resolved through the `@font-face` registry obeys a fourth, and
 * platform-INDEPENDENT, rule: Chrome decides webfont synthetic bold in the CSS
 * layer from the declared `font-weight` DESCRIPTOR, not from the file — so none
 * of the system-font predicates apply to it (`webfontSyntheticBold`).
 *
 * No variable-`wght` exemption is needed here: `naturalWeight` and
 * `faceIsBoldTrait` describe the INSTANTIATED variation instance — the same
 * fact `typeface->fontStyle().weight()` / `kCTFontTraitBold` describe for
 * Blink — so a face already instanced at the requested weight reaches "not
 * bold" on its own, through the same per-platform tests below that a static
 * face does. (Before that reporting fix, a variable `wght` axis reached the
 * outlines but never the metadata — `sf-pro` instanced at 400/700/900 all
 * reported `naturalWeight: 400, faceIsBoldTrait: false`, the unchanged
 * default — and this predicate carried a dedicated short-circuit to
 * compensate. See `font-resolution.ts`'s `getFontInstance` for where the
 * instantiated position is now read.)
 *
 * Honest substitution, unchanged from where this lived inline: macOS's test is
 * CoreText's `kCTFontTraitBold` symbolic trait. `faceIsBoldTrait` carries the
 * real thing when the extractor could read it (OS/2 `fsSelection` bit 5 for a
 * fontkit face, the CoreText trait for a helper-backed one); the
 * `naturalWeight >= 600` comparison is only a fallback for a face that reports
 * neither, and must not quietly become the primary signal — as the primary it
 * measurably regressed `2070-209F-superscripts-and-subscripts`.
 */
export function faceNeedsSyntheticBold(
  font: SynthesisFace,
  requestedWeight: number,
  fontSynthesis: FontSynthesisAllowance | undefined,
): boolean {
  // DM-1971: `font-synthesis-weight: none` vetoes faux-bold outright. Blink
  // ANDs `SyntheticBoldAllowed()` into BOTH synthesis paths — the webfont one
  // (`core/css/css_segmented_font_face.cc:116-119`) and the per-platform
  // system-font ones — so the veto sits above the whole ternary rather than
  // inside either branch.
  if (!synthesisAllowed(fontSynthesis, "weight")) return false;
  if (font.webfontFace != null) return webfontSyntheticBold(font.webfontFace, requestedWeight);
  const faceNaturalWeight = font.naturalWeight;
  if (faceNaturalWeight == null) return false;
  const platform = hostPlatform();

  if (platform === "darwin") {
    // `mac/font_cache_mac.mm:425-427`, rev 7d859f27:
    //   desired_bold = Weight() > 500
    //   synthetic = desired_bold && !(matched_font_traits & kCTFontTraitBold)
    // The trait is the WHOLE test upstream — there is no numeric fallback,
    // because CoreText always answers. Ours can be absent when the native
    // helper is unavailable, and defaulting that to "not bold" would synthesize
    // a second bold on top of every real Bold face; the declared-weight test is
    // the degradation for that case only, not part of the transcription.
    const faceIsBold = font.faceIsBoldTrait ?? faceNaturalWeight >= 600;
    return requestedWeight > 500 && !faceIsBold;
  }
  if (platform === "win32") {
    // `win/font_cache_skia_win.cc:486-488`: `Weight() >= kBoldThreshold &&
    // !typeface->isBold()`, with `kBoldThreshold = 600`
    // (`font_selection_types.h:182`). Here the numeric test IS the definition —
    // Skia's `isBold()` is the face's own declared weight >= 600 — so the
    // fallback and the trait agree by construction.
    const faceIsBold = font.faceIsBoldTrait ?? faceNaturalWeight >= 600;
    return requestedWeight >= 600 && !faceIsBold;
  }
  // Linux (also Android/Fuchsia) — `skia/font_cache_skia.cc:333-337`:
  //   Weight() > FontSelectionValue(200) + typeface->fontStyle().weight()
  // A DELTA against the matched face's own weight, not a fixed threshold, and
  // it never consults a bold trait. Porting either threshold rule here would
  // break it.
  return requestedWeight - faceNaturalWeight > FAUX_BOLD_WEIGHT_DELTA;
}

/**
 * Whether Chrome would synthesize an OBLIQUE for this resolved face.
 *
 * DM-1695: when italic is requested (slant ≠ 0) but the resolved face is
 * UPRIGHT — no italic sibling was routed to, no `slnt` axis carried the slant —
 * Chrome shears the glyph (`SkFont.setSkewX(-1/4)`, `font_platform_data.cc`).
 *
 * `resolvedItalicAngle` is the face's own `post.italicAngle`: a real italic
 * (|angle| ≥ 1°) already leans, so skip it. `isRoutedItalicCut` covers the
 * faces that lean but UNDER-REPORT it — some `.ttc` members ship an angle of 0
 * despite a visibly slanted outline, and shearing those a second time doubled
 * their lean.
 */
export function faceNeedsSyntheticOblique(
  font: SynthesisFace,
  slant: number,
  fontSynthesis: FontSynthesisAllowance | undefined,
): boolean {
  // DM-1971: `font-synthesis-style: none` vetoes the synthesized oblique —
  // Blink's `SyntheticItalicAllowed()`, ANDed in at the same place as the bold
  // one (`core/css/css_segmented_font_face.cc:120-123`). A face that really
  // leans is unaffected: the conditions below already exclude it.
  return synthesisAllowed(fontSynthesis, "style")
    && slant !== 0
    && font.hasSlantAxis !== true
    && font.isRoutedItalicCut !== true
    && (font.resolvedItalicAngle == null || Math.abs(font.resolvedItalicAngle) < 1);
}
