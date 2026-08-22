import { describe, expect, it } from "vitest";

import {
  buildAnimatedCullingCases,
  buildAnimatedCullingMutationControls,
  validateAnimatedCullingCorpus,
} from "../tools/animated-culling-geometry-oracle.js";

describe("animated culling geometry oracle corpus", () => {
  it("covers every required family with enter, leave, and negative controls", () => {
    expect(validateAnimatedCullingCorpus()).toEqual([]);

    const cases = buildAnimatedCullingCases();
    const byFamily = Map.groupBy(cases, (test) => test.family);
    expect([...byFamily.keys()].sort()).toEqual([
      "clip-mask",
      "compatible-functions",
      "mismatched-functions",
      "motion-path",
      "narrow-crossing",
      "nested-timing",
      "projective",
      "reference-box",
      "repeat-easing",
      "static-transform",
      "visual-overflow",
    ]);
    for (const rows of byFamily.values()) {
      expect(new Set(rows.map((row) => row.activation))).toEqual(new Set(["enter", "leave", "negative"]));
      expect(rows.every((row) => row.probes.length > 0)).toBe(true);
    }
  });

  it("pins all four unsafe-algorithm mutation discriminators plus fail-closed retention", () => {
    const controls = buildAnimatedCullingMutationControls();
    expect(new Set(controls.map((control) => control.kind))).toEqual(new Set([
      "reference-box-selection",
      "ancestor-composition",
      "function-first-interpolation",
      "fixed-sampling-proof",
      "fail-closed-retention",
    ]));
    expect(controls.every((control) => control.discriminator.length > 20)).toBe(true);
  });

  it("keeps motion-path and projective rows on explicit retain decisions", () => {
    const cases = buildAnimatedCullingCases();
    for (const family of ["motion-path", "projective"] as const) {
      const rows = cases.filter((row) => row.family === family);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.expectedDecision === "retain")).toBe(true);
    }
  });
});
