import { describe, expect, it } from "vitest";
import {
  blinkCanResize,
  blinkIsScrollContainer,
  blinkOverflowValueIsScrollable,
  blinkPixelSnappedSize,
  blinkPlatformResizerStrokes,
  blinkResizerCorner,
  blinkResizerIsOnLogicalLeft,
  blinkResizerThickness,
  blinkUsesCustomResizer,
} from "./resize-handle.js";

describe("Blink resizer activation (LayoutBox::CanResize, rev 7d859f271c)", () => {
  it("requires non-none resize", () => {
    expect(blinkCanResize({ resize: "none", overflowX: "auto", overflowY: "auto" })).toBe(false);
    expect(blinkCanResize({ overflowX: "auto", overflowY: "auto" })).toBe(false);
  });

  it("excludes visible and clip on either overflow axis", () => {
    expect(blinkOverflowValueIsScrollable("visible")).toBe(false);
    expect(blinkOverflowValueIsScrollable("clip")).toBe(false);
    expect(blinkCanResize({ resize: "both", overflowX: "visible", overflowY: "clip" })).toBe(false);
    expect(blinkCanResize({ resize: "both", overflowX: "clip", overflowY: "clip" })).toBe(false);
  });

  it.each(["auto", "scroll", "hidden"])("accepts %s as scroll-container overflow", (overflow) => {
    expect(blinkCanResize({ resize: "both", overflowX: overflow, overflowY: "clip" })).toBe(true);
    expect(blinkCanResize({ resize: "both", overflowX: "clip", overflowY: overflow })).toBe(true);
  });

  it("applies LayoutReplaced exclusion but preserves the iframe special case", () => {
    const replaced = {
      resize: "both",
      overflowX: "auto",
      overflowY: "auto",
      isLayoutReplaced: true,
    };
    expect(blinkIsScrollContainer(replaced)).toBe(false);
    expect(blinkCanResize(replaced)).toBe(false);
    expect(blinkCanResize({ ...replaced, isLayoutIFrame: true })).toBe(true);
    expect(blinkCanResize({ resize: "both", overflowX: "visible", overflowY: "visible", isLayoutIFrame: true })).toBe(true);
  });

  it("covers ordinary div and textarea-style auto overflow without tag shortcuts", () => {
    expect(blinkCanResize({ resize: "both", overflowX: "auto", overflowY: "auto" })).toBe(true);
    expect(blinkCanResize({ resize: "vertical", overflowX: "auto", overflowY: "auto" })).toBe(true);
  });
});

describe("Blink resizer side and thickness selection", () => {
  it("uses logical-left only for horizontal RTL", () => {
    expect(blinkResizerIsOnLogicalLeft("rtl", "horizontal-tb")).toBe(true);
    expect(blinkResizerIsOnLogicalLeft("rtl", undefined)).toBe(true);
    expect(blinkResizerIsOnLogicalLeft("ltr", "horizontal-tb")).toBe(false);
    expect(blinkResizerIsOnLogicalLeft("rtl", "vertical-rl")).toBe(false);
    expect(blinkResizerIsOnLogicalLeft("rtl", "vertical-lr")).toBe(false);
  });

  it("uses theme thickness with no bars and copies a lone bar", () => {
    expect(blinkResizerThickness({ themeThickness: 16, verticalScrollbarThickness: null, horizontalScrollbarThickness: null }))
      .toEqual({ width: 16, height: 16, hasScrollbar: false });
    expect(blinkResizerThickness({ themeThickness: 16, verticalScrollbarThickness: 13, horizontalScrollbarThickness: null }))
      .toEqual({ width: 13, height: 13, hasScrollbar: true });
    expect(blinkResizerThickness({ themeThickness: 16, verticalScrollbarThickness: null, horizontalScrollbarThickness: 11 }))
      .toEqual({ width: 11, height: 11, hasScrollbar: true });
  });

  it("uses vertical width and horizontal height when both bars exist", () => {
    expect(blinkResizerThickness({ themeThickness: 16, verticalScrollbarThickness: 14, horizontalScrollbarThickness: 10 }))
      .toEqual({ width: 14, height: 10, hasScrollbar: true });
  });
});

describe("Blink rounded resizer corner geometry", () => {
  it("snaps the box and subtracts asymmetric right/bottom borders", () => {
    expect(blinkResizerCorner({
      x: 10.4, y: 20.6, borderBoxWidth: 100.3, borderBoxHeight: 80.2,
      borderLeftWidth: 3, borderRightWidth: 7, borderBottomWidth: 5,
      cornerWidth: 16, cornerHeight: 16, logicalLeft: false,
    })).toEqual({ x: 88, y: 80, width: 16, height: 16 });
  });

  it("places horizontal RTL resizers after the left border", () => {
    expect(blinkResizerCorner({
      x: 10.4, y: 20.6, borderBoxWidth: 100.3, borderBoxHeight: 80.2,
      borderLeftWidth: 3, borderRightWidth: 7, borderBottomWidth: 5,
      cornerWidth: 14, cornerHeight: 10, logicalLeft: true,
    })).toEqual({ x: 13, y: 86, width: 14, height: 10 });
  });

  it("preserves Blink's minimum non-zero snapped layout size", () => {
    expect(blinkPixelSnappedSize(0.05, 0)).toBe(0);
    expect(blinkPixelSnappedSize(0.1, 0)).toBe(1);
    expect(blinkPixelSnappedSize(4.4, 0.6)).toBe(4);
  });
});

describe("Blink platform resizer paint", () => {
  it("matches the two dark and two light logical-right segments", () => {
    expect(blinkPlatformResizerStrokes({ x: 100, y: 200, width: 16, height: 16 }, 1, false)).toEqual({
      dark: [
        { x: 115, y: 208 }, { x: 108, y: 215 },
        { x: 115, y: 212 }, { x: 112, y: 215 },
      ],
      light: [
        { x: 115, y: 209 }, { x: 109, y: 215 },
        { x: 115, y: 213 }, { x: 113, y: 215 },
      ],
      strokeWidth: 1,
    });
  });

  it("mirrors offsets on logical-left and ceil-scales the paint", () => {
    expect(blinkPlatformResizerStrokes({ x: 10, y: 20, width: 15, height: 11 }, 1.25, true)).toEqual({
      dark: [
        { x: 12, y: 25 }, { x: 18, y: 29 },
        { x: 12, y: 28 }, { x: 14, y: 29 },
      ],
      light: [
        { x: 12, y: 27 }, { x: 16, y: 29 },
        { x: 12, y: 30 }, { x: 12, y: 29 },
      ],
      strokeWidth: 2,
    });
  });

  it("does not use devicePixelRatio as ScaleFromDIP", () => {
    const atDprOne = blinkPlatformResizerStrokes({ x: 0, y: 0, width: 16, height: 16 }, 1, false);
    const atDprTwo = blinkPlatformResizerStrokes({ x: 0, y: 0, width: 16, height: 16 }, 1, false);
    expect(atDprTwo).toEqual(atDprOne);
  });

  it("gives custom pseudo paint ownership only to real scroll containers", () => {
    expect(blinkUsesCustomResizer(true, true, true)).toBe(true);
    expect(blinkUsesCustomResizer(true, false, true)).toBe(false);
    expect(blinkUsesCustomResizer(true, true, false)).toBe(false);
    expect(blinkUsesCustomResizer(false, true, true)).toBe(false);
  });
});
