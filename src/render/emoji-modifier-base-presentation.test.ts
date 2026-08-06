/**
 * An emoji-modifier BASE is emoji-presentation whatever its Unicode
 * `Emoji_Presentation` property says — and, like the regional-indicator
 * exclusion beside it, that is an ORDERING in Blink's categoriser rather than a
 * property.
 *
 * `GetEmojiSegmentationCategory`
 * (`platform/text/emoji_segmentation_category_inline_header.h:53-65`, Chromium
 * rev `7d859f27`) tests:
 *
 *     if (Character::IsEmojiModifierBase(codepoint))
 *       return EmojiSegmentationCategory::EMOJI_MODIFIER_BASE;
 *     if (Character::IsModifier(codepoint))          → EMOJI_MODIFIER
 *     if (Character::IsRegionalIndicator(codepoint)) → REGIONAL_INDICATOR
 *     if (Character::IsEmojiEmojiDefault(codepoint)) → EMOJI_EMOJI_PRESENTATION
 *
 * The modifier-base arm returns FIRST, so a text-default base is never
 * categorised `EMOJI_TEXT_PRESENTATION` — and the ragel grammar's
 * `emoji_presentation` rule admits the whole `EMOJI_MODIFIER_BASE` category
 * while omitting bare `EMOJI_MODIFIER` and `REGIONAL_INDICATOR`.
 *
 * READ THAT GRAMMAR AT THE PINNED REVISION. Chromium pins google/emoji-segmenter
 * `955936be8b391e00835257059607d7c5b72ce744` (`DEPS:378`), where the rule reads
 * `… | TAG_BASE | EMOJI_MODIFIER_BASE | …`. Upstream HEAD later SPLIT that
 * category into `_TEXT` / `_EMOJI` halves and narrowed the rule to `_EMOJI` —
 * the opposite answer for exactly the codepoints below. Reading HEAD instead of
 * the pin produced a confidently wrong conclusion once already; if this test
 * starts failing after a Chromium roll, check the pin before "fixing" it.
 *
 * Why a unit test and not just the sweeps: this predicate is consumed by all
 * three platforms' emoji stages, and the consequence is only visible where a
 * colour-emoji face exists to be reached. It was already wrong at a SECOND call
 * site that had inlined its own copy of the property test — the shared predicate
 * was corrected and the duplicate silently kept the old behaviour, which is
 * precisely the failure a per-platform fixture cannot catch.
 */
import { describe, expect, it } from "vitest";
import { isEmojiPresentationCp } from "./font-resolution.js";

/** The `Emoji_Modifier_Base` characters whose `Emoji_Presentation` is No — the
 *  set where the property and the categoriser disagree. Measured cost of getting
 *  these wrong: ~6,038 disagreeing rows on Linux and ~3,958 on Windows in the
 *  full-corpus conformance sweeps, plus 250 in a 5M-comparison macOS slice. */
const TEXT_DEFAULT_MODIFIER_BASES = [
  0x261d, // ☝ WHITE UP POINTING INDEX
  0x26f9, // ⛹ PERSON WITH BALL
  0x270c, // ✌ VICTORY HAND
  0x270d, // ✍ WRITING HAND
  0x1f3cb, // 🏋 WEIGHT LIFTER
  0x1f3cc, // 🏌 GOLFER
  0x1f574, // 🕴 MAN IN BUSINESS SUIT LEVITATING
  0x1f575, // 🕵 SLEUTH OR SPY
  0x1f590, // 🖐 RAISED HAND WITH FINGERS SPLAYED
];

describe("isEmojiPresentationCp — emoji-modifier bases", () => {
  it.each(TEXT_DEFAULT_MODIFIER_BASES)(
    "treats U+%s as emoji presentation despite Emoji_Presentation=No",
    (cp) => {
      // The premise of the test, asserted so it fails loudly rather than
      // silently passing if Unicode ever flips the property on these.
      expect(/\p{Emoji_Presentation}/u.test(String.fromCodePoint(cp))).toBe(false);
      expect(/\p{Emoji_Modifier_Base}/u.test(String.fromCodePoint(cp))).toBe(true);
      expect(isEmojiPresentationCp(cp)).toBe(true);
    },
  );

  it("still treats emoji-presentation defaults as emoji presentation", () => {
    expect(isEmojiPresentationCp(0x1f600)).toBe(true); // 😀
    expect(isEmojiPresentationCp(0x231a)).toBe(true); // ⌚
  });

  it("excludes lone skin-tone modifiers — EMOJI_MODIFIER is absent from the pinned rule", () => {
    for (let cp = 0x1f3fb; cp <= 0x1f3ff; cp++) {
      expect(/\p{Emoji_Modifier}/u.test(String.fromCodePoint(cp))).toBe(true);
      expect(isEmojiPresentationCp(cp)).toBe(false);
    }
  });

  it("excludes lone regional indicators — REGIONAL_INDICATOR is absent from the pinned rule", () => {
    // Their own `Emoji_Presentation` reads Yes, so a property-only test gets
    // these wrong in the other direction. A PAIR is an emoji sequence, which is
    // beyond what a per-codepoint predicate expresses and is handled elsewhere.
    for (const cp of [0x1f1e6, 0x1f1fa, 0x1f1ff]) {
      expect(/\p{Emoji_Presentation}/u.test(String.fromCodePoint(cp))).toBe(true);
      expect(isEmojiPresentationCp(cp)).toBe(false);
    }
  });

  it("leaves ordinary text alone", () => {
    for (const cp of [0x41, 0x20, 0x4e2d, 0x2603]) {
      expect(isEmojiPresentationCp(cp)).toBe(false);
    }
  });
});
