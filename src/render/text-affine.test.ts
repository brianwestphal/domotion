import { describe, expect, it } from "vitest";
import type { CapturedElement, CapturedTextPaintAffine } from "../capture/types.js";
import { buildCapturedTextLineOrigin } from "../capture/text-line-origin.js";
import {
  buildEmittedTextCtmMap,
  emittedElementTextAffine,
  invertTextAffine,
  multiplyTextAffine,
  prepareAffineTextPaint,
  wrapAffineTextPaint,
} from "./text-affine.js";

const base = (): CapturedElement => ({
  tag: "div", text: "live", x: 100, y: 50, width: 80, height: 20,
  styles: { transform: "none", transformOrigin: "40px 10px" } as CapturedElement["styles"],
  children: [],
});

const horizontalLineOrigin = (x: number, y: number, width: number, height: number, ascent: number) =>
  buildCapturedTextLineOrigin({
    fragmentLeft: x,
    fragmentTop: y,
    fragmentWidth: width,
    fragmentHeight: height,
    primaryFontAscent: ascent,
    writingMode: "horizontal-tb",
    effectiveZoom: 1,
  })!;

describe("source-owned affine text paint", () => {
  it("composes and inverts the complete signed affine matrix", () => {
    const parent: CapturedTextPaintAffine = [-1.2, 0.35, 0.4, 0.75, 17, -9];
    const local: CapturedTextPaintAffine = [0.8, -0.2, 0.6, 1.3, -4, 11];
    const composed = multiplyTextAffine(parent, local);
    const inverse = invertTextAffine(parent)!;
    expect(multiplyTextAffine(inverse, composed)).toEqual(expect.arrayContaining([
      expect.closeTo(local[0], 10), expect.closeTo(local[1], 10),
      expect.closeTo(local[2], 10), expect.closeTo(local[3], 10),
      expect.closeTo(local[4], 10), expect.closeTo(local[5], 10),
    ]));
  });

  it("removes an already-emitted ancestor matrix without losing shear/reflection", () => {
    const root = base();
    root.styles.transform = "matrix(-1, 0.25, 0.5, 0.8, 9, -3)";
    const child = base();
    child.x = 115;
    child.y = 65;
    root.children = [child];
    const ctm = buildEmittedTextCtmMap([root]).get(child)!;
    const paint: CapturedTextPaintAffine = [-1.6, 0.1, 0.75, 1.2, 27, 14];
    child.textPaintGeometry = {
      source: "blink-text-fragment-affine-v2", space: "pre-css-transform-viewport",
      neutral: { x: 10, y: 20, width: 60, height: 18, text: "neutral" },
      fragments: [{
        source: "blink-text-fragment-affine-v2", space: "pre-css-transform-viewport",
        textSegmentIndex: 0, sourceTextNodeIndex: 0, physicalFragmentIndex: 0,
        neutralQuad: [10, 20, 70, 20, 70, 38, 10, 38],
        paintQuad: [26, 39, -70, 45, -56.5, 66.6, 39.5, 60.6],
        paintMatrix: paint, affineResidual: 0,
        lineOrigin: horizontalLineOrigin(10, 20, 60, 18, 14), inlineOffset: 10,
        shapedOrigins: [], shapedAdvances: [], writingMode: "horizontal-tb", direction: "ltr",
        transformBox: "border-box", transformOrigin: "40px 10px",
      }],
    };
    const prepared = prepareAffineTextPaint(child, ctm);
    expect(prepared.element.text).toBe("neutral");
    expect(prepared.element.x).toBe(10);
    expect(multiplyTextAffine(ctm, prepared.residualMatrix!)).toEqual(expect.arrayContaining([
      expect.closeTo(paint[0], 8), expect.closeTo(paint[1], 8),
      expect.closeTo(paint[2], 8), expect.closeTo(paint[3], 8),
      expect.closeTo(paint[4], 8), expect.closeTo(paint[5], 8),
    ]));
    expect(wrapAffineTextPaint(prepared.residualMatrix, "<path/>")).toContain("matrix(");
  });

  it("fails closed for a singular emitted plane and never scalarizes rotation", () => {
    const el = base();
    el.styles.transform = "matrix(0, 1, -1, 0, 0, 0)";
    expect(emittedElementTextAffine(el)).toEqual([0, 1, -1, 0, 200, -80]);
    el.textPaintGeometry = {
      source: "blink-text-fragment-affine-v2", space: "pre-css-transform-viewport",
      neutral: { x: 0, y: 0, width: 1, height: 1, text: "x" },
      fragments: [{
        source: "blink-text-fragment-affine-v2", space: "pre-css-transform-viewport",
        textSegmentIndex: 0, sourceTextNodeIndex: 0, physicalFragmentIndex: 0,
        neutralQuad: [0, 0, 1, 0, 1, 1, 0, 1], paintQuad: [0, 0, 1, 0, 1, 1, 0, 1],
        paintMatrix: [1, 0, 0, 1, 0, 0], affineResidual: 0,
        lineOrigin: horizontalLineOrigin(0, 0, 1, 1, 1), inlineOffset: 0,
        shapedOrigins: [0], shapedAdvances: [1], writingMode: "horizontal-tb", direction: "ltr",
        transformBox: "border-box", transformOrigin: "0 0",
      }],
    };
    expect(prepareAffineTextPaint(el, [0, 0, 0, 0, 0, 0]).failureReason).toMatch(/singular/);
  });

  it("consumes the structured writing-plane origin once before the affine matrix", () => {
    const el = base();
    const lineOrigin = buildCapturedTextLineOrigin({
      fragmentLeft: 70.25,
      fragmentTop: 14.375,
      fragmentWidth: 22,
      fragmentHeight: 40,
      primaryFontAscent: 16,
      writingMode: "vertical-rl",
      effectiveZoom: 1.25,
    })!;
    el.textPaintGeometry = {
      source: "blink-text-fragment-affine-v2",
      space: "pre-css-transform-viewport",
      neutral: {
        x: 70.25, y: 14.375, width: 22, height: 40, text: "縦A",
        textSegments: [{
          text: "縦A", x: 70.25, y: 14.375, width: 22, height: 40,
          verticalWritingMode: "vertical-rl", fontAscent: 99,
          yOffsets: [14.375, 34.375], verticalAdvances: [20, 20],
        }],
      },
      fragments: [{
        source: "blink-text-fragment-affine-v2",
        space: "pre-css-transform-viewport",
        textSegmentIndex: 0, sourceTextNodeIndex: 0, physicalFragmentIndex: 0,
        neutralQuad: [70.25, 14.375, 92.25, 14.375, 92.25, 54.375, 70.25, 54.375],
        paintQuad: [70.25, 14.375, 92.25, 14.375, 92.25, 54.375, 70.25, 54.375],
        paintMatrix: [1, 0, 0, 1, 0, 0], affineResidual: 0,
        lineOrigin, inlineOffset: 14.375,
        shapedOrigins: [14.375, 34.375], shapedAdvances: [20, 20],
        writingMode: "vertical-rl", direction: "ltr",
        transformBox: "border-box", transformOrigin: "73% 18%",
      }],
    };
    const prepared = prepareAffineTextPaint(el, [1, 0, 0, 1, 0, 0]);
    expect(prepared.failureReason).toBeUndefined();
    expect(prepared.element.textSegments?.[0]).toMatchObject({
      y: 14.375,
      baseline: 76.25,
      fontAscent: 16,
      yOffsets: [14.375, 34.375],
    });
    expect(prepared.residualMatrix).toEqual([1, 0, 0, 1, 0, 0]);

    lineOrigin.writingModeRotation = [1, 0, 0, 1, 0, 0];
    expect(prepareAffineTextPaint(el, [1, 0, 0, 1, 0, 0]).failureReason)
      .toContain("writing-mode rotation changed");
  });
});
