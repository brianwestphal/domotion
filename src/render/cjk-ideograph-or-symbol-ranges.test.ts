import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CJK_IDEOGRAPH_OR_SYMBOL_MEMBER_COUNT,
  CJK_IDEOGRAPH_OR_SYMBOL_RANGES,
  CJK_IDEOGRAPH_OR_SYMBOL_SHA256,
} from "./cjk-ideograph-or-symbol-ranges.generated.js";
import { canTextDecorationSkipInk, isCjkIdeographOrSymbol } from "./unicode-classification.js";

function digest(ranges: ReadonlyArray<readonly [number, number]>): string {
  const packed = Buffer.allocUnsafe(ranges.length * 8);
  ranges.forEach(([lo, hi], index) => {
    packed.writeUInt32LE(lo, index * 8);
    packed.writeUInt32LE(hi, index * 8 + 4);
  });
  return createHash("sha256").update(packed).digest("hex");
}

describe("generated Blink CJK ideograph-or-symbol property", () => {
  it("matches every scalar, member count, and exhaustive range digest", () => {
    let rangeIndex = 0;
    let members = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      while (rangeIndex < CJK_IDEOGRAPH_OR_SYMBOL_RANGES.length
          && cp > CJK_IDEOGRAPH_OR_SYMBOL_RANGES[rangeIndex][1]) rangeIndex++;
      const range = CJK_IDEOGRAPH_OR_SYMBOL_RANGES[rangeIndex];
      const expected = range != null && cp >= range[0] && cp <= range[1];
      if (expected) members++;
      expect(isCjkIdeographOrSymbol(cp)).toBe(expected);
    }
    expect(members).toBe(CJK_IDEOGRAPH_OR_SYMBOL_MEMBER_COUNT);
    expect(digest(CJK_IDEOGRAPH_OR_SYMBOL_RANGES)).toBe(CJK_IDEOGRAPH_OR_SYMBOL_SHA256);
  });

  it("includes text-default Extended_Pictographic RGI members", () => {
    // FEMALE/MALE SIGN are text-default pictographs in RGI ZWJ sequences, not
    // Emoji_Presentation and not members of Blink's handwritten base ranges.
    for (const cp of [0x2640, 0x2642]) {
      expect(isCjkIdeographOrSymbol(cp)).toBe(true);
      expect(canTextDecorationSkipInk(cp)).toBe(false);
    }
  });

  it("detects a one-endpoint mutation and preserves a nearby skip-ink control", () => {
    const mutated = CJK_IDEOGRAPH_OR_SYMBOL_RANGES.map((range, index) =>
      index === 0 ? [range[0], range[1] + 1] as const : range);
    expect(digest(mutated)).not.toBe(CJK_IDEOGRAPH_OR_SYMBOL_SHA256);
    expect(isCjkIdeographOrSymbol(0x02c6)).toBe(false);
    expect(canTextDecorationSkipInk(0x02c6)).toBe(true);
  });
});
