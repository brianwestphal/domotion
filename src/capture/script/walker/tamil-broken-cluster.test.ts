import { describe, expect, it } from "vitest";
import { isTamilJoinerBrokenPrefix } from "./text-segments.js";

describe("Tamil joiner-prefixed broken-cluster capture gate", () => {
  it("keeps only the measured cluster-initial ZWJ + U+0BC6 base-less", () => {
    expect(isTamilJoinerBrokenPrefix(0x200D, 0x0BC6, false)).toBe(true);
    expect(isTamilJoinerBrokenPrefix(0x200D, 0x0BC6, true)).toBe(false);
  });

  it("does not generalize to ordinary ZWJ use or unconfirmed scripts", () => {
    expect(isTamilJoinerBrokenPrefix(0x200D, 0x0BCD, false)).toBe(false);
    expect(isTamilJoinerBrokenPrefix(0x200D, 0x0D46, false)).toBe(false);
    expect(isTamilJoinerBrokenPrefix(0x200C, 0x0BC6, false)).toBe(false);
  });
});
