import { describe, expect, it } from "vitest";
import { offscreenCanvasClip } from "./real-world-webgl-preflight.js";

const page = {
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  scrollX: 10,
  scrollY: 200,
  documentWidth: 1_000,
  documentHeight: 2_000,
};

describe("offscreen canvas screenshot coordinates", () => {
  it("translates the main-frame viewport rectangle into document coordinates", () => {
    expect(offscreenCanvasClip({ x: 20, y: 500, width: 40, height: 40 }, page)).toEqual({
      x: 30,
      y: 700,
      width: 40,
      height: 40,
      scale: 1,
    });
  });

  it("clips a translated canvas through every enclosing frame content box", () => {
    expect(
      offscreenCanvasClip({ x: 20, y: 500, width: 40, height: 40 }, page, [
        { x: 10, y: 480, width: 80, height: 60 },
        { x: 0, y: 490, width: 50, height: 30 },
      ]),
    ).toEqual({ x: 30, y: 700, width: 30, height: 20, scale: 1 });
  });

  it("does not prime a canvas clipped out of its iframe or already visible", () => {
    expect(
      offscreenCanvasClip({ x: 20, y: 500, width: 40, height: 40 }, page, [{ x: 0, y: 600, width: 100, height: 100 }]),
    ).toBeNull();
    expect(offscreenCanvasClip({ x: 90, y: 90, width: 40, height: 40 }, page)).toBeNull();
  });

  it("retains the per-clip side cap and document bounds", () => {
    expect(offscreenCanvasClip({ x: 0, y: 100, width: 1_000, height: 1_000 }, page)).toEqual({
      x: 10,
      y: 300,
      width: 512,
      height: 512,
      scale: 1,
    });
    expect(offscreenCanvasClip({ x: 980, y: 1_700, width: 50, height: 500 }, page)).toEqual({
      x: 990,
      y: 1_900,
      width: 10,
      height: 100,
      scale: 1,
    });
  });

  it("rejects unusable geometry and surfaces beyond document bounds", () => {
    for (const rect of [
      { x: NaN, y: 200, width: 10, height: 10 },
      { x: 0, y: 200, width: 0, height: 10 },
      { x: 0, y: 2_000, width: 10, height: 10 },
    ])
      expect(offscreenCanvasClip(rect, page)).toBeNull();
  });
});
