import { describe, expect, it } from "vitest";
import type { CapturedElement, CapturedTextPaintAffine } from "../capture/types.js";
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
      source: "blink-text-fragment-affine-v1", space: "pre-css-transform-viewport",
      neutral: { x: 10, y: 20, width: 60, height: 18, text: "neutral" },
      fragments: [{
        source: "blink-text-fragment-affine-v1", space: "pre-css-transform-viewport",
        textSegmentIndex: 0, sourceTextNodeIndex: 0, physicalFragmentIndex: 0,
        neutralQuad: [10, 20, 70, 20, 70, 38, 10, 38],
        paintQuad: [26, 39, -70, 45, -56.5, 66.6, 39.5, 60.6],
        paintMatrix: paint, affineResidual: 0, baseline: 34, inlineOffset: 10,
        shapedOrigins: [], shapedAdvances: [], writingMode: "horizontal-tb", direction: "ltr",
        transformBox: "border-box", transformOrigin: "40px 10px", effectiveZoom: 1,
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
      source: "blink-text-fragment-affine-v1", space: "pre-css-transform-viewport",
      neutral: { x: 0, y: 0, width: 1, height: 1, text: "x" },
      fragments: [{
        source: "blink-text-fragment-affine-v1", space: "pre-css-transform-viewport",
        textSegmentIndex: 0, sourceTextNodeIndex: 0, physicalFragmentIndex: 0,
        neutralQuad: [0, 0, 1, 0, 1, 1, 0, 1], paintQuad: [0, 0, 1, 0, 1, 1, 0, 1],
        paintMatrix: [1, 0, 0, 1, 0, 0], affineResidual: 0, baseline: 1, inlineOffset: 0,
        shapedOrigins: [0], shapedAdvances: [1], writingMode: "horizontal-tb", direction: "ltr",
        transformBox: "border-box", transformOrigin: "0 0", effectiveZoom: 1,
      }],
    };
    expect(prepareAffineTextPaint(el, [0, 0, 0, 0, 0, 0]).failureReason).toMatch(/singular/);
  });
});
