/**
 * DM-1884: an emoji-presentation codepoint resolves to the STANDARD colour-emoji
 * face, without walking the CoreText cascade at all.
 *
 * Blink short-circuits at the very top of `PlatformFallbackFontForCharacter`
 * (`mac/font_cache_mac.mm:319-324`, Chromium rev `7d859f27`):
 *
 *     if (IsEmojiPresentationEmoji(fallback_priority)) {
 *       if (const SimpleFontData* emoji_font =
 *               GetFontData(font_description, AtomicString(kColorEmojiFontMac)))
 *         return emoji_font;
 *     }
 *
 * — a by-name family lookup of `"Apple Color Emoji"` (`:288`), performed before
 * `font_data_to_substitute` is read. So for emoji the cascade base cannot matter.
 *
 * Why this needs a regression test rather than just a fix: the defect was
 * INVISIBLE for as long as the cascade base happened to be a named face, whose
 * cascade reaches plain `AppleColorEmoji` anyway. It surfaced only when DM-1859
 * armed the CoreText UI-font base, whose own cascade list reaches the hidden
 * `.AppleColorEmojiUI` variant — which Blink's comment at `:156-159` predicts in
 * so many words. A future change to the base would silently reintroduce it, and
 * the fixture corpus cannot see it (DM-1879: nothing paints non-Latin under a
 * `system-ui` primary), so the guard has to live here.
 */
import { describe, expect, it, afterEach } from "vitest";
import { __resolveSystemFallbackKeyForCpForTest } from "./text-to-path.js";
import { clearGlyphHelperCache, isGlyphHelperAvailable } from "./glyph-helper.js";

// Needs real CoreText: the assertion is about which face the platform returns.
const darwinHelper = process.platform === "darwin" && isGlyphHelperAvailable();

(darwinHelper ? describe : describe.skip)("emoji-presentation fallback (DM-1884)", () => {
  afterEach(() => clearGlyphHelperCache());

  // The four codepoints the conformance oracle reported as
  // `AppleColorEmoji -> .AppleColorEmojiUI`, 1,186 rows in each of the three
  // `system-ui` stacks. All are Emoji_Presentation=Yes and all sit in
  // Miscellaneous Technical — a block `isEmojiCodepoint`'s hand-curated ranges
  // never covered, which is why nobody caught it by sampling.
  const EMOJI_PRESENTATION: Array<[number, string]> = [
    [0x231A, "⌚ watch"],
    [0x231B, "⌛ hourglass"],
    [0x23E9, "⏩ fast-forward"],
    [0x23EA, "⏪ rewind"],
    [0x1F600, "😀 grinning face"],
    [0x2B50, "⭐ star"],
  ];

  for (const [cp, label] of EMOJI_PRESENTATION) {
    it(`${label} resolves to the standard colour-emoji face, not the UI variant`, () => {
      const key = __resolveSystemFallbackKeyForCpForTest(cp);
      expect(key).toBe("sysfb:AppleColorEmoji");
      // The specific failure being guarded against: CoreText's UI-font cascade
      // answers with the hidden `.`-prefixed variant, which is a DIFFERENT face
      // in the same .ttc — so a path-level comparison would call it agreement.
      expect(key).not.toContain("UI");
    });
  }

  // Emoji_Presentation=No: these default to TEXT presentation, so Blink's
  // early return does not fire and they must keep walking the normal cascade.
  // Over-broadening the predicate to `\p{Emoji}` would swallow all of these —
  // ❤ and ☘ have Emoji=Yes but text presentation, and `#`/digits are Emoji=Yes
  // as keycap bases.
  const TEXT_PRESENTATION: Array<[number, string]> = [
    [0x2764, "❤ heavy black heart"],
    [0x2618, "☘ shamrock"],
    [0x0023, "# keycap base"],
    [0x0041, "A latin"],
    [0x4E00, "一 Han"],
  ];

  for (const [cp, label] of TEXT_PRESENTATION) {
    it(`${label} is NOT routed to the colour-emoji font`, () => {
      expect(__resolveSystemFallbackKeyForCpForTest(cp)).not.toBe("sysfb:AppleColorEmoji");
    });
  }

  // Emoji_Modifier: Emoji_Presentation=Yes, but Chrome answers these with the UI
  // variant — the early return does NOT fire, so the cascade runs. Measured, not
  // assumed: without this exclusion the fix traded 1,698 fixed rows for 15 newly
  // broken ones on the emoji slice. Blink's priority is a property of the
  // segmented RUN, and a lone modifier is a combining character rather than an
  // emoji-presentation run of its own.
  it("an emoji-presentation codepoint short-circuits under the system-ui base too", () => {
    // The base is what made the defect visible, so pin the fix under it as well
    // as under the default named base.
    expect(__resolveSystemFallbackKeyForCpForTest(0x231A, 400, 0, 16, "sf-pro", true))
      .toBe("sysfb:AppleColorEmoji");
  });

  // NOT asserted here: that Emoji_Modifier (U+1F3FB–U+1F3FF) keeps walking the
  // cascade. The exclusion is real and measured — on the emoji conformance slice
  // it is the difference between 45 mismatches with no inverted route and 60 with
  // a new 15-row `.AppleColorEmojiUI -> AppleColorEmoji` route — but the effect
  // is NOT reproducible through this seam: `resolveSystemFallbackKeyForCp`
  // returns `sysfb:AppleColorEmoji` for a modifier under either base, so the
  // oracle's differing answer must arrive via a different path through
  // `resolveFontForCodepoint`'s chain, which this seam bypasses.
  //
  // An assertion written against the mechanism I *assumed* passed for the wrong
  // reason, so it is deliberately absent rather than weakened into something
  // vacuous. The guard for that behaviour is the conformance slice:
  //   npx tsx tools/font-conformance.ts --max-stacks 8 \
  //     --range 2300-23FF --range 2B00-2BFF --range 1F300-1F5FF
  // Tracking the unexplained path is left to the ticket.

  it("is stable across weights, since Blink's early return ignores the description", () => {
    // The short-circuit happens before any weight-dependent work, so a bold run
    // must not drift to a different face — there is no bold colour-emoji cut.
    for (const weight of [100, 400, 700, 900]) {
      expect(__resolveSystemFallbackKeyForCpForTest(0x231A, weight)).toBe("sysfb:AppleColorEmoji");
    }
  });
});
