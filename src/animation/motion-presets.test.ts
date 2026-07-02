import { describe, it, expect } from "vitest";
import {
  EASING_PRESETS, easingPresetNames, resolveEasingPreset,
  motionPresetNames, resolveMotionPreset,
} from "./motion-presets.js";

describe("easing presets (DM-1526)", () => {
  it("resolves a named preset to its cubic-bezier / keyword", () => {
    expect(resolveEasingPreset("spring")).toBe("cubic-bezier(0.34,1.56,0.64,1)");
    expect(resolveEasingPreset("ease-out-quart")).toBe("cubic-bezier(0.165,0.84,0.44,1)");
    expect(resolveEasingPreset("linear")).toBe("linear");
  });

  it("passes a raw CSS easing through unchanged", () => {
    expect(resolveEasingPreset("cubic-bezier(0.1,0.2,0.3,0.4)")).toBe("cubic-bezier(0.1,0.2,0.3,0.4)");
    expect(resolveEasingPreset("steps(4)")).toBe("steps(4)");
    expect(resolveEasingPreset("some-unknown-name")).toBe("some-unknown-name");
  });

  it("undefined → undefined (emitter default applies)", () => {
    expect(resolveEasingPreset(undefined)).toBeUndefined();
  });

  it("every listed easing preset resolves", () => {
    for (const n of easingPresetNames()) expect(EASING_PRESETS[n]).toBeTruthy();
  });

  it("DM-1542: the spring presets resolve to sampled linear() strings, not beziers", () => {
    for (const n of ["spring-bouncy", "spring-soft"]) {
      const css = resolveEasingPreset(n)!;
      expect(css.startsWith("linear(")).toBe(true);
      expect(css).not.toContain("cubic-bezier");
    }
    // spring-bouncy carries a real overshoot (a baked value > 1); the plain
    // `spring` bezier stays a single-overshoot cubic-bezier.
    const bouncy = resolveEasingPreset("spring-bouncy")!;
    const nums = bouncy.slice("linear(".length, -1).split(",").map((s) => parseFloat(s));
    expect(Math.max(...nums)).toBeGreaterThan(1.2);
    expect(resolveEasingPreset("spring")).toBe("cubic-bezier(0.34,1.56,0.64,1)");
  });
});

describe("motion presets (DM-1526)", () => {
  it("fade-up: translateY rise→0 with fused opacity + smooth easing", () => {
    const m = resolveMotionPreset("fade-up", { distance: 30 });
    expect(m).toMatchObject({ property: "translateY", from: "30px", to: "0px", easing: EASING_PRESETS.smooth });
    expect(m.fuse).toEqual([{ property: "opacity", from: "0", to: "1" }]);
  });

  it("fade-down comes from above (negative translateY)", () => {
    expect(resolveMotionPreset("fade-down", { distance: 20 })).toMatchObject({ property: "translateY", from: "-20px", to: "0px" });
  });

  it("pop: center-origin scale overshoot with fused opacity", () => {
    const m = resolveMotionPreset("pop", { scaleFrom: 0.5 });
    expect(m).toMatchObject({ property: "scale", from: "0.5", to: "1", transformOrigin: "center", easing: EASING_PRESETS["back-out"] });
    expect(m.fuse?.[0]).toMatchObject({ property: "opacity" });
  });

  it("slide-in-<dir> enters from the named side", () => {
    expect(resolveMotionPreset("slide-in-left").from).toBe("-48px");   // from the left
    expect(resolveMotionPreset("slide-in-right").from).toBe("48px");   // from the right
    expect(resolveMotionPreset("slide-in-up")).toMatchObject({ property: "translateY", from: "48px" });   // from below
    expect(resolveMotionPreset("slide-in-down")).toMatchObject({ property: "translateY", from: "-48px" }); // from above
  });

  it("wipe-in: a left→right clip-path reveal (no box motion)", () => {
    expect(resolveMotionPreset("wipe-in")).toMatchObject({ property: "clipPath", from: "inset(0 100% 0 0)", to: "inset(0 0 0 0)" });
  });

  it("exit reverses from/to (and its fused tracks)", () => {
    const enter = resolveMotionPreset("fade-up");
    const exit = resolveMotionPreset("fade-up", { exit: true });
    expect(exit.from).toBe(enter.to);
    expect(exit.to).toBe(enter.from);
    expect(exit.fuse?.[0]).toMatchObject({ from: "1", to: "0" }); // opacity reversed
  });

  it("throws on an unknown preset, listing the valid ones", () => {
    expect(() => resolveMotionPreset("nope")).toThrow(/unknown preset/);
    expect(() => resolveMotionPreset("nope")).toThrow(/fade-up/);
  });

  it("motionPresetNames covers the documented vocabulary", () => {
    const names = motionPresetNames();
    for (const n of ["fade", "fade-up", "fade-down", "pop", "slide-in-left", "slide-in-right", "slide-in-up", "slide-in-down", "wipe-in"]) {
      expect(names).toContain(n);
    }
  });
});
