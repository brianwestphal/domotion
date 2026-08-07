/**
 * `text-decoration-skip-ink` exclusions, transcribed from Blink.
 *
 * The rule is `Character::CanTextDecorationSkipInk`
 * (`third_party/blink/renderer/platform/text/character.cc:143-167`, Chromium
 * rev `7d859f27`), applied PER CHARACTER while intercepts are collected
 * (`ShapeResultBloberizer::IsSkipInkException`,
 * `platform/fonts/shaping/shape_result_bloberizer.cc:228-234`).
 *
 * Why this needs pinning rather than trusting the implementation: we skip-inked
 * everything, so underlined CJK got gaps Chrome never paints. That is visible
 * in the unicode sweep's CJK blocks, but a pixel suite reports it as a small
 * per-tile delta rather than as "the rule is absent", and the tile still passes
 * at threshold. These assertions report it as a failure.
 *
 * Each case below names the clause it exercises, because the predicate has
 * three independent ones and a test that only covered Han ideographs would
 * miss two of them — including the Hangul clause, which no amount of CJK
 * testing reaches (Hangul is deliberately NOT part of the CJK property).
 */
import { describe, expect, it } from "vitest";
import { canTextDecorationSkipInk, isCjkIdeographOrSymbol } from "./unicode-classification.js";

const cp = (s: string) => s.codePointAt(0)!;

describe("canTextDecorationSkipInk — clause 1: the three shredded ASCII glyphs", () => {
  // `character.cc:144-147` — kSolidus / kReverseSolidus / kLowLine. These are
  // the only sub-U+02C7 exclusions; the CJK property's own `c < 0x2C7` early
  // out (`character.h:97-100`) means nothing else in ASCII can be excluded.
  it.each([
    ["/ SOLIDUS", 0x002f],
    ["\\ REVERSE SOLIDUS", 0x005c],
    ["_ LOW LINE", 0x005f],
  ])("%s does not skip ink", (_label, c) => {
    expect(canTextDecorationSkipInk(c)).toBe(false);
  });

  it("leaves neighbouring ASCII alone — the exclusion is three characters, not a range", () => {
    // U+002E and U+0030 bracket SOLIDUS; U+005B and U+005D bracket REVERSE
    // SOLIDUS; U+005E and U+0060 bracket LOW LINE. A range-shaped mistake
    // would take at least one of these with it.
    for (const c of [0x002e, 0x0030, 0x005b, 0x005d, 0x005e, 0x0060]) {
      expect(canTextDecorationSkipInk(c)).toBe(true);
    }
  });
});

describe("canTextDecorationSkipInk — clause 2: IsCjkIdeographOrSymbol", () => {
  it.each([
    ["日 CJK Unified Ideographs", 0x65e5],
    ["㐀 Extension A", 0x3400],
    ["豈 Compatibility Ideographs", 0xf900],
    ["𠀀 Supplementary Ideographic Plane", 0x20000],
    ["あ Hiragana", 0x3042],
    ["ア Katakana", 0x30a2],
    ["ㄅ Bopomofo", 0x3105],
    ["、 CJK Symbols and Punctuation", 0x3001],
    ["！ Fullwidth Forms", 0xff01],
    ["① Enclosed Alphanumerics (cjkSymbolRanges)", 0x2460],
  ])("%s does not skip ink", (_label, c) => {
    expect(canTextDecorationSkipInk(c)).toBe(false);
  });

  it("includes the Mandarin tone marks, which sit far below the CJK blocks", () => {
    // The four singletons that open `kIsCjkIdeographOrSymbolArray`. They are
    // also exactly where Blink's `c < 0x2C7` fast path stops, so getting the
    // boundary off by one drops U+02C7 itself.
    for (const c of [0x02c7, 0x02ca, 0x02cb, 0x02d9]) {
      expect(isCjkIdeographOrSymbol(c)).toBe(true);
      expect(canTextDecorationSkipInk(c)).toBe(false);
    }
    // One below the fast-path boundary: must NOT be CJK.
    expect(isCjkIdeographOrSymbol(0x02c6)).toBe(false);
  });

  it("excludes the Hangul tone marks from the punctuation range, as Blink does", () => {
    // `kIsCjkIdeographOrSymbolRanges` splits [0x2FF0,0x302D] + [0x3031,0x312F]
    // specifically to leave U+302E/U+302F out — "Hangul is not Han and no
    // other Hangul are included". A single merged range would swallow them.
    expect(isCjkIdeographOrSymbol(0x302d)).toBe(true);
    expect(isCjkIdeographOrSymbol(0x302e)).toBe(false);
    expect(isCjkIdeographOrSymbol(0x302f)).toBe(false);
    expect(isCjkIdeographOrSymbol(0x3031)).toBe(true);
  });

  it("covers emoji via Emoji_Presentation", () => {
    // The generator marks every `[:Emoji_Presentation:]` codepoint as a CJK
    // symbol (`character_property_data_generator.cc:117-124`), so emoji do not
    // skip ink either.
    for (const c of [0x1f600, 0x1f44d, 0x231a, 0x2b50]) {
      expect(canTextDecorationSkipInk(c)).toBe(false);
    }
  });
});

describe("canTextDecorationSkipInk — clause 3: the CJK-adjacent blocks", () => {
  // `character.cc:153-165`. These are excluded by BLOCK, explicitly because
  // `IsCjkIdeographOrSymbol` does not cover them — so they are unreachable by
  // any amount of testing against clause 2, and a reading of the rule that
  // stopped at "CJK ideographs and symbols" would miss Korean entirely.
  it.each([
    ["한 Hangul Syllables", 0xac00],
    ["ᄀ Hangul Jamo", 0x1100],
    ["ㄱ Hangul Compatibility Jamo", 0x3131],
    ["ꥠ Hangul Jamo Extended-A", 0xa960],
    ["ퟀ Hangul Jamo Extended-B", 0xd7b0],
    ["𐂀 Linear B Ideograms", 0x10080],
  ])("%s does not skip ink", (_label, c) => {
    expect(canTextDecorationSkipInk(c)).toBe(false);
  });

  it("is a block exclusion, not a CJK-property one", () => {
    // The distinction matters: if Hangul were folded into clause 2 it would
    // also suppress word segmentation elsewhere, which Blink does not do.
    expect(isCjkIdeographOrSymbol(0xac00)).toBe(false);
    expect(canTextDecorationSkipInk(0xac00)).toBe(false);
  });
});

describe("canTextDecorationSkipInk — what still skips", () => {
  it("permits Latin, Cyrillic, Greek, Arabic, Devanagari and Hebrew", () => {
    // The failure mode worth guarding against is an over-broad exclusion that
    // quietly turns skip-ink off for everything, which no CJK test would catch.
    for (const c of [cp("g"), cp("y"), cp("Q"), 0x0434, 0x03be, 0x0645, 0x0917, 0x05e7]) {
      expect(canTextDecorationSkipInk(c)).toBe(true);
    }
  });

  it("permits Thai and Hangul-adjacent-but-not-Hangul codepoints", () => {
    expect(canTextDecorationSkipInk(0x0e01)).toBe(true);   // ก THAI KO KAI
    expect(canTextDecorationSkipInk(0x10fff)).toBe(true);  // just past Linear B Ideograms
  });
});
