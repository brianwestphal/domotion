import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GRAPHEME_EXTEND_MEMBER_COUNT,
  GRAPHEME_EXTEND_RANGES,
  GRAPHEME_EXTEND_SHA256,
  MIXED_VERTICAL_UPRIGHT_MEMBER_COUNT,
  MIXED_VERTICAL_UPRIGHT_RANGES,
  MIXED_VERTICAL_UPRIGHT_SHA256,
  VERTICAL_ORIENTATION_SOURCE_SHA256,
  VERTICAL_ORIENTATION_UNICODE_VERSION,
} from "./vertical-orientation.generated.js";
import { isBlinkGraphemeExtend, isMixedVerticalUpright } from "../../vertical-orientation.js";

function packedDigest(ranges: readonly (readonly number[])[]): string {
  const packed = Buffer.allocUnsafe(ranges.length * 8);
  ranges.forEach(([lo, hi], i) => {
    packed.writeUInt32LE(lo, i * 8);
    packed.writeUInt32LE(hi, i * 8 + 4);
  });
  return createHash("sha256").update(packed).digest("hex");
}

/**
 * Compares `predicate` with range membership for every Unicode scalar and
 * returns the member count plus the first mismatching scalars. Mismatches are
 * collected rather than asserted one scalar at a time: a per-scalar `expect`
 * cost about 1.6 s of CPU per sweep against 0.04 s for the comparison itself,
 * which a loaded host stretched past the test timeout
 * (docs/tool-child-process-test-bounds.md).
 */
function sweepScalars(
  ranges: readonly (readonly number[])[],
  predicate: (cp: number) => boolean,
): { members: number; mismatches: string[] } {
  let index = 0;
  let members = 0;
  const mismatches: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    while (index < ranges.length && cp > ranges[index][1]) index++;
    const range = ranges[index];
    const expected = range != null && cp >= range[0] && cp <= range[1];
    if (expected) members++;
    if (predicate(cp) !== expected && mismatches.length < 32) {
      mismatches.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} expected ${String(expected)}`);
    }
  }
  return { members, mismatches };
}

describe("Chromium-pinned ICU mixed vertical orientation", () => {
  it("matches every scalar and the packed property digest", () => {
    const { members, mismatches } = sweepScalars(MIXED_VERTICAL_UPRIGHT_RANGES, isMixedVerticalUpright);
    expect(mismatches).toEqual([]);
    expect(members).toBe(MIXED_VERTICAL_UPRIGHT_MEMBER_COUNT);
    expect(packedDigest(MIXED_VERTICAL_UPRIGHT_RANGES)).toBe(MIXED_VERTICAL_UPRIGHT_SHA256);
  });

  it("matches every Grapheme_Extend scalar and its packed-property digest", () => {
    const { members, mismatches } = sweepScalars(GRAPHEME_EXTEND_RANGES, isBlinkGraphemeExtend);
    expect(mismatches).toEqual([]);
    expect(members).toBe(GRAPHEME_EXTEND_MEMBER_COUNT);
    expect(packedDigest(GRAPHEME_EXTEND_RANGES)).toBe(GRAPHEME_EXTEND_SHA256);
  });

  it("pins Unicode and source-image identity so a roll cannot be silent", () => {
    expect(VERTICAL_ORIENTATION_UNICODE_VERSION).toBe("17.0.0");
    expect(VERTICAL_ORIENTATION_SOURCE_SHA256).toBe("bccc5a5ca1baea3de767e8266d59ffa13ff99595bea37ca82415851386f57dbd");
  });
});
