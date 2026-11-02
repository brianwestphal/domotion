import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import {
  bevelShades,
  bevelSidePolygons,
  paintBorder,
  paintCollapsedBorderRects,
  roundedRectPerimeter,
} from "./border-paint.js";
import { parseCornerRadii } from "./borders.js";
import { openDashArray, closedDashArray } from "./stroke-style.js";
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
    expect(bevelShades(red, "outset", "top")).toEqual({ outer: "rgb(255,0,0)", inner: "rgb(170,0,0)" });
    expect(bevelShades(red, "outset", "right")).toEqual({ outer: "rgb(170,0,0)", inner: "rgb(255,0,0)" });
    expect(bevelShades(red, "groove", "left").outer).toBe("rgb(170,0,0)");
    const polygons = bevelSidePolygons(element({}), 4);
    expect(Object.keys(polygons)).toEqual(["top", "right", "bottom", "left"]);
    expect(polygons.top.full).toContain("10,20 110,20");
    expect(polygons.top.outer).not.toBe(polygons.top.inner);
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
});
