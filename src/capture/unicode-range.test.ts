import { describe, expect, it } from "vitest";
import { parseUnicodeRangeDescriptor, unicodeRangeIntervalsCover } from "./unicode-range.js";

// DM-KRMZ4Y: one parser for the `@font-face` `unicode-range` descriptor,
// transcribed from Blink's tokenizer (`CSSTokenizer::ConsumeUnicodeRange`) and
// descriptor parser (`ConsumeFontFaceUnicodeRange`), Chromium 7d859f27. The
// token expectations below are the cases of Blink's own
// `CSSTokenizerTest.UnicodeRangeToken` (`css_tokenizer_test.cc:460-493`); a
// case Blink tokenizes as a range followed by another token is an invalid
// descriptor here, because the descriptor parser rejects anything that is not
// a comma or the end after a range.

describe("parseUnicodeRangeDescriptor: Blink's unicode-range tokens", () => {
  it.each([
    ["u+012345-10ffff", 0x012345, 0x10ffff],
    ["U+1234-2345", 0x1234, 0x2345],
    ["U+CafE-d00D", 0xcafe, 0xd00d],
    ["U+2??", 0x200, 0x2ff],
    ["U+10ff??", 0x10ff00, 0x10ffff],
    ["u+??", 0x00, 0xff],
    ["u+a", 0xa, 0xa],
    ["U+10FFFF", 0x10ffff, 0x10ffff],
    ["U+0-10FFFF", 0, 0x10ffff],
  ])("%s is one range", (value, start, end) => {
    expect(parseUnicodeRangeDescriptor(value)).toEqual([[start, end]]);
  });

  it.each([
    // Token followed by something that is not a comma (Blink: valid token, then
    // a stray token; the descriptor parser then fails `stream.AtEnd()`).
    "u+222+111",
    "u+12345678", // the token is U+123456; "78" is left over
    "u+123-12345678",
    "u+cake", // U+CA then the identifier "ke"
    "u+1234-gggg",
    "U+ab12???", // the seventh "?" exceeds the six-digit budget
    "u+a1?-123", // U+A10-A1F then the number -123
    "u+1??4",
    "U+41zz", // trailing garbage the old parseInt-based parsers accepted
    "U+41 U+42", // two ranges without a comma
    "U+0-", // "-" without a hex digit is not part of the token
  ])("%s is an invalid descriptor", (value) => {
    expect(parseUnicodeRangeDescriptor(value)).toBeUndefined();
  });

  it.each(["u+z", "u+", "u+-543", "U +41", "41", "U-41", "\\55+41"])("%s is not a unicode-range token", (value) => {
    expect(parseUnicodeRangeDescriptor(value)).toBeUndefined();
  });

  it("rejects a reversed range (start > end) and an end past U+10FFFF", () => {
    // `u+222-111` tokenizes (Blink's test) but the descriptor rejects it.
    expect(parseUnicodeRangeDescriptor("u+222-111")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor("U+0-7F, U+7F-0")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor("U+110000")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor("u+??????")).toBeUndefined(); // 0-FFFFFF
    expect(parseUnicodeRangeDescriptor("U+0-110000")).toBeUndefined();
    // Valid tokens in Blink's tokenizer test, rejected here only by the range limit.
    expect(parseUnicodeRangeDescriptor("u+012345-123456")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor("U+ab12??")).toBeUndefined();
  });

  it("rejects the whole descriptor when any entry is invalid or empty", () => {
    expect(parseUnicodeRangeDescriptor("U+0-7F, U+41zz")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor("U+0-7F,,U+100")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor("U+0-7F,")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor(",U+0-7F")).toBeUndefined();
  });

  it("accepts CSS whitespace and comments around the comma-separated tokens", () => {
    expect(parseUnicodeRangeDescriptor("  U+0-7F ,\n\tU+100 /* latin ext */ , U+2??  ")).toEqual([
      [0, 0x7f],
      [0x100, 0x100],
      [0x200, 0x2ff],
    ]);
  });

  it("returns undefined for an empty value", () => {
    expect(parseUnicodeRangeDescriptor("")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor(" \t ")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor("/* nothing */")).toBeUndefined();
  });

  it('parses the CSSOM serialization Blink produces (`U+%X` / `U+%X-%X`, joined by ", ")', () => {
    expect(parseUnicodeRangeDescriptor("U+0-FF, U+131, U+152-153, U+2BB-2BC")).toEqual([
      [0, 0xff],
      [0x131, 0x131],
      [0x152, 0x153],
      [0x2bb, 0x2bc],
    ]);
  });
});

describe("unicodeRangeIntervalsCover", () => {
  it("is inclusive at both ends", () => {
    const ranges = parseUnicodeRangeDescriptor("U+2020-2026, U+3000")!;
    expect(unicodeRangeIntervalsCover(ranges, 0x2026)).toBe(true);
    expect(unicodeRangeIntervalsCover(ranges, 0x2020)).toBe(true);
    expect(unicodeRangeIntervalsCover(ranges, 0x3000)).toBe(true);
    expect(unicodeRangeIntervalsCover(ranges, 0x2027)).toBe(false);
    expect(unicodeRangeIntervalsCover([], 0x41)).toBe(false);
  });
});
