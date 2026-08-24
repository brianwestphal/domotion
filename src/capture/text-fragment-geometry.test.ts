import { describe, expect, it } from "vitest";
import type { CapturedTextPaintAffine, CapturedTextPaintQuad, TextSegment } from "./types.js";
import {
  buildCapturedTextPaintGeometry,
  mapTextPaintPoint,
  solveTextPaintAffine,
  textPaintAffineResidual,
  type ProtocolTextNodeGeometry,
} from "./text-fragment-geometry.js";
import type { BlinkRangeFragmentProbe } from "./text-fragment-spans.js";

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
  rangeFragments: overrides.rangeFragments ?? neutralQuads.map((quad, physicalFragmentIndex): BlinkRangeFragmentProbe => ({
    physicalFragmentIndex,
    domUtf16Span: [physicalFragmentIndex * 6, (physicalFragmentIndex + 1) * 6],
    neutralRangeRect: {
      x: quad[0],
      y: quad[1],
      width: quad[2] - quad[0],
      height: quad[7] - quad[1],
    },
  })),
});

const segment = (x: number, y: number, text = "Affine", sourceStart = 0): TextSegment => ({
  text,
  sourceText: text,
  sourceMapping: {
    source: "dom-text-utf16-v1",
    sourceTextNodeIndex: 0,
    domText: `${"_".repeat(sourceStart)}${text}`,
    domUtf16Span: [sourceStart, sourceStart + text.length],
    renderedChunks: Array.from({ length: text.length }, (_, index) => ({
      renderedUtf16Span: [index, index + 1],
      domUtf16Span: [sourceStart + index, sourceStart + index + 1],
    })),
    role: "ordinary",
  },
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
  it("correlates wrapped fragments and retains zoom, structured origin, and advances", () => {
    const first = segment(12, 18);
    const second = segment(12, 48, "wrap", 6);
    second.sourceMapping!.domText = "Affinewrap";
    first.sourceMapping!.domText = "Affinewrap";
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
        rangeFragments: [
          { physicalFragmentIndex: 0, domUtf16Span: [0, 6], neutralRangeRect: { x: 12, y: 18, width: 60, height: 20 } },
          { physicalFragmentIndex: 1, domUtf16Span: [6, 10], neutralRangeRect: { x: 12, y: 48, width: 40, height: 20 } },
        ],
      })],
    );
    expect(result.failureReason).toBeUndefined();
    expect(result.geometry?.fragments).toHaveLength(2);
    expect(result.geometry?.fragments[0]).toMatchObject({
      textSegmentIndex: 0,
      inlineOffset: 12,
      shapedOrigins: [12, 22, 32, 42, 52, 62],
      shapedAdvances: [10, 10, 10, 10, 10, 10],
      lineOrigin: {
        roundedContainingPaintOffsetTop: 18,
        fragmentRelativeTop: 0,
        primaryFontIntegerAscent: 15,
        lineRelativeTextOrigin: { lineLeft: 12, lineOver: 33 },
        writingModeRotation: [1, 0, 0, 1, 0, 0],
        physicalBaselinePoint: { x: 12, y: 33 },
        effectiveZoom: 1.5,
      },
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
      sourceText: "縦A",
      sourceMapping: {
        source: "dom-text-utf16-v1",
        sourceTextNodeIndex: 0,
        domText: "縦A",
        domUtf16Span: [0, 2],
        renderedChunks: [
          { renderedUtf16Span: [0, 1], domUtf16Span: [0, 1] },
          { renderedUtf16Span: [1, 2], domUtf16Span: [1, 2] },
        ],
        role: "ordinary",
      },
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
        rangeFragments: [{
          physicalFragmentIndex: 0,
          domUtf16Span: [0, 2],
          neutralRangeRect: { x: 70, y: 14, width: 22, height: 40 },
        }],
      })],
    );
    expect(verticalResult.geometry?.fragments[0]).toMatchObject({
      inlineOffset: 14,
      shapedOrigins: [14, 34],
      shapedAdvances: [20, 20],
      lineOrigin: {
        primaryFontIntegerAscent: 16,
        lineRelativeTextOrigin: { lineLeft: 70, lineOver: 30 },
        writingModeRotation: [0, 1, -1, 0, 106, -56],
        physicalBaselinePoint: { x: 76, y: 14 },
      },
    });
  });

  it("fails closed on projective corners, count drift, and wrong source spans", () => {
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

    const wrongSpan = node([1, 0, 0, 1, 0, 0], [local]);
    wrongSpan.rangeFragments[0].domUtf16Span = [1, 6];
    expect(buildCapturedTextPaintGeometry([segment(10, 10)], 15, [wrongSpan]).failureReason)
      .toContain("crosses or ambiguously belongs");
  });
});
