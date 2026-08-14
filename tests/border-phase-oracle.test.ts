import { describe, expect, it } from "vitest";
import { buildPhaseCases, deriveSnapRule, profileEdges, profileRmse } from "../tools/border-phase-oracle.js";

describe("border phase oracle corpus", () => {
  it("crosses kind, style, width, and quarter-pixel phase", () => {
    const cases = buildPhaseCases();
    expect(cases).toHaveLength(128);
    expect(new Set(cases.map((c) => c.kind))).toEqual(new Set(["border", "outline"]));
    expect(new Set(cases.map((c) => c.style))).toEqual(new Set(["solid", "dashed", "dotted", "double"]));
    expect(new Set(cases.map((c) => c.phase))).toEqual(new Set([0, 0.25, 0.5, 0.75]));
  });
});

describe("edge alpha profiles", () => {
  it("recovers fractional edges and coverage centroid", () => {
    const p = profileEdges([0, 0.25, 1, 0.5, 0], 10, 4);
    expect(p.outer).toBeCloseTo(10.4375, 6);
    expect(p.inner).toBeCloseTo(10.875, 6);
    expect(p.center).toBeCloseTo(10 + (1.5 * 0.25 + 2.5 + 3.5 * 0.5) / 1.75 / 4, 6);
  });
  it("computes aligned profile RMSE", () => {
    expect(profileRmse([0, 1, 0], [0, 1, 0])).toBe(0);
    expect(profileRmse([0, 1], [0, 0])).toBeCloseTo(Math.sqrt(0.5));
  });
});

describe("shared snap-rule fit", () => {
  it("selects CSS-edge rounding when observations follow it", () => {
    const samples = [0.2, 0.45, 0.7].map((edge) => ({ nominalCenter: edge + 1.5, observedCenter: Math.round(edge) + 1.5, width: 3 }));
    expect(deriveSnapRule(samples)[0]).toMatchObject({ rule: "css-edge-round", mae: 0 });
  });
});
