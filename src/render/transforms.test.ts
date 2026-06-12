import { describe, it, expect } from "vitest";
import { cssTransformToSvg } from "./transforms.js";

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

  it("downgrades matrix3d to its 2D submatrix (m11,m12,m21,m22,m41,m42)", () => {
    // column-major: m11=2,m12=0,…,m21=0,m22=2,…,m41=10,m42=20
    expect(cssTransformToSvg("matrix3d(2,0,0,0, 0,2,0,0, 0,0,1,0, 10,20,0,1)", 0, 0)).toBe(
      "matrix(2 0 0 2 10 20)",
    );
  });

  it("returns '' for a malformed matrix3d or an unrecognized transform", () => {
    expect(cssTransformToSvg("matrix3d(1,2,3)", 0, 0)).toBe("");          // wrong arg count
    expect(cssTransformToSvg("rotate(45deg)", 0, 0)).toBe("");            // not a computed matrix form
  });
});
