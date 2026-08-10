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

import { webfontSyntheticBold, webfontSyntheticItalic, BLINK_ITALIC_SLOPE_VALUE, type FontInstance } from "./font-resolution.js";
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
  "naturalWeight" | "faceIsBoldTrait" | "faceIsItalicTrait" | "webfontFace"
  | "hasSlantAxis" | "isRoutedItalicCut" | "resolvedItalicAngle"
  | "linuxFallbackIsBold" | "linuxFallbackIsItalic">;

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
 * DM-2017: a Linux face resolved through the LIVE PER-CODEPOINT FALLBACK
 * (`resolveFcFallbackFonts`'s `fcfallback` query, not a declared family or the
 * static chain) obeys a FIFTH rule, and it is not the Linux delta above.
 * `FontCache::PlatformFallbackFontForCharacter` builds the substitute
 * `FontPlatformData` and then explicitly OVERRIDES its synthetic-bold flag
 * from fontconfig's own `is_bold` bit (`linux/font_cache_linux.cc:110-117,
 * 132-136`) — a binary test shaped like the Windows rule above, not the delta.
 * See `FontInstance.linuxFallbackIsBold`.
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
  const platform = hostPlatform();
  // DM-2017: a Linux LIVE-FALLBACK pick (the `fcfallback` resolver) is
  // governed by a BINARY test against fontconfig's OWN is_bold classification
  // of the chosen candidate, not the general per-platform rule below — see
  // `FontInstance.linuxFallbackIsBold`. Checked before the `naturalWeight`
  // null-guard: a fallback face's fontconfig classification can be present
  // even when its OS/2 weight class isn't readable.
  //   `linux/font_cache_linux.cc:110-117`, rev 7d859f27:
  //     should_set_synthetic_bold = !fallback_font.is_bold &&
  //         description.Weight() >= kBoldThreshold && SyntheticBoldAllowed();
  // This OVERRIDES whatever `CreateFontPlatformData`'s internal delta test
  // (the plain Linux branch below) would have computed — Blink calls
  // `platform_data->SetSyntheticBold(should_set_synthetic_bold)` explicitly
  // right after resolving the substitute face (`:132-136`).
  if (platform === "linux" && font.linuxFallbackIsBold != null) {
    return requestedWeight >= 600 && !font.linuxFallbackIsBold;
  }
  const faceNaturalWeight = font.naturalWeight;

  if (platform === "darwin") {
    // `mac/font_cache_mac.mm:425-427`, rev 7d859f27:
    //   desired_bold = Weight() > 500
    //   synthetic = desired_bold && !(matched_font_traits & kCTFontTraitBold)
    // The trait is the WHOLE test upstream — there is no numeric fallback,
    // because CoreText always answers. `faceIsBoldTrait` carries exactly that
    // bit (OS/2 fsSelection for a fontkit face, the CoreText trait for a
    // native-helper one), read at the INSTANTIATED axis. `naturalWeight` is
    // only a degradation for a face reporting NEITHER, and must NOT gate the
    // branch: a native-helper-backed face (the PingFang/SF-Compact cuts)
    // reports the trait but never parses an OS/2 weight class, so the old
    // up-front `naturalWeight == null` bail silently disabled synthetic bold
    // for every one of them (DM-2025). Bail only when both signals are absent,
    // where "not bold" is the safe degradation (never double-bold a real Bold).
    const faceIsBold =
      font.faceIsBoldTrait ?? (faceNaturalWeight != null ? faceNaturalWeight >= 600 : null);
    if (faceIsBold == null) return false;
    return requestedWeight > 500 && !faceIsBold;
  }
  if (platform === "win32") {
    // `win/font_cache_skia_win.cc:486-488`: `Weight() >= kBoldThreshold &&
    // !typeface->isBold()`, with `kBoldThreshold = 600`
    // (`font_selection_types.h:182`). Here the numeric test IS the definition —
    // Skia's `isBold()` is the face's own declared weight >= 600 — so the
    // fallback and the trait agree by construction. Same null handling as
    // darwin: the DirectWrite default path is native-helper-backed and reports
    // the trait without an OS/2 weight, so gating on `naturalWeight` up front
    // disabled it there too (DM-2025).
    const faceIsBold =
      font.faceIsBoldTrait ?? (faceNaturalWeight != null ? faceNaturalWeight >= 600 : null);
    if (faceIsBold == null) return false;
    return requestedWeight >= 600 && !faceIsBold;
  }
  // Linux (also Android/Fuchsia) — `skia/font_cache_skia.cc:333-337`:
  //   Weight() > FontSelectionValue(200) + typeface->fontStyle().weight()
  // A DELTA against the matched face's own weight, not a fixed threshold, and
  // it never consults a bold trait. Porting either threshold rule here would
  // break it. This branch genuinely needs the numeric weight, so it keeps the
  // `naturalWeight == null` bail the other two branches no longer share.
  if (faceNaturalWeight == null) return false;
  return requestedWeight - faceNaturalWeight > FAUX_BOLD_WEIGHT_DELTA;
}

/**
 * Whether Chrome would synthesize an OBLIQUE for this resolved face.
 *
 * DM-1695 first built this as ONE predicate for every platform, testing the
 * face's own `post.italicAngle` against an invented 1° threshold. Neither
 * half of that survives scrutiny against `external/chromium` (checkout
 * 7d859f27): Blink tests the ITALIC STYLE BIT, not the angle — and the three
 * platforms genuinely disagree about WHICH bit and how the request must
 * compare, so one un-dispatched predicate cannot express Chrome's actual
 * behavior:
 *
 *   macOS   mac/font_cache_mac.mm:431-436
 *           desired_italic = font_description.Style();  // ANY nonzero slope
 *           matched_font_italic = matched_font_traits & kCTFontTraitItalic;
 *           synthetic = desired_italic && !matched_font_italic;
 *
 *   Windows win/font_cache_skia_win.cc:490-493
 *           synthetic = (Style() == kItalicSlopeValue) && !typeface->isItalic();
 *           // EXACTLY 14 — kItalicSlopeValue, font_selection_types.h:171 —
 *           // not any nonzero slope.
 *
 *   Linux   skia/font_cache_skia.cc:341-345
 *           Byte-identical rule to Windows: `Style() == kItalicSlopeValue &&
 *           !typeface->isItalic()`.
 *
 * The macOS test is "any nonzero slope" (an author's `oblique 30deg` counts);
 * Windows and Linux test EQUALITY to the italic sentinel angle, which CSS
 * gives to `italic` and to bare `oblique` (no angle) alike
 * (`resolver/style_builder_converter.cc:1102-1140`) but NOT to
 * `oblique <angle>` for any angle other than exactly 14 — so `oblique 30deg`
 * synthesizes on macOS and must NOT on Linux/Windows. `requestedSlopeDegrees`
 * is that CSS-degree value (`BLINK_ITALIC_SLOPE_VALUE` = 14 for
 * `italic`/bare `oblique`, the literal angle otherwise); see
 * `blinkRequestedSlopeDegrees` in text-to-path.ts for where it is computed
 * from the captured `font-style` string.
 *
 * `faceIsItalicTrait` carries the platform face's italic style bit — the mirror
 * of `faceIsBoldTrait`, wired from the native helper's `traitItalic` meta field.
 * CoreText reports `kCTFontTraitItalic`; Linux reports the FreeType face's
 * native italic style bit; Windows reports `IDWriteFontFace3::GetStyle()`.
 * Older helpers omit the optional field and preserve the outline-derived
 * fallback below.
 *
 * That heuristic — `hasSlantAxis` / `isRoutedItalicCut` /
 * `resolvedItalicAngle` — is what this predicate used exclusively before this
 * platform split, and remains each platform's fallback when its trait signal
 * is unavailable: `resolvedItalicAngle` is the face's own `post.italicAngle`
 * (a real italic, |angle| ≥ 1°, already leans, so skip it); `isRoutedItalicCut`
 * covers faces that lean but UNDER-REPORT it (some `.ttc` members ship an
 * angle of 0 despite a visibly slanted outline, and shearing those a second
 * time doubled their lean); `hasSlantAxis` covers a variable face that baked
 * the slant into its `slnt` axis instead.
 *
 * DM-2017: a Linux LIVE-FALLBACK pick is a separate exception to all of the
 * above — Blink's `PlatformFallbackFontForCharacter` sets synthetic italic
 * from fontconfig's own `is_italic` bit tested against `Style() ==
 * kItalicSlopeValue` (EXACTLY, same sentinel as the general Linux rule above
 * — `linux/font_cache_linux.cc:118-125`, mirroring the bold override in
 * `faceNeedsSyntheticBold`). See `FontInstance.linuxFallbackIsItalic`.
 *
 * A run resolved through the `@font-face` registry obeys a fourth, and
 * platform-INDEPENDENT, rule — mirroring `faceNeedsSyntheticBold`'s webfont
 * branch: `webfontSyntheticItalic`.
 */
export function faceNeedsSyntheticOblique(
  font: SynthesisFace,
  requestedSlopeDegrees: number,
  fontSynthesis: FontSynthesisAllowance | undefined,
): boolean {
  // DM-1971: `font-synthesis-style: none` vetoes the synthesized oblique —
  // Blink's `SyntheticItalicAllowed()`, ANDed in at the same place as the bold
  // one (`core/css/css_segmented_font_face.cc:120-123`). A face that really
  // leans is unaffected: the conditions below already exclude it.
  if (!synthesisAllowed(fontSynthesis, "style")) return false;
  if (font.webfontFace != null) return webfontSyntheticItalic(font.webfontFace, requestedSlopeDegrees);
  const platform = hostPlatform();
  if (platform === "linux" && font.linuxFallbackIsItalic != null) {
    return requestedSlopeDegrees === BLINK_ITALIC_SLOPE_VALUE && !font.linuxFallbackIsItalic;
  }
  // The pre-existing outline-derived signal: does the RESOLVED face already
  // lean, by any of the three ways that can be true? Shared by every
  // platform as the fallback when its native trait is unavailable.
  const faceAlreadyLeans = font.hasSlantAxis === true
    || font.isRoutedItalicCut === true
    || (font.resolvedItalicAngle != null && Math.abs(font.resolvedItalicAngle) >= 1);
  if (platform === "darwin") {
    // `mac/font_cache_mac.mm:431-436`: ANY nonzero requested slope, tested
    // against the CoreText trait — full stop, when the trait is known. Falls
    // back to the outline heuristic only when the helper never answered
    // (older binary, no helper on host), same shape as `faceIsBoldTrait`'s
    // fallback in `faceNeedsSyntheticBold`.
    const faceIsItalic = font.faceIsItalicTrait ?? faceAlreadyLeans;
    return requestedSlopeDegrees !== 0 && !faceIsItalic;
  }
  // Windows / Linux (general, non-live-fallback) path — byte-identical rules:
  // `win/font_cache_skia_win.cc:490-493`, `skia/font_cache_skia.cc:341-345`.
  // The EXACT-14 test, not "any nonzero slope" — an author's `oblique 30deg`
  // does not synthesize here, only `italic` / bare `oblique` / literally
  // `oblique 14deg` do. Linux and Windows report their native face style bit;
  // older helper binaries safely retain the outline heuristic.
  const faceIsItalic = font.faceIsItalicTrait ?? faceAlreadyLeans;
  return requestedSlopeDegrees === BLINK_ITALIC_SLOPE_VALUE && !faceIsItalic;
}
