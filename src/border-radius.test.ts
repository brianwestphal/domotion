import { describe, expect, it } from "vitest";
import { insetCornerRadii, parseCornerRadii, roundedRectPath, roundedRectSvg } from "./render/borders.js";

describe("parseCornerRadii: shorthand and longhand", () => {
  it("treats four equal circular corners as uniform", () => {
    const c = parseCornerRadii({
      borderTopLeftRadius: "10px 10px",
      borderTopRightRadius: "10px 10px",
      borderBottomRightRadius: "10px 10px",
      borderBottomLeftRadius: "10px 10px",
    }, 200, 100);
    expect(c.uniform).toBe(true);
    expect(c.tl).toEqual({ h: 10, v: 10 });
  });

  it("flags asymmetric per-corner radii as non-uniform (DM-300)", () => {
    const c = parseCornerRadii({
      borderTopLeftRadius: "10px 10px",
      borderTopRightRadius: "30px 30px",
      borderBottomRightRadius: "50px 50px",
      borderBottomLeftRadius: "70px 70px",
    }, 200, 100);
    expect(c.uniform).toBe(false);
    expect(c.tl.h).toBe(10);
    expect(c.tr.h).toBe(30);
    expect(c.br.h).toBe(50);
    expect(c.bl.h).toBe(70);
  });

  it("flags elliptical corners as non-uniform even when all four are equal", () => {
    const c = parseCornerRadii({
      borderTopLeftRadius: "50px 20px",
      borderTopRightRadius: "50px 20px",
      borderBottomRightRadius: "50px 20px",
      borderBottomLeftRadius: "50px 20px",
    }, 400, 80);
    expect(c.uniform).toBe(false);
    expect(c.tl).toEqual({ h: 50, v: 20 });
  });

  it("falls back to the borderRadius shorthand when longhands aren't captured", () => {
    const c = parseCornerRadii({ borderRadius: "12px" }, 100, 100);
    expect(c.uniform).toBe(true);
    expect(c.tl).toEqual({ h: 12, v: 12 });
  });

  it("scales corners down to fit the edge length (CSS corner-overlap §5.5)", () => {
    // 999px corners on a 200x100 box: top edge has rTL.h + rTR.h = 1998 > 200,
    // so all corners scale by 200/1998 ≈ 0.1. The vertical sums (rTR.v +
    // rBR.v = 1998 > 100, etc.) drive a tighter scale of 100/1998 ≈ 0.05,
    // which wins. Final per-corner radius: ~50 (half the box height).
    const c = parseCornerRadii({
      borderTopLeftRadius: "999px 999px",
      borderTopRightRadius: "999px 999px",
      borderBottomRightRadius: "999px 999px",
      borderBottomLeftRadius: "999px 999px",
    }, 200, 100);
    expect(c.tl.h).toBeCloseTo(50, 0);
    expect(c.tl.v).toBeCloseTo(50, 0);
    expect(c.uniform).toBe(true);
  });
});

describe("insetCornerRadii: inner-corner derivation", () => {
  it("shrinks each corner by the matching adjacent border-side widths", () => {
    const c = parseCornerRadii({
      borderTopLeftRadius: "20px 20px",
      borderTopRightRadius: "20px 20px",
      borderBottomRightRadius: "20px 20px",
      borderBottomLeftRadius: "20px 20px",
    }, 100, 100);
    const inner = insetCornerRadii(c, 5, 3, 5, 3);
    // TL: shrink by left=3 (h) and top=5 (v).
    expect(inner.tl).toEqual({ h: 17, v: 15 });
    // TR: shrink by right=3 (h) and top=5 (v).
    expect(inner.tr).toEqual({ h: 17, v: 15 });
  });

  it("clamps shrunk corners to zero rather than going negative", () => {
    const c = parseCornerRadii({
      borderTopLeftRadius: "4px 4px",
      borderTopRightRadius: "4px 4px",
      borderBottomRightRadius: "4px 4px",
      borderBottomLeftRadius: "4px 4px",
    }, 100, 100);
    const inner = insetCornerRadii(c, 10, 10, 10, 10);
    expect(inner.tl).toEqual({ h: 0, v: 0 });
  });
});

describe("roundedRectPath: SVG d-attribute geometry", () => {
  it("emits a clockwise path with one elliptical arc per corner", () => {
    const c = parseCornerRadii({
      borderTopLeftRadius: "10px 10px",
      borderTopRightRadius: "20px 20px",
      borderBottomRightRadius: "30px 30px",
      borderBottomLeftRadius: "40px 40px",
    }, 200, 100);
    const d = roundedRectPath(0, 0, 200, 100, c);
    // Starts at (TL.h, 0).
    expect(d.startsWith("M10,0 ")).toBe(true);
    // Has 4 elliptical arc commands, one per non-zero corner.
    const arcs = d.match(/A/g) || [];
    expect(arcs.length).toBe(4);
    // Closes the path.
    expect(d.endsWith(" Z")).toBe(true);
  });

  it("omits the arc for a zero-radius corner so adjacent lines meet sharply", () => {
    const c = parseCornerRadii({
      borderTopLeftRadius: "0px 0px",
      borderTopRightRadius: "20px 20px",
      borderBottomRightRadius: "0px 0px",
      borderBottomLeftRadius: "20px 20px",
    }, 100, 100);
    const d = roundedRectPath(0, 0, 100, 100, c);
    const arcs = d.match(/A/g) || [];
    expect(arcs.length).toBe(2);
  });
});

describe("roundedRectSvg: rect-or-path branching", () => {
  it("emits <rect rx> for uniform circular corners (fast path)", () => {
    const c = parseCornerRadii({
      borderTopLeftRadius: "8px 8px",
      borderTopRightRadius: "8px 8px",
      borderBottomRightRadius: "8px 8px",
      borderBottomLeftRadius: "8px 8px",
    }, 100, 50);
    const svg = roundedRectSvg(0, 0, 100, 50, c, 'fill="red"');
    expect(svg.startsWith("<rect ")).toBe(true);
    expect(svg).toContain('rx="8"');
    expect(svg).toContain('fill="red"');
  });

  it("emits <path> for asymmetric corners (DM-300)", () => {
    const c = parseCornerRadii({
      borderTopLeftRadius: "10px 10px",
      borderTopRightRadius: "30px 30px",
      borderBottomRightRadius: "50px 50px",
      borderBottomLeftRadius: "70px 70px",
    }, 200, 100);
    const svg = roundedRectSvg(0, 0, 200, 100, c, 'fill="blue"');
    expect(svg.startsWith("<path ")).toBe(true);
    expect(svg).toContain('fill="blue"');
    // Four arcs.
    expect((svg.match(/A/g) || []).length).toBe(4);
  });

  it("emits <path> for elliptical corners (50px / 20px)", () => {
    const c = parseCornerRadii({
      borderTopLeftRadius: "50px 20px",
      borderTopRightRadius: "50px 20px",
      borderBottomRightRadius: "50px 20px",
      borderBottomLeftRadius: "50px 20px",
    }, 400, 80);
    const svg = roundedRectSvg(0, 0, 400, 80, c, "");
    expect(svg.startsWith("<path ")).toBe(true);
  });
});
