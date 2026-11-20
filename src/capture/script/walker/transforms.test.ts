import { describe, expect, it } from "vitest";

import {
  resolveTranslateComponent,
  transformReferenceBox,
  transformWrapsAsAffine2D,
  zoomTransformOrigin,
  zoomTransformTranslation,
} from "./transforms.js";

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

describe("effective zoom on a frozen transform", () => {
  it("scales only the matrix translation, as AffineTransform::Zoom does", () => {
    expect(zoomTransformTranslation("matrix(1.5, 0, 0, 1.5, 17, 9)", 1.25)).toBe(
      "matrix(1.5, 0, 0, 1.5, 21.25, 11.25)",
    );
    expect(zoomTransformTranslation("matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)", 0.5)).toBe(
      "matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 5, 10, 0, 1)",
    );
    expect(zoomTransformTranslation("matrix(1, 0, 0, 1, 17, 9)", 1)).toBe("matrix(1, 0, 0, 1, 17, 9)");
    expect(zoomTransformTranslation("none", 2)).toBe("none");
  });

  it("scales a resolved px origin and leaves anything else alone", () => {
    expect(zoomTransformOrigin("7.5px 3.25px", 1.25)).toBe("9.375px 4.0625px");
    expect(zoomTransformOrigin("20px 12px 4px", 0.5)).toBe("10px 6px 2px");
    expect(zoomTransformOrigin("7.5px 3.25px", 1)).toBe("7.5px 3.25px");
    expect(zoomTransformOrigin("50% 50%", 2)).toBe("50% 50%");
  });
});
