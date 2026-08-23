import { describe, expect, it } from "vitest";
import {
  buildBorderPaintDecisionCases,
  buildPhaseCases,
  buildPhaseScenarios,
  borderPhaseGeometryStatus,
  classifyBorderPaintDecision,
  deriveSnapRule,
  profileEdges,
  profileRmse,
} from "../tools/border-phase-oracle.js";

describe("border phase oracle corpus", () => {
  it("crosses kind, style, width, and quarter-pixel phase", () => {
    const cases = buildPhaseCases();
    expect(cases).toHaveLength(128);
    expect(new Set(cases.map((c) => c.kind))).toEqual(new Set(["border", "outline"]));
    expect(new Set(cases.map((c) => c.style))).toEqual(new Set(["solid", "dashed", "dotted", "double"]));
    expect(new Set(cases.map((c) => c.phase))).toEqual(new Set([0, 0.25, 0.5, 0.75]));
    expect(Math.max(...cases.map((c) => c.y))).toBeLessThan(32 * 60);
  });

  it("ratifies every family after uniform-double adopts the snapped reference box", () => {
    const rows = buildPhaseCases().map((phaseCase) => ({
      id: phaseCase.id,
      status: borderPhaseGeometryStatus(phaseCase),
    }));
    expect(rows.filter(({ status }) => status === "source-exact")).toHaveLength(128);
    expect(borderPhaseGeometryStatus({ kind: "outline", style: "double" })).toBe("source-exact");
  });

  it("takes the Cartesian product of requested scale and zoom values", () => {
    expect(buildPhaseScenarios([1, 2, 4], [0.8, 1, 1.25])).toEqual([
      { id: "dsf1.zoom0.8", dsf: 1, zoom: 0.8 },
      { id: "dsf1.zoom1", dsf: 1, zoom: 1 },
      { id: "dsf1.zoom1.25", dsf: 1, zoom: 1.25 },
      { id: "dsf2.zoom0.8", dsf: 2, zoom: 0.8 },
      { id: "dsf2.zoom1", dsf: 2, zoom: 1 },
      { id: "dsf2.zoom1.25", dsf: 2, zoom: 1.25 },
      { id: "dsf4.zoom0.8", dsf: 4, zoom: 0.8 },
      { id: "dsf4.zoom1", dsf: 4, zoom: 1 },
      { id: "dsf4.zoom1.25", dsf: 4, zoom: 1.25 },
    ]);
  });
});

describe("Blink border paint decision transcription (DM-2313)", () => {
  it("covers every fast, straight, and rounded clipping branch", () => {
    const decisions = new Set(buildBorderPaintDecisionCases().map(classifyBorderPaintDecision));
    expect(decisions).toEqual(new Set([
      "solid-rect-fast-path",
      "solid-drrect-fast-path",
      "double-drrect-fast-path",
      "partial-transparent-path-fast-path",
      "complex-rounded-close-edge-clips",
      "complex-rounded-hull-clips",
      "complex-straight-sides",
    ]));
  });

  it("uses the complex path when any fast-path prerequisite is absent", () => {
    const base = buildBorderPaintDecisionCases()[0];
    expect(classifyBorderPaintDecision({ ...base, id: "color", uniformColor: false }))
      .toBe("complex-straight-sides");
    expect(classifyBorderPaintDecision({ ...base, id: "style", uniformStyle: false, outerRounded: true }))
      .toBe("complex-rounded-close-edge-clips");
    expect(classifyBorderPaintDecision({ ...base, id: "inner", innerRenderable: false, outerRounded: true }))
      .toBe("complex-rounded-hull-clips");
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
