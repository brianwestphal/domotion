import { describe, expect, it } from "vitest";
import {
  composeUseTransform,
  isActiveSvgTransformValue,
  isConcreteSvgAttributeValue,
  isSvgTransformAnimation,
  isUnresolvedSvgCssExpression,
  normalizeComputedSvgGeometry,
  shouldBakeSvgGeometry,
  shouldStripPromotedViewportDimension,
} from "./inline-svg-decisions.js";

describe("inline SVG capture decisions", () => {
  it("distinguishes concrete attributes from cascade-dependent expressions", () => {
    expect(isUnresolvedSvgCssExpression("var(--icon-fill)")).toBe(true);
    expect(isUnresolvedSvgCssExpression("calc(10px + 2px)")).toBe(true);
    expect(isConcreteSvgAttributeValue("12px")).toBe(true);
    expect(isConcreteSvgAttributeValue(null)).toBe(false);
  });

  it("recognizes static and animated transform ownership", () => {
    expect(isActiveSvgTransformValue("matrix(1,0,0,1,2,3)")).toBe(true);
    expect(isActiveSvgTransformValue("none")).toBe(false);
    expect(isSvgTransformAnimation("animateMotion", "")).toBe(true);
    expect(isSvgTransformAnimation("animate", "transform")).toBe(true);
    expect(isSvgTransformAnimation("animate", "opacity")).toBe(false);
  });

  it("normalizes computed geometry without inventing unsupported values", () => {
    expect(normalizeComputedSvgGeometry("x", "12.5px")).toBe("12.5");
    expect(normalizeComputedSvgGeometry("x", "25%")).toBe("25%");
    expect(normalizeComputedSvgGeometry("d", 'path("M 0 0 L 1 1")')).toBe("M 0 0 L 1 1");
    expect(normalizeComputedSvgGeometry("d", "none")).toBeNull();
    expect(normalizeComputedSvgGeometry("d", "ray(45deg)")).toBeNull();
  });

  it("bakes only computed geometry that owns the cascade decision", () => {
    expect(shouldBakeSvgGeometry(null, "12", false)).toBe(true);
    expect(shouldBakeSvgGeometry("var(--x)", "12", false)).toBe(true);
    expect(shouldBakeSvgGeometry("12", "12", false)).toBe(false);
    expect(shouldBakeSvgGeometry("10", "12", true)).toBe(false);
  });

  it("preserves SVG use transform ordering and nested viewport promotion", () => {
    expect(composeUseTransform("scale(2)", 4, 5)).toBe("scale(2) translate(4,5)");
    expect(composeUseTransform("", 0, 0)).toBe("");
    expect(shouldStripPromotedViewportDimension(null, "0")).toBe(true);
    expect(shouldStripPromotedViewportDimension("0", "0")).toBe(false);
    expect(shouldStripPromotedViewportDimension("var(--w)", "0.0")).toBe(true);
  });
});
