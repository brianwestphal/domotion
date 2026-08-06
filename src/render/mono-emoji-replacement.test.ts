/**
 * Blink's monochrome-emoji replacement, and the guard on its OUTPUT.
 *
 * `GetSubstituteFont` (`mac/font_cache_mac.mm:156-184`, rev 7d859f27) re-asks a
 * colour-emoji cascade answer from an "Apple Symbols" base carrying the colour
 * font's own cascade list. Its condition is `IsAppleColorEmojiFont(substitute)
 * && Character::IsEmoji(character)` — there is no term for the run's priority.
 * The priority acts one level up, as an early return for emoji-presentation
 * runs (`:314-324`), which our by-name short-circuit mirrors. So a DEFAULT run
 * over a text-presentation-default emoji reaches the replacement, and for a
 * long time ours only reached it under `font-variant-emoji: text`.
 *
 * Widening that gate alone made things WORSE — measured, +258 mismatches on the
 * emoji-range slice — because the replacement can come back having found no
 * monochrome face at all, and Chrome does not paint that answer. This file pins
 * both halves: the widened gate, and the discard.
 *
 * The discard is deliberately partial. Blink reaches the same outcome through a
 * VS-aware fallback walk we do not model (`shaping/harfbuzz_face.cc:191-204`
 * plus the `kIgnoreVariationSelector` reset pass at
 * `shaping/harfbuzz_shaper.cc:1008-1019`); what we model is the one consequence
 * that reaches this seam. The full mirror is tracked separately — these tests
 * are written against the OBSERVABLE answer rather than against the mechanism,
 * so they stay valid if it is built.
 */
import { describe, expect, it } from "vitest";
import {
  clearFontResolutionCaches,
  resolveFont,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontForCodepoint,
  resolveFontSpec,
} from "./font-resolution.js";
import { isGlyphHelperAvailable } from "./glyph-helper.js";
import { hostPlatform } from "./host-platform.js";

/** The replacement is a CoreText construction; it exists only on macOS, and
 *  only the native helper can perform it. */
const describeMac = hostPlatform() === "darwin" && isGlyphHelperAvailable()
  ? describe : describe.skip;

/** `system-ui` — the base whose cascade reaches Apple's hidden `.…UI` faces.
 *  The defect is invisible on any other stack, which is why the 273 rows that
 *  exposed it sat on this one and nowhere else. */
const SYSTEM_UI = "system-ui, -apple-system, sans-serif";

const SIZE = 20;
const WEIGHT = 700;

/** Resolve one codepoint the way the renderer does and report the face. */
function faceFor(
  cp: number, stack: string, systemUi: boolean, fve?: "text" | "emoji" | "unicode",
): string | null {
  const key = resolveFontKey(stack);
  const chain = resolveFontKeyChain(stack);
  const primary = resolveFont(stack, WEIGHT, SIZE, 0);
  if (primary == null) return null;
  const r = resolveFontForCodepoint(
    cp, primary, key, WEIGHT, SIZE, 0, undefined, "en", chain, systemUi, 100, fve);
  if (r.key == null) return null;
  return resolveFontSpec(r.key)?.postscriptName ?? r.key;
}

describeMac("the monochrome-emoji replacement and the guard on its result", () => {
  /**
   * U+1F321 🌡 THERMOMETER — text-presentation-default, so a default run
   * reaches the replacement, and no monochrome face covers it. Chrome paints
   * `.Apple Color Emoji UI` under a system-ui base: the face it had BEFORE the
   * replacement.
   *
   * Without the guard we answer plain `AppleColorEmoji` here, which is what the
   * re-ask returns and what made the widened gate regress. The two names differ
   * by one hidden variant, which is precisely why this needs a test rather than
   * an eyeball.
   */
  it("keeps the pre-replacement face when the re-ask finds no monochrome one", () => {
    clearFontResolutionCaches();
    const face = faceFor(0x1f321, SYSTEM_UI, true);
    expect(face, "the system-ui stack must resolve on this host").not.toBeNull();
    expect(face).toBe(".AppleColorEmojiUI");
  });

  it("still takes the replacement when a monochrome face DOES exist", () => {
    // The control, and the reason the guard is phrased as "was the result still
    // a colour emoji face" rather than "did the result change". U+2744 ❄ is
    // text-presentation-default and Apple ships monochrome coverage for it, so
    // a guard that discarded every replacement would show up here.
    //
    // Asserted as "not a colour emoji face" rather than as a specific name: the
    // face the cascade lands on is a property of the host's font set, and
    // pinning it would make this a test of this Mac's inventory.
    clearFontResolutionCaches();
    const face = faceFor(0x2744, SYSTEM_UI, true);
    expect(face).not.toBeNull();
    expect(["AppleColorEmoji", ".AppleColorEmojiUI"]).not.toContain(face);
  });

  it("leaves emoji-presentation codepoints on the PLAIN colour face", () => {
    // These never reach the replacement in Blink — the priority early return
    // answers first — and must not reach it here either. If the widened gate
    // ever started catching them, this is where it would show.
    //
    // Plain `AppleColorEmoji` rather than the `.…UI` variant even under a
    // system-ui base, and that asymmetry is the point: Blink's early return is
    // a by-NAME lookup (`GetFontData(font_description, kColorEmojiFontMac)`,
    // `mac/font_cache_mac.mm:319-324`), so it yields the public family whatever
    // the cascade base is. Only codepoints that go through the cascade — like
    // U+1F321 above — reach the hidden variant.
    clearFontResolutionCaches();
    expect(faceFor(0x1f600, SYSTEM_UI, true)).toBe("AppleColorEmoji");
    expect(faceFor(0x26a1, SYSTEM_UI, true)).toBe("AppleColorEmoji");
  });

  it("does not disturb the non-system-ui base, where the replacement already agreed", () => {
    // The `Helvetica` calibration recorded on `resolveSystemFallbackKeyForCp`
    // — U+26A1 ⚡ resolves to Apple Symbols — was measured against Chrome and
    // must survive both the widened gate and the guard. Apple Symbols is not a
    // colour emoji face, so the guard must not fire.
    //
    // It needs `font-variant-emoji: text` to be reachable at all: U+26A1 is
    // emoji-presentation-default, so a DEFAULT run takes the early return above
    // and never consults the cascade. Asserting it without the override tests
    // the short-circuit a second time rather than the replacement.
    clearFontResolutionCaches();
    expect(faceFor(0x26a1, "Helvetica, sans-serif", false, "text")).toBe("AppleSymbols");
  });
});
