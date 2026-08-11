import { describe, expect, it } from "vitest";
import { normalizeTransition, transitionSchema, transitionTypeSchema } from "./transition-schema.js";

const TYPES = [
  "crossfade", "push-left", "scroll", "cut", "magic-move",
  "push-right", "push-up", "push-down", "wipe", "iris",
  "zoom-in", "zoom-out", "shine", "wipe-radial", "wipe-clock",
] as const;

describe("canonical transition schema", () => {
  it("validates every legacy spelling from one vocabulary", () => {
    expect(transitionTypeSchema.options).toEqual(TYPES);
    for (const type of TYPES) {
      expect(transitionSchema.parse({ type, duration: 300 }).type).toBe(type);
    }
  });

  it("rejects negative transition durations", () => {
    expect(transitionSchema.safeParse({ type: "crossfade", duration: -1 }).success).toBe(false);
  });
});

describe("legacy transition normalization", () => {
  it("normalizes aliases to identical motion channels while retaining their spelling", () => {
    const scroll = normalizeTransition({ type: "scroll", duration: 300 });
    const pushUp = normalizeTransition({ type: "push-up", duration: 300 });
    expect(scroll.incoming).toEqual(pushUp.incoming);
    expect(scroll.outgoing).toEqual(pushUp.outgoing);

    const iris = normalizeTransition({ type: "iris", duration: 300 });
    const radial = normalizeTransition({ type: "wipe-radial", duration: 300 });
    expect(iris.incoming).toEqual(radial.incoming);
    expect(iris.outgoing).toEqual(radial.outgoing);
  });

  it("maps every legacy type onto only opacity, translate, scale, clip, and overlay channels", () => {
    for (const type of TYPES) {
      const plan = normalizeTransition({ type, duration: 300 });
      expect(plan.legacyType).toBe(type);
      expect(Object.keys(plan.incoming).sort()).toEqual(expect.arrayContaining(["opacity"]));
      expect(Object.keys(plan.incoming).every(key => ["opacity", "translate", "scale", "clip"].includes(key))).toBe(true);
      expect(Object.keys(plan.outgoing).every(key => ["opacity", "translate"].includes(key))).toBe(true);
      expect(plan.overlay == null || ["shine", "magic-move"].includes(plan.overlay)).toBe(true);
    }
  });

  it("retains legacy wipe and clock parameters in their normalized clip plans", () => {
    expect(normalizeTransition({ type: "wipe", duration: 200, wipeAngle: 37 }).incoming.clip).toEqual({ shape: "wipe", angle: 37 });
    expect(normalizeTransition({ type: "wipe-clock", duration: 200, wipeStartAngle: 90, wipeCounterclockwise: true }).incoming.clip).toEqual({
      shape: "clock", startAngle: 90, counterclockwise: true,
    });
  });
});
