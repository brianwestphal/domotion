import { describe, expect, it } from "vitest";

import { resolveImageRootTransform, resolveTransformOrigin } from "./svg-image-root-transform.js";

const box = { x: 10, y: 20, w: 100, h: 50 };
const resolve = (
  style: Record<string, string>,
  transformAttr: string | null = null,
  transformOriginAttr: string | null = null,
) => resolveImageRootTransform({ transformAttr, transformOriginAttr, style: new Map(Object.entries(style)) }, box);

describe("resolveImageRootTransform", () => {
  it("returns null when the root has no transform", () => {
    expect(resolve({})).toBeNull();
    expect(resolve({ transform: "none" })).toBeNull();
    expect(resolve({ translate: "none", rotate: "none", scale: "none" })).toBeNull();
  });

  it("passes the SVG transform attribute through about the box center", () => {
    expect(resolve({}, "rotate(30)")).toEqual({ transform: "rotate(30)", origin: { x: 60, y: 45 } });
  });

  it("lets a style transform override the attribute (author declaration over presentation attribute)", () => {
    expect(resolve({ transform: "rotate(45deg)" }, "rotate(30)")).toEqual({
      transform: "rotate(45)",
      origin: { x: 60, y: 45 },
    });
  });

  it("converts CSS functions, units and percentages against the reference box", () => {
    const out = resolve({
      transform: "translate(10%, 4px) rotate(0.25turn) scale(150%) skewX(10deg) translateY(-20%)",
    });
    expect(out).not.toBe("unsupported");
    expect(out).toMatchObject({ transform: "translate(10 4) rotate(90) scale(1.5 1.5) skewX(10) translate(0 -10)" });
    expect(resolve({ transform: "rotate(3.14159265rad)" })).toMatchObject({ transform: "rotate(180)" });
    expect(resolve({ transform: "rotate(100grad)" })).toMatchObject({ transform: "rotate(90)" });
    expect(resolve({ transform: "matrix(1, 0, 0, 1, 5, 6)" })).toMatchObject({ transform: "matrix(1 0 0 1 5 6)" });
    expect(resolve({ transform: "skew(45deg)" })).toMatchObject({ transform: "matrix(1 0 1 1 0 0)" });
  });

  // ComputedStyle::ApplyTransform (core/style/computed_style.cc:1429-1490,
  // chromium 7d859f27): translate, rotate, scale, then transform.
  it("composes the individual properties before transform, in Blink's order", () => {
    expect(resolve({ transform: "skewX(5deg)", scale: "2", rotate: "z 10deg", translate: "5px 50%" })).toMatchObject({
      transform: "translate(5 25) rotate(10) scale(2 2) skewX(5)",
    });
    expect(resolve({ scale: "1 50%" }, "rotate(30)")).toMatchObject({ transform: "scale(1 0.5) rotate(30)" });
  });

  it("resolves transform-origin from the style, else the attribute, else 50% 50%", () => {
    expect(resolve({}, "rotate(30)", "0 0")).toMatchObject({ origin: { x: 10, y: 20 } });
    expect(resolve({ "transform-origin": "right bottom" }, "rotate(30)", "0 0")).toMatchObject({
      origin: { x: 110, y: 70 },
    });
  });

  it("resolves calc(), absolute and font-relative lengths", () => {
    expect(resolve({ transform: "rotate(calc(10deg + 5deg))" })).toMatchObject({ transform: "rotate(15)" });
    expect(resolve({ transform: "translate(calc(50% - 2 * 5px), calc((1in - 6px) / 2))" })).toMatchObject({
      transform: "translate(40 45)",
    });
    expect(resolve({ transform: "translate(1em, 0.5rem)" })).toMatchObject({ transform: "translate(16 8)" });
    expect(
      resolveImageRootTransform(
        {
          transformAttr: null,
          transformOriginAttr: null,
          style: new Map([["transform", "translate(2em)"]]),
          fontSize: 10,
        },
        box,
      ),
    ).toMatchObject({ transform: "translate(20 0)" });
    expect(resolve({ transform: "scale(calc(1 / 2))" })).toMatchObject({ transform: "scale(0.5 0.5)" });
    expect(resolve({ transform: "rotate(30deg)", "transform-origin": "calc(50%) 1em" })).toMatchObject({
      origin: { x: 60, y: 36 },
    });
  });

  // A flat picture with no perspective shows only the 2D affine part of a 3D
  // matrix (CSS Transforms 2 matrices).
  it("flattens 3D functions and the axis forms of rotate without perspective", () => {
    const cos60 = "0.5";
    expect(resolve({ transform: "rotateX(60deg)" })).toMatchObject({ transform: `matrix(1 0 0 ${cos60} 0 0)` });
    expect(resolve({ transform: "rotateY(60deg)" })).toMatchObject({ transform: `matrix(${cos60} 0 0 1 0 0)` });
    expect(resolve({ transform: "rotate3d(0, 0, 1, 90deg)" })).toMatchObject({ transform: "matrix(0 1 -1 0 0 0)" });
    expect(
      resolve({ transform: "translate3d(5px, 10%, 40px) scale3d(2, 3, 4) translateZ(9px) scaleZ(2)" }),
    ).toMatchObject({
      transform: "matrix(2 0 0 3 5 5)",
    });
    expect(resolve({ transform: "matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 7,8,9,1)" })).toMatchObject({
      transform: "matrix(1 0 0 1 7 8)",
    });
    expect(resolve({ transform: "perspective(none) rotate(10deg)" })).toMatchObject({ transform: "rotate(10)" });
    expect(resolve({ rotate: "x 60deg" })).toMatchObject({ transform: `matrix(1 0 0 ${cos60} 0 0)` });
    expect(resolve({ rotate: "0 0 -1 30deg" })).toMatchObject({ transform: "rotate(-30)" });
    expect(resolve({ translate: "1px 2px 3px", scale: "2 2 5" })).toMatchObject({
      transform: "matrix(2 0 0 2 1 2)",
    });
    // 3D factors couple through z: rotateX after translateZ moves y.
    expect(resolve({ transform: "rotateX(90deg) translateZ(10px)" })).toMatchObject({
      transform: "matrix(1 0 0 0 0 -10)",
    });
  });

  // The plane maps through w = m14 x + m24 y + m44; it is projective only when
  // w varies across it (or is not positive).
  it("reports projective products, and flattens perspective that never reaches the plane", () => {
    expect(resolve({ transform: "perspective(100px) rotateY(10deg)" })).toBe("projective");
    expect(resolve({ transform: "matrix3d(1,0,0,0.01, 0,1,0,0, 0,0,1,0, 0,0,0,1)" })).toBe("projective");
    expect(resolve({ transform: "matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,-1)" })).toBe("projective");
    expect(resolve({ rotate: "y 30deg", transform: "perspective(0px) rotateY(1deg)" })).toBe("projective");
    // perspective() alone (or before a z translation) leaves w = 1 on the z = 0 plane.
    expect(resolve({ transform: "perspective(100px)" })).toMatchObject({ transform: "matrix(1 0 0 1 0 0)" });
    expect(resolve({ transform: "perspective(50px) rotate(90deg)" })).toMatchObject({
      transform: "matrix(0 1 -1 0 0 0)",
    });
    // A uniform w divides out.
    expect(resolve({ transform: "matrix3d(2,0,0,0, 0,2,0,0, 0,0,1,0, 4,6,0,2)" })).toMatchObject({
      transform: "matrix(1 0 0 1 2 3)",
    });
    expect(resolve({ transform: "perspective(-1px)" })).toBe("unsupported");
    expect(resolve({ transform: "perspective(10%)" })).toBe("unsupported");
  });

  it("reports unsupported values instead of guessing", () => {
    expect(resolve({ transform: "translate(1ex)" })).toBe("unsupported");
    expect(resolve({ transform: "translate(10vw)" })).toBe("unsupported"); // no viewport known
    expect(
      resolveImageRootTransform(
        {
          transformAttr: null,
          transformOriginAttr: null,
          style: new Map([["transform", "translate(10vw, calc(50vh - 2vmin)) rotate(calc(1deg * 0))"]]),
          viewport: { w: 200, h: 80 },
        },
        box,
      ),
    ).toMatchObject({ transform: "translate(20 38.4) rotate(0)" });
    expect(resolve({ transform: "rotate(calc(10deg + 5px))" })).toBe("unsupported");
    expect(resolve({ translate: "1px 2px 3%" })).toBe("unsupported");
    expect(
      resolveImageRootTransform(
        {
          transformAttr: null,
          transformOriginAttr: null,
          style: new Map([["transform", "translate(1em)"]]),
          fontSize: null,
        },
        box,
      ),
    ).toBe("unsupported");
  });
});

describe("resolveTransformOrigin", () => {
  it("handles one and two values, keywords in either order, and a z offset", () => {
    expect(resolveTransformOrigin("left", box)).toEqual({ x: 10, y: 45 });
    expect(resolveTransformOrigin("top", box)).toEqual({ x: 60, y: 20 });
    expect(resolveTransformOrigin("bottom right", box)).toEqual({ x: 110, y: 70 });
    expect(resolveTransformOrigin("25% 10px", box)).toEqual({ x: 35, y: 30 });
    expect(resolveTransformOrigin("center top 4px", box)).toEqual({ x: 60, y: 20 });
    expect(resolveTransformOrigin("1em", box)).toEqual({ x: 26, y: 45 });
    expect(resolveTransformOrigin("1em", box, { fontSize: null, viewport: null })).toBeNull();
  });
});
