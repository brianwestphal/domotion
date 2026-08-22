import { describe, expect, it } from "vitest";

import {
  NESTED_PROJECTIVE_CASES,
  NESTED_PROJECTIVE_REQUIRED_FAMILIES,
  NESTED_PROJECTIVE_SOURCE_PINS,
  adjudicateProjectiveOwnership,
  emptyGrouping,
  nestedProjectiveAuditFixtureHtml,
  projectiveGroupingReasons,
  resolveProjectiveOwnership,
  type ProjectiveContextFact,
  type ProjectiveGroupingFacts,
} from "../tools/nested-projective-ownership-audit.js";

const fact = (
  id: string,
  parentId: string | null,
  overrides: Partial<ProjectiveContextFact> = {},
): ProjectiveContextFact => ({
  id,
  parentId,
  preserve3dApplicable: true,
  computedPreserve3d: false,
  grouping: emptyGrouping(),
  activationPlane: false,
  nonAffine: false,
  inlineSvgRootId: null,
  ...overrides,
});

describe("DM-2356 Blink projective context model", () => {
  it("pins the audited Chromium and Chromium-owned Skia revisions", () => {
    expect(NESTED_PROJECTIVE_SOURCE_PINS).toEqual({
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
    });
  });

  it("keeps perspective projection out of rendering-context ownership", () => {
    const result = resolveProjectiveOwnership([
      fact("perspective-host", null),
      fact("plane", "perspective-host", { activationPlane: true, nonAffine: true }),
    ]);
    expect(result.ownerIds).toEqual(["plane"]);
    expect(result.contexts.every((context) => context.renderingContextRootId == null)).toBe(true);
  });

  it("shares one id only across direct used-preserve DOM edges", () => {
    const shared = resolveProjectiveOwnership([
      fact("outer", null, { computedPreserve3d: true }),
      fact("inner", "outer", { computedPreserve3d: true }),
      fact("plane", "inner", { activationPlane: true, nonAffine: true }),
    ]);
    expect(shared.ownerIds).toEqual(["outer"]);
    expect(shared.contexts.map((context) => context.renderingContextRootId))
      .toEqual(["outer", "outer", "outer"]);

    const broken = resolveProjectiveOwnership([
      fact("outer", null, { computedPreserve3d: true }),
      fact("ordinary", "outer"),
      fact("inner", "ordinary", { computedPreserve3d: true }),
      fact("plane", "inner", { activationPlane: true, nonAffine: true }),
    ]);
    expect(broken.ownerIds).toEqual(["inner"]);
    expect(broken.contexts.map((context) => context.renderingContextRootId))
      .toEqual(["outer", "outer", "inner", "inner"]);
  });

  it("forces computed preserve-3d flat for every pinned grouping family", () => {
    const rows: Array<[string, Partial<ProjectiveGroupingFacts>, string]> = [
      ["opacity", { opacity: ".8" }, "opacity"],
      ["current opacity animation", { hasCurrentOpacityAnimation: true }, "opacity"],
      ["will-change opacity", { willChange: "opacity" }, "opacity"],
      ["filter", { filter: "blur(0px)" }, "filter"],
      ["will-change filter", { willChange: "filter" }, "filter"],
      ["box reflection", { hasBoxReflection: true }, "box-reflection"],
      ["clip path", { clipPath: "inset(0)" }, "clip-path"],
      ["isolation", { isolation: "isolate" }, "isolation"],
      ["mask", { maskImage: "linear-gradient(#000,#000)" }, "mask"],
      ["blend", { mixBlendMode: "multiply" }, "mix-blend-mode"],
      ["backdrop", { backdropFilter: "blur(1px)" }, "backdrop-filter"],
      ["will-change backdrop", { willChange: "backdrop-filter" }, "backdrop-filter"],
      ["view transition", { viewTransitionName: "card" }, "view-transition"],
      ["active view transition", { isViewTransitionParticipant: true }, "view-transition"],
      ["positioned CSS clip", { position: "absolute", cssClip: "rect(0px, 10px, 10px, 0px)" }, "css-clip"],
      ["overflow hidden", { overflowY: "hidden" }, "overflow"],
      ["overflow clip", { overflowX: "clip" }, "overflow"],
    ];
    for (const [label, overrides, expected] of rows) {
      expect(projectiveGroupingReasons({ ...emptyGrouping(), ...overrides }), label).toContain(expected);
    }
    expect(projectiveGroupingReasons({ ...emptyGrouping(), position: "static", cssClip: "rect(0px, 10px, 10px, 0px)" }))
      .not.toContain("css-clip");
    expect(projectiveGroupingReasons({ ...emptyGrouping(), willChange: "transform, clip-path, mask" }))
      .toEqual([]);
  });

  it("starts a fresh context below an explicit or grouping-property flatten", () => {
    for (const grouping of [
      { ...emptyGrouping(), opacity: ".8" },
      { ...emptyGrouping(), overflowX: "hidden" },
      { ...emptyGrouping(), isolation: "isolate" },
    ]) {
      const result = resolveProjectiveOwnership([
        fact("outer", null, { computedPreserve3d: true, grouping }),
        fact("inner", "outer", { computedPreserve3d: true }),
        fact("plane", "inner", { activationPlane: true, nonAffine: true }),
      ]);
      expect(result.ownerIds).toEqual(["inner"]);
    }
    const explicit = resolveProjectiveOwnership([
      fact("outer", null, { computedPreserve3d: true }),
      fact("flat", "outer"),
      fact("inner", "flat", { computedPreserve3d: true }),
      fact("plane", "inner", { activationPlane: true, nonAffine: true }),
    ]);
    expect(explicit.ownerIds).toEqual(["inner"]);
  });

  it("keeps independent planes separate and promotes only through an atomic inline SVG", () => {
    const independent = resolveProjectiveOwnership([
      fact("root", null),
      fact("a", "root", { activationPlane: true, nonAffine: true }),
      fact("b", "root", { activationPlane: true, nonAffine: true }),
    ]);
    expect(independent.ownerIds).toEqual(["a", "b"]);

    const svg = resolveProjectiveOwnership([
      fact("svg", null),
      fact("foreign-object", "svg", { preserve3dApplicable: false }),
      fact("html-host", "foreign-object", { computedPreserve3d: true, inlineSvgRootId: "svg" }),
      fact("plane", "html-host", {
        activationPlane: true,
        nonAffine: true,
        inlineSvgRootId: "svg",
      }),
    ]);
    expect(svg.ownerIds).toEqual(["svg"]);
  });

  it("ships every requested composed family without text/font dependence", () => {
    expect(new Set(NESTED_PROJECTIVE_CASES.map((row) => row.family)))
      .toEqual(new Set(NESTED_PROJECTIVE_REQUIRED_FAMILIES));
    const fixture = nestedProjectiveAuditFixtureHtml();
    expect(fixture).toContain("perspective:280px");
    expect(fixture).toContain("transform-style:preserve-3d");
    expect(fixture).toContain("isolation:isolate");
    expect(fixture).toContain("mask-image:linear-gradient");
    expect(fixture).not.toMatch(/font|content:/);
  });

  it("rejects owner promotion/demotion, missing/duplicate crops, vector absorption, and double transforms", () => {
    const expected = ["inner"];
    const passing = {
      actualOwnerIds: ["inner"],
      rasterOccurrences: 1,
      vectorSentinelRetained: true,
      staticTransformApplications: 1,
    };
    expect(adjudicateProjectiveOwnership(expected, passing).pass).toBe(true);
    for (const mutation of [
      { ...passing, actualOwnerIds: ["outer"] },
      { ...passing, actualOwnerIds: ["plane"] },
      { ...passing, actualOwnerIds: [], rasterOccurrences: 0, staticTransformApplications: 0 },
      { ...passing, rasterOccurrences: 2 },
      { ...passing, vectorSentinelRetained: false },
      { ...passing, staticTransformApplications: 2 },
    ]) expect(adjudicateProjectiveOwnership(expected, mutation).pass).toBe(false);
  });
});
