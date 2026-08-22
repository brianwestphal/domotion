import { describe, expect, it } from "vitest";

import type { IntraFrameAnimation } from "../animation/animator.js";
import { conservativeSweptBoxes, type SweptAnimationContext } from "./swept-transform-bounds.js";

const anim = (overrides: Partial<IntraFrameAnimation>): IntraFrameAnimation => ({
  animId: "a",
  property: "translateX",
  from: "0px",
  to: "0px",
  duration: 1000,
  easing: "linear",
  ...overrides,
});

const ctx = (animation: IntraFrameAnimation, start = 0, end = 100): SweptAnimationContext => ({
  animStartPct: start,
  animEndPct: end,
  frameStartPct: start - ((animation.delay ?? 0) / animation.duration) * (end - start),
  anim: animation,
  transformReferenceBox: { x: 0, y: 0, w: 200, h: 100 },
});

describe("conservativeSweptBoxes", () => {
  it("interpolates matching functions before reverse-order composition", () => {
    const boxes = conservativeSweptBoxes(
      { x: 0, y: 10, w: 20, h: 20 },
      [ctx(anim({
        property: "transform",
        from: "scale(-1) translateX(-100px)",
        to: "scale(1) translateX(100px)",
      }))],
    );
    expect(boxes).not.toBeNull();
    // At p=.45 Chromium applies translate(-10) then scale(-.1), reaching
    // x=-1..1. A composed-endpoint matrix lerp misses this entry entirely.
    const sweep = boxes![0].bounds;
    expect(sweep.x).toBeLessThanOrEqual(-1);
    expect(sweep.x + sweep.w).toBeGreaterThanOrEqual(1);
  });

  it("proves a narrow between-grid crossing without finite samples", () => {
    const boxes = conservativeSweptBoxes(
      { x: 0, y: 10, w: 10, h: 10 },
      [ctx(anim({ from: "-101000px", to: "99000px" }))],
    );
    expect(boxes).not.toBeNull();
    expect(boxes![0].bounds.x).toBeLessThanOrEqual(0);
    expect(boxes![0].bounds.x + boxes![0].bounds.w).toBeGreaterThanOrEqual(10);
  });

  it("partitions and composes nested wrappers on their own global clocks", () => {
    const outer = ctx(anim({ animId: "outer", from: "0px", to: "400px", duration: 1000 }), 0, 100);
    const innerAnimation = anim({ animId: "inner", from: "0px", to: "-400px", duration: 200, delay: 400 });
    const inner = ctx(innerAnimation, 40, 60);
    const boxes = conservativeSweptBoxes({ x: 200, y: 10, w: 20, h: 20 }, [outer, inner]);
    expect(boxes).not.toBeNull();
    const afterInner = boxes!.find((interval) => interval.startPct === 60 && interval.endPct === 100);
    expect(afterInner).toBeDefined();
    // At 70%, +280 outer and -400 inner paints x=80..100.
    expect(afterInner!.bounds.x).toBeLessThanOrEqual(80);
    expect(afterInner!.bounds.x + afterInner!.bounds.w).toBeGreaterThanOrEqual(100);
  });

  it("includes cubic-bezier overshoot extrema, not only eased endpoints", () => {
    const boxes = conservativeSweptBoxes(
      { x: 100, y: 10, w: 10, h: 10 },
      [ctx(anim({ from: "0px", to: "100px", easing: "cubic-bezier(.34,1.56,.64,1)" }))],
    );
    expect(boxes).not.toBeNull();
    expect(boxes![0].bounds.x + boxes![0].bounds.w).toBeGreaterThan(210);
  });

  it("preserves CSS list order in both translate/scale permutations", () => {
    const box = { x: 0, y: 0, w: 10, h: 10 };
    const translateThenScale = conservativeSweptBoxes(box, [ctx(anim({
      property: "transform",
      from: "translateX(100px) scale(2)",
      to: "translateX(100px) scale(2)",
    }))]);
    const scaleThenTranslate = conservativeSweptBoxes(box, [ctx(anim({
      property: "transform",
      from: "scale(2) translateX(100px)",
      to: "scale(2) translateX(100px)",
    }))]);
    expect(translateThenScale![0].bounds.x).toBeCloseTo(100, 6);
    expect(translateThenScale![0].bounds.w).toBeCloseTo(20, 6);
    expect(scaleThenTranslate![0].bounds.x).toBeCloseTo(200, 6);
    expect(scaleThenTranslate![0].bounds.w).toBeCloseTo(20, 6);
  });

  it("includes all 2D rotation-arc extrema, not only equal endpoints", () => {
    const boxes = conservativeSweptBoxes(
      { x: 100, y: 0, w: 10, h: 10 },
      [ctx(anim({ property: "transform", from: "rotate(0deg)", to: "rotate(360deg)" }))],
    );
    expect(boxes).not.toBeNull();
    expect(boxes![0].bounds.x).toBeLessThanOrEqual(-110);
    expect(boxes![0].bounds.y).toBeLessThanOrEqual(-110);
    expect(boxes![0].bounds.x + boxes![0].bounds.w).toBeGreaterThanOrEqual(110);
    expect(boxes![0].bounds.y + boxes![0].bounds.h).toBeGreaterThanOrEqual(110);
  });

  it("partitions repeat, alternate, hold, and step discontinuities", () => {
    const repeating = anim({
      from: "0px",
      to: "100px",
      duration: 100,
      delay: 100,
      repeat: 3,
      alternate: true,
      easing: "steps(2, jump-end)",
    });
    const boxes = conservativeSweptBoxes(
      { x: 0, y: 0, w: 10, h: 10 },
      [ctx(repeating, 10, 20)],
    );
    expect(boxes).not.toBeNull();
    expect(boxes!.map(({ startPct, endPct }) => [startPct, endPct])).toEqual([
      [0, 10], [10, 15], [15, 20], [20, 25], [25, 30], [30, 35], [35, 40], [40, 100],
    ]);
    // Three alternate iterations finish at `to`, then `both` fill holds it.
    expect(boxes!.at(-1)!.bounds.x).toBeCloseTo(100);
  });

  it("fails closed for mismatched/decomposed, projective, and unknown easing paths", () => {
    const values = [
      anim({ property: "transform", from: "translateX(0px) scale(1)", to: "scale(1) translateX(10px)" }),
      anim({ property: "transform", from: "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)", to: "none" }),
      anim({ property: "transform", from: "translate(0px 10px)", to: "translate(20px 30px)" }),
      anim({ property: "scale", from: "1 2", to: "2 3" }),
      anim({ from: "0px", to: "10px", easing: "linear(0, 1.2, 1)" }),
    ];
    for (const animation of values) {
      expect(conservativeSweptBoxes({ x: 900, y: 0, w: 10, h: 10 }, [ctx(animation)])).toBeNull();
    }
  });

  it("fails closed when a raw `none` would invalidate a fused transform declaration", () => {
    const animation = anim({
      property: "transform",
      from: "none",
      to: "none",
      fuse: [{ property: "translateX", from: "0px", to: "100px" }],
    });
    expect(conservativeSweptBoxes({ x: 900, y: 0, w: 10, h: 10 }, [ctx(animation)])).toBeNull();
  });

  it("models independently timed fused transform tracks instead of replacing them", () => {
    const animation = anim({
      property: "opacity",
      from: "0",
      to: "1",
      fuse: [
        { property: "translateX", from: "0px", to: "400px" },
        { property: "translateY", from: "0px", to: "200px", delay: 500, duration: 250, easing: "ease-out" },
      ],
    });
    const boxes = conservativeSweptBoxes({ x: 0, y: 0, w: 10, h: 10 }, [ctx(animation)]);
    expect(boxes).not.toBeNull();
    expect(boxes!.some((interval) => interval.startPct === 50)).toBe(true);
    expect(boxes!.some((interval) => interval.startPct === 75)).toBe(true);
    expect(Math.max(...boxes!.map((interval) => interval.bounds.x + interval.bounds.w))).toBeGreaterThanOrEqual(410);
    expect(Math.max(...boxes!.map((interval) => interval.bounds.y + interval.bounds.h))).toBeGreaterThanOrEqual(210);
  });

  it("maps a negative-delay infinite alternate loop onto the scene clock", () => {
    const animation = anim({
      from: "-100px",
      to: "100px",
      duration: 1000,
      delay: -250,
      repeat: "infinite",
      alternate: true,
    });
    const boxes = conservativeSweptBoxes(
      { x: 0, y: 0, w: 10, h: 10 },
      [ctx(animation, -25, 75)],
    );
    expect(boxes).not.toBeNull();
    expect(boxes!.map(({ startPct, endPct }) => [startPct, endPct])).toEqual([[0, 75], [75, 100]]);
    // The first interval starts one quarter into iteration zero; the second is
    // iteration one and reverses both direction and easing.
    expect(boxes![0].bounds.x).toBeLessThanOrEqual(-50);
    expect(boxes![0].bounds.x + boxes![0].bounds.w).toBeGreaterThanOrEqual(110);
    expect(boxes![1].bounds.x).toBeLessThanOrEqual(50);
    expect(boxes![1].bounds.x + boxes![1].bounds.w).toBeGreaterThanOrEqual(110);
  });
});
