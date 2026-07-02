import { describe, expect, it } from "vitest";
import { cubicBezier, interpolateCssValue, resolveEasing } from "./easing.js";

describe("cubicBezier / resolveEasing (DM-1517)", () => {
  it("linear cubic-bezier is the identity", () => {
    const f = cubicBezier(0, 0, 1, 1);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) expect(f(t)).toBeCloseTo(t, 3);
  });

  it("clamps outside [0,1]", () => {
    const f = resolveEasing("ease-out");
    expect(f(-1)).toBe(0);
    expect(f(2)).toBe(1);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
  });

  it("ease-out is ahead of linear in the first half (front-loaded)", () => {
    const eo = resolveEasing("ease-out");
    expect(eo(0.25)).toBeGreaterThan(0.25);
    expect(eo(0.5)).toBeGreaterThan(0.5);
  });

  it("ease-in trails linear in the first half", () => {
    const ei = resolveEasing("ease-in");
    expect(ei(0.25)).toBeLessThan(0.25);
  });

  it("named keywords resolve; unknown + steps() fall back to linear", () => {
    expect(resolveEasing("linear")(0.4)).toBeCloseTo(0.4, 5);
    expect(resolveEasing(undefined)(0.4)).toBeCloseTo(0.4, 5);
    expect(resolveEasing("steps(4)")(0.4)).toBeCloseTo(0.4, 5); // fallback
    expect(resolveEasing("frobnicate")(0.4)).toBeCloseTo(0.4, 5); // fallback
  });

  it("parses cubic-bezier(...) with an overshoot control point", () => {
    // The `pop` overshoot curve exceeds 1 mid-way.
    const pop = resolveEasing("cubic-bezier(0.34,1.56,0.64,1)");
    expect(pop(0.5)).toBeGreaterThan(1);
    expect(pop(1)).toBe(1);
  });
});

describe("interpolateCssValue (DM-1517)", () => {
  it("lerps a bare number (scale)", () => {
    expect(interpolateCssValue("0.3", "1", 0.5)).toBe("0.65");
    expect(interpolateCssValue("0.3", "1", 0)).toBe("0.3");
    expect(interpolateCssValue("0.3", "1", 1)).toBe("1");
  });

  it("lerps a number with a unit, keeping the unit", () => {
    expect(interpolateCssValue("24px", "0px", 0.5)).toBe("12px");
    expect(interpolateCssValue("-0.6em", "0em", 0.5)).toBe("-0.3em");
  });

  it("lerps each numeric token in a clip-path inset (only the changing one moves)", () => {
    expect(interpolateCssValue("inset(-10% 100% -10% 0)", "inset(-10% 0% -10% 0)", 0.5))
      .toBe("inset(-10% 50% -10% 0)");
  });

  it("steps at the midpoint when the skeletons don't match (different units)", () => {
    expect(interpolateCssValue("1px", "1em", 0.4)).toBe("1px");
    expect(interpolateCssValue("1px", "1em", 0.6)).toBe("1em");
  });
});
