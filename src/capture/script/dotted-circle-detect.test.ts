import { describe, expect, it } from "vitest";
import { dottedCircleInkMatches, isDottedCircleProbeCandidate } from "./dotted-circle-detect.js";

const stats = (indices: number[], width = 10) => {
  const mask = new Uint8Array(64);
  for (const i of indices) mask[i] = 1;
  return { cnt: indices.length, w: width, mask };
};

describe("dotted-circle capture probe", () => {
  it("admits BMP and SMP marks/cluster letters without a block boundary", () => {
    expect(isDottedCircleProbeCandidate("\u0301")).toBe(true); // BMP default-shaper mark: ink probe rejects later
    expect(isDottedCircleProbeCandidate("\u0B85")).toBe(true); // BMP Lo
    expect(isDottedCircleProbeCandidate("\u{11A84}")).toBe(true); // SMP Lo
    expect(isDottedCircleProbeCandidate("\u{16D6B}")).toBe(true); // SMP Lm
    expect(isDottedCircleProbeCandidate("A")).toBe(false);
    expect(isDottedCircleProbeCandidate(".")).toBe(false);
  });

  it("accepts matching bare and explicit-circle ink masks", () => {
    const ink = Array.from({ length: 24 }, (_, i) => i + 10);
    expect(dottedCircleInkMatches(stats(ink), stats(ink))).toBe(true);
  });

  it("rejects equal-area equal-width masks at different pixel locations", () => {
    const bare = Array.from({ length: 24 }, (_, i) => i);
    const combined = Array.from({ length: 24 }, (_, i) => i + 32);
    expect(dottedCircleInkMatches(stats(bare), stats(combined))).toBe(false);
  });

  it("rejects an explicit-circle render that adds substantial ink", () => {
    const bare = Array.from({ length: 24 }, (_, i) => i + 8);
    const combined = Array.from({ length: 36 }, (_, i) => i + 8);
    expect(dottedCircleInkMatches(stats(bare), stats(combined, 14))).toBe(false);
  });
});
