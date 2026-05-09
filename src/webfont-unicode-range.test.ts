import * as fs from "fs";
import { describe, expect, it, beforeEach } from "vitest";
import { parseUnicodeRangeDescriptor } from "./capture.js";
import { __pickWebfontVariantMetaForTest, clearWebfonts, registerWebfont, unicodeRangeCovers } from "./text-to-path.js";

// DM-517: webfont registration honors the `@font-face { unicode-range: ... }`
// descriptor. Google-Fonts-style partitioning declares the same `(family,
// weight, style)` pair across multiple `@font-face` rules, each with a
// distinct `unicode-range` (Latin, Latin Ext, Cyrillic, Greek, …). Without
// honoring the descriptor, `pickWebfontVariant` may return the Cyrillic-only
// partition for a Latin run — the run lays out as .notdef tofu.

describe("parseUnicodeRangeDescriptor", () => {
  it("returns undefined for empty / whitespace input", () => {
    expect(parseUnicodeRangeDescriptor("")).toBeUndefined();
    expect(parseUnicodeRangeDescriptor("   ")).toBeUndefined();
  });

  it("parses single codepoints (U+26)", () => {
    expect(parseUnicodeRangeDescriptor("U+26")).toEqual([[0x26, 0x26]]);
  });

  it("parses interval forms (U+0-7F)", () => {
    expect(parseUnicodeRangeDescriptor("U+0-7F")).toEqual([[0x0, 0x7f]]);
    expect(parseUnicodeRangeDescriptor("U+0000-00FF")).toEqual([[0x0, 0xff]]);
  });

  it("parses wildcard forms (U+4??)", () => {
    expect(parseUnicodeRangeDescriptor("U+4??")).toEqual([[0x400, 0x4ff]]);
    expect(parseUnicodeRangeDescriptor("U+1F??")).toEqual([[0x1f00, 0x1fff]]);
  });

  it("parses comma-separated mixed forms (real Google Fonts Cyrillic partition)", () => {
    const ranges = parseUnicodeRangeDescriptor("U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116");
    expect(ranges).toEqual([
      [0x0301, 0x0301],
      [0x0400, 0x045f],
      [0x0490, 0x0491],
      [0x04b0, 0x04b1],
      [0x2116, 0x2116],
    ]);
  });

  it("is case-insensitive on the U+ prefix", () => {
    expect(parseUnicodeRangeDescriptor("u+0-7f")).toEqual([[0x0, 0x7f]]);
  });
});

describe("unicodeRangeCovers", () => {
  it("returns true for any codepoint when ranges is undefined (CSS default)", () => {
    expect(unicodeRangeCovers(undefined, 0x0041)).toBe(true);
    expect(unicodeRangeCovers(undefined, 0x10ffff)).toBe(true);
  });

  it("returns true for codepoints inside any interval", () => {
    const ranges: Array<[number, number]> = [[0x0, 0x7f], [0x0400, 0x04ff]];
    expect(unicodeRangeCovers(ranges, 0x0041)).toBe(true); // 'A' in Basic Latin
    expect(unicodeRangeCovers(ranges, 0x0410)).toBe(true); // Cyrillic 'А'
  });

  it("returns false for codepoints outside all intervals", () => {
    const ranges: Array<[number, number]> = [[0x0400, 0x04ff]]; // Cyrillic only
    expect(unicodeRangeCovers(ranges, 0x0041)).toBe(false); // 'A' Latin — not covered
    expect(unicodeRangeCovers(ranges, 0x4e00)).toBe(false); // CJK — not covered
  });

  it("respects interval boundaries (inclusive)", () => {
    const ranges: Array<[number, number]> = [[0x0020, 0x007f]];
    expect(unicodeRangeCovers(ranges, 0x001f)).toBe(false);
    expect(unicodeRangeCovers(ranges, 0x0020)).toBe(true);
    expect(unicodeRangeCovers(ranges, 0x007f)).toBe(true);
    expect(unicodeRangeCovers(ranges, 0x0080)).toBe(false);
  });
});

describe("pickWebfontVariant: unicode-range preference (DM-517)", () => {
  // Use a real system font buffer — `registerWebfont` calls `fontkit.create`
  // and silently skips on parse failure, so we can't fake the buffer.
  const helveticaBuf = fs.existsSync("/System/Library/Fonts/Helvetica.ttc")
    ? fs.readFileSync("/System/Library/Fonts/Helvetica.ttc")
    : null;
  const haveFontFixture = helveticaBuf != null;

  beforeEach(() => {
    clearWebfonts();
  });

  it.skipIf(!haveFontFixture)("prefers Latin-covering variant when ties on weight + italic (Cyrillic-first registration order)", () => {
    // Simulates Google Fonts' Geist@400 partitioning: Cyrillic partition
    // registers first, then the Latin partition. Without unicode-range
    // awareness, `pickWebfontVariant` would return the Cyrillic variant for
    // a request like (geist, 400, italic=false) because it scores first.
    registerWebfont("geist", 400, "normal", helveticaBuf!, [[0x0301, 0x0301], [0x0400, 0x045f]]);
    registerWebfont("geist", 400, "normal", helveticaBuf!, [[0x0000, 0x00ff], [0x0131, 0x0131]]);

    const picked = __pickWebfontVariantMetaForTest("geist", 400, false);
    expect(picked).not.toBeNull();
    // The Latin-covering partition (second registration) must win.
    expect(picked!.unicodeRange).toEqual([[0x0000, 0x00ff], [0x0131, 0x0131]]);
  });

  it.skipIf(!haveFontFixture)("variant with no unicode-range (CSS default = U+0..U+10FFFF) ties non-partitioned cases unchanged", () => {
    // Single registration, no unicode-range — most common case (single woff2
    // covering everything). Behavior unchanged from pre-DM-517.
    registerWebfont("inter", 500, "normal", helveticaBuf!);
    const picked = __pickWebfontVariantMetaForTest("inter", 500, false);
    expect(picked).not.toBeNull();
    expect(picked!.unicodeRange).toBeUndefined();
    expect(picked!.weight).toBe(500);
  });

  it.skipIf(!haveFontFixture)("range coverage outweighs italic mismatch — synthesized italic on Latin font beats tofu from italic Cyrillic font", () => {
    // Pathological registration: italic Cyrillic-only + upright Latin-only.
    // Asked for italic, the picker should still prefer the Latin variant
    // because rendering tofu (.notdef) is far worse than synthesized italic.
    registerWebfont("geist", 400, "italic", helveticaBuf!, [[0x0400, 0x045f]]);
    registerWebfont("geist", 400, "normal", helveticaBuf!, [[0x0000, 0x00ff]]);

    const picked = __pickWebfontVariantMetaForTest("geist", 400, true);
    expect(picked).not.toBeNull();
    // Upright Latin-covering variant wins despite italic mismatch.
    expect(picked!.italic).toBe(false);
    expect(picked!.unicodeRange).toEqual([[0x0000, 0x00ff]]);
  });

  it.skipIf(!haveFontFixture)("when only non-Latin partitions are registered, picker returns the closest by weight (last-resort fallback)", () => {
    // No Latin-covering variant available — picker still returns the best
    // available (weight match). Avoids returning null for pages where only
    // non-Latin partitions were fetched.
    registerWebfont("geist", 400, "normal", helveticaBuf!, [[0x0400, 0x045f]]);
    registerWebfont("geist", 700, "normal", helveticaBuf!, [[0x0400, 0x045f]]);

    const picked = __pickWebfontVariantMetaForTest("geist", 400, false);
    expect(picked).not.toBeNull();
    expect(picked!.weight).toBe(400);
  });
});
