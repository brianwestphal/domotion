/** Mechanical extraction from font-resolution.ts; preserve resolver behavior. */
import { UNICODE_FONT_RANGES_WIN32 } from "./unicode-font-routing.win32.generated.js";
import { blinkWinHardcodedFamilies } from "./win-font-fallback.js";
import type { CssFallbackDescription } from "./fallback-chain.js";
import { winFallbackPriority } from "./family-match.js";
import { win32FamilyKey } from "./family-match.js";
import { win32DeferOrStatic } from "./family-match.js";
import { binarySearchRange } from "./fallback-chain.linux.js";

export function win32FallbackChain(
  codepoint: number,
  primaryKey?: string,
  lang?: string,
  css?: CssFallbackDescription,
): string[] {
  // Style-BLIND on purpose: this is Blink's `IsFontPresent`, which asks
  // `matchFamilyStyle(name, SkFontStyle())` with the default style while choosing
  // which family to nominate (`win/font_fallback_win.cc:54-65`). Whether a family
  // is installed does not depend on the run's weight.
  const families = blinkWinHardcodedFamilies(
    codepoint,
    {
      // Blink carries FontDescription::GenericFamily independently from the
      // concrete face selected for the first family.  A named Courier is not the
      // monospace enum, while a session-probed monospace generic need not resolve
      // to our `courier` key.  The unresolved CSS stack is therefore the owner.
      generic: css?.genericFamily === "monospace" ? "monospace" : "standard",
      lang,
      // DM-1985: the run's SEGMENTED priority, not an unconditional upgrade.
      // `winFallbackPriorityForTextRun` transcribes Blink's `kText → kEmojiText`
      // promotion (`win/font_cache_skia_win.cc:279-284`), and that promotion is
      // guarded on the priority ALREADY being `kText`. An emoji-presentation
      // codepoint never arrives as `kText` — the shaper's segmentation hands it
      // `EMOJI_EMOJI_PRESENTATION` (`platform/text/
      // emoji_segmentation_category_inline_header.h:63-65`), i.e. `kEmojiEmoji` —
      // so it reaches `GetFallbackFamily`'s color arm. Applying the promotion to
      // every `\p{Emoji}` codepoint inverted exactly that set: 😀🚀⭐ and U+1F46A
      // resolved Segoe UI Symbol where Chrome paints Segoe UI Emoji.
      //
      // A lone REGIONAL INDICATOR is deliberately NOT in this set (see
      // `isEmojiPresentationCp`), and Windows agrees it should not be — Chrome
      // answers Segoe UI Symbol for it, which is the `emoji-text` arm.
      //
      // `font-variant-emoji` sits ABOVE all of it: Blink runs
      // `ApplyFontVariantEmojiOnFallbackPriority` before this stage reads the
      // priority, so `text` forces the mono arm and `emoji` the color one
      // whatever the codepoint's own presentation says.
      priority: winFallbackPriority(codepoint, css?.fontVariantEmoji),
    },
    (family) => win32FamilyKey(family) != null,
  );

  // Style-CARRYING: instantiating the nominated family is
  // `GetFontPlatformData(font_description, create_by_family)`, so the cut comes
  // from the run's own description (DM-1878).
  const keys: string[] = [];
  for (const family of families) {
    const key = win32FamilyKey(family, css);
    if (key != null) keys.push(key);
  }

  // DM-987's generated per-block table: a Chrome CDP `CSS.getPlatformFontsForNode`
  // sweep over every Unicode block on a Windows 11 host, resolved to
  // C:\Windows\Fonts faces. Kept ONLY as the net behind the live DirectWrite
  // resolver — see `win32DeferOrStatic`.
  const generatedKey = lookupWin32UnicodeFontRange(codepoint);
  if (generatedKey != null) keys.push(...win32DeferOrStatic([generatedKey]));
  return keys;
}

/**
 * The Windows hardcoded-stage nomination under a FORCED fallback priority —
 * what `font-variant-emoji: emoji` produces: `ApplyFontVariantEmojiOnFallbackPriority`
 * (`shaping/harfbuzz_shaper.cc:184-198`, rev 7d859f27) sets the run's priority
 * to `kEmojiEmoji` before any platform stage runs, and `GetFallbackFamily`
 * (`win/font_fallback_win.cc:500-607`) then nominates the first installed
 * color-emoji family instead of consulting the per-block table.
 */
export function win32FallbackChainWithPriority(
  codepoint: number,
  priority: "emoji-emoji" | "emoji-text",
  lang?: string,
): string[] {
  const families = blinkWinHardcodedFamilies(codepoint, { lang, priority }, (family) => win32FamilyKey(family) != null);
  const keys: string[] = [];
  for (const family of families) {
    const key = win32FamilyKey(family);
    if (key != null) keys.push(key);
  }
  return keys;
}

/** Binary-search the generated `UNICODE_FONT_RANGES_WIN32` for a codepoint. */
function lookupWin32UnicodeFontRange(codepoint: number): string | null {
  return binarySearchRange(UNICODE_FONT_RANGES_WIN32, codepoint);
}
