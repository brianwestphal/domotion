/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { ICU_BINARY, icuCodepointProperties } from "./icu-helper.js";
import type { FontInstance } from "./font-instance.js";

/**
 * DM-1403: fontconfig live system-fallback for a codepoint the static Linux
 * table (`LINUX_FONT_PATHS`) misses — the analogue of the darwin CoreText
 * resolver. `fc-match :charset=<hex>` returns the best-priority installed font
 * whose charset covers `cp`; register it as a `sysfb:` key (fontkit-extracted,
 * like the rest of the Linux chain) so the chain walker opens it through the
 * normal path. Returns null when fontconfig finds nothing (→ the codepoint
 * falls through to LastResort tofu, unchanged from before).
 *
 * DM-1416 (coverage guard): `fc-match :charset` ALWAYS returns a font — when
 * nothing actually covers `cp` it returns fontconfig's default face (e.g. it
 * returns WenQuanYi Zen Hei for U+17000 Tangut, which WenQuanYi does not
 * contain). The empirical Chromium-on-noble calibration (tools/scratch
 * probe-1416) showed this is by far the dominant divergence between fc-match's
 * pick and Chromium's painted family: ~91% of divergences are exactly this
 * non-covering default, and the chain walker already drops them to tofu — which
 * matches Chromium, since Chromium also tofus those codepoints. So we verify the
 * matched font genuinely covers `cp` (`glyphForCodePoint(cp).id !== 0`) before
 * registering it; a non-covering pick returns null (→ tofu, as before) rather
 * than registering a face that would only be rejected downstream. Net effect:
 * the resolver registers ONLY covering faces (doc 80, calibration step 3).
 */
/**
 * A fontconfig `:lang=` pattern fragment for a CSS locale, or "" when there is
 * none to pass.
 *
 * The tag is passed through whole (lower-cased), NOT reduced to its primary
 * subtag. Measured against fontconfig on the pinned Playwright noble image, with
 * Noto CJK installed so the answer can discriminate at all:
 *
 *     :lang=zh-cn    → Noto Sans CJK SC     ← the region is what discriminates
 *     :lang=zh-tw    → Noto Sans CJK TC
 *     :lang=zh       → WenQuanYi Zen Hei    ← truncating loses the distinction
 *     :lang=zh-hans  → WenQuanYi Zen Hei    ← script subtags are NOT understood
 *     :lang=ja-jp    → (matches; same face here, no Japanese Noto installed)
 *
 * So fontconfig speaks language-REGION (RFC-3066 style), and cutting `zh-CN`
 * down to `zh` throws away precisely the Han-unification signal this argument
 * exists to carry. An earlier revision of this function did that, on the
 * assumption that a region-qualified tag "matches nothing" — measured false.
 *
 * A language-SCRIPT tag (`zh-Hans`) is passed through as-is and simply does not
 * discriminate, which is the same outcome as sending no locale. Mapping script
 * subtags onto regions (`Hans`→`cn`) would be inventing a table rather than
 * transcribing one. Chrome does not do it either: `GetFallbackFontForChar` adds
 * the locale string verbatim as `FC_LANG` (`ui/gfx/font_fallback_linux.cc:251-253`,
 * chromium 7d859f27), so passing the tag through whole is the transcription.
 */
export function fcLangProperty(lang?: string): string {
  if (lang == null) return "";
  const tag = lang.trim().toLowerCase().replace(/_/g, "-");
  // Guard the pattern string: fontconfig tags are alphanumeric subtags joined by
  // hyphens, and anything else would either match nothing or inject syntax into
  // the pattern (`:`/`,` are meaningful there).
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(tag)) return "";
  return `:lang=${tag}`;
}

/**
 * Blink's `IsEmojiPresentationEmoji(fallback_priority)`, as far as a single
 * codepoint can express it.
 *
 * Blink's version is a property of the SEGMENTED RUN — `kEmojiEmoji |
 * kEmojiEmojiWithVS` (`font_fallback_priority.h:45-48`) — so a text-presentation
 * codepoint followed by U+FE0F is emoji-presentation there and is not here. Our
 * resolver is per-codepoint, so this is the closest faithful reading: default
 * emoji presentation, minus the skin-tone modifiers, which are never a run's
 * priority on their own.
 *
 * Derived from Unicode properties rather than a hand-listed range set, so it
 * tracks the Unicode version rather than freezing one.
 *
 * DM-1989: a REGIONAL INDICATOR is excluded, and the reason is an ORDERING in
 * Blink's segmenter rather than a property. `GetEmojiSegmentationCategory`
 * (`platform/text/emoji_segmentation_category_inline_header.h:59-65`, rev
 * 7d859f27) tests them in this sequence:
 *
 *     if (Character::IsRegionalIndicator(codepoint))
 *       return EmojiSegmentationCategory::REGIONAL_INDICATOR;
 *
 *     if (Character::IsEmojiEmojiDefault(codepoint))
 *       return EmojiSegmentationCategory::EMOJI_EMOJI_PRESENTATION;
 *
 * The regional-indicator arm returns FIRST, so an RI is never categorised as
 * emoji-presentation however its `Emoji_Presentation` property reads — and it
 * does read Yes for U+1F1E6–U+1F1FF, which is why a property-only test gets
 * this wrong. It is the ragel state machine downstream that turns a PAIR of
 * them into an emoji sequence; a lone one falls through to text. Measured:
 * Chrome paints a lone U+1F1FA from FreeSans on Linux, not Noto Color Emoji.
 *
 * The pair is beyond what a per-codepoint predicate can express, and does not
 * need to be: a real flag sequence is painted by the capture layer's raster
 * overlay, which is keyed on the sequence rather than on this.
 */
export function isEmojiPresentationCp(cp: number): boolean {
  // Chromium 147's emoji segmenter predates the seven newly encoded Emoji 17
  // scalars. Linux Node 22 reports Unicode 17, so using its current property
  // data sends these through the U+1F46A color-emoji fallback even though
  // Chromium treats them as ordinary text and can paint Unifont Upper.
  // Keep this boundary pinned to the browser that the package ships with;
  // revisit it when that browser's emoji data advances.
  if (
    cp === 0x1faea ||
    cp === 0x1faef ||
    cp === 0x1fac8 ||
    cp === 0x1facd ||
    cp === 0x1f6d8 ||
    cp === 0x1fa8a ||
    cp === 0x1fa8e
  )
    return false;
  const pinned = icuCodepointProperties(cp);
  const ch = String.fromCodePoint(cp);
  const v2 = pinned != null && (pinned.binaryProperties & ICU_BINARY.V2) !== 0;
  if (v2 ? (pinned.binaryProperties & ICU_BINARY.REGIONAL_INDICATOR) !== 0 : /\p{Regional_Indicator}/u.test(ch))
    return false;
  if (v2 ? (pinned.binaryProperties & ICU_BINARY.EMOJI_MODIFIER) !== 0 : /\p{Emoji_Modifier}/u.test(ch)) return false;
  // An emoji-modifier BASE is emoji-presentation whatever its
  // `Emoji_Presentation` property says — and, like the regional-indicator case
  // above, that is an ORDERING rather than a property. The categoriser tests
  // `IsEmojiModifierBase` BEFORE `IsEmojiEmojiDefault`
  // (`emoji_segmentation_category_inline_header.h:53-65`, rev 7d859f27), so a
  // text-default base is categorised `EMOJI_MODIFIER_BASE`, never
  // `EMOJI_TEXT_PRESENTATION` — and the ragel grammar's `emoji_presentation`
  // rule admits that whole category.
  //
  // Read the grammar at the revision `DEPS` PINS, not upstream HEAD: Chromium
  // pins google/emoji-segmenter `955936be8b391e00835257059607d7c5b72ce744`
  // (`DEPS:378`), where the rule is `… | TAG_BASE | EMOJI_MODIFIER_BASE | …`.
  // Upstream later split the category into `_TEXT` / `_EMOJI` halves and
  // narrowed the rule to `_EMOJI`, which is the OPPOSITE answer for exactly
  // these codepoints. When Chromium rolls that pin, this line changes with it.
  //
  // Measured consequence: the nine `Emoji_Presentation=No` modifier bases
  // (U+261D U+26F9 U+270C U+270D U+1F3CB U+1F3CC U+1F574 U+1F575 U+1F590)
  // account for ~6,038 disagreeing rows in the full-corpus Linux sweep, where
  // Chrome paints Noto Color Emoji and a property-only reading paints FreeSans
  // or Unifont. Chrome reaches the color face only because emoji presentation
  // sends the query down the substituted-codepoint/`und-Zsye` branch — Noto
  // Color Emoji is LAST in the `:lang=en` fontconfig order, so no walk of that
  // order could ever have found it.
  if (pinned != null) {
    if ((pinned.binaryProperties & ICU_BINARY.EMOJI_MODIFIER_BASE) !== 0) return true;
    return (pinned.binaryProperties & ICU_BINARY.EMOJI_PRESENTATION) !== 0;
  }
  if (/\p{Emoji_Modifier_Base}/u.test(ch)) return true;
  return /\p{Emoji_Presentation}/u.test(ch);
}

/**
 * CSS `font-variant-emoji` values that override presentation (`normal` — no
 * override — is expressed as `undefined` throughout the pipeline).
 *
 * Blink turns the property into two mechanisms (rev 7d859f27):
 *  1. a fallback-priority override — `ApplyFontVariantEmojiOnFallbackPriority`
 *     (`shaping/harfbuzz_shaper.cc:184-198`) forces the run to `kEmojiEmoji`
 *     (`emoji`) or `kText` (`text`) unless the priority came from an explicit
 *     VS15/VS16 in the text (`HasVSFallbackPriority`);
 *  2. a forced variation selector in the glyph lookup —
 *     `GetVariationSelectorModeFromFontVariantEmoji`
 *     (`shaping/variation_selector_mode.cc:19-32`) maps `text`→VS15,
 *     `emoji`→VS16, `unicode`→the codepoint's Unicode default, and
 *     `HarfBuzzGetGlyph` (`shaping/harfbuzz_face.cc:127-206`) then treats a
 *     candidate face with the WRONG presentation as having no glyph
 *     (`kUnmatchedVSGlyphId`), so the cascade moves on. When no face with the
 *     requested presentation exists anywhere, the shaper resets the fallback
 *     queue and re-resolves ignoring the selector
 *     (`harfbuzz_shaper.cc:1010-1020`) — which is why `font-variant-emoji:
 *     text` on U+1F600 still paints the color font.
 */
export type FontVariantEmojiOverride = "text" | "emoji" | "unicode";

/**
 * Blink's `Character::IsEmoji` — the Unicode `Emoji` property. This is the
 * gate for the forced variation selector (`harfbuzz_face.cc:137-139`), and it
 * INCLUDES the keycap bases (`0-9`, `#`, `*`): measured on the pinned Chrome,
 * `font-variant-emoji: emoji` really does move a bare digit `5` and `#` from
 * Helvetica to Apple Color Emoji (CDP `getPlatformFontsForNode`).
 */
export function isEmojiCharCp(cp: number): boolean {
  const pinned = icuCodepointProperties(cp);
  return pinned != null
    ? (pinned.binaryProperties & ICU_BINARY.EMOJI) !== 0
    : /\p{Emoji}/u.test(String.fromCodePoint(cp));
}

/**
 * Does `fve` force EMOJI presentation for this codepoint? `emoji` forces VS16
 * for every `Emoji` codepoint (`harfbuzz_face.cc:156-160`,
 * kForceVariationSelector16); `unicode` only where the Unicode default is
 * already emoji presentation (`IsEmojiEmojiDefault`, same lines) — measured:
 * under `unicode`, U+26A1 moves OFF a covering Apple Symbols primary to Apple
 * Color Emoji, while text-default U+2764 stays on its normal cascade.
 */
export function forcesEmojiPresentation(cp: number, fve: FontVariantEmojiOverride | undefined): boolean {
  if (fve === "emoji") return isEmojiCharCp(cp);
  if (fve === "unicode") return isEmojiPresentationCp(cp);
  return false;
}

/**
 * Blink `ColorTableLookup::TypefaceHasAnySupportedColorTable`, transcribed
 * from `opentype/color_table_lookup.cc` (Chromium rev 7d859f27).
 *
 * A face is color-capable when it contains sbix, both COLR+CPAL, or both
 * CBDT+CBLC. This is deliberately a table query rather than an emoji-family
 * allowlist: author webfonts can carry any of these formats under any name.
 * Native-helper faces expose the same directory evidence through their meta
 * response, so this decision never depends on a family or PostScript name.
 */
export function fontHasSupportedColorTable(font: Pick<FontInstance, "directory">, _key = ""): boolean {
  const tables = font.directory?.tables;
  if (tables == null) return false;
  if ("sbix" in tables) return true;
  if ("COLR" in tables && "CPAL" in tables) return true;
  if ("CBDT" in tables && "CBLC" in tables) return true;
  return false;
}
