import { describe, expect, it } from "vitest";

import { paintInsetBoxShadow, type ShadowBox, type ShadowPaintCtx } from "./box-shadow-paint.js";
import type { CornerRadii } from "./borders.js";

const SHARP: CornerRadii = {
  tl: { h: 0, v: 0 },
  tr: { h: 0, v: 0 },
  br: { h: 0, v: 0 },
  bl: { h: 0, v: 0 },
  uniform: true,
};

function paint(boxShadow: string): ShadowPaintCtx {
  let n = 0;
  const ctx: ShadowPaintCtx = { svgParts: [], defsParts: [], nextClipId: (p) => `${p}${n++}` };
  const box: ShadowBox = {
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    styles: {
      boxShadow,
      borderTopWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
    },
  };
  paintInsetBoxShadow(ctx, box, SHARP, "");
  return ctx;
}

describe("paintInsetBoxShadow", () => {
  // Blink's PaintInsetBoxShadow has no blur/spread early-out
  // (core/paint/box_painter_base.cc:526-571, Chromium 7d859f27): an
  // offset-only inset paints the padding box minus the shifted hole.
  it("paints an offset-only inset shadow (zero blur, zero spread) as an unblurred donut", () => {
    const ctx = paint("rgba(0, 0, 0, 0.3) 0px -3px 0px 0px inset");
    expect(ctx.svgParts).toHaveLength(1);
    const part = ctx.svgParts[0];
    expect(part).toContain('fill-rule="evenodd"');
    expect(part).not.toContain("filter=");
    // The hole is the padding box shifted up by 3px: it starts at y = 17.
    expect(part).toMatch(/M\s*10[ ,]17\b/);
    expect(ctx.defsParts.some((d) => d.includes("<clipPath"))).toBe(true);
    expect(ctx.defsParts.some((d) => d.includes("<filter"))).toBe(false);
  });

  it("paints a horizontal offset-only inset shadow", () => {
    const ctx = paint("rgb(255, 0, 0) 4px 0px 0px 0px inset");
    expect(ctx.svgParts).toHaveLength(1);
    expect(ctx.svgParts[0]).toMatch(/M\s*14[ ,]20\b/);
  });

  it("paints nothing for an all-zero inset shadow, whose hole is the whole clip", () => {
    const ctx = paint("rgb(0, 0, 0) 0px 0px 0px 0px inset");
    expect(ctx.svgParts).toHaveLength(0);
    expect(ctx.defsParts).toHaveLength(0);
  });

  it("ignores outer shadows", () => {
    const ctx = paint("rgb(0, 0, 0) 0px -3px 0px 0px");
    expect(ctx.svgParts).toHaveLength(0);
  });
});
