// Blink asks fontconfig a DIFFERENT question for an emoji-presentation run.
//
// `PlatformFallbackFontForCharacter` (`linux/font_cache_linux.cc:71-93`,
// Chromium rev 7d859f27) substitutes both the character and the locale before
// the query: the character becomes `uchar::kFamily` (U+1F46A FAMILY) and the
// locale becomes `kColorEmojiLocale` (`und-Zsye`, `fonts/font_cache.cc:82`).
//
// Both matter and for different reasons. Asking about FAMILY rather than the
// run's own emoji is deliberate over-asking — a font covering FAMILY is a real
// emoji font, where a font covering some individual emoji may be an ordinary
// text face that happens to carry a few. `und-Zsye` is what steers fontconfig
// toward a colour font instead of toward the page's language.
//
// These test the SUBSTITUTION rather than the resolver, on purpose. The resolver
// is platform-gated and needs fontconfig, so a test of it runs only on Linux —
// and the rule would then go unchecked on the machine most changes are written
// on, which is exactly how this went missing in the first place.
import { describe, expect, it } from "vitest";
import { blinkEmojiFallbackQuery, isEmojiPresentationCp } from "./font-resolution.js";

const FAMILY = 0x1f46a;
const ZSYE = "und-Zsye";

describe("Blink's emoji-presentation predicate", () => {
  it("holds for default-emoji-presentation codepoints", () => {
    for (const cp of [0x1f600 /* 😀 */, 0x1f46a /* 👪 */, 0x1f6d1 /* 🛑 */, 0x231a /* ⌚ */]) {
      expect(isEmojiPresentationCp(cp)).toBe(true);
    }
  });

  it("does not hold for text-presentation codepoints that are still Emoji", () => {
    // U+2600 SUN and U+2764 HEAVY BLACK HEART are `Emoji` but NOT
    // `Emoji_Presentation` — they default to text and need a VS16 to become
    // emoji. Treating them as emoji here would send ordinary dingbats down the
    // colour-font path.
    for (const cp of [0x2600, 0x2764, 0x203c, 0x2122]) {
      expect(isEmojiPresentationCp(cp)).toBe(false);
    }
  });

  it("excludes the skin-tone modifiers", () => {
    // U+1F3FB..U+1F3FF are `Emoji_Presentation` but are never a run's priority
    // on their own — they modify a preceding base. Blink's priority is a
    // property of the segmented run, so a lone modifier reaching the resolver
    // is not an emoji-presentation run.
    for (let cp = 0x1f3fb; cp <= 0x1f3ff; cp++) expect(isEmojiPresentationCp(cp)).toBe(false);
  });

  it("does not hold for ordinary text", () => {
    for (const cp of [0x41, 0x4e00, 0x0645, 0x0e01, 0x1f46a - 0x10000]) {
      expect(isEmojiPresentationCp(cp)).toBe(false);
    }
  });
});

describe("the query Blink actually sends fontconfig", () => {
  it("replaces BOTH the character and the locale for an emoji run", () => {
    // Both, not either. Substituting only the character still asks fontconfig
    // in the page's language; substituting only the locale still asks about a
    // codepoint a text font may happen to cover. Each alone would pass a test
    // that checked the other.
    expect(blinkEmojiFallbackQuery(0x1f600, "ja")).toEqual({ cp: FAMILY, lang: ZSYE });
    expect(blinkEmojiFallbackQuery(0x231a, undefined)).toEqual({ cp: FAMILY, lang: ZSYE });
  });

  it("overrides the content locale rather than deferring to it", () => {
    // The page's language losing is the point: a `lang="ja"` page must still get
    // a colour emoji font, not Hiragino.
    for (const lang of ["ja", "zh-Hans", "ar", "en-GB"]) {
      expect(blinkEmojiFallbackQuery(0x1f46a, lang).lang).toBe(ZSYE);
    }
  });

  it("leaves a non-emoji query completely alone", () => {
    // The control. A substitution that fired for everything would satisfy every
    // assertion above.
    expect(blinkEmojiFallbackQuery(0x4e00, "ja")).toEqual({ cp: 0x4e00, lang: "ja" });
    expect(blinkEmojiFallbackQuery(0x2764, "en")).toEqual({ cp: 0x2764, lang: "en" });
    expect(blinkEmojiFallbackQuery(0x41, undefined)).toEqual({ cp: 0x41, lang: undefined });
  });

  it("is idempotent, since FAMILY is itself emoji-presentation", () => {
    const once = blinkEmojiFallbackQuery(0x1f600, "ja");
    expect(blinkEmojiFallbackQuery(once.cp, once.lang)).toEqual(once);
  });
});

/**
 * A REGIONAL INDICATOR is not emoji-presentation, and the reason is an ORDERING
 * in Blink rather than a Unicode property (DM-1989).
 *
 * `GetEmojiSegmentationCategory`
 * (`platform/text/emoji_segmentation_category_inline_header.h:59-65`, rev
 * 7d859f27) returns `REGIONAL_INDICATOR` **before** it ever reaches the
 * `IsEmojiEmojiDefault` arm, so an RI is never categorised as
 * emoji-presentation — even though `Emoji_Presentation` reads Yes for all of
 * U+1F1E6–U+1F1FF. A property-only predicate therefore gets it exactly wrong,
 * which is what shipped: Chrome paints a lone U+1F1FA from FreeSans on Linux
 * and we routed it to Noto Color Emoji (156 rows on the Linux conformance
 * sweep).
 *
 * It is the ragel state machine downstream that turns a PAIR into a flag.
 */
describe("a lone regional indicator is not emoji-presentation (DM-1989)", () => {
  it("excludes the whole RI block, though Emoji_Presentation says Yes for it", () => {
    for (const cp of [0x1f1e6, 0x1f1fa, 0x1f1ff]) {
      // The precondition: the property really does say Yes, so this test is
      // pinning the ordering rule and not restating the property.
      expect(/\p{Emoji_Presentation}/u.test(String.fromCodePoint(cp))).toBe(true);
      expect(isEmojiPresentationCp(cp)).toBe(false);
    }
  });

  it("still treats ordinary emoji-presentation codepoints as such", () => {
    // The control — an exclusion that swallowed everything would pass above.
    for (const cp of [0x1f600, 0x1f46a, 0x1f680, 0x2b50]) {
      expect(isEmojiPresentationCp(cp)).toBe(true);
    }
  });

  it("leaves a lone RI's fallback query unsubstituted", () => {
    // The consequence that the conformance sweep actually measured: no U+1F46A
    // swap, no `und-Zsye` locale, so fontconfig is asked about the RI itself.
    expect(blinkEmojiFallbackQuery(0x1f1fa, "en")).toEqual({ cp: 0x1f1fa, lang: "en" });
  });
});
