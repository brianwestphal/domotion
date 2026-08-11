import { describe, expect, it } from "vitest";
import { normalizeTransition, transitionSchema, transitionTypeSchema } from "./transition-schema.js";

const TYPES = [
  "crossfade", "push-left", "scroll", "cut", "magic-move",
  "push-right", "push-up", "push-down", "wipe", "iris",
  "zoom-in", "zoom-out", "shine", "wipe-radial", "wipe-clock",
] as const;

describe("canonical transition schema", () => {
  it("validates every legacy spelling from one vocabulary", () => {
    expect(transitionTypeSchema.options).toEqual([...TYPES, "push", "reveal", "zoom", "custom"]);
    for (const type of TYPES) {
      expect(transitionSchema.parse({ type, duration: 300 }).type).toBe(type);
    }
  });

  it("accepts bounded custom recipes and rejects unsafe or unsupported channels actionably", () => {
    const recipe = { type: "custom" as const, duration: 400, custom: {
      incoming: { opacity: 0, translate: { x: 0.2, y: -0.1 }, scale: { from: 0.8, origin: { x: 0.5, y: 0.5 } } },
      outgoing: { opacity: 0.2, translate: { x: -0.1, y: 0 } },
    } };
    expect(transitionSchema.safeParse(recipe).success).toBe(true);
    expect(transitionSchema.safeParse({ ...recipe, custom: { ...recipe.custom, css: "filter: blur(2px)" } }).success).toBe(false);
    const outgoingClip = transitionSchema.safeParse({ ...recipe, custom: { ...recipe.custom, outgoing: { clip: { shape: "linear" } } } });
    expect(outgoingClip.success).toBe(false);
    if (!outgoingClip.success) expect(outgoingClip.error.issues.map(issue => issue.message).join(" ")).toMatch(/unrecognized|outgoing/i);
    const mismatchedOrigins = transitionSchema.safeParse({ type: "custom", duration: 300, custom: {
      incoming: { scale: { from: 0.8, origin: { x: 0.2, y: 0.2 } }, clip: { shape: "radial", origin: { x: 0.8, y: 0.8 } } },
      outgoing: { opacity: 0 },
    } });
    expect(mismatchedOrigins.success).toBe(false);
    if (!mismatchedOrigins.success) expect(mismatchedOrigins.error.issues[0].message).toContain("same viewport-relative origin");
  });

  it("rejects negative transition durations", () => {
    expect(transitionSchema.safeParse({ type: "crossfade", duration: -1 }).success).toBe(false);
  });

  it("discriminates family parameters and rejects irrelevant channels", () => {
    expect(transitionSchema.parse({ type: "push", duration: 300, push: { angle: 35, distance: 0.8 } }).push).toEqual({ angle: 35, distance: 0.8 });
    expect(transitionSchema.parse({ type: "reveal", duration: 300, reveal: { shape: "radial" } }).reveal).toEqual({ shape: "radial", origin: { x: 0.5, y: 0.5 }, radius: 1 });
    expect(transitionSchema.parse({ type: "zoom", duration: 300, zoom: {} }).zoom).toEqual({ fromScale: 0.9, origin: { x: 0.5, y: 0.5 } });
    expect(transitionSchema.safeParse({ type: "push", duration: 300, push: { direction: "left" }, reveal: { shape: "linear" } }).success).toBe(false);
    expect(transitionSchema.safeParse({ type: "reveal", duration: 300, reveal: { shape: "linear", origin: { x: 0.5, y: 0.5 } } }).success).toBe(false);
    expect(transitionSchema.safeParse({ type: "zoom", duration: 300, zoom: { fromScale: 5 } }).success).toBe(false);
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

  it("normalizes parameter families to bounded viewer-safe channels", () => {
    const translate = normalizeTransition({ type: "push", duration: 200, push: { angle: 45, distance: 1 } }).incoming.translate;
    expect(translate != null && "x" in translate ? translate.x : NaN).toBeCloseTo(Math.SQRT1_2);
    expect(translate != null && "y" in translate ? translate.y : NaN).toBeCloseTo(Math.SQRT1_2);
    expect(normalizeTransition({ type: "zoom", duration: 200, zoom: { fromScale: 1.4, origin: { x: 0.25, y: 0.75 } } }).incoming.scale).toEqual({ from: 1.4, origin: { x: 0.25, y: 0.75 } });
  });

  it("retains legacy wipe and clock parameters in their normalized clip plans", () => {
    expect(normalizeTransition({ type: "wipe", duration: 200, wipeAngle: 37 }).incoming.clip).toEqual({ shape: "wipe", angle: 37 });
    expect(normalizeTransition({ type: "wipe-clock", duration: 200, wipeStartAngle: 90, wipeCounterclockwise: true }).incoming.clip).toEqual({
      shape: "clock", startAngle: 90, counterclockwise: true,
    });
  });
});
