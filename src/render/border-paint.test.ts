import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import {
  adjustedClosedDashArray,
  adjustedDashArray,
  paintBorder,
  paintCollapsedBorderRects,
  roundedRectPerimeter,
} from "./border-paint.js";
import { parseCornerRadii } from "./borders.js";
import { parseColor } from "./colors.js";
import type { PaintCtx } from "./element-tree-to-svg.js";

function context(): PaintCtx {
  let index = 0;
  return {
    svgParts: [], defsParts: [], idPrefix: "t-",
    nextClipId: (prefix) => `t-${prefix}${index++}`,
    peekClipIdx: () => index,
    advanceClipIdx: (count) => { index += count; },
    emittedTextCtm: new Map(),
  };
}

function element(styles: Record<string, unknown>): CapturedElement {
  return {
    tag: "div", x: 10, y: 20, width: 100, height: 40,
    styles: {
      borderTopWidth: "2", borderRightWidth: "2", borderBottomWidth: "2", borderLeftWidth: "2",
      borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
      borderTopColor: "rgb(255, 0, 0)", borderRightColor: "rgb(255, 0, 0)",
      borderBottomColor: "rgb(255, 0, 0)", borderLeftColor: "rgb(255, 0, 0)",
      borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
      borderCollapse: "separate",
      ...styles,
    },
  } as unknown as CapturedElement;
}

describe("SVG border paint owner", () => {
  it("keeps deterministic open-side and closed-contour dash plans", () => {
    expect(adjustedDashArray("dashed", 2, 32)).not.toBe("");
    expect(adjustedDashArray("solid", 2, 32)).toBe("");
    expect(adjustedClosedDashArray("dotted", 2, 40, true)).toBe("2 2");
    expect(adjustedClosedDashArray("solid", 2, 40, false)).toBe("");
  });

  it("measures rounded contours from straight edges and quarter ellipses", () => {
    const square = parseCornerRadii(element({}).styles, 100, 40);
    const rounded = parseCornerRadii(element({
      borderTopLeftRadius: "10", borderTopRightRadius: "10",
      borderBottomRightRadius: "10", borderBottomLeftRadius: "10",
    }).styles, 100, 40);
    expect(roundedRectPerimeter(100, 40, square)).toBe(280);
    expect(roundedRectPerimeter(100, 40, rounded)).toBeLessThan(280);
  });

  it("routes a uniform solid border through the extracted owner", () => {
    const ctx = context();
    const el = element({});
    const corners = parseCornerRadii(el.styles, el.width, el.height);
    paintBorder(ctx, el, "  ", corners, 800, 600, 2, parseColor("rgb(255, 0, 0)"), false, false, new Set());
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
});
