import { describe, expect, it } from "vitest";

import { resolveTranslateComponent, transformReferenceBox, transformWrapsAsAffine2D } from "./transforms.js";

function computed(fields: Record<string, string>): CSSStyleDeclaration {
  return {
    transform: "none",
    translate: "none",
    rotate: "none",
    scale: "none",
    width: "0px",
    height: "0px",
    boxSizing: "content-box",
    paddingLeft: "0px",
    paddingRight: "0px",
    paddingTop: "0px",
    paddingBottom: "0px",
    borderLeftWidth: "0px",
    borderRightWidth: "0px",
    borderTopWidth: "0px",
    borderBottomWidth: "0px",
    ...fields,
  } as unknown as CSSStyleDeclaration;
}

describe("translate longhand resolution", () => {
  it("resolves lengths, percentages of the reference box, and calc() sums", () => {
    expect(resolveTranslateComponent("8px", 200)).toBe(8);
    expect(resolveTranslateComponent("-50%", 200)).toBe(-100);
    expect(resolveTranslateComponent("calc(50% + 8px)", 200)).toBe(108);
    expect(resolveTranslateComponent("calc(-25% - 2.5px)", 40)).toBe(-12.5);
    expect(resolveTranslateComponent("0px", 0)).toBe(0);
    expect(resolveTranslateComponent("garbage", 10)).toBe(0);
  });

  it("measures the border box as the reference box", () => {
    const style = computed({
      width: "100px",
      height: "20px",
      paddingLeft: "10px",
      paddingRight: "10px",
      paddingTop: "4px",
      paddingBottom: "4px",
      borderLeftWidth: "1px",
      borderRightWidth: "1px",
      borderTopWidth: "1px",
      borderBottomWidth: "1px",
    });
    expect(transformReferenceBox(style)).toEqual({ width: 122, height: 30 });
    expect(transformReferenceBox({ ...style, boxSizing: "border-box" } as CSSStyleDeclaration)).toEqual({
      width: 100,
      height: 20,
    });
  });
});

describe("transformWrapsAsAffine2D", () => {
  it("accepts planar affine matrices and rejects projective or translateZ ones", () => {
    expect(transformWrapsAsAffine2D("none")).toBe(false);
    expect(transformWrapsAsAffine2D("matrix(1, 0, 0, 1, 0.5, 0.5)")).toBe(true);
    expect(transformWrapsAsAffine2D("matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 3, 4, 0, 1)")).toBe(true);
    expect(transformWrapsAsAffine2D("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1)")).toBe(false);
    expect(transformWrapsAsAffine2D("matrix3d(1, 0, 0, 0, 0, 1, 0, -0.01, 0, 0, 1, 0, 0, 0, 0, 1)")).toBe(false);
  });
});
