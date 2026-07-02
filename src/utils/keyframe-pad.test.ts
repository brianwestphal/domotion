import { describe, expect, it } from "vitest";
import { VISIBILITY_CULL_OVERLAP_MS, cullOverlapPct, padAfter, padBefore } from "./keyframe-pad.js";

describe("padBefore / padAfter", () => {
  it("nudges a percentage by epsilon and clamps to [0, 100]", () => {
    expect(padBefore(50, 0.001, 3)).toBe("49.999");
    expect(padAfter(50, 0.001, 3)).toBe("50.001");
    // Clamp.
    expect(padBefore(0, 0.01, 3)).toBe("0.000");
    expect(padAfter(100, 0.01, 3)).toBe("100.000");
  });
});

describe("cullOverlapPct (DM-1511)", () => {
  it("expresses the fixed wall-clock overlap as a percentage of the scene", () => {
    // 150 ms of a 30 s scene = 0.5%.
    expect(cullOverlapPct(30_000)).toBeCloseTo(0.5, 6);
    // 150 ms of a 3 s scene = 5%.
    expect(cullOverlapPct(3_000)).toBeCloseTo(5, 6);
  });

  it("is wall-clock, so the absolute overlap is scene-length-independent", () => {
    // The overlap in ms is always VISIBILITY_CULL_OVERLAP_MS regardless of scene
    // length — that's what beats the compositor's (scene-independent) slop.
    for (const totalMs of [2_000, 10_000, 60_000, 300_000]) {
      const overlapMs = (cullOverlapPct(totalMs) / 100) * totalMs;
      expect(overlapMs).toBeCloseTo(VISIBILITY_CULL_OVERLAP_MS, 6);
    }
  });

  it("is larger than the largest observed Firefox compositor gap (~70 ms)", () => {
    expect(VISIBILITY_CULL_OVERLAP_MS).toBeGreaterThan(70);
  });

  it("returns 0 for a zero-length scene (guard)", () => {
    expect(cullOverlapPct(0)).toBe(0);
  });
});
