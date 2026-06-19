import { describe, expect, it } from "vitest";
import {
  computeWedgeApexes,
  dashArrayForStyle,
  injectSvgSize,
  insetCornerRadii,
  outsetCornerRadiiForShadow,
  parseCornerRadii,
  parseSide,
  roundedRectPath,
  roundedRectSvg,
  wedgePolygonPoints,
} from "./borders.js";

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

describe("computeWedgeApexes + wedgePolygonPoints (DM-803 / DM-917 / DM-918)", () => {
  // For a uniform-width SQUARE box, every same-side apex lands at the box
  // centre — all four wedges degenerate to triangles meeting at the centre.
  it("square box with uniform widths gives triangles meeting at the centre", () => {
    const apexes = computeWedgeApexes(0, 0, 100, 100, 6, 6, 6, 6);
    expect(apexes.apexTopX).toBe(50); expect(apexes.apexTopY).toBe(50);
    expect(apexes.apexBottomX).toBe(50); expect(apexes.apexBottomY).toBe(50);
    expect(apexes.apexLeftX).toBe(50); expect(apexes.apexLeftY).toBe(50);
    expect(apexes.apexRightX).toBe(50); expect(apexes.apexRightY).toBe(50);
    expect(wedgePolygonPoints("top", 0, 0, 100, 100, apexes))
      .toBe("0,0 100,0 50,50");
    expect(wedgePolygonPoints("bottom", 0, 0, 100, 100, apexes))
      .toBe("100,100 0,100 50,50");
  });

  // DM-918: 6/6/6/6 widths on a 240×100 box. apexTop/apexBottom (formula
  // `bxT + tw·W/(lw+rw)` = bxT + 120) land BELOW / ABOVE the box. Before
  // the fix the bottom wedge triangle was `(R,B) (L,B) (cx, bxT-20)` —
  // covering the entire box vertically, so the solid bottom border bled
  // through the gaps of the top dashed border. The fix: top / bottom
  // become quadrilaterals capped at apexLeft / apexRight on y=cyBox.
  it("wide box with uniform widths caps top/bottom wedges at the perpendicular apexes", () => {
    const apexes = computeWedgeApexes(0, 0, 240, 100, 6, 6, 6, 6);
    // apexTop is at y = 6·240/12 = 120, below bxB=100 → outside the box.
    expect(apexes.apexTopY).toBe(120);
    expect(apexes.apexBottomY).toBe(-20);
    // apexLeft / apexRight sit at y=cyBox=50, inside.
    expect(apexes.apexLeftX).toBe(50); expect(apexes.apexLeftY).toBe(50);
    expect(apexes.apexRightX).toBe(190); expect(apexes.apexRightY).toBe(50);
    // Top wedge: quadrilateral spans only the upper half (no bleed into y > 50).
    expect(wedgePolygonPoints("top", 0, 0, 240, 100, apexes))
      .toBe("0,0 240,0 190,50 50,50");
    // Bottom wedge: quadrilateral spans only the lower half.
    expect(wedgePolygonPoints("bottom", 0, 0, 240, 100, apexes))
      .toBe("240,100 0,100 50,50 190,50");
    // Left / right wedges keep their triangles (apexLeft / apexRight inside).
    expect(wedgePolygonPoints("left", 0, 0, 240, 100, apexes))
      .toBe("0,100 0,0 50,50");
    expect(wedgePolygonPoints("right", 0, 0, 240, 100, apexes))
      .toBe("240,0 240,100 190,50");
  });

  // DM-917: 8/2/8/2 widths on a wide 240×100 box (the "circle, mixed
  // sides" ellipse). apexTop/apexBottom land WAY outside (y = ±480) —
  // before the fix both top and bottom wedges claimed the entire ring,
  // and bottom (painted last) covered the whole ellipse green. The fix:
  // top/bottom cap at apexLeft / apexRight, which still sit on y=cyBox
  // because tw == bw.
  it("8/2/8/2 widths on a wide box gives top/bottom quads bounded at cyBox", () => {
    const apexes = computeWedgeApexes(0, 0, 240, 100, 8, 2, 8, 2);
    // apexTop = bxT + 8·240/4 = 480 (way past bxB=100).
    expect(apexes.apexTopY).toBe(480);
    expect(apexes.apexBottomY).toBe(-380);
    // apexLeft / apexRight: y = bxT + 8·100/16 = 50, inside.
    expect(apexes.apexLeftX).toBe(12.5); expect(apexes.apexLeftY).toBe(50);
    expect(apexes.apexRightX).toBe(227.5); expect(apexes.apexRightY).toBe(50);
    // Top quad: bounded to upper half.
    expect(wedgePolygonPoints("top", 0, 0, 240, 100, apexes))
      .toBe("0,0 240,0 227.5,50 12.5,50");
    // Bottom quad: bounded to lower half.
    expect(wedgePolygonPoints("bottom", 0, 0, 240, 100, apexes))
      .toBe("240,100 0,100 12.5,50 227.5,50");
  });

  // Asymmetric tw/bw — apexLeft.y shifts off cyBox toward the thicker side
  // (DM-803). The top quad's bottom edge tilts accordingly.
  it("shifts apexLeft.y when tw != bw to preserve miter-line geometry", () => {
    // tw=4, bw=8, lw=rw=2 on a 240×120 box. apexLeft.y = bxT + 4·120/12 = 40.
    const apexes = computeWedgeApexes(0, 0, 240, 120, 4, 2, 8, 2);
    expect(apexes.apexLeftY).toBe(40);
    expect(apexes.apexRightY).toBe(40);
    // Top quad bottom edge is at y=40 (above cyBox=60), giving the
    // thinner top side less vertical extent than the thicker bottom.
    // apexLeft/Right .x = lw·H/(tw+bw) = 2·120/12 = 20.
    expect(wedgePolygonPoints("top", 0, 0, 240, 120, apexes))
      .toBe("0,0 240,0 220,40 20,40");
  });

  // Edge case: all-zero widths → fall back to box centre (no division by 0).
  it("falls back to the box centre when the adjacent-pair widths sum to zero", () => {
    const apexes = computeWedgeApexes(0, 0, 100, 100, 0, 0, 0, 0);
    expect(apexes.apexTopX).toBe(50); expect(apexes.apexTopY).toBe(50);
    expect(apexes.apexLeftX).toBe(50); expect(apexes.apexLeftY).toBe(50);
  });

  // DM-1150: a SINGLE-side border with border-radius (e.g. `border-top: 6px; …
  // border-radius: 8px`, left+right = 0). Blink's BoxBorderPainter computes NO
  // miter when the adjacent side is zero-width (`ComputeMiter` → `kNoMiter`), so
  // the top border paints its FULL rounded corner arc. The same-side apex
  // degenerates to the box centre here; without the widths the wedge would be a
  // centre-converging TRIANGLE that cuts each corner off mid-arc. Passing the
  // widths makes the top wedge span the full box edge so both corners are covered.
  it("spans the full box edge for a single-side border (both adjacent sides zero-width)", () => {
    const apexes = computeWedgeApexes(0, 0, 240, 100, 6, 0, 0, 0); // top-only
    // Legacy (no widths): centre-converging triangle — cuts the corners.
    expect(wedgePolygonPoints("top", 0, 0, 240, 100, apexes))
      .toBe("0,0 240,0 120,50");
    // DM-1150 (widths passed): box-spanning quad — covers BOTH top corners.
    expect(wedgePolygonPoints("top", 0, 0, 240, 100, apexes, { tw: 6, rw: 0, bw: 0, lw: 0 }))
      .toBe("0,0 240,0 240,100 0,100");
  });

  it("does NOT span the full edge when an adjacent side has nonzero width", () => {
    // top + left borders, right + bottom zero: the top side's left corner has a
    // real miter (left has width), so it must NOT switch to the spanning quad.
    const apexes = computeWedgeApexes(0, 0, 240, 100, 6, 0, 0, 6);
    const withWidths = wedgePolygonPoints("top", 0, 0, 240, 100, apexes, { tw: 6, rw: 0, bw: 0, lw: 6 });
    // horizSum = lw + rw = 6 ≠ 0, so the legacy apex form is kept (not the quad).
    expect(withWidths).toBe(wedgePolygonPoints("top", 0, 0, 240, 100, apexes));
  });
});


describe("parseSide", () => {
  it("parses a width/style/color triple into a BorderSide", () => {
    expect(parseSide("2px", "solid", "rgb(255, 0, 0)")).toEqual({
      w: 2, style: "solid", color: { r: 255, g: 0, b: 0, a: 1 },
    });
  });

  it("treats a zero / unparseable width as 0", () => {
    expect(parseSide("0px", "dashed", "rgb(0,0,0)")).toMatchObject({ w: 0, style: "dashed" });
  });

  it("returns null when any of width / style / color is missing", () => {
    expect(parseSide(undefined, "solid", "rgb(0,0,0)")).toBeNull();
    expect(parseSide("1px", undefined, "rgb(0,0,0)")).toBeNull();
    expect(parseSide("1px", "solid", undefined)).toBeNull();
  });

  it("returns null when the color can't be parsed", () => {
    expect(parseSide("1px", "solid", "not-a-color")).toBeNull();
  });
});

describe("dashArrayForStyle", () => {
  it("emits a 2:1 dash for `dashed`", () => {
    expect(dashArrayForStyle("dashed", 2)).toBe("4 2");
  });
  it("emits a 1:1 dash for `dotted`", () => {
    expect(dashArrayForStyle("dotted", 3)).toBe("3 3");
  });
  it("emits '' for solid / other styles", () => {
    expect(dashArrayForStyle("solid", 2)).toBe("");
    expect(dashArrayForStyle("double", 2)).toBe("");
  });
});

describe("outsetCornerRadiiForShadow", () => {
  const mk = (h: number, v: number) => ({ h, v });
  it("grows positive corners by the spread and leaves zero corners sharp", () => {
    const c = { tl: mk(4, 4), tr: mk(0, 0), br: mk(4, 4), bl: mk(0, 0), uniform: false };
    const out = outsetCornerRadiiForShadow(c, 3);
    expect(out.tl).toEqual({ h: 7, v: 7 });
    expect(out.tr).toEqual({ h: 0, v: 0 }); // a 0-radius corner stays sharp
    expect(out.br).toEqual({ h: 7, v: 7 });
  });

  it("recomputes the uniform flag and clamps negative growth to 0", () => {
    const uniform = { tl: mk(4, 4), tr: mk(4, 4), br: mk(4, 4), bl: mk(4, 4), uniform: true };
    expect(outsetCornerRadiiForShadow(uniform, 2).uniform).toBe(true);
    // spread more negative than the radius clamps to 0 (no negative radii).
    expect(outsetCornerRadiiForShadow(uniform, -10).tl).toEqual({ h: 0, v: 0 });
  });
});

describe("injectSvgSize", () => {
  it("replaces existing width/height with the captured layout size", () => {
    expect(injectSvgSize('<svg width="24" height="24" viewBox="0 0 24 24"><path/></svg>', 12, 12))
      .toBe('<svg viewBox="0 0 24 24" width="12" height="12"><path/></svg>');
  });

  it("injects width/height when the source has none", () => {
    expect(injectSvgSize('<svg viewBox="0 0 1 1"></svg>', 30, 40))
      .toBe('<svg viewBox="0 0 1 1" width="30" height="40"></svg>');
  });

  it("leaves the markup untouched for non-positive sizes or non-<svg> input", () => {
    expect(injectSvgSize('<svg width="24"/>', 0, 10)).toBe('<svg width="24"/>');
    expect(injectSvgSize("<div></div>", 10, 10)).toBe("<div></div>");
  });
});
