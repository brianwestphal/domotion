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

  it("reports unsupported values instead of guessing", () => {
    expect(resolve({ transform: "rotate(calc(10deg + 5deg))" })).toBe("unsupported");
    expect(resolve({ transform: "translate(1em)" })).toBe("unsupported");
    expect(resolve({ transform: "rotateX(10deg)" })).toBe("unsupported");
    expect(resolve({ rotate: "1 0 0 10deg" })).toBe("unsupported");
    expect(resolve({ translate: "1px 2px 3px" })).toBe("unsupported");
    expect(resolve({ transform: "rotate(30deg)", "transform-origin": "calc(50%)" })).toBe("unsupported");
  });
});

describe("resolveTransformOrigin", () => {
  it("handles one and two values, keywords in either order, and a z offset", () => {
    expect(resolveTransformOrigin("left", box)).toEqual({ x: 10, y: 45 });
    expect(resolveTransformOrigin("top", box)).toEqual({ x: 60, y: 20 });
    expect(resolveTransformOrigin("bottom right", box)).toEqual({ x: 110, y: 70 });
    expect(resolveTransformOrigin("25% 10px", box)).toEqual({ x: 35, y: 30 });
    expect(resolveTransformOrigin("center top 4px", box)).toEqual({ x: 60, y: 20 });
    expect(resolveTransformOrigin("1em", box)).toBeNull();
  });
});
