import { describe, expect, it } from "vitest";

import { capturedElement, capturedStyles } from "../test-support/captured-fixtures.js";
import type { CapturedElement } from "./types.js";
import { createRasterViewportSpace, mapRectThroughAffine } from "./raster-viewport-space.js";

function box(
  x: number,
  y: number,
  width: number,
  height: number,
  transform = "none",
  children: CapturedElement[] = [],
): CapturedElement {
  return capturedElement({
    tag: "div",
    x,
    y,
    width,
    height,
    children,
    styles: capturedStyles({ transform, transformOrigin: "0px 0px" }),
  });
}

describe("mapRectThroughAffine", () => {
  it("translates and scales a rectangle exactly", () => {
    expect(mapRectThroughAffine({ x: 10, y: 20, width: 30, height: 40 }, [1, 0, 0, 1, 10.5, -2])).toEqual({
      x: 20.5,
      y: 18,
      width: 30,
      height: 40,
    });
    expect(mapRectThroughAffine({ x: 10, y: 20, width: 30, height: 40 }, [1.5, 0, 0, 2, 0, 0])).toEqual({
      x: 15,
      y: 40,
      width: 45,
      height: 80,
    });
  });

  it("returns the axis-aligned bounds of a rotated or reflected rectangle", () => {
    const quarterTurn = mapRectThroughAffine({ x: 0, y: 0, width: 20, height: 10 }, [0, 1, -1, 0, 0, 0]);
    expect(quarterTurn.x).toBeCloseTo(-10);
    expect(quarterTurn.y).toBeCloseTo(0);
    expect(quarterTurn.width).toBeCloseTo(10);
    expect(quarterTurn.height).toBeCloseTo(20);
    expect(mapRectThroughAffine({ x: 0, y: 0, width: 20, height: 10 }, [-1, 0, 0, 1, 0, 0])).toEqual({
      x: -20,
      y: 0,
      width: 20,
      height: 10,
    });
  });
});

describe("createRasterViewportSpace", () => {
  it("reports no frozen CTM for untransformed content", () => {
    const child = box(5, 5, 10, 10);
    const space = createRasterViewportSpace([box(0, 0, 100, 100, "none", [child])]);
    expect(space.frozenCtm(child)).toBeNull();
  });

  it("composes ancestor and own frozen transforms about their origins", () => {
    const child = box(30, 30, 10, 10, "matrix(2, 0, 0, 2, 0, 0)");
    const root = box(20, 20, 100, 100, "matrix(1, 0, 0, 1, 10.5, 10)", [child]);
    const space = createRasterViewportSpace([root]);
    expect(space.frozenCtm(root)).toEqual([1, 0, 0, 1, 10.5, 10]);
    // scale(2) about (30, 30), then translate(10.5, 10).
    expect(space.frozenCtm(child)).toEqual([2, 0, 0, 2, -30 + 10.5, -30 + 10]);
    expect(mapRectThroughAffine(child, space.frozenCtm(child)!)).toEqual({ x: 40.5, y: 40, width: 20, height: 20 });
  });

  it("leaves a projective owner's descendants to that owner's raster", () => {
    const child = box(10, 10, 10, 10);
    const root = box(0, 0, 50, 50, "none", [child]);
    root.projectiveTransform = [1, 0, 0, 0, 1, 0, 0.001, 0, 1];
    const space = createRasterViewportSpace([root]);
    expect(space.frozenCtm(root)).toBeNull();
    expect(space.frozenCtm(child)).toBeNull();
  });
});
