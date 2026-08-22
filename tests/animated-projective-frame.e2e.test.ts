import { describe, expect, it } from "vitest";
import {
  ANIMATED_PROJECTIVE_SAMPLE_TIMES_MS,
  runAnimatedProjectiveFrameOracle,
} from "../tools/animated-projective-frame-oracle.js";

describe("animated CSS 3D frame-state capture (DM-2359)", () => {
  it("matches independent Chromium quads, composition, and raster owners at DPR 1", async () => {
    const report = await runAnimatedProjectiveFrameOracle({
      dprs: [1],
      sampleTimesMs: [...ANIMATED_PROJECTIVE_SAMPLE_TIMES_MS],
    });
    expect(report.verdict).toBe("source-exact");
    expect(report.rows).toHaveLength(32);
    expect(new Set(report.rows.map((row) => row.family))).toEqual(new Set([
      "rotate3d",
      "translate3d",
      "matrix3d",
      "perspective",
      "transform-origin",
      "preserve-3d-transition",
      "grouping-property-flattening",
      "animation-composition",
    ]));
    expect(report.rows.every((row) => row.pass)).toBe(true);
    expect(report.mutations).toHaveLength(5);
    expect(report.mutations.every((mutation) => mutation.killed)).toBe(true);
  }, 180_000);
});
