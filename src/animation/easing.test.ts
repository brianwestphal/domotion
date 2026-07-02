import { describe, expect, it } from "vitest";
import { cubicBezier, interpolateCssValue, resolveEasing, springEasingFn, springLinearEasing } from "./easing.js";

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

describe("spring easing sampler (DM-1542)", () => {
  it("springEasingFn starts at 0, ends at 1, and OVERSHOOTS past 1 (bounce)", () => {
    const f = springEasingFn(0.25, 2 * Math.PI * 2.5);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
    // Sample densely; a bouncy spring rings ABOVE 1 (a monotonic bezier can't).
    let max = 0;
    let overshoots = 0;
    let prev = 0;
    for (let i = 1; i < 200; i++) {
      const v = f(i / 200);
      max = Math.max(max, v);
      // count local maxima above 1
      const next = f((i + 1) / 200);
      if (v > prev && v >= next && v > 1.001) overshoots++;
      prev = v;
    }
    expect(max).toBeGreaterThan(1.2); // a real overshoot, not just easing tail
    expect(overshoots).toBeGreaterThanOrEqual(2); // MULTIPLE oscillations
  });

  it("a softer damping rings fewer times than a bouncy one", () => {
    const count = (z: number, w: number): number => {
      const f = springEasingFn(z, w);
      let n = 0;
      for (let i = 1; i < 200; i++) {
        const v = f(i / 200);
        if (v > f((i - 1) / 200) && v >= f((i + 1) / 200) && v > 1.001) n++;
      }
      return n;
    };
    expect(count(0.6, 2 * Math.PI * 1.1)).toBeLessThan(count(0.25, 2 * Math.PI * 2.5));
  });

  it("springLinearEasing bakes to a CSS linear() string pinned 0 → 1 at the ends", () => {
    const css = springLinearEasing(0.25, 2 * Math.PI * 2.5, 40);
    expect(css.startsWith("linear(")).toBe(true);
    expect(css.endsWith(")")).toBe(true);
    const nums = css.slice("linear(".length, -1).split(",").map((s) => parseFloat(s));
    expect(nums).toHaveLength(41); // samples + 1
    expect(nums[0]).toBe(0);
    expect(nums[nums.length - 1]).toBe(1);
    // Carries the overshoot: at least one baked sample exceeds 1.
    expect(Math.max(...nums)).toBeGreaterThan(1.2);
  });

  it("clamps a pathological damping into the valid open interval (no NaN)", () => {
    // damping >= 1 would make omega_d = 0 (division by zero); it's clamped.
    const css = springLinearEasing(2, 2 * Math.PI, 10);
    expect(css.includes("NaN")).toBe(false);
    expect(css.startsWith("linear(")).toBe(true);
  });
});
