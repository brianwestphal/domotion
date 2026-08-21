import { describe, expect, it } from "vitest";
import type { CornerRadii } from "./borders.js";
import {
  capturedBoxRespectsCssOverflow,
  isOverflowReplacedElement,
  isOverflowRespectingReplacedElement,
  overflowClipMarginGeometry,
  overflowClipMarginOuterExtension,
  parseOverflowClipMargin,
  shouldApplyOverflowClipMargin,
  type ParsedOverflowClipMargin,
} from "./overflow-clip.js";

const corners = (
  tl: [number, number],
  tr: [number, number],
  br: [number, number],
  bl: [number, number],
): CornerRadii => ({
  tl: { h: tl[0], v: tl[1] },
  tr: { h: tr[0], v: tr[1] },
  br: { h: br[0], v: br[1] },
  bl: { h: bl[0], v: bl[1] },
  uniform: tl[0] === tl[1] && tl[0] === tr[0] && tl[0] === tr[1]
    && tl[0] === br[0] && tl[0] === br[1] && tl[0] === bl[0] && tl[0] === bl[1],
});

const parsed = (referenceBox: ParsedOverflowClipMargin["referenceBox"], margin: number): ParsedOverflowClipMargin => ({
  referenceBox,
  margin,
  hasEffect: referenceBox !== "padding-box" || margin !== 0,
});

describe("overflow-clip-margin parsing and activation (DM-2419)", () => {
  it("preserves reference-box-only zero values and rejects invalid negative lengths", () => {
    expect(parseOverflowClipMargin("0px")).toEqual({ referenceBox: "padding-box", margin: 0, hasEffect: false });
    expect(parseOverflowClipMargin("12.5px")).toEqual({ referenceBox: "padding-box", margin: 12.5, hasEffect: true });
    expect(parseOverflowClipMargin("content-box")).toEqual({ referenceBox: "content-box", margin: 0, hasEffect: true });
    expect(parseOverflowClipMargin("border-box 0px")).toEqual({ referenceBox: "border-box", margin: 0, hasEffect: true });
    expect(parseOverflowClipMargin("4px content-box")).toEqual({ referenceBox: "content-box", margin: 4, hasEffect: true });
    expect(parseOverflowClipMargin("0")).toEqual({ referenceBox: "padding-box", margin: 0, hasEffect: false });
    expect(parseOverflowClipMargin("4")).toBeNull();
    expect(parseOverflowClipMargin("content-box border-box 4px")).toBeNull();
    expect(parseOverflowClipMargin("-1px")).toBeNull();
    expect(parseOverflowClipMargin("calc(2px)")).toBeNull();
  });

  it("requires both clip axes for ordinary boxes and keeps scroll modes inactive", () => {
    const value = parsed("padding-box", 8);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "clip", overflowY: "clip" })).toBe(true);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "clip", overflowY: "visible" })).toBe(false);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "visible", overflowY: "clip" })).toBe(false);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "hidden", overflowY: "hidden" })).toBe(false);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "auto", overflowY: "auto" })).toBe(false);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "scroll", overflowY: "scroll" })).toBe(false);
  });

  it("applies through paint containment only when the box is not a scroll container", () => {
    const value = parsed("border-box", 0);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "visible", overflowY: "visible", contain: "paint" })).toBe(true);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "visible", overflowY: "visible", contain: "content" })).toBe(true);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "hidden", overflowY: "hidden", contain: "paint" })).toBe(false);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "clip", overflowY: "clip", respectsCssOverflow: false })).toBe(false);
  });

  it("uses non-visible used overflow on both axes for replaced elements", () => {
    const value = parsed("content-box", 0);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "hidden", overflowY: "auto", isReplaced: true })).toBe(true);
    expect(shouldApplyOverflowClipMargin(value, { overflowX: "clip", overflowY: "visible", isReplaced: true })).toBe(false);
    expect(isOverflowRespectingReplacedElement("img")).toBe(true);
    expect(isOverflowRespectingReplacedElement("svg")).toBe(true);
    expect(isOverflowRespectingReplacedElement("input")).toBe(false);
    expect(isOverflowReplacedElement("input", "image")).toBe(true);
    expect(capturedBoxRespectsCssOverflow("fieldset", "block")).toBe(false);
    expect(capturedBoxRespectsCssOverflow("span", "inline")).toBe(false);
    expect(capturedBoxRespectsCssOverflow("body", "block", "visible", "visible")).toBe(false);
    expect(capturedBoxRespectsCssOverflow("body", "block", "hidden", "hidden")).toBe(true);
    expect(isOverflowRespectingReplacedElement("div")).toBe(false);
  });
});

describe("Blink rounded overflow-clip-margin contour geometry (DM-2419)", () => {
  const zeroSides = { top: 0, right: 0, bottom: 0, left: 0 };

  it("matches Chromium's coverage-factor oracle for square and elliptical corners", () => {
    // Directly mirrors float_rounded_rect_test.cc's 200x200 / 32px outset row.
    const actual = overflowClipMarginGeometry(
      { x: 0, y: 0, width: 200, height: 200 },
      zeroSides,
      zeroSides,
      corners([4, 8], [12, 16], [64, 0], [0, 32]),
      parsed("padding-box", 32),
    );
    expect(actual).toMatchObject({ x: -32, y: -32, width: 264, height: 264 });
    expect(actual.corners.tl.h).toBeCloseTo(14.5639, 3);
    expect(actual.corners.tl.v).toBeCloseTo(26.5009, 3);
    expect(actual.corners.tr.h).toBeCloseTo(36.201, 3);
    expect(actual.corners.tr.v).toBeCloseTo(44.0069, 3);
    expect(actual.corners.bl).toEqual({ h: 0, v: 64 });
    expect(actual.corners.br).toEqual({ h: 96, v: 0 });

    const sharp = overflowClipMarginGeometry(
      { x: 0, y: 0, width: 40, height: 20 }, zeroSides, zeroSides,
      corners([0, 0], [0, 0], [0, 0], [0, 0]), parsed("padding-box", 30),
    );
    expect(sharp.corners).toMatchObject({
      tl: { h: 0, v: 0 }, tr: { h: 0, v: 0 }, br: { h: 0, v: 0 }, bl: { h: 0, v: 0 },
    });
  });

  it("uses the nonuniform source edge in the coverage calculation", () => {
    // Chromium's companion 200x100 oracle catches implementations that use
    // width for both coverage terms or adjust the two axes independently.
    const actual = overflowClipMarginGeometry(
      { x: 0, y: 0, width: 200, height: 100 }, zeroSides, zeroSides,
      corners([50, 8], [12, 56], [64, 0], [0, 32]), parsed("padding-box", 32),
    );
    expect(actual.corners.tl.h).toBeCloseTo(82, 3);
    expect(actual.corners.tl.v).toBeCloseTo(26.5553, 3);
    expect(actual.corners.tr.h).toBeCloseTo(36.201, 3);
    expect(actual.corners.tr.v).toBeCloseTo(88, 3);
  });

  it("snaps the inner-border edges, then applies asymmetric border-box outsets", () => {
    const borderBox = { x: 10.4, y: 20.6, width: 100.3, height: 60.4 };
    const borders = { top: 2.25, right: 3.5, bottom: 4.25, left: 1.25 };
    const padding = { top: 9, right: 11, bottom: 13, left: 7 };
    const value = parsed("border-box", 5);
    const actual = overflowClipMarginGeometry(
      borderBox, borders, padding,
      corners([8, 10], [20, 6], [0, 0], [30, 16]), value,
    );
    // Snapped inner rect = (12,23)..(107,77), then TLBR outsets are
    // border widths + 5 = 7.25 / 8.5 / 9.25 / 6.25.
    expect(actual).toMatchObject({
      x: 5.75, y: 15.75, width: 109.75, height: 70.5,
      outsets: { top: 7.25, right: 8.5, bottom: 9.25, left: 6.25 },
    });
    const extension = overflowClipMarginOuterExtension(borderBox, actual);
    expect(extension.top).toBeCloseTo(4.85, 10);
    expect(extension.right).toBeCloseTo(4.8, 10);
    expect(extension.bottom).toBeCloseTo(5.25, 10);
    expect(extension.left).toBeCloseTo(4.65, 10);
  });

  it("contracts to the content reference box with negative per-side outsets", () => {
    const actual = overflowClipMarginGeometry(
      { x: 10.4, y: 20.6, width: 100.3, height: 60.4 },
      { top: 2.25, right: 3.5, bottom: 4.25, left: 1.25 },
      { top: 9, right: 11, bottom: 13, left: 7 },
      corners([8, 10], [20, 6], [0, 0], [30, 16]),
      parsed("content-box", 0),
    );
    expect(actual).toMatchObject({
      x: 19, y: 32, width: 77, height: 32,
      outsets: { top: -9, right: -11, bottom: -13, left: -7 },
      corners: {
        tl: { h: 0, v: 0 },
        tr: { h: 5.5, v: 0 },
        br: { h: 0, v: 0 },
        bl: { h: 21.75, v: 0 },
      },
    });
  });

  it("moves each edge by exactly the margin mutation while correcting radii continuously", () => {
    const box = { x: 0, y: 0, width: 80, height: 40 };
    const base = overflowClipMarginGeometry(box, zeroSides, zeroSides, corners([6, 4], [6, 4], [6, 4], [6, 4]), parsed("padding-box", 10));
    const mutated = overflowClipMarginGeometry(box, zeroSides, zeroSides, corners([6, 4], [6, 4], [6, 4], [6, 4]), parsed("padding-box", 11));
    expect(mutated.x).toBe(base.x - 1);
    expect(mutated.y).toBe(base.y - 1);
    expect(mutated.width).toBe(base.width + 2);
    expect(mutated.height).toBe(base.height + 2);
    expect(mutated.corners.tl.h).toBeGreaterThan(base.corners.tl.h);
    expect(mutated.corners.tl.v).toBeGreaterThan(base.corners.tl.v);
  });
});
