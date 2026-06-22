import { describe, expect, it } from "vitest";
import { parseGradientStops } from "./element-tree-to-svg.js";

// DM-1242: a CSS color hint (the bare <percentage> between two color stops)
// shifts the 50% transition to that position via a power curve. SVG only does
// linear interpolation between stops, so `parseGradientStops` samples the curve
// at uniform mix-weight and emits a stop at each sample (one landing exactly on
// the hint). These lock the curve in.

describe("color-hint power-curve interpolation (DM-1242)", () => {
  it("places the 50/50 midpoint color exactly at the hint position, not the geometric middle", () => {
    // red → blue with a hint at 20%.
    const stops = parseGradientStops(["red", "20%", "blue"], 100);
    // A stop at pos 0.2 whose color is the ~50/50 mix (rgb(128,0,128)).
    const atHint = stops.find((s) => Math.abs(s.pos - 0.2) < 1e-6);
    expect(atHint).toBeDefined();
    expect(atHint!.color.r).toBeGreaterThan(120);
    expect(atHint!.color.r).toBeLessThan(136);
    expect(atHint!.color.b).toBeGreaterThan(120);
    expect(atHint!.color.b).toBeLessThan(136);
    // At the geometric middle (50%) the color must be well past the midpoint
    // toward blue (since the transition was front-loaded to 20%).
    const interior = stops.filter((s) => s.pos > 0 && s.pos < 1);
    const near50 = interior.reduce((best, s) => Math.abs(s.pos - 0.5) < Math.abs(best.pos - 0.5) ? s : best, interior[0]);
    expect(near50.color.b).toBeGreaterThan(150); // mostly blue by 50%
  });

  it("emits multiple interior stops (piecewise-linear curve), not a single mid stop", () => {
    const stops = parseGradientStops(["red", "20%", "blue"], 100);
    const interior = stops.filter((s) => s.pos > 0 && s.pos < 1);
    expect(interior.length).toBeGreaterThanOrEqual(5); // 7 samples (one may coincide)
  });

  it("a hint at the exact midpoint (50%) stays linear — no extra stops", () => {
    const stops = parseGradientStops(["red", "50%", "blue"], 100);
    // Only the two endpoints; the linear case needs no curve samples.
    expect(stops.filter((s) => s.pos > 0 && s.pos < 1).length).toBe(0);
    expect(stops).toHaveLength(2);
  });

  it("monotonic non-decreasing stop positions", () => {
    const stops = parseGradientStops(["red", "20%", "blue"], 100);
    for (let i = 1; i < stops.length; i++) expect(stops[i].pos).toBeGreaterThanOrEqual(stops[i - 1].pos);
  });
});
