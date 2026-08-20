import { describe, expect, it } from "vitest";

import { thinDottedEndpointPlan } from "./element-tree-to-svg.js";

describe("thinDottedEndpointPlan (DM-2324)", () => {
  it("grows the first dot for even 1px paths", () => {
    expect(thinDottedEndpointPlan(8, 1)).toEqual({
      startDotGrowth: 1,
      endDotGrowth: null,
      lineStart: 3,
      lineEnd: 8,
    });
    expect(thinDottedEndpointPlan(9, 1)).toEqual({
      startDotGrowth: null,
      endDotGrowth: null,
      lineStart: 0,
      lineEnd: 9,
    });
  });

  it("covers all four 2px endpoint phases", () => {
    expect(thinDottedEndpointPlan(8, 2)).toEqual({ startDotGrowth: 0, endDotGrowth: 0, lineStart: 3, lineEnd: 5 });
    expect(thinDottedEndpointPlan(9, 2)).toEqual({ startDotGrowth: 0, endDotGrowth: null, lineStart: 3, lineEnd: 9 });
    expect(thinDottedEndpointPlan(10, 2)).toEqual({ startDotGrowth: null, endDotGrowth: null, lineStart: 0, lineEnd: 10 });
    expect(thinDottedEndpointPlan(11, 2)).toEqual({ startDotGrowth: 0, endDotGrowth: null, lineStart: 5, lineEnd: 11 });
  });

  it("covers all six 3px endpoint phases", () => {
    expect(thinDottedEndpointPlan(12, 3)).toEqual({ startDotGrowth: 1, endDotGrowth: 1, lineStart: 7, lineEnd: 7 });
    expect(thinDottedEndpointPlan(13, 3)).toEqual({ startDotGrowth: 0, endDotGrowth: 0, lineStart: 5, lineEnd: 9 });
    expect(thinDottedEndpointPlan(14, 3)).toEqual({ startDotGrowth: 0, endDotGrowth: null, lineStart: 5, lineEnd: 14 });
    expect(thinDottedEndpointPlan(15, 3)).toEqual({ startDotGrowth: null, endDotGrowth: null, lineStart: 0, lineEnd: 15 });
    expect(thinDottedEndpointPlan(16, 3)).toEqual({ startDotGrowth: 0, endDotGrowth: null, lineStart: 7, lineEnd: 16 });
    expect(thinDottedEndpointPlan(17, 3)).toEqual({ startDotGrowth: 0, endDotGrowth: 0, lineStart: 7, lineEnd: 13 });
  });

  it("rounds length and width at the same DrawLineWithStyle boundary", () => {
    expect(thinDottedEndpointPlan(10.4, 1.6)).toEqual(thinDottedEndpointPlan(10, 2));
  });
});
