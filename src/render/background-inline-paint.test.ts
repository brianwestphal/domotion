import { describe, expect, it, vi } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import {
  deriveFragmentCorners,
  paintBackgroundImageLayers,
  renderInlineFragments,
  type BackgroundLayerBuilder,
} from "./background-inline-paint.js";
import { blinkCurvedDashPathLength } from "./borders.js";
import type { PaintCtx, RenderState } from "./element-tree-to-svg.js";
import { closedDashArray } from "./stroke-style.js";

const corners = {
  tl: { h: 8, v: 8 },
  tr: { h: 7, v: 7 },
  br: { h: 6, v: 6 },
  bl: { h: 5, v: 5 },
  uniform: false,
};

function paintContext(): PaintCtx {
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

function element(
  styles: Record<string, unknown>,
  inlineFragments?: CapturedElement["inlineFragments"],
): CapturedElement {
  return {
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    tag: "span",
    styles: {
      backgroundImage: "none",
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "0",
      borderRightWidth: "0",
      borderBottomWidth: "0",
      borderLeftWidth: "0",
      paddingTop: "0",
      paddingRight: "0",
      paddingBottom: "0",
      paddingLeft: "0",
      ...styles,
    },
    inlineFragments,
  } as unknown as CapturedElement;
}

describe("background and inline-fragment paint owners", () => {
  it("suppresses slice corners on the correct fragmentation axis", () => {
    expect(deriveFragmentCorners(corners, true, false, false, false)).toMatchObject({
      tl: corners.tl,
      bl: corners.bl,
      tr: { h: 0, v: 0 },
      br: { h: 0, v: 0 },
    });
    expect(deriveFragmentCorners(corners, false, true, false, true)).toMatchObject({
      tl: { h: 0, v: 0 },
      tr: { h: 0, v: 0 },
      bl: corners.bl,
      br: corners.br,
    });
    expect(deriveFragmentCorners(corners, false, false, true, true)).toBe(corners);
  });

  it("routes text-clipped background layers into fills without painting a box", () => {
    const ctx = paintContext();
    const builder = vi.fn(() => ({ def: '<linearGradient id="t-bg0"/>' })) as BackgroundLayerBuilder;
    const result = paintBackgroundImageLayers(
      ctx,
      element({ backgroundImage: "linear-gradient(red, blue)", backgroundClip: "text" }),
      "  ",
      corners,
      false,
      { w: 800, h: 600 },
      builder,
      () => false,
    );
    expect(builder).toHaveBeenCalledOnce();
    expect(result.fills).toEqual(["url(#t-bg0)"]);
    expect(ctx.defsParts).toEqual(['<linearGradient id="t-bg0"/>']);
    expect(ctx.svgParts).toEqual([]);
  });

  // DM-H20KAP: rounded dashed/dotted inline fragments follow Blink's
  // DrawCurvedDashedDottedBoxSide, as block borders do (DM-96BH76).
  const dashedSides = (width: number, style = "dashed") => ({
    borderTopWidth: `${width}px`,
    borderRightWidth: `${width}px`,
    borderBottomWidth: `${width}px`,
    borderLeftWidth: `${width}px`,
    borderTopStyle: style,
    borderRightStyle: style,
    borderBottomStyle: style,
    borderLeftStyle: style,
    borderTopColor: "rgb(0, 160, 0)",
    borderRightColor: "rgb(0, 160, 0)",
    borderBottomColor: "rgb(0, 160, 0)",
    borderLeftColor: "rgb(0, 160, 0)",
  });
  const round8 = { tl: { h: 8, v: 8 }, tr: { h: 8, v: 8 }, br: { h: 8, v: 8 }, bl: { h: 8, v: 8 }, uniform: true };
  const renderState = (paintCtx: PaintCtx) =>
    ({
      paintCtx,
      defsParts: paintCtx.defsParts,
      svgParts: paintCtx.svgParts,
      captureViewport: { w: 800, h: 600 },
    }) as unknown as RenderState;

  it("strokes a whole rounded dashed fragment on the truncated centerline under a ring mask", () => {
    const paintCtx = paintContext();
    const fragment = { x: 10.4, y: 20.4, width: 60, height: 30 };
    const el = element({ ...dashedSides(1), boxDecorationBreak: "clone" }, [fragment]);
    renderInlineFragments(renderState(paintCtx), el, "", null, round8, vi.fn(), () => false);
    const stroke = paintCtx.svgParts.find((part) => part.includes("stroke-dasharray"));
    // floor(1 / 2) = 0: the 1px border strokes the snapped fragment's outer edge.
    expect(stroke).toMatch(/d="M18,20 /);
    expect(stroke).toContain('stroke-width="2.2"');
    expect(stroke).toContain(`stroke-dasharray="${closedDashArray("dashed", 1, blinkCurvedDashPathLength(60, 30, round8))}"`);
    expect(stroke).toMatch(/mask="url\(#t-bm\d+\)"/);
  });

  it("fits a sliced fragment's dashes to the closed contour that runs along its excluded edge", () => {
    const paintCtx = paintContext();
    const first = { x: 10, y: 20, width: 60, height: 30 };
    const last = { x: 10, y: 60, width: 40, height: 30 };
    const el = element(dashedSides(3), [first, last]);
    renderInlineFragments(renderState(paintCtx), el, "", null, round8, vi.fn(), () => false);
    const strokes = paintCtx.svgParts.filter((part) => part.includes("stroke-dasharray"));
    // The first fragment paints top, bottom and left; its excluded right side has no width.
    expect(strokes.slice(0, 3)).toHaveLength(3);
    const firstCorners = { tl: { h: 7, v: 7 }, tr: { h: 0, v: 0 }, br: { h: 0, v: 0 }, bl: { h: 7, v: 7 } };
    // Insets of floor(3 / 2) = 1 on the included sides and 0 on the excluded right side.
    const expectedDash = closedDashArray("dashed", 3, blinkCurvedDashPathLength(59, 28, firstCorners));
    for (const stroke of strokes.slice(0, 3)) {
      expect(stroke).toContain(`stroke-dasharray="${expectedDash}"`);
      expect(stroke).toContain('stroke-width="6.6"');
      expect(stroke).toMatch(/d="M18,21 L70,21 /);
    }
  });

  it("paints clone fragments independently through the extracted coordinator", () => {
    const paintCtx = paintContext();
    const fragment = { x: 10, y: 20, width: 40, height: 20 };
    const el = element({ backgroundColor: "rgb(255, 0, 0)", boxDecorationBreak: "clone" }, [fragment]);
    const state = {
      paintCtx,
      defsParts: paintCtx.defsParts,
      svgParts: paintCtx.svgParts,
      captureViewport: { w: 800, h: 600 },
    } as unknown as RenderState;
    renderInlineFragments(state, el, "  ", { r: 255, g: 0, b: 0, a: 1 }, corners, vi.fn(), () => false);
    expect(paintCtx.svgParts).toHaveLength(1);
    expect(paintCtx.svgParts[0]).toContain('fill="rgb(255,0,0)"');
  });
});
