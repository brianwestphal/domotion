import { describe, expect, it } from "vitest";

import {
  deviceRoundedEdge,
  deviceRoundedRect,
  insetShadowCastingRect,
  adjustRectForSideClipping,
  sideClipKeepRect,
  regionBandPieces,
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

  // SVG has no unequal-radius rrect; a pixel-aligned rect under a CSS inset()
  // clip is Blink's SkRRect rasterized as an AA clip (basic_shapes.cc:349-379).
  it("draws unequal rounded corners as a rect under an inset() SkRRect clip", () => {
    const unequal: CornerRadii = {
      tl: { h: 2, v: 2 },
      tr: { h: 0, v: 0 },
      br: { h: 4, v: 4 },
      bl: { h: 8, v: 8 },
      uniform: false,
    };
    const ctx = paintNormal(box(snapHalf), unequal);
    expect(ctx.svgParts[0]).toBe(
      '<g mask="url(#shcut0)"><rect x="24" y="20" width="22" height="22" fill="rgb(255,0,0)" style="clip-path:inset(1px 1px 1px 1px round 2px 0px 4px 8px / 2px 0px 4px 8px) fill-box" /></g>',
    );
    expect(ctx.defsParts.join("")).toContain(
      '<rect x="20" y="20" width="22" height="22" fill="black" style="clip-path:inset(1px 1px 1px 1px round 2px 0px 4px 8px / 2px 0px 4px 8px) fill-box" />',
    );
    expect(ctx.defsParts.join("")).not.toContain("shaa");
  });

  it("leaves sharp and blurred shadows on the unclipped raster route", () => {
    expect(paintNormal(box(snapHalf), SHARP).defsParts.join("")).not.toContain("shaa");
    const blurred = paintNormal(
      { ...box(snapHalf), styles: { ...box().styles, boxShadow: "rgb(255, 0, 0) 4px 0px 3px 0px" } },
      ROUND5,
    );
    expect(blurred.svgParts[0]).not.toContain("shaa");
  });

  // Blink blurs the shadow's coverage mask, merges the antialiased clip-out's
  // coverage into it (SkAAClipBlitter::blitMask, SkAAClip.cpp:1806 at Skia
  // 62efacd3), then blits the color (DM-RRWR8E): blur stage, knockout mask,
  // blit stage, in that order, with the contour on the AA-clip route.
  it("stages a blurred rounded shadow as coverage blur, knockout, then color blit", () => {
    const ctx = paintNormal(
      { ...box(), x: 20, y: 20, styles: { ...box().styles, boxShadow: "rgba(0, 0, 0, 0.5) 4px 4px 8px 0px" } },
      ROUND5,
    );
    const defs = ctx.defsParts.join("");
    expect(ctx.svgParts[0]).toMatch(
      /^<g filter="url\(#(sh\d+)\)"><g mask="url\(#shcut\d+\)"><rect x="24" y="24" width="20" height="20" rx="5" fill="black" filter="url\(#(sh\d+)\)" \/><\/g><\/g>$/,
    );
    const [, blit, blur] = /^<g filter="url\(#(sh\d+)\)">.*filter="url\(#(sh\d+)\)"/.exec(ctx.svgParts[0])!;
    // σ = 4 → box window 8 → PlanGauss border 11: the region starts there.
    expect(defs).toContain(
      `<filter id="${blur}" filterUnits="userSpaceOnUse" x="13" y="13" width="44" height="44" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="4"/></filter>`,
    );
    expect(defs).toMatch(new RegExp(`<filter id="${blit}"[^>]*><feComponentTransfer>.*<feFuncA type="discrete"`));
    expect(defs).toMatch(/<mask id="shcut\d+"[^>]*>.*clip-path="url\(#shaa\d+\)"/);
  });

  it("keeps one blur-and-blit filter on a sharp blurred shadow", () => {
    const ctx = paintNormal(
      { ...box(), x: 20, y: 20, styles: { ...box().styles, boxShadow: "rgb(255, 0, 0) 4px 4px 8px 0px" } },
      SHARP,
    );
    expect(ctx.svgParts).toHaveLength(1);
    const defs = ctx.defsParts.join("");
    expect(defs).toMatch(
      /<filter id="sh\d+"[^>]*><feGaussianBlur in="SourceAlpha" stdDeviation="4"\/><feComponentTransfer><feFuncR type="linear" slope="0" intercept="1.0020"\/><feFuncG [^>]*intercept="0.0020"\/><feFuncB [^>]*intercept="0.0020"\/><\/feComponentTransfer><\/filter>/,
    );
    expect(defs).not.toContain("feFuncA");
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

// A sharp box's shadow knockout is GraphicsContext::ClipOut(RectF), a
// non-antialiased difference clip (graphics_context.h:384-386, Chromium
// 7d859f27): SkRasterClip rounds its device rect (Skia 62efacd3
// SkRasterClip.cpp:170-171) and SkScan::AntiFillRect fills the shadow rect once
// per clip-region rectangle (SkScan_Antihair.cpp:784-808).
describe("non-antialiased sharp shadow clips", () => {
  it("rounds a user-space edge to the device pixel edge, half up", () => {
    expect(deviceRoundedEdge(21, 0.5)).toBe(21.5);
    expect(deviceRoundedEdge(20.75, 0.25)).toBe(20.75);
    expect(deviceRoundedEdge(20.5, 0)).toBe(21);
    expect(deviceRoundedEdge(20.49, 0)).toBe(20);
    expect(deviceRoundedEdge(-0.5, 0)).toBe(0);
    expect(deviceRoundedRect({ left: 21, top: 21, right: 41, bottom: 41 }, { x: 0.5, y: 0.25 })).toEqual({
      left: 21.5,
      top: 20.75,
      right: 41.5,
      bottom: 40.75,
    });
  });

  it("splits a rect into the clip region's bands", () => {
    const hole = { left: 20, top: 20, right: 40, bottom: 40 };
    // Overlapping the hole on the right: only the right span survives.
    expect(regionBandPieces({ left: 24, top: 20, right: 44, bottom: 40 }, hole)).toEqual([
      { left: 40, top: 20, right: 44, bottom: 40 },
    ]);
    // A half-pixel row below the hole becomes its own one-scanline piece.
    expect(regionBandPieces({ left: 50.5, top: 20.5, right: 70.5, bottom: 40.5 }, hole)).toEqual([
      { left: 50.5, top: 20.5, right: 70.5, bottom: 40 },
      { left: 50.5, top: 40, right: 70.5, bottom: 40.5 },
    ]);
    // Spread around the whole hole: all four pieces.
    expect(regionBandPieces({ left: 18, top: 18, right: 42, bottom: 42 }, hole)).toEqual([
      { left: 18, top: 18, right: 42, bottom: 20 },
      { left: 18, top: 20, right: 20, bottom: 40 },
      { left: 40, top: 20, right: 42, bottom: 40 },
      { left: 18, top: 40, right: 42, bottom: 42 },
    ]);
    // Inside the hole: nothing. An empty hole leaves the shape whole.
    expect(regionBandPieces({ left: 22, top: 22, right: 30, bottom: 30 }, hole)).toEqual([]);
    const shape = { left: 1, top: 2, right: 3, bottom: 4 };
    expect(regionBandPieces(shape, { left: 5, top: 5, right: 5, bottom: 9 })).toEqual([shape]);
  });

  it("transcribes AreaCastingShadowInHole for the inset fill", () => {
    const bounds = { left: 20, top: 20, right: 40, bottom: 40 };
    expect(insetShadowCastingRect(bounds, 0, 0, 0, 3)).toEqual(bounds);
    expect(insetShadowCastingRect(bounds, 3, -2, 0, 0)).toEqual({ left: 20, top: 18, right: 43, bottom: 40 });
    expect(insetShadowCastingRect(bounds, 3, 2, 0, -1)).toEqual({ left: 19, top: 19, right: 44, bottom: 43 });
    expect(insetShadowCastingRect(bounds, 0, 0, 4, 0)).toEqual({ left: 16, top: 16, right: 44, bottom: 44 });
  });

  const sharpBox = (boxShadow: string, backgroundColor: string, device?: { x: number; y: number }): ShadowBox => ({
    x: 21,
    y: 21,
    width: 20,
    height: 20,
    borderPaintSnap: {
      source: "blink-pixel-snapped-border-v1",
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 20,
      height: 20,
      ...(device == null ? {} : { device }),
    },
    styles: {
      boxShadow,
      backgroundColor,
      borderTopWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
    },
  });
  const run = (el: ShadowBox, inset = false): ShadowPaintCtx => {
    let n = 0;
    const ctx: ShadowPaintCtx = { svgParts: [], defsParts: [], nextClipId: (p) => `${p}${n++}` };
    if (inset) paintInsetBoxShadow(ctx, el, SHARP, "");
    else paintBoxShadow(ctx, el, SHARP, "");
    return ctx;
  };

  it("paints a transparent box's sharp shadow as unclipped region pieces around the device-rounded hole", () => {
    const ctx = run(sharpBox("rgb(255, 0, 0) 4px 0px 0px 0px", "rgba(0, 0, 0, 0)", { x: 0.5, y: 0.5 }));
    expect(ctx.defsParts).toEqual([]);
    expect(ctx.svgParts).toEqual([
      '<rect x="25" y="21" width="20" height="0.5" fill="rgb(255,0,0)"/>',
      '<rect x="41.5" y="21.5" width="3.5" height="19.5" fill="rgb(255,0,0)"/>',
    ]);
  });

  it("clips an opaque box's sharp shadow out of the contour inset by one pixel", () => {
    const ctx = run(sharpBox("rgb(255, 0, 0) 4px 0px 0px 0px", "rgb(0, 0, 255)", { x: 0.5, y: 0.5 }));
    // Hole 22..40 in user space → device 22.5..40.5 → rounded 23..41.
    expect(ctx.svgParts).toEqual([
      '<rect x="25" y="21" width="20" height="1.5" fill="rgb(255,0,0)"/>',
      '<rect x="40.5" y="22.5" width="4.5" height="18" fill="rgb(255,0,0)"/>',
      '<rect x="25" y="40.5" width="20" height="0.5" fill="rgb(255,0,0)"/>',
    ]);
    const tiny = {
      ...sharpBox("rgb(255, 0, 0) 4px 0px 0px 0px", "rgb(0, 0, 255)", { x: 0, y: 0 }),
      width: 2,
      height: 2,
    };
    tiny.borderPaintSnap = { ...tiny.borderPaintSnap!, width: 2, height: 2 };
    expect(run(tiny).svgParts).toEqual(['<rect x="25" y="21" width="2" height="2" fill="rgb(255,0,0)"/>']);
  });

  it("snaps a blurred transparent shadow's knockout hole to device pixels", () => {
    const ctx = run(sharpBox("rgb(255, 0, 0) 4px 0px 3px 0px", "rgba(0, 0, 0, 0)", { x: 0.5, y: 0.5 }));
    expect(ctx.defsParts.join("")).toContain("M21.5 21.5H41.5V41.5H21.5Z");
    expect(ctx.svgParts[0]).toMatch(/fill="black" filter="url\(#sh\d+\)"/);
  });

  it("keeps the antialiased producer without a device record (negative control)", () => {
    const ctx = run(sharpBox("rgb(255, 0, 0) 4px 0px 0px 0px", "rgba(0, 0, 0, 0)"));
    expect(ctx.defsParts[0]).toContain('clip-rule="evenodd"');
    expect(ctx.svgParts).toHaveLength(1);
    const opaqueBlur = run(sharpBox("rgb(255, 0, 0) 4px 0px 3px 0px", "rgb(0, 0, 255)", { x: 0.5, y: 0.5 }));
    expect(opaqueBlur.defsParts.join("")).not.toContain("<clipPath");
  });

  it("snaps a sharp inset clip to device pixels and fills the casting rect around the hole", () => {
    const ctx = run(sharpBox("rgb(255, 0, 0) 0px 0px 0px 3px inset", "rgba(0, 0, 0, 0)", { x: 0.5, y: 0.5 }), true);
    expect(ctx.defsParts).toEqual(['<clipPath id="ishc0"><rect x="21.5" y="21.5" width="20" height="20"/></clipPath>']);
    expect(ctx.svgParts[0]).toContain('d="M21,21 L41,21 L41,41 L21,41 L21,21 Z M24,24 L38,24');
    const unsnapped = run(sharpBox("rgb(255, 0, 0) 0px 0px 0px 3px inset", "rgba(0, 0, 0, 0)"), true);
    expect(unsnapped.defsParts[0]).toContain('<rect x="21" y="21" width="20" height="20" rx="0"');
  });
});

// A fragment that excludes sides: ClipToSides keeps the border rect outset by
// ShadowData::RectOutsets on included sides only, and AdjustRectForSideClipping
// stretches the fill rect past the excluded ones (box_painter_base.cc:200-250,
// shadow_data.cc:32-43, Chromium 7d859f27).
describe("fragment side clipping", () => {
  const layer = (x: number, y: number, blur: number, spread: number) => ({
    x,
    y,
    blur,
    spread,
    color: "red",
    inset: false,
  });
  const rect = { left: 10, top: 20, right: 50, bottom: 32 };
  const openRight = { top: true, right: false, bottom: true, left: true };
  const openLeft = { top: true, right: true, bottom: true, left: false };

  it("stretches the fill rect past excluded sides by the offset and blur", () => {
    expect(adjustRectForSideClipping(rect, layer(4, 4, 0, 0), openRight)).toEqual(rect);
    expect(adjustRectForSideClipping(rect, layer(-3, 2, 2, 0), openRight)).toEqual({ ...rect, right: 55 });
    expect(adjustRectForSideClipping(rect, layer(4, 4, 2, 0), openLeft)).toEqual({ ...rect, left: 4 });
  });

  it("keeps the border outset by the shadow's extent on included sides only", () => {
    expect(sideClipKeepRect(rect, layer(4, 4, 0, 0), openRight)).toEqual({ left: 14, top: 24, right: 50, bottom: 36 });
    // ceil(3σ) with σ = blur / 2: blur 3 → ceil(4.5) = 5, plus spread 1.
    expect(sideClipKeepRect(rect, layer(0, 0, 3, 1), openLeft)).toEqual({ left: 10, top: 14, right: 56, bottom: 38 });
  });

  it("wraps a fragment's shadow in the side clip and leaves a whole box alone", () => {
    let n = 0;
    const ctx: ShadowPaintCtx = { svgParts: [], defsParts: [], nextClipId: (p) => `${p}${n++}` };
    const box: ShadowBox = {
      x: 10,
      y: 20,
      width: 40,
      height: 12,
      styles: {
        boxShadow: "rgb(255, 0, 0) 4px 4px 0px 0px",
        backgroundColor: "rgb(0, 0, 255)",
        borderTopWidth: "0px",
        borderRightWidth: "0px",
        borderBottomWidth: "0px",
        borderLeftWidth: "0px",
      },
    };
    paintBoxShadow(ctx, box, SHARP, "", { sides: openRight, device: { x: 0, y: 0 } });
    expect(ctx.defsParts.at(-1)).toBe(
      '<clipPath id="shside0" clipPathUnits="userSpaceOnUse"><rect x="14" y="24" width="36" height="12"/></clipPath>',
    );
    expect(ctx.svgParts[0]).toBe('<g clip-path="url(#shside0)">');
    expect(ctx.svgParts.at(-1)).toBe("</g>");
    const whole: ShadowPaintCtx = { svgParts: [], defsParts: [], nextClipId: (p) => p };
    paintBoxShadow(whole, box, SHARP, "", {
      sides: { top: true, right: true, bottom: true, left: true },
      device: { x: 0, y: 0 },
    });
    expect(whole.defsParts.join("")).not.toContain("shside");
  });

  it("drops an inset fragment's excluded borders and opens its hole past them", () => {
    let n = 0;
    const ctx: ShadowPaintCtx = { svgParts: [], defsParts: [], nextClipId: (p) => `${p}${n++}` };
    const box: ShadowBox = {
      x: 10,
      y: 20,
      width: 40,
      height: 12,
      styles: {
        boxShadow: "rgb(255, 0, 0) 2px 2px 0px 0px inset",
        borderTopWidth: "1px",
        borderRightWidth: "1px",
        borderBottomWidth: "1px",
        borderLeftWidth: "1px",
      },
    };
    paintInsetBoxShadow(ctx, box, SHARP, "", { sides: openRight, device: { x: 0, y: 0 } });
    // The clip runs to the open right edge (no right border there).
    expect(ctx.defsParts.at(-1)).toContain('<rect x="11" y="21" width="39" height="10"/>');
    // The hole starts 2px in and runs past the open right side.
    expect(ctx.svgParts[0]).toContain("M13,23 L52,23");
  });
});
