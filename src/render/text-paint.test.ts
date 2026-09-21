import { describe, expect, it, vi } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import type { BackgroundLayerBuilder } from "./background-inline-paint.js";
import { parseColor } from "./colors.js";
import type { PaintCtx } from "./element-tree-to-svg.js";
import { buildPseudoBoxBgLayers, emitVerticalRasterText, resolveTextFill } from "./text-paint.js";

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

function element(styles: Record<string, unknown> = {}): CapturedElement {
  return {
    tag: "span", text: "Hello", x: 10, y: 20, width: 100, height: 30,
    styles: { color: "rgba(0, 0, 0, 0)", ...styles },
  } as unknown as CapturedElement;
}

describe("text paint owner", () => {
  it("selects the top text-clipped fill for transparent text", () => {
    const ctx = context();
    const builder = vi.fn() as unknown as BackgroundLayerBuilder;
    expect(resolveTextFill(
      ctx,
      element(),
      parseColor("rgba(0, 0, 0, 0)"),
      ["url(#top)", "url(#bottom)"],
      { w: 800, h: 600 },
      builder,
    )).toEqual({ fillColor: "url(#top)", textIsTransparent: true });
    expect(builder).not.toHaveBeenCalled();
  });

  it("materializes inherited text gradients against their captured owner box", () => {
    const ctx = context();
    const builder = vi.fn(() => ({ def: '<linearGradient id="t-bg0"/>' })) as BackgroundLayerBuilder;
    const result = resolveTextFill(
      ctx,
      element({
        inheritedTextFillGradient: "linear-gradient(red, blue)",
        inheritedTextFillGradientRect: { x: 1, y: 2, width: 300, height: 40 },
      }),
      parseColor("rgba(0, 0, 0, 0)"),
      [],
      { w: 800, h: 600 },
      builder,
    );
    expect(result).toEqual({ fillColor: "url(#t-bg0)", textIsTransparent: true });
    expect(builder).toHaveBeenCalledWith(
      "t-bg0", "linear-gradient(red, blue)", 1, 2, 300, 40,
      "auto", "0% 0%", "no-repeat", null, "scroll", { w: 800, h: 600 },
    );
    expect(ctx.defsParts).toEqual(['<linearGradient id="t-bg0"/>']);
  });

  it("emits pseudo-box layers bottom-to-top through the injected builder", () => {
    const ctx = context();
    const builder = vi.fn((id: string) => ({ def: `<pattern id="${id}"/>` })) as BackgroundLayerBuilder;
    const svg = buildPseudoBoxBgLayers(
      ctx,
      { w: 800, h: 600 },
      { x: 1, y: 2, width: 30, height: 10, backgroundImage: "url(top), url(bottom)", borderRadius: 3 },
      builder,
    );
    expect(ctx.defsParts).toEqual(['<pattern id="t-pbgt0"/>', '<pattern id="t-pbgt1"/>']);
    expect(svg.indexOf("t-pbgt0")).toBeLessThan(svg.indexOf("t-pbgt1"));
    expect(svg).toContain('rx="3"');
  });

  it("keeps vertical text on its captured raster boundary", () => {
    const ctx = context();
    const el = element();
    el.elementRaster = { x: 3, y: 4, width: 20, height: 40, dataUri: "data:image/png;base64,AA==" };
    emitVerticalRasterText(ctx, el, "  ");
    expect(ctx.defsParts[0]).toContain('<clipPath id="t-ct0">');
    expect(ctx.svgParts[0]).toContain('href="data:image/png;base64,AA=="');
  });
});
