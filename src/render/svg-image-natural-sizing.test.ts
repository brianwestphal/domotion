import { describe, expect, it } from "vitest";
import { computeObjectFitRectFromNaturalSizing } from "./element-tree-to-svg.js";
import { svgImageNaturalSizing, type SvgNaturalSizing } from "./svg-inline.js";

describe("svgImageNaturalSizing (LayoutSVGRoot::UnscaledNaturalSizingInfo)", () => {
  it("takes the size from absolute width/height and the ratio from that size", () => {
    expect(svgImageNaturalSizing(`<svg width="200" height="100" viewBox="0 0 10 10"/>`)).toEqual({
      size: { w: 200, h: 100 },
      ratio: { w: 200, h: 100 },
      hasWidth: true,
      hasHeight: true,
    });
    expect(svgImageNaturalSizing(`<svg width="1in" height="72pt"/>`)?.size).toEqual({ w: 96, h: 96 });
  });

  it("gives a viewBox-only root a ratio and no size", () => {
    expect(svgImageNaturalSizing(`<svg viewBox="0 0 100 50"/>`)).toEqual({
      size: { w: 0, h: 0 },
      ratio: { w: 100, h: 50 },
      hasWidth: false,
      hasHeight: false,
    });
    // A percentage (or the initial 100%) is no natural dimension.
    expect(svgImageNaturalSizing(`<svg width="50%" height="40" viewBox="0 0 2 1"/>`)).toEqual({
      size: { w: 0, h: 40 },
      ratio: { w: 2, h: 1 },
      hasWidth: false,
      hasHeight: true,
    });
  });

  it("clears everything when a dimension is missing and preserveAspectRatio is none", () => {
    expect(svgImageNaturalSizing(`<svg viewBox="0 0 100 50" preserveAspectRatio="none"/>`)).toEqual({
      size: { w: 0, h: 0 },
      ratio: null,
      hasWidth: false,
      hasHeight: false,
    });
    // Both dimensions present: the clearing does not apply.
    expect(svgImageNaturalSizing(`<svg width="4" height="2" preserveAspectRatio="none"/>`)?.hasWidth).toBe(true);
  });

  it("returns null for a length it cannot resolve exactly, or no root", () => {
    expect(svgImageNaturalSizing(`<svg width="2em" height="10"/>`)).toBeNull();
    expect(svgImageNaturalSizing(`<svg width="calc(1px + 2px)"/>`)).toBeNull();
    expect(svgImageNaturalSizing(`<rect/>`)).toBeNull();
  });
});

describe("computeObjectFitRectFromNaturalSizing (LayoutReplaced::ComputeObjectFitAndPositionRect)", () => {
  const ratioOnly: SvgNaturalSizing = {
    size: { w: 0, h: 0 },
    ratio: { w: 1, h: 1 },
    hasWidth: false,
    hasHeight: false,
  };
  const nothing: SvgNaturalSizing = { size: { w: 0, h: 0 }, ratio: null, hasWidth: false, hasHeight: false };
  const fit = (n: SvgNaturalSizing, mode: string, pos = "50% 50%") =>
    computeObjectFitRectFromNaturalSizing(0, 0, 200, 80, n, mode, pos);

  it("resolves none / scale-down on a ratio-only image as a contain size against the box", () => {
    expect(fit(ratioOnly, "none")).toEqual({ x: 60, y: 0, width: 80, height: 80 });
    expect(fit(ratioOnly, "scale-down", "0% 0%")).toEqual({ x: 0, y: 0, width: 80, height: 80 });
    expect(fit(ratioOnly, "cover")).toEqual({ x: 0, y: -60, width: 200, height: 200 });
  });

  it("uses the content box when there is neither a size nor a ratio", () => {
    for (const mode of ["contain", "cover", "none", "scale-down", "fill"]) {
      expect(fit(nothing, mode)).toEqual({ x: 0, y: 0, width: 200, height: 80 });
    }
  });

  it("completes a single natural dimension from the ratio; with no ratio the box wins", () => {
    const widthOnly: SvgNaturalSizing = {
      size: { w: 40, h: 0 },
      ratio: { w: 2, h: 1 },
      hasWidth: true,
      hasHeight: false,
    };
    expect(fit(widthOnly, "none", "0% 0%")).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    const heightNoRatio: SvgNaturalSizing = { size: { w: 0, h: 30 }, ratio: null, hasWidth: false, hasHeight: true };
    // An empty natural size with no ratio short-circuits to the content box
    // before ConcreteObjectSize is consulted (layout_replaced.cc:437).
    expect(fit(heightNoRatio, "none", "0% 0%")).toEqual({ x: 0, y: 0, width: 200, height: 80 });
  });

  it("matches the fixed-size behavior when both dimensions are natural", () => {
    const fixed: SvgNaturalSizing = {
      size: { w: 50, h: 25 },
      ratio: { w: 50, h: 25 },
      hasWidth: true,
      hasHeight: true,
    };
    expect(fit(fixed, "scale-down", "0% 0%")).toEqual({ x: 0, y: 0, width: 50, height: 25 });
    expect(fit(fixed, "contain", "0% 0%")).toEqual({ x: 0, y: 0, width: 160, height: 80 });
  });
});
