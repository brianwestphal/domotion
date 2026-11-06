import { describe, expect, it } from "vitest";
import { coveredPairs, generatePairwiseAssignments, layoutAxes, requiredPairs } from "../tools/layout-stage-matrix.js";

describe("layout-stage declarative matrix", () => {
  it("covers every pair of every declared CSS value deterministically", () => {
    const first = generatePairwiseAssignments();
    const second = generatePairwiseAssignments();
    expect(second).toEqual(first);
    expect(coveredPairs(first)).toEqual(requiredPairs());
  });

  it("classifies paint and diagnostic axes without relabeling logical states", () => {
    expect(layoutAxes.find((axis) => axis.id === "emphasis")?.verdict).toBe("paint");
    // Justification expansion is in Chromium's laid-out ranges, so captured
    // origins carry it: the axis agrees logically rather than hiding behind a
    // capture diagnostic.
    expect(layoutAxes.find((axis) => axis.id === "justification")?.verdict).toBe("logical");
    expect(layoutAxes.filter((axis) => axis.verdict === "diagnostic")).toEqual([]);
    expect(layoutAxes.find((axis) => axis.id === "writingMode")?.verdict).toBe("logical");
    expect(layoutAxes.find((axis) => axis.id === "textCombine")?.verdict).toBe("logical");
  });

  it("inventories every acceptance axis", () => {
    expect(layoutAxes.map((axis) => axis.id)).toEqual([
      "direction",
      "unicodeBidi",
      "writingMode",
      "textOrientation",
      "textCombine",
      "whiteSpace",
      "overflowWrap",
      "wordBreak",
      "lineBreak",
      "hyphens",
      "tabSize",
      "spacing",
      "rubyPosition",
      "rubyAlign",
      "emphasis",
      "justification",
      "synthesis",
      "zoom",
      "transform",
      "fragmentation",
    ]);
  });
});
