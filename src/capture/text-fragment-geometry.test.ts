import { describe, expect, it } from "vitest";
import type { CapturedTextPaintAffine, CapturedTextPaintQuad, TextSegment } from "./types.js";
import {
  buildCapturedTextPaintGeometry,
  mapTextPaintPoint,
  solveTextPaintAffine,
  textPaintAffineResidual,
  type ProtocolTextNodeGeometry,
} from "./text-fragment-geometry.js";

const rectQuad = (x: number, y: number, width: number, height: number): CapturedTextPaintQuad =>
  [x, y, x + width, y, x + width, y + height, x, y + height];

const mapQuad = (matrix: CapturedTextPaintAffine, quad: CapturedTextPaintQuad): CapturedTextPaintQuad => {
  const result: number[] = [];
  for (let corner = 0; corner < 4; corner++) {
    const mapped = mapTextPaintPoint(matrix, { x: quad[corner * 2], y: quad[corner * 2 + 1] });
    result.push(mapped.x, mapped.y);
  }
  return result as CapturedTextPaintQuad;
};

const node = (
  matrix: CapturedTextPaintAffine,
  neutralQuads: CapturedTextPaintQuad[],
  overrides: Partial<ProtocolTextNodeGeometry> = {},
): ProtocolTextNodeGeometry => ({
  sourceTextNodeIndex: 0,
  neutralQuads,
  paintQuads: neutralQuads.map((quad) => mapQuad(matrix, quad)),
  writingMode: "horizontal-tb",
  direction: "ltr",
  transformBox: "border-box",
  transformOrigin: "17px 23px",
  effectiveZoom: 1,
  ...overrides,
});

const segment = (x: number, y: number, text = "Affine"): TextSegment => ({
  text,
  x,
  y,
  width: 60,
  height: 20,
  fontAscent: 15,
  xOffsets: Array.from({ length: text.length }, (_, index) => x + index * 10),
  xAdvances: Array.from({ length: text.length }, () => 10),
});

describe("affine text-fragment matrix recovery", () => {
  it("recovers signed rotation/scale/translation and validates held-out corners", () => {
    const angle = 37 * Math.PI / 180;
    const matrix: CapturedTextPaintAffine = [
      Math.cos(angle) * 1.6,
      Math.sin(angle) * 1.6,
      -Math.sin(angle) * 0.7,
      Math.cos(angle) * 0.7,
      31.25,
      -17.5,
    ];
    const neutral = [rectQuad(10, 12, 80, 24), rectQuad(10, 42, 55, 24)];
    const paint = neutral.map((quad) => mapQuad(matrix, quad));
    const solved = solveTextPaintAffine(neutral[0], paint[0]);
    expect(solved).not.toBeNull();
    solved!.forEach((value, index) => expect(value).toBeCloseTo(matrix[index], 10));
    expect(textPaintAffineResidual(solved!, neutral, paint)).toBeLessThan(1e-9);
  });

  it("preserves a negative determinant instead of taking scalar magnitudes", () => {
    const reflected: CapturedTextPaintAffine = [-1.2, 0.15, 0.3, 0.8, 90, 4];
    const quad = rectQuad(8, 9, 70, 22);
    const solved = solveTextPaintAffine(quad, mapQuad(reflected, quad))!;
    expect(solved[0] * solved[3] - solved[1] * solved[2]).toBeLessThan(0);
  });

  it("keeps equal-diagonal rotation and scale as distinct matrices", () => {
    const cosine = Math.cos(37 * Math.PI / 180);
    const neutral = rectQuad(20, 30, 70, 20);
    const scale: CapturedTextPaintAffine = [cosine, 0, 0, cosine, 0, 0];
    const rotate: CapturedTextPaintAffine = [cosine, Math.sin(37 * Math.PI / 180), -Math.sin(37 * Math.PI / 180), cosine, 0, 0];
    const solvedScale = solveTextPaintAffine(neutral, mapQuad(scale, neutral))!;
    const solvedRotate = solveTextPaintAffine(neutral, mapQuad(rotate, neutral))!;
    expect(solvedScale[0]).toBeCloseTo(solvedRotate[0], 10);
    expect(Math.max(...solvedScale.map((value, index) => Math.abs(value - solvedRotate[index])))).toBeGreaterThan(0.5);
  });
});

describe("captured text paint geometry", () => {
  it("correlates wrapped fragments and retains zoom, baseline, origin, and advances", () => {
    const first = segment(12, 18);
    const second = segment(12, 48, "wrap");
    second.width = 40;
    second.xOffsets = [12, 22, 32, 42];
    second.xAdvances = [10, 10, 10, 10];
    const matrix: CapturedTextPaintAffine = [0.8, 0.6, -0.2, 1.1, 50, 9];
    const result = buildCapturedTextPaintGeometry(
      [first, second],
      14,
      [node(matrix, [rectQuad(12, 18, 60, 20), rectQuad(12, 48, 40, 20)], {
        effectiveZoom: 1.5,
        transformBox: "content-box",
        transformOrigin: "73% 18%",
      })],
    );
    expect(result.failureReason).toBeUndefined();
    expect(result.geometry?.fragments).toHaveLength(2);
    expect(result.geometry?.fragments[0]).toMatchObject({
      textSegmentIndex: 0,
      baseline: 33,
      inlineOffset: 12,
      shapedOrigins: [12, 22, 32, 42, 52, 62],
      shapedAdvances: [10, 10, 10, 10, 10, 10],
      effectiveZoom: 1.5,
      transformBox: "content-box",
      transformOrigin: "73% 18%",
    });
  });

  it("preserves RTL physical inline start and vertical inline geometry", () => {
    const rtl = segment(30, 10, "RTL");
    rtl.width = 30;
    const rtlResult = buildCapturedTextPaintGeometry(
      [rtl], 15, [node([1, 0, 0, 1, 0, 0], [rectQuad(30, 10, 30, 20)], { direction: "rtl" })],
    );
    expect(rtlResult.geometry?.fragments[0].inlineOffset).toBe(60);

    const vertical: TextSegment = {
      text: "縦A",
      x: 70,
      y: 14,
      width: 22,
      height: 40,
      fontAscent: 16,
      verticalWritingMode: "vertical-rl",
      yOffsets: [14, 34],
      verticalAdvances: [20, 20],
    };
    const verticalResult = buildCapturedTextPaintGeometry(
      [vertical], 15, [node([1, 0, 0, 1, 0, 0], [rectQuad(70, 14, 22, 40)], {
        writingMode: "vertical-rl",
      })],
    );
    expect(verticalResult.geometry?.fragments[0]).toMatchObject({
      baseline: 86,
      inlineOffset: 14,
      shapedOrigins: [14, 34],
      shapedAdvances: [20, 20],
    });
  });

  it("fails closed on projective corners, count drift, and ambiguous correlation", () => {
    const local = rectQuad(10, 10, 60, 20);
    const projective = rectQuad(10, 10, 60, 20);
    projective[4] -= 9;
    const projectedNode = node([1, 0, 0, 1, 0, 0], [local]);
    projectedNode.paintQuads = [projective];
    expect(buildCapturedTextPaintGeometry([segment(10, 10)], 15, [projectedNode]).failureReason)
      .toContain("non-affine");

    const drift = node([1, 0, 0, 1, 0, 0], [local]);
    drift.paintQuads = [];
    expect(buildCapturedTextPaintGeometry([segment(10, 10)], 15, [drift]).failureReason)
      .toContain("count changed");

    expect(buildCapturedTextPaintGeometry(
      [segment(10, 10), segment(10, 10)],
      15,
      [node([1, 0, 0, 1, 0, 0], [local])],
    ).failureReason).toContain("ambiguous");
  });
});
