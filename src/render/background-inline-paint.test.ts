import { describe, expect, it, vi } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import {
  deriveFragmentCorners,
  paintBackgroundImageLayers,
  renderInlineFragments,
  type BackgroundLayerBuilder,
} from "./background-inline-paint.js";
import type { PaintCtx, RenderState } from "./element-tree-to-svg.js";

const corners = {
  tl: { h: 8, v: 8 }, tr: { h: 7, v: 7 },
  br: { h: 6, v: 6 }, bl: { h: 5, v: 5 }, uniform: false,
};

function paintContext(): PaintCtx {
  let index = 0;
  return {
    svgParts: [], defsParts: [], idPrefix: "t-",
    nextClipId: (prefix) => `t-${prefix}${index++}`,
    peekClipIdx: () => index,
    advanceClipIdx: (count) => { index += count; },
    emittedTextCtm: new Map(),
  };
}

function element(styles: Record<string, unknown>, inlineFragments?: CapturedElement["inlineFragments"]): CapturedElement {
  return {
    x: 10, y: 20, width: 100, height: 40,
    tag: "span",
    styles: {
      backgroundImage: "none", backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
      paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
      ...styles,
    },
    inlineFragments,
  } as unknown as CapturedElement;
}

describe("background and inline-fragment paint owners", () => {
  it("suppresses slice corners on the correct fragmentation axis", () => {
    expect(deriveFragmentCorners(corners, true, false, false, false)).toMatchObject({
      tl: corners.tl, bl: corners.bl, tr: { h: 0, v: 0 }, br: { h: 0, v: 0 },
    });
    expect(deriveFragmentCorners(corners, false, true, false, true)).toMatchObject({
      tl: { h: 0, v: 0 }, tr: { h: 0, v: 0 }, bl: corners.bl, br: corners.br,
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
