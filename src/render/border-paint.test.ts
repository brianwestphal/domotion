import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import {
  bevelShades,
  BEVEL_PAINT_ORDER,
  bevelSidePolygons,
  paintBorder,
  paintCollapsedBorderRects,
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
    expect(ctx.defsParts.some((part) => part.startsWith("<mask") && part.includes("evenodd"))).toBe(true);
  });
});
