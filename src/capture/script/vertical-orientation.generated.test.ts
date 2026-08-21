import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MIXED_VERTICAL_UPRIGHT_MEMBER_COUNT,
  MIXED_VERTICAL_UPRIGHT_RANGES,
  MIXED_VERTICAL_UPRIGHT_SHA256,
} from "./vertical-orientation.generated.js";
import { isMixedVerticalUpright } from "./walker/text-segments.js";

describe("Chromium-pinned ICU mixed vertical orientation", () => {
  it("matches every scalar and the packed property digest", () => {
    let index = 0;
    let members = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      while (index < MIXED_VERTICAL_UPRIGHT_RANGES.length && cp > MIXED_VERTICAL_UPRIGHT_RANGES[index][1]) index++;
      const range = MIXED_VERTICAL_UPRIGHT_RANGES[index];
      const expected = range != null && cp >= range[0] && cp <= range[1];
      if (expected) members++;
      expect(isMixedVerticalUpright(cp)).toBe(expected);
    }
    const packed = Buffer.allocUnsafe(MIXED_VERTICAL_UPRIGHT_RANGES.length * 8);
    MIXED_VERTICAL_UPRIGHT_RANGES.forEach(([lo, hi], i) => {
      packed.writeUInt32LE(lo, i * 8);
      packed.writeUInt32LE(hi, i * 8 + 4);
    });
    expect(members).toBe(MIXED_VERTICAL_UPRIGHT_MEMBER_COUNT);
    expect(createHash("sha256").update(packed).digest("hex")).toBe(MIXED_VERTICAL_UPRIGHT_SHA256);
  });
});
