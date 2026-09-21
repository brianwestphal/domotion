import { describe, it, expect } from "vitest";
import {
  parsePreserveAspectRatio,
  computeViewportMatrix,
  DEFAULT_PRESERVE_ASPECT_RATIO,
  type ViewBox,
  type ViewportPlacement,
  type AffineMatrix,
} from "./svg-viewport-matrix.js";

// DM-DQXZ6K: the viewport→viewBox affine matrix, transcribed from Blink's
// SVGPreserveAspectRatio::ComputeTransform (chromium 7d859f27). Expectations are
// derived from the algorithm and the SVG preserveAspectRatio semantics.

const vb = (minX: number, minY: number, width: number, height: number): ViewBox => ({ minX, minY, width, height });
const place = (x: number, y: number, w: number, h: number): ViewportPlacement => ({ x, y, w, h });
const par = (s: string) => parsePreserveAspectRatio(s);

function expectMatrix(m: AffineMatrix | null, e: AffineMatrix): void {
  expect(m).not.toBeNull();
  expect(m!.a).toBeCloseTo(e.a, 6);
  expect(m!.b).toBeCloseTo(e.b, 6);
  expect(m!.c).toBeCloseTo(e.c, 6);
  expect(m!.d).toBeCloseTo(e.d, 6);
  expect(m!.e).toBeCloseTo(e.e, 6);
  expect(m!.f).toBeCloseTo(e.f, 6);
}

describe("parsePreserveAspectRatio", () => {
  it("defaults to xMidYMid meet when absent/empty/unparseable", () => {
    expect(parsePreserveAspectRatio(null)).toEqual(DEFAULT_PRESERVE_ASPECT_RATIO);
    expect(parsePreserveAspectRatio("")).toEqual(DEFAULT_PRESERVE_ASPECT_RATIO);
    expect(parsePreserveAspectRatio("garbage")).toEqual(DEFAULT_PRESERVE_ASPECT_RATIO);
  });
  it("parses align + meet/slice, and ignores a leading `defer`", () => {
    expect(par("xMinYMax slice")).toEqual({ align: "xMinYMax", meetOrSlice: "slice" });
    expect(par("none")).toEqual({ align: "none", meetOrSlice: "meet" });
    expect(par("defer xMaxYMid meet")).toEqual({ align: "xMaxYMid", meetOrSlice: "meet" });
    expect(par("xMidYMid")).toEqual({ align: "xMidYMid", meetOrSlice: "meet" });
  });
});

describe("computeViewportMatrix", () => {
  it("returns null when the viewBox or the placement is empty", () => {
    expect(computeViewportMatrix(place(0, 0, 100, 100), vb(0, 0, 0, 50), par("xMidYMid meet"))).toBeNull();
    expect(computeViewportMatrix(place(0, 0, 100, 100), vb(0, 0, 100, 0), par("xMidYMid meet"))).toBeNull();
    expect(computeViewportMatrix(place(0, 0, 0, 100), vb(0, 0, 100, 50), par("none"))).toBeNull();
  });

  it("none: independent non-uniform scale, no alignment offset", () => {
    // viewBox 0 0 100 50 into a 100×100 placement → sx=1, sy=2.
    expectMatrix(computeViewportMatrix(place(0, 0, 100, 100), vb(0, 0, 100, 50), par("none")), {
      a: 1,
      b: 0,
      c: 0,
      d: 2,
      e: 0,
      f: 0,
    });
  });

  it("identity when viewBox matches the placement exactly", () => {
    expectMatrix(computeViewportMatrix(place(0, 0, 24, 24), vb(0, 0, 24, 24), par("xMidYMid meet")), {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
    });
  });

  it("xMidYMid meet: uniform fit + centering (a 2:1 viewBox in a 1:1 box centers vertically)", () => {
    // scale=1 (width-fitted), content 100×50 centered in 100×100 → f = (100-50)/2 = 25.
    expectMatrix(computeViewportMatrix(place(0, 0, 100, 100), vb(0, 0, 100, 50), par("xMidYMid meet")), {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 25,
    });
  });

  it("xMidYMid slice: uniform cover + centering (a 2:1 viewBox in a 1:1 box overflows horizontally)", () => {
    // scale=2 (height-fitted), content 200×100 centered in 100 wide → e = 2·(-25) = -50.
    expectMatrix(computeViewportMatrix(place(0, 0, 100, 100), vb(0, 0, 100, 50), par("xMidYMid slice")), {
      a: 2,
      b: 0,
      c: 0,
      d: 2,
      e: -50,
      f: 0,
    });
  });

  it("xMinYMin meet: fit, top-left aligned (no centering offset)", () => {
    expectMatrix(computeViewportMatrix(place(0, 0, 100, 100), vb(0, 0, 100, 50), par("xMinYMin meet")), {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
    });
  });

  it("xMaxYMax meet: fit, bottom-right aligned (full leftover offset)", () => {
    // width-fitted scale=1, leftover height 50 fully below → f = 50.
    expectMatrix(computeViewportMatrix(place(0, 0, 100, 100), vb(0, 0, 100, 50), par("xMaxYMax meet")), {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 50,
    });
  });

  it("xMaxYMax slice: cover, right-aligned (full leftover width offset)", () => {
    // height-fitted scale=2, leftover width 50 → e = 2·(-50) = -100.
    expectMatrix(computeViewportMatrix(place(0, 0, 100, 100), vb(0, 0, 100, 50), par("xMaxYMax slice")), {
      a: 2,
      b: 0,
      c: 0,
      d: 2,
      e: -100,
      f: 0,
    });
  });

  it("folds the placement x/y and a non-zero viewBox origin into e/f", () => {
    // none: sx=1, sy=2, tx=-minX=-10, ty=-minY=-5 → e = 1·(-10)+px, f = 2·(-5)+py.
    expectMatrix(computeViewportMatrix(place(7, 9, 100, 100), vb(10, 5, 100, 50), par("none")), {
      a: 1,
      b: 0,
      c: 0,
      d: 2,
      e: -10 + 7,
      f: -10 + 9,
    });
  });

  it("common icon case: a 0 0 24 24 icon drawn at 16×16 scales uniformly by 2/3", () => {
    expectMatrix(computeViewportMatrix(place(0, 0, 16, 16), vb(0, 0, 24, 24), par("xMidYMid meet")), {
      a: 16 / 24,
      b: 0,
      c: 0,
      d: 16 / 24,
      e: 0,
      f: 0,
    });
  });
});
