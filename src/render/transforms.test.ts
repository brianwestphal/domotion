import { describe, it, expect } from "vitest";
import { cssTransformToSvg, isProjectiveCssTransform } from "./transforms.js";

describe("cssTransformToSvg", () => {
  it("returns '' for none / empty / undefined", () => {
    expect(cssTransformToSvg(undefined, 0, 0)).toBe("");
    expect(cssTransformToSvg("", 0, 0)).toBe("");
    expect(cssTransformToSvg("none", 0, 0)).toBe("");
  });

  it("short-circuits the identity matrix to ''", () => {
    expect(cssTransformToSvg("matrix(1, 0, 0, 1, 0, 0)", 5, 5)).toBe("");
  });

  it("emits a bare matrix() when the origin is (0, 0)", () => {
    expect(cssTransformToSvg("matrix(2, 0, 0, 2, 10, 20)", 0, 0)).toBe("matrix(2 0 0 2 10 20)");
  });

  it("composes translate(origin) … translate(-origin) around a non-zero origin", () => {
    expect(cssTransformToSvg("matrix(0, -1, 1, 0, 0, 0)", 5, 5)).toBe(
      "translate(5 5) matrix(0 -1 1 0 0 0) translate(-5 -5)",
    );
  });

  it("projects an affine matrix3d exactly onto its z=0 plane (Skia asM33)", () => {
    // column-major: m11=2,m12=0,…,m21=0,m22=2,…,m41=10,m42=20
    expect(cssTransformToSvg("matrix3d(2,0,0,0, 0,2,0,0, 0,0,1,0, 10,20,0,1)", 0, 0)).toBe("matrix(2 0 0 2 10 20)");
    // z-only terms (m13, m23, m33, m43, m31, m32) never reach flat z=0 paint.
    expect(cssTransformToSvg("matrix3d(1,0,0.5,0, 0,1,0.25,0, 3,4,2,0, 5,6,7,1)", 0, 0)).toBe("matrix(1 0 0 1 5 6)");
    expect(isProjectiveCssTransform("matrix3d(2,0,0,0, 0,2,0,0, 0,0,1,0, 10,20,0,1)")).toBe(false);
  });

  it("divides a uniform w (m44 != 1) out of the affine", () => {
    expect(cssTransformToSvg("matrix3d(4,0,0,0, 0,4,0,0, 0,0,1,0, 20,40,0,2)", 0, 0)).toBe("matrix(2 0 0 2 10 20)");
  });

  it("never selects six entries from a projective matrix3d", () => {
    // perspective(200px) rotateY(50deg): m14 != 0.
    const persp = "matrix3d(0.642788, 0, 0.766044, -0.00383022, 0, 1, 0, 0, -0.766044, 0, 0.642788, 0, 0, 0, 0, 1)";
    expect(cssTransformToSvg(persp, 0, 0)).toBe("");
    expect(cssTransformToSvg(persp, 50, 40)).toBe("");
    expect(isProjectiveCssTransform(persp)).toBe(true);
    // m24 != 0 alone.
    expect(isProjectiveCssTransform("matrix3d(1,0,0,0, 0,1,0,0.002, 0,0,1,0, 0,0,0,1)")).toBe(true);
    // m44 = 0 maps the plane to infinity.
    expect(isProjectiveCssTransform("matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,0)")).toBe(true);
  });

  it("does not call non-matrix3d or malformed input projective", () => {
    expect(isProjectiveCssTransform(undefined)).toBe(false);
    expect(isProjectiveCssTransform("none")).toBe(false);
    expect(isProjectiveCssTransform("matrix(1, 0, 0, 1, 0, 0)")).toBe(false);
    expect(isProjectiveCssTransform("matrix3d(1,2,3)")).toBe(false);
  });

  it("returns '' for a malformed matrix3d or an unrecognized transform", () => {
    expect(cssTransformToSvg("matrix3d(1,2,3)", 0, 0)).toBe(""); // wrong arg count
    expect(cssTransformToSvg("rotate(45deg)", 0, 0)).toBe(""); // not a computed matrix form
  });
});
