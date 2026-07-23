// DM-1732: baseline selection for propagated decorations on
// vertical-align-shifted children.
import { describe, expect, it } from "vitest";

import { pickPropagatedBaseline } from "./text.js";

describe("pickPropagatedBaseline", () => {
  it("keeps the run's own baseline when no ancestor baselines exist", () => {
    expect(pickPropagatedBaseline(undefined, 100, 24)).toBe(100);
    expect(pickPropagatedBaseline([], 100, 24)).toBe(100);
  });

  it("keeps the run's own baseline for same-line children (≤1px difference)", () => {
    // Sub-pixel/rounding drift between child and ancestor ascent — no shift.
    expect(pickPropagatedBaseline([100], 100, 24)).toBe(100);
    expect(pickPropagatedBaseline([101], 100, 24)).toBe(100);
  });

  it("anchors a sub/sup-shifted child at the decorating box's baseline", () => {
    // <u>x<sub>2</sub></u>: sub baseline ~4px below the parent's.
    expect(pickPropagatedBaseline([100], 104, 24)).toBe(100);
    // sup: shifted up.
    expect(pickPropagatedBaseline([100], 92, 24)).toBe(100);
  });

  it("picks the nearest ancestor line in multi-line content", () => {
    expect(pickPropagatedBaseline([100, 140], 143, 24)).toBe(140);
  });

  it("falls back to the run's baseline when every ancestor line is too far (different line)", () => {
    // Nearest ancestor baseline is 30px away at fontSize 24 → not this line.
    expect(pickPropagatedBaseline([100], 130, 24)).toBe(130);
  });
});
