import { describe, expect, it } from "vitest";
import { composeAnimatedLayers } from "./composite.js";
import { cssEasingForStyle, easingInputSchema, isEasingInput } from "./easing-input.js";
import { intraFrameAnimationSchema, overlaySlideSchema } from "./overlay-schema.js";
import { transitionSchema } from "./transition-schema.js";

// DM-GYACKZ: animation easing used to be free text interpolated into a
// `<style>` block of the self-contained SVG, so a value could close the element
// and inject markup. Each config schema now accepts only a preset name or a CSS
// <easing-function>, and every emission site re-checks for direct API callers.
const HOSTILE = [
  "ease}</style><script>alert(1)</script><style>",
  "ease; } .x { fill: red",
  "linear</style>",
  "cubic-bezier(0, 0, 1, 1)} @import url(x);",
  "steps(2)<",
  "",
  "   ",
  "unknown-preset",
];

describe("easing input validation (DM-GYACKZ)", () => {
  it("accepts preset names and the CSS easing grammar", () => {
    for (const value of [
      "ease",
      "ease-in-out",
      "smooth",
      "spring-bouncy",
      "back-out",
      "cubic-bezier(0.22, 1, 0.36, 1)",
      "steps(4, jump-end)",
      "linear(0, 0.5 50%, 1)",
      "  ease-out  ",
    ]) {
      expect(isEasingInput(value), value).toBe(true);
      expect(easingInputSchema.safeParse(value).success, value).toBe(true);
      // Positive controls, so the rejections below are not vacuous.
      expect(transitionSchema.safeParse({ type: "wipe", duration: 300, easing: value }).success, value).toBe(true);
      expect(overlaySlideSchema.safeParse({ from: "left", duration: 300, easing: value }).success, value).toBe(true);
    }
  });

  it.each(HOSTILE)("rejects %j in every config schema", (value) => {
    expect(isEasingInput(value)).toBe(false);
    expect(easingInputSchema.safeParse(value).success).toBe(false);
    expect(transitionSchema.safeParse({ type: "wipe", duration: 300, easing: value }).success).toBe(false);
    expect(overlaySlideSchema.safeParse({ from: "left", duration: 300, easing: value }).success).toBe(false);
    expect(
      intraFrameAnimationSchema.safeParse({
        animId: "a",
        property: "opacity",
        from: "0",
        to: "1",
        duration: 300,
        easing: value,
      }).success,
    ).toBe(false);
  });

  it("cssEasingForStyle resolves presets, keeps CSS, and defaults when absent", () => {
    expect(cssEasingForStyle(undefined, "ease-in")).toBe("ease-in");
    expect(cssEasingForStyle("smooth", "ease")).toBe("cubic-bezier(0.22,1,0.36,1)");
    expect(cssEasingForStyle(" steps(3) ", "ease")).toBe("steps(3)");
  });

  it.each(HOSTILE)("cssEasingForStyle throws on %j", (value) => {
    expect(() => cssEasingForStyle(value, "ease")).toThrow(/Invalid easing/);
  });

  it("the composite emitter refuses a hostile easing from a direct API caller", () => {
    const layer = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50"/></svg>`;
    const compose = (easing: string) =>
      composeAnimatedLayers(
        [
          {
            svg: layer,
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            animations: [{ property: "opacity", from: "0", to: "1", duration: 500, easing }],
          },
        ],
        { width: 100, height: 50, durationMs: 1000 },
      );
    expect(compose("smooth").svg).toContain("cubic-bezier(0.22,1,0.36,1)");
    expect(() => compose("ease}</style><script>alert(1)</script>")).toThrow(/Invalid easing/);
  });
});
