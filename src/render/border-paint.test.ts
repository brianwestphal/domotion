import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import {
  bevelShades,
  BEVEL_PAINT_ORDER,
  bevelSidePolygons,
  curvedBevelRingMarkup,
  paintBorder,
  paintCollapsedBorderRects,
  roundedRectClipLayers,
  roundedRectPerimeter,
} from "./border-paint.js";
import { blinkCurvedDashPathLength, parseCornerRadii, skiaRoundedRectContourLength } from "./borders.js";
import { openDashArray, closedDashArray } from "./stroke-style.js";
import { paintThinDottedLine } from "./outline-paint.js";
import { parseColor } from "./colors.js";
import type { PaintCtx } from "./element-tree-to-svg.js";

function context(): PaintCtx {
  let index = 0;
  return {
    svgParts: [],
    defsParts: [],
    idPrefix: "t-",
    nextClipId: (prefix) => `t-${prefix}${index++}`,
    peekClipIdx: () => index,
    advanceClipIdx: (count) => {
      index += count;
    },
    emittedTextCtm: new Map(),
  };
}

function element(styles: Record<string, unknown>): CapturedElement {
  return {
    tag: "div",
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    styles: {
      borderTopWidth: "2",
      borderRightWidth: "2",
      borderBottomWidth: "2",
      borderLeftWidth: "2",
      borderTopStyle: "solid",
      borderRightStyle: "solid",
      borderBottomStyle: "solid",
      borderLeftStyle: "solid",
      borderTopColor: "rgb(255,0,0)",
      borderRightColor: "rgb(255,0,0)",
      borderBottomColor: "rgb(255,0,0)",
      borderLeftColor: "rgb(255,0,0)",
      borderTopLeftRadius: "0",
      borderTopRightRadius: "0",
      borderBottomRightRadius: "0",
      borderBottomLeftRadius: "0",
      borderCollapse: "separate",
      ...styles,
    },
  } as unknown as CapturedElement;
}

describe("SVG border paint owner", () => {
  it("uses one bevel shade and polygon plan for every side", () => {
    const red = { r: 255, g: 0, b: 0, a: 1 };
    expect(bevelShades(red, "outset", "top")).toEqual({ outer: "rgb(255,0,0)", inner: "rgb(171,0,0)" });
    expect(bevelShades(red, "outset", "right")).toEqual({ outer: "rgb(171,0,0)", inner: "rgb(255,0,0)" });
    expect(bevelShades(red, "groove", "left").outer).toBe("rgb(171,0,0)");
    // DM-NVVDRB: CalculateInsetOutsetColor lightens a low-contrast light edge
    // (Color::Light) and Color::Dark scales by the max channel, both measured
    // against native Chromium paint.
    expect(bevelShades({ r: 16, g: 32, b: 64, a: 1 }, "groove", "top")).toEqual({
      outer: "rgb(0,0,0)",
      inner: "rgb(37,74,148)",
    });
    expect(bevelShades({ r: 0, g: 0, b: 0, a: 1 }, "inset", "bottom").outer).toBe("rgb(84,84,84)");
    expect(bevelShades({ r: 255, g: 255, b: 255, a: 1 }, "inset", "top").outer).toBe("rgb(171,171,171)");
    expect(bevelShades({ r: 40, g: 90, b: 200, a: 1 }, "groove", "top").outer).toBe("rgb(23,52,116)");
    const polygons = bevelSidePolygons(element({}), 4);
    expect(Object.keys(polygons)).toEqual(["top", "right", "bottom", "left"]);
    expect(polygons.top.full).toContain("10,20 110,20");
    expect(polygons.top.outer).not.toBe(polygons.top.inner);
    // DM-XWP1NV: top and bottom are full-width bands painted first; right and
    // left are mitered over them. Odd widths split at Blink's integer midpoint.
    expect(BEVEL_PAINT_ORDER).toEqual(["top", "bottom", "right", "left"]);
    const odd = bevelSidePolygons(element({}), 3);
    expect(odd.top.outer).toBe("10,20 110,20 110,22 10,22");
    expect(odd.bottom.outer).toBe("10,59 110,59 110,60 10,60");
  });

  it("keeps deterministic open-side and closed-contour dash plans", () => {
    expect(openDashArray("dashed", 2, 32)).not.toBe("");
    expect(openDashArray("solid", 2, 32)).toBe("");
    expect(closedDashArray("dotted", 2, 40, true)).toBe("2 2");
    expect(closedDashArray("solid", 2, 40, false)).toBe("");
  });

  it("measures rounded contours from straight edges and quarter ellipses", () => {
    const square = parseCornerRadii(element({}).styles, 100, 40);
    const rounded = parseCornerRadii(
      element({
        borderTopLeftRadius: "10",
        borderTopRightRadius: "10",
        borderBottomRightRadius: "10",
        borderBottomLeftRadius: "10",
      }).styles,
      100,
      40,
    );
    expect(roundedRectPerimeter(100, 40, square)).toBe(280);
    expect(roundedRectPerimeter(100, 40, rounded)).toBeLessThan(280);
  });

  it("routes a uniform solid border through the extracted owner", () => {
    const ctx = context();
    const el = element({});
    const corners = parseCornerRadii(el.styles, el.width, el.height);
    paintBorder(ctx, el, "  ", corners, 800, 600, 2, parseColor("rgb(255,0,0)"), false, false, new Set());
    expect(ctx.svgParts.join("\n")).toContain('stroke="rgb(255,0,0)"');
  });

  it("keeps captured collapsed-table border rectangles authoritative", () => {
    const ctx = context();
    const el = element({
      borderCollapse: "collapse",
      collapsedBorderRects: [{ x: 9, y: 19, width: 102, height: 2, color: "rgb(0, 0, 255)", style: "solid" }],
    });
    expect(paintCollapsedBorderRects(ctx, el, "")).toBe(true);
    expect(ctx.svgParts[0]).toContain('fill="rgb(0,0,255)"');
  });

  it("paints collapsed double edges with Blink's integer stripe, not thirds (DM-VJASEG)", () => {
    const ctx = context();
    const el = element({
      borderCollapse: "collapse",
      collapsedBorderRects: [
        { x: 203, y: 1275, width: 146, height: 4, axis: "row", color: "rgb(109, 40, 217)", style: "double" },
        { x: 345, y: 1275, width: 4, height: 40, axis: "column", color: "rgb(109, 40, 217)", style: "double" },
      ],
    });
    expect(paintCollapsedBorderRects(ctx, el, "")).toBe(true);
    // DrawDoubleBoxSide: stripe = (4 + 1) / 3 = 1 → 1px, 2px gap, 1px.
    expect(ctx.svgParts).toEqual([
      '<rect x="203" y="1275" width="146" height="1" fill="rgb(109,40,217)" />',
      '<rect x="203" y="1278" width="146" height="1" fill="rgb(109,40,217)" />',
      '<rect x="345" y="1275" width="1" height="40" fill="rgb(109,40,217)" />',
      '<rect x="348" y="1275" width="1" height="40" fill="rgb(109,40,217)" />',
    ]);
  });

  it("insets thick collapsed dotted edges by half the width, sizing dots from the full edge (DM-VJASEG)", () => {
    const ctx = context();
    const el = element({
      borderCollapse: "collapse",
      collapsedBorderRects: [
        { x: 32, y: 175, width: 100, height: 4, axis: "row", color: "rgb(185, 28, 28)", style: "dotted" },
      ],
    });
    expect(paintCollapsedBorderRects(ctx, el, "")).toBe(true);
    const line = ctx.svgParts[0];
    // DrawLineWithStyle: endpoints move in by 4/2; intervals still come from length 100.
    expect(line).toContain('x1="34" y1="177" x2="130" y2="177"');
    expect(line).toContain(`stroke-dasharray="${openDashArray("dotted", 4, 100)}"`);
    expect(line).toContain('stroke-linecap="round"');
    expect(line).not.toContain("stroke-dashoffset");
  });

  it("strokes uniform thick dotted sides from the inset start with dash phase 0 (DM-D1BK35)", () => {
    const ctx = context();
    const sides = ["Top", "Right", "Bottom", "Left"];
    const el = element(
      Object.fromEntries(
        sides.flatMap((side) => [
          [`border${side}Width`, "4"],
          [`border${side}Style`, "dotted"],
        ]),
      ),
    );
    const corners = parseCornerRadii(el.styles, el.width, el.height);
    paintBorder(ctx, el, "", corners, 800, 600, 4, parseColor("rgb(255,0,0)"), false, false, new Set());
    const top = ctx.svgParts.find((part) => part.includes('y1="22"') && part.includes('y2="22"'));
    // Blink moves the endpoints in by width/2 and draws the first dot there.
    expect(top).toContain('x1="12"');
    expect(top).toContain('x2="108"');
    expect(top).toContain(`stroke-dasharray="${openDashArray("dotted", 4, 100)}"`);
    expect(ctx.svgParts.join("\n")).not.toContain("stroke-dashoffset");
  });

  it("paints thin collapsed dotted edges with Blink's endpoint-dot plan (DM-92KTN7)", () => {
    const ctx = context();
    const el = element({
      borderCollapse: "collapse",
      collapsedBorderRects: [
        { x: 19, y: 19, width: 101, height: 2, axis: "row", color: "rgb(185, 28, 28)", style: "dotted" },
        { x: 19, y: 19, width: 2, height: 41, axis: "column", color: "rgb(185, 28, 28)", style: "dotted" },
      ],
    });
    expect(paintCollapsedBorderRects(ctx, el, "")).toBe(true);
    expect(ctx.svgParts).toEqual([
      ...paintThinDottedLine(19, 20, 120, 20, 2, "rgb(185,28,28)", ""),
      ...paintThinDottedLine(20, 19, 20, 60, 2, "rgb(185,28,28)", ""),
    ]);
    expect(ctx.defsParts).toEqual([]);
  });

  it("measures rounded contours as Skia does and truncates for the dash fit (DM-96BH76)", () => {
    const c = { h: 7.5, v: 7.5 };
    const corners = { tl: c, tr: c, br: c, bl: c };
    // Chrome's own SVGGeometryElement.getTotalLength() for this rect reports 792.8203125;
    // the analytic perimeter is 793.12, which would truncate to the wrong integer.
    expect(skiaRoundedRectContourLength(302, 101, corners)).toBeCloseTo(792.82, 2);
    expect(blinkCurvedDashPathLength(302, 101, corners)).toBe(792);
    expect(
      skiaRoundedRectContourLength(100, 40, {
        tl: { h: 0, v: 0 },
        tr: { h: 0, v: 0 },
        br: { h: 0, v: 0 },
        bl: { h: 0, v: 0 },
      }),
    ).toBe(280);
    // SkRRect squares a corner when either radius is zero.
    expect(
      skiaRoundedRectContourLength(100, 40, {
        tl: { h: 10, v: 0 },
        tr: { h: 0, v: 0 },
        br: { h: 0, v: 0 },
        bl: { h: 0, v: 0 },
      }),
    ).toBe(280);
  });

  it("strokes a rounded dashed border on Blink's truncated centerline under a ring mask (DM-96BH76)", () => {
    const ctx = context();
    const sides = ["Top", "Right", "Bottom", "Left"];
    const el = element({
      ...Object.fromEntries(
        sides.flatMap((side) => [
          [`border${side}Width`, "1"],
          [`border${side}Style`, "dashed"],
        ]),
      ),
      borderTopLeftRadius: "8",
      borderTopRightRadius: "8",
      borderBottomRightRadius: "8",
      borderBottomLeftRadius: "8",
    });
    const corners = parseCornerRadii(el.styles, el.width, el.height);
    paintBorder(ctx, el, "", corners, 800, 600, 1, parseColor("rgb(255,0,0)"), false, false, new Set());
    const stroke = ctx.svgParts.find((part) => part.includes("stroke-dasharray"))!;
    // CenterOutsets truncates 0.5 to 0: the 1px border strokes its outer edge, radius 8.
    expect(stroke).toContain('d="M18,20 L102,20 A8,8 0 0 1 110,28');
    expect(stroke).toContain('stroke-width="2.2"');
    const corner = { h: 8, v: 8 };
    const length = blinkCurvedDashPathLength(100, 40, { tl: corner, tr: corner, br: corner, bl: corner });
    expect(stroke).toContain(`stroke-dasharray="${closedDashArray("dashed", 1, length)}"`);
    expect(stroke).toMatch(/mask="url\(#[^)]+\)"/);
    // A uniform round ring clips with rounded rects, not an even-odd ring (DM-KA85VS).
    expect(ctx.defsParts.some((part) => part.startsWith("<clipPath") && part.includes('rx="8"'))).toBe(true);
    expect(ctx.defsParts.some((part) => part.includes("evenodd"))).toBe(false);
  });
});

// DM-KA85VS: Blink clips curved dashed/dotted border strokes with anti-aliased
// rounded-rect clips (ClipContouredRect outer, ClipOutContouredRect inner), so
// a uniform round ring emits a rounded-rect clipPath plus an inner rounded-rect
// cut-out instead of an even-odd arc-path ring.
describe("curved dashed/dotted border ring clip (DM-KA85VS)", () => {
  const dashed = (styles: Record<string, string>) => ({
    borderTopStyle: "dashed",
    borderRightStyle: "dashed",
    borderBottomStyle: "dashed",
    borderLeftStyle: "dashed",
    ...styles,
  });
  const paint = (styles: Record<string, string>) => {
    const ctx = context();
    const el = element(dashed(styles));
    paintBorder(
      ctx,
      el,
      "",
      parseCornerRadii(el.styles, el.width, el.height),
      800,
      600,
      2,
      parseColor("rgb(255,0,0)"),
      false,
      false,
      new Set(),
    );
    return ctx.defsParts.join("\n") + ctx.svgParts.join("\n");
  };
  const uniform = {
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
    borderBottomRightRadius: "6px",
    borderBottomLeftRadius: "6px",
  };

  it("clips a uniform round ring to rounded rects", () => {
    const svg = paint(uniform);
    expect(svg).toContain('<rect x="10" y="20" width="100" height="40" rx="6" ry="6"/></clipPath>');
    expect(svg).toContain('<rect x="12" y="22" width="96" height="36" rx="4" ry="4" fill="black"/></mask>');
    expect(svg).not.toContain('fill-rule="evenodd"');
  });

  it("intersects one rounded rect per corner for per-corner radii (DM-1110JP)", () => {
    const svg = paint({ ...uniform, borderTopRightRadius: "3px" });
    // Each corner's rect extends past the far sides by more than its radius.
    expect(svg).toContain('<rect x="10" y="20" width="107" height="47" rx="6" ry="6"/></clipPath>');
    expect(svg).toContain('<rect x="6" y="20" width="104" height="44" rx="3" ry="3"/></clipPath>');
    expect(svg.match(/<g clip-path=/g)?.length).toBeGreaterThanOrEqual(4);
    expect(svg).not.toContain('fill-rule="evenodd"');
  });

  it("cuts out an unequal-width inner contour with per-corner rects", () => {
    const svg = paint({ ...uniform, borderLeftWidth: "4" });
    // The inner top-left corner is 2x4 (6 - left 4, 6 - top 2).
    expect(svg).toContain('rx="2" ry="4"');
    expect(svg).toContain('fill="black"/></g>');
    expect(svg).not.toContain('fill-rule="evenodd"');
  });
});

describe("roundedRectClipLayers (DM-1110JP)", () => {
  const box = { x: 0, y: 0, w: 40, h: 30 };
  const corners = (tl: number, tr: number, br: number, bl: number) => ({
    tl: { h: tl, v: tl },
    tr: { h: tr, v: tr },
    br: { h: br, v: br },
    bl: { h: bl, v: bl },
    uniform: false,
  });

  it("emits one rect for a shared radius and skips square corners otherwise", () => {
    expect(roundedRectClipLayers(box, corners(5, 5, 5, 5))).toEqual([
      '<rect x="0" y="0" width="40" height="30" rx="5" ry="5"/>',
    ]);
    expect(roundedRectClipLayers(box, corners(8, 0, 8, 0))).toEqual([
      '<rect x="0" y="0" width="49" height="39" rx="8" ry="8"/>',
      '<rect x="-9" y="-9" width="49" height="39" rx="8" ry="8"/>',
    ]);
  });

  it("returns null when SkRRect would scale the radii, for an empty box, or for non-round corners", () => {
    expect(roundedRectClipLayers(box, corners(25, 20, 0, 0))).toBeNull();
    expect(roundedRectClipLayers(box, corners(16, 16, 16, 16))).toBeNull();
    expect(roundedRectClipLayers({ ...box, w: 0 }, corners(2, 2, 2, 2))).toBeNull();
    expect(
      roundedRectClipLayers(box, { ...corners(4, 2, 4, 2), curvature: { tl: 4, tr: 2, br: 2, bl: 2 } }),
    ).toBeNull();
  });
});

// DM-DBGKAG: rounded 3D borders take Blink's curved side path: one ring clip,
// a rounded miter wedge per side, the side's shade over the whole ring, and for
// groove/ridge the opposite shade inside the CenterOutsets contour.
describe("rounded 3D bevel borders (DM-DBGKAG)", () => {
  const rounded = {
    borderTopLeftRadius: "8px",
    borderTopRightRadius: "8px",
    borderBottomRightRadius: "8px",
    borderBottomLeftRadius: "8px",
  };
  const paint = (style: string) => {
    const ctx = context();
    const el = element({
      ...rounded,
      borderTopWidth: "6",
      borderRightWidth: "6",
      borderBottomWidth: "6",
      borderLeftWidth: "6",
      borderTopStyle: style,
      borderRightStyle: style,
      borderBottomStyle: style,
      borderLeftStyle: style,
    });
    paintBorder(
      ctx,
      el,
      "",
      parseCornerRadii(el.styles, el.width, el.height),
      800,
      600,
      6,
      parseColor("rgb(255,0,0)"),
      false,
      false,
      new Set(),
    );
    return ctx.svgParts.join("\n");
  };

  it("clips every side to one ring and splits matching joins with crisp miters (DM-F77PN8)", () => {
    const svg = paint("inset");
    expect(svg.match(/<clipPath id="[^"]+"><path d="[^"]+" clip-rule="evenodd"\/><\/clipPath>/g)).toHaveLength(1);
    // Top/left and bottom/right share shades: each side clips to the union of
    // its pair's wedges and a crisp half-plane on its side of the miter.
    expect(svg.match(/<clipPath id="[^"]+"><path d="M[^"]+ Z M[^"]+ Z"\/><\/clipPath>/g)).toHaveLength(4);
    expect(svg.match(/<mask id="[^"]+"[^>]*><polygon [^>]*shape-rendering="crispEdges"\/><\/mask>/g)).toHaveLength(4);
    expect(svg).not.toMatch(/<clipPath id="[^"]+"><polygon /);
    // Inset fills only the ring (a rect under the ring clip); no center contour.
    expect(svg).not.toContain("  <path d=");
  });

  it("keeps anti-aliased wedges where adjacent sides differ in style", () => {
    let index = 0;
    const corner = { h: 8, v: 8 };
    const markup = curvedBevelRingMarkup({
      indent: "",
      outer: { x: 10, y: 20, w: 100, h: 40 },
      corners: { tl: corner, tr: corner, br: corner, bl: corner, uniform: true },
      widths: { top: 6, right: 6, bottom: 6, left: 6 },
      color: { r: 255, g: 0, b: 0, a: 1 },
      styles: { top: "inset", right: "inset", bottom: "inset", left: "outset" },
      nextId: (side) => `c${side}${index++}`,
    }).join("\n");
    // Bottom/right still pair; top and left differ, so each keeps its wedge.
    expect(markup.match(/<clipPath id="[^"]+"><polygon /g)).toHaveLength(2);
    expect(markup.match(/shape-rendering="crispEdges"/g)).toHaveLength(2);
  });

  it("splits groove into the side shade and the opposite shade inside the center contour", () => {
    const svg = paint("groove");
    // Center contour: outer 10,20 100×40 radius 8 inset by trunc(6/2)=3.
    expect(svg).toContain('<path d="M18,23 ');
    const shades = [...svg.matchAll(/fill="(rgb\([^)]*\))"/g)].map((m) => m[1]);
    expect(new Set(shades).size).toBe(2);
  });
});
