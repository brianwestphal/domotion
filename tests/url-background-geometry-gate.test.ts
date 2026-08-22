import { describe, expect, it } from "vitest";

import {
  adjudicateUrlBackgroundRow,
  type Comparison,
  type PatternFacts,
} from "../tools/url-background-geometry-audit.js";

function comparison(): Comparison {
  const bound = { x: 20, y: 20, width: 32, height: 20, pixels: 640 };
  return {
    sourceColorPixels: 640,
    generatedColorPixels: 640,
    unionColorPixels: 640,
    mismatchedLabels: 0,
    labelMismatchFraction: 0,
    maxColorBoundDelta: 0,
    sourceInkBounds: bound,
    generatedInkBounds: bound,
    maxInkBoundDelta: 0,
    sourceBounds: { red: bound },
    generatedBounds: { red: bound },
  };
}

const pattern: PatternFacts = {
  x: 20,
  y: 20,
  width: 32,
  height: 20,
  imageX: 0,
  imageY: 0,
  imageWidth: 32,
  imageHeight: 20,
};

function evidence() {
  return {
    expectedRoute: "source-equivalent",
    comparison: comparison(),
    patterns: [pattern],
    expectedPatternCount: 1,
    activePalette: ["red"],
    warnings: [] as string[],
    requiresRestartMutation: false,
  };
}

describe("hard URL background geometry adjudication", () => {
  it("accepts complete source-equivalent evidence", () => {
    expect(adjudicateUrlBackgroundRow(evidence())).toEqual([]);
  });

  it("rejects every former observational escape hatch", () => {
    const mutations = [
      { name: "route", mutate: (row: ReturnType<typeof evidence>) => { row.expectedRoute = "current-gap"; } },
      { name: "warning", mutate: (row: ReturnType<typeof evidence>) => { row.warnings.push("capture warning"); } },
      { name: "palette", mutate: (row: ReturnType<typeof evidence>) => { row.comparison.sourceBounds.red = null; } },
      { name: "ink", mutate: (row: ReturnType<typeof evidence>) => { row.comparison.maxInkBoundDelta = 2; } },
      { name: "pattern count", mutate: (row: ReturnType<typeof evidence>) => { row.expectedPatternCount = 2; } },
      { name: "pattern geometry", mutate: (row: ReturnType<typeof evidence>) => { row.patterns[0] = { ...pattern, width: Number.NaN }; } },
      { name: "pixel envelope", mutate: (row: ReturnType<typeof evidence>) => { row.comparison.maxColorBoundDelta = 2; } },
      { name: "restart discriminator", mutate: (row: ReturnType<typeof evidence>) => { row.requiresRestartMutation = true; } },
    ];
    for (const mutation of mutations) {
      const row = evidence();
      mutation.mutate(row);
      expect(adjudicateUrlBackgroundRow(row), mutation.name).not.toEqual([]);
    }
  });
});
