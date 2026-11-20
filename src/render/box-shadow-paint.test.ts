import { describe, expect, it } from "vitest";

import {
  paintBoxShadow,
  paintInsetBoxShadow,
  shadowBorderContour,
  shadowInnerBorderContour,
  normalShadowCorners,
  type ShadowBox,
  type ShadowPaintCtx,
} from "./box-shadow-paint.js";
import { constrainCornerRadiiToRect, type CornerRadii } from "./borders.js";

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

describe("normal box-shadow pixel-snapped border contour", () => {
  const ROUND5: CornerRadii = {
    tl: { h: 5, v: 5 },
    tr: { h: 5, v: 5 },
    br: { h: 5, v: 5 },
    bl: { h: 5, v: 5 },
    uniform: true,
  };
  type Deltas = Omit<NonNullable<ShadowBox["borderPaintSnap"]>, "width" | "height">;
  const box = (snap?: Deltas, width = 20, height = 20): ShadowBox => ({
    x: 20.5,
    y: 20.5,
    width,
    height,
    borderPaintSnap: snap == null ? undefined : { ...snap, width, height },
    styles: {
      boxShadow: "rgb(255, 0, 0) 4px 0px 0px 0px",
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderTopWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
    },
  });
  const snapHalf = { source: "blink-pixel-snapped-border-v1", left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 } as const;
  const paintNormal = (el: ShadowBox, corners: CornerRadii): ShadowPaintCtx => {
    let n = 0;
    const ctx: ShadowPaintCtx = { svgParts: [], defsParts: [], nextClipId: (p) => `${p}${n++}` };
    paintBoxShadow(ctx, el, corners, "");
    return ctx;
  };

  // PaintNormalBoxShadow derives both the shadow rect and the excluded
  // contour from PixelSnappedContouredBorder (box_painter_base.cc:294-338,
  // Chromium 7d859f27); the captured DOM rect itself stays fractional.
  it("paints the shadow and its knockout from the authenticated snapped rect", () => {
    const ctx = paintNormal(box(snapHalf), SHARP);
    expect(ctx.svgParts[0]).toContain('x="25" y="21" width="20" height="20"');
    expect(ctx.defsParts[0]).toContain("M21,21 L41,21 L41,41 L21,41");
  });

  it("snaps the rounded knockout mask contour too", () => {
    const ctx = paintNormal(box(snapHalf), ROUND5);
    expect(ctx.svgParts[0]).toContain('x="25" y="21"');
    expect(ctx.defsParts.join("")).toContain('x="21" y="21" width="20" height="20" rx="5" fill="black"');
  });

  // Blink's rounded clip-out is antialiased, which sends Skia's CPU path fill
  // through the run-based accumulator (SkScan_AntiPath.cpp:145-153 at Skia
  // 62efacd3); both the knockout contour and the shape are drawn under an AA
  // clip whose rounded edge sits 2px outside them.
  it("draws a rounded zero-blur shadow and its knockout under AA clips", () => {
    const ctx = paintNormal(box(snapHalf), ROUND5);
    expect(ctx.defsParts[0]).toBe(
      '<clipPath id="shaa1" clipPathUnits="userSpaceOnUse"><rect x="19" y="19" width="24" height="24" rx="1"/></clipPath>',
    );
    expect(ctx.defsParts[2]).toBe(
      '<clipPath id="shaa2" clipPathUnits="userSpaceOnUse"><rect x="23" y="19" width="24" height="24" rx="1"/></clipPath>',
    );
    expect(ctx.svgParts[0]).toMatch(/^<g mask="url\(#shcut0\)"><rect [^>]*clip-path="url\(#shaa2\)" \/><\/g>$/);
  });

  it("leaves sharp and blurred shadows on the unclipped raster route", () => {
    expect(paintNormal(box(snapHalf), SHARP).defsParts.join("")).not.toContain("shaa");
    const blurred = paintNormal(
      { ...box(snapHalf), styles: { ...box().styles, boxShadow: "rgb(255, 0, 0) 4px 0px 3px 0px" } },
      ROUND5,
    );
    expect(blurred.svgParts[0]).not.toContain("shaa");
  });

  // On an opaque background Blink clips out the contour inset by 1px
  // (box_painter_base.cc:185-187) and skips an empty one.
  it("clips an opaque rounded box's shadow to the contour inset by one pixel", () => {
    const opaque = { ...box(snapHalf), styles: { ...box().styles, backgroundColor: "rgb(0, 0, 255)" } };
    const ctx = paintNormal(opaque, ROUND5);
    expect(ctx.defsParts.join("")).toContain('x="22" y="22" width="18" height="18" rx="4" fill="black"');
    const tiny = { ...opaque, width: 2, height: 2, borderPaintSnap: undefined };
    expect(paintNormal(tiny, ROUND5).defsParts.join("")).not.toContain("<mask");
  });

  it("ignores a record describing a box of another size (a derived box)", () => {
    const ctx = paintNormal({ ...box(snapHalf), width: 18 }, SHARP);
    expect(ctx.svgParts[0]).toContain('x="24.5" y="20.5"');
  });

  it("keeps the captured geometry when the paint space is not authenticated", () => {
    const ctx = paintNormal(box(undefined), SHARP);
    expect(ctx.svgParts[0]).toContain('x="24.5" y="20.5"');
    expect(ctx.defsParts[0]).toContain("M20.5,20.5");
  });

  it("returns the source corners unchanged when they fit the snapped rect", () => {
    expect(shadowBorderContour(box(snapHalf), ROUND5)).toEqual({
      x: 21,
      y: 21,
      width: 20,
      height: 20,
      corners: ROUND5,
    });
  });

  it("keeps a nonzero snapped size of at least one pixel (SnapSizeToPixel)", () => {
    // 20.125 + 0.25 rounds both edges to 20, but a 0.25px box keeps 1px.
    const tiny = { source: "blink-pixel-snapped-border-v1", left: -0.125, top: 0, right: -0.375, bottom: 0 } as const;
    const contour = shadowBorderContour({ ...box(tiny, 0.25), x: 20.125 }, SHARP);
    expect(contour.x).toBe(20);
    expect(contour.width).toBe(1);
    // An empty box stays empty.
    const empty = { source: "blink-pixel-snapped-border-v1", left: -0.125, top: 0, right: -0.125, bottom: 0 } as const;
    expect(shadowBorderContour({ ...box(empty, 0), x: 20.125 }, SHARP).width).toBe(0);
  });

  // PixelSnappedContouredInnerBorder (contoured_border_geometry.cc:207-255,
  // Chromium 7d859f27): the inset rect is the snapped outer edges moved by the
  // truncated integer border widths, allowing zero, with the outer radii
  // inset by the same widths.
  it("derives the inset clip from the snapped outer edges and integer borders", () => {
    const bordered: ShadowBox = {
      ...box(snapHalf, 24, 24),
      styles: {
        ...box().styles,
        borderTopWidth: "2px",
        borderRightWidth: "2px",
        borderBottomWidth: "2px",
        borderLeftWidth: "2px",
      },
    };
    const contour = shadowInnerBorderContour(bordered, ROUND5);
    expect(contour).toMatchObject({ x: 23, y: 23, width: 20, height: 20 });
    expect(contour.corners.tl).toEqual({ h: 3, v: 3 });
    const ctx: ShadowPaintCtx = { svgParts: [], defsParts: [], nextClipId: (p) => p };
    paintInsetBoxShadow(
      ctx,
      { ...bordered, styles: { ...bordered.styles, boxShadow: "rgb(255, 0, 0) 0px 0px 0px 3px inset" } },
      ROUND5,
      "",
    );
    expect(ctx.defsParts.join("")).toContain('x="23" y="23" width="20" height="20"');
  });

  it("collapses the inset contour to zero size when borders consume the box", () => {
    const thick: ShadowBox = {
      ...box(snapHalf),
      styles: { ...box().styles, borderLeftWidth: "10px", borderRightWidth: "10.9px" },
    };
    expect(shadowInnerBorderContour(thick, SHARP).width).toBe(0);
    expect(shadowInnerBorderContour(thick, SHARP).height).toBe(20);
  });

  it("keeps the captured inset geometry without an authenticated snap", () => {
    expect(shadowInnerBorderContour(box(undefined), SHARP)).toMatchObject({ x: 20.5, y: 20.5, width: 20, height: 20 });
  });

  // ApplySpreadToShadowShape → OutsetWithCornerCorrectionUsingCoverageFactor
  // (float_rounded_rect.cc:168-264, Chromium 7d859f27) then ConstrainRadii.
  describe("normalShadowCorners", () => {
    const uniform = (radius: number): CornerRadii => ({
      tl: { h: radius, v: radius },
      tr: { h: radius, v: radius },
      br: { h: radius, v: radius },
      bl: { h: radius, v: radius },
      uniform: true,
    });
    it("leaves the radii untouched for a zero spread", () => {
      const corners = uniform(30);
      expect(normalShadowCorners(corners, 0, 20, 20, 20, 20)).toBe(corners);
    });
    it("grows a radius larger than the spread linearly", () => {
      expect(normalShadowCorners(uniform(5), 2, 20, 20, 24, 24).tl.h).toBe(7);
    });
    it("grows a radius smaller than the spread by the coverage-corrected amount", () => {
      // coverage 0.2, ratio 0.5: 2 + 4 * (1 - 0.5^3 * (1 - 0.2^3)) = 5.504
      expect(normalShadowCorners(uniform(2), 4, 20, 20, 28, 28).tl.h).toBeCloseTo(5.504, 10);
    });
    it("keeps a sharp corner sharp and shrinks radii for a negative spread", () => {
      expect(normalShadowCorners(SHARP, 4, 20, 20, 28, 28).tl).toEqual({ h: 0, v: 0 });
      expect(normalShadowCorners(uniform(1), -2, 20, 20, 16, 16).tl).toEqual({ h: 0, v: 0 });
      expect(normalShadowCorners(uniform(5), -0.125, 20, 20, 19.75, 19.75).tl.h).toBe(4.875);
    });
    it("constrains the corrected radii to the spread rect", () => {
      expect(normalShadowCorners(uniform(12), 6, 20, 20, 32, 32).tl.h).toBeCloseTo(16, 10);
    });
    it("emits the corrected radius with three decimals", () => {
      const ctx: ShadowPaintCtx = { svgParts: [], defsParts: [], nextClipId: (p) => p };
      paintBoxShadow(
        ctx,
        { ...box(undefined), x: 20, y: 20, styles: { ...box().styles, boxShadow: "rgb(255, 0, 0) 0px 0px 0px 4px" } },
        uniform(2),
        "",
      );
      expect(ctx.svgParts[0]).toContain('rx="5.504"');
    });
  });

  it("constrains radii against the snapped rect (FloatRoundedRect::ConstrainRadii)", () => {
    const big: CornerRadii = { ...ROUND5, tl: { h: 15, v: 15 }, tr: { h: 15, v: 15 } };
    const shrink = { source: "blink-pixel-snapped-border-v1", left: 0.5, top: 0.5, right: -0.5, bottom: 0.5 } as const;
    const contour = shadowBorderContour(box(shrink, 30), big);
    expect(contour.width).toBe(29);
    expect(contour.corners.tl.h).toBeCloseTo(14.5, 10);
    expect(contour.corners.br.h).toBeCloseTo((5 * 29) / 30, 10);
    expect(constrainCornerRadiiToRect(ROUND5, 20, 20)).toBe(ROUND5);
  });
});
