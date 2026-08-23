import { describe, expect, it } from "vitest";

import {
  buildImagePatternDef,
  cyclicBackgroundLayer,
  parseBackgroundLength,
  resolveBlinkBackgroundImageGeometry,
  type BackgroundNaturalSizing,
} from "./image-pattern.js";

const bitmap: BackgroundNaturalSizing = {
  known: true,
  hasWidth: true,
  hasHeight: true,
  width: 32,
  height: 20,
  ratio: { width: 32, height: 20 },
};

const box = { x: 20, y: 20, width: 160, height: 100 };

function geometry(overrides: Partial<Parameters<typeof resolveBlinkBackgroundImageGeometry>[0]> = {}) {
  const result = resolveBlinkBackgroundImageGeometry({
    positioningArea: box,
    paintingArea: box,
    size: "32px 20px",
    position: "0% 0%",
    repeat: "repeat",
    natural: bitmap,
    ...overrides,
  });
  expect(result).not.toBeNull();
  return result!;
}

describe("Blink BackgroundImageGeometry transcription", () => {
  it("parses computed affine calc lengths without parseFloat truncation", () => {
    expect(parseBackgroundLength("calc(37% + 9px - 2px)")).toEqual({ percent: 37, px: 7 });
    expect(parseBackgroundLength("calc(24% - 5.5px)")).toEqual({ percent: 24, px: -5.5 });
    expect(parseBackgroundLength("min(20px, 30%)")).toBeNull();
  });

  it("uses natural ratio for one auto axis and LayoutUnit truncation", () => {
    expect(geometry({ size: "auto 37px", repeat: "no-repeat" }).tileSize).toEqual({
      width: 59.1875,
      height: 37,
    });
    expect(geometry({ size: "47px auto", repeat: "no-repeat" }).tileSize).toEqual({
      width: 47,
      height: 29.375,
    });
  });

  it("truncates signed CSS geometry once into Blink's raw LayoutUnit domain", () => {
    const result = geometry({
      positioningArea: { x: -0.02, y: 0.02, width: 12.02, height: 9.02 },
      paintingArea: { x: -0.04, y: 0.04, width: 12.04, height: 9.04 },
      size: "1px 1px",
    });

    expect(result.unsnappedPositioningArea).toEqual({
      x: -0.015625,
      y: 0.015625,
      width: 12.015625,
      height: 9.015625,
    });
    expect(result.unsnappedDestination).toEqual({
      x: -0.03125,
      y: 0.03125,
      width: 12.03125,
      height: 9.03125,
    });
  });

  it("resolves percentage-plus-length sizes against the positioning area", () => {
    expect(geometry({
      size: "calc(37% + 9px) calc(24% + 5px)",
      repeat: "no-repeat",
    }).tileSize).toEqual({ width: 68.1875, height: 29 });
  });

  it("uses snapped contain rounding but LayoutUnit-precise cover clamping", () => {
    const positioningArea = { x: 20, y: 20, width: 157.5, height: 93.5 };
    expect(geometry({ positioningArea, paintingArea: positioningArea, size: "contain" }).tileSize)
      .toEqual({ width: 150, height: 94 });
    expect(geometry({ positioningArea, paintingArea: positioningArea, size: "cover" }).tileSize)
      .toEqual({ width: 158, height: 98.75 });
  });

  it("resolves calc position over available space before no-repeat destination movement", () => {
    const result = geometry({
      size: "47px 31px",
      position: "calc(23% + 7px) calc(71% - 5px)",
      repeat: "no-repeat",
    });
    expect(result.unsnappedDestination).toEqual({
      x: 52.984375,
      y: 63.984375,
      width: 47,
      height: 31,
    });
    expect(result.snappedDestination).toEqual({ x: 53, y: 64, width: 47, height: 31 });
    expect(result.phase).toEqual({ x: 0, y: 0 });
  });

  it("preserves positive and negative no-repeat destination/subset phase branches", () => {
    const positive = geometry({ position: "11px 7px", repeat: "no-repeat" });
    expect(positive.snappedDestination).toEqual({ x: 31, y: 27, width: 32, height: 20 });
    expect(positive.phase).toEqual({ x: 0, y: 0 });

    const negative = geometry({ position: "-9px -6px", repeat: "no-repeat" });
    expect(negative.snappedDestination).toEqual({ x: 20, y: 20, width: 23, height: 14 });
    expect(negative.phase).toEqual({ x: -9, y: -6 });
  });

  it("retains unsnapped repeat phase", () => {
    const result = geometry({ position: "7.3125px 5.1875px" });
    expect(result.phase).toEqual({ x: -24.6875, y: -14.8125 });
    expect(result.spacing).toEqual({ width: 0, height: 0 });
  });

  it("rounds tile count and recomputes an orthogonal auto axis from aspect ratio", () => {
    const positioningArea = { x: 20, y: 20, width: 153, height: 97 };
    const result = geometry({
      positioningArea,
      paintingArea: positioningArea,
      size: "43px auto",
      position: "31% 67%",
      repeat: "round no-repeat",
    });
    expect(result.tileSize).toEqual({ width: 38.25, height: 23.90625 });
    expect(result.repeat).toEqual({ x: "round", y: "no-repeat" });
  });

  it("computes space spacing and converts a single-tile space axis to no-repeat", () => {
    const multipleArea = { x: 20, y: 20, width: 153, height: 97 };
    const multiple = geometry({
      positioningArea: multipleArea,
      paintingArea: multipleArea,
      size: "38px 24px",
      position: "29px 61px",
      repeat: "space no-repeat",
    });
    expect(multiple.repeat.x).toBe("space");
    expect(multiple.spacing.width).toBe(0.328125);
    expect(multiple.phase.x).toBe(0);

    const singleArea = { x: 20, y: 20, width: 91, height: 75 };
    const single = geometry({
      positioningArea: singleArea,
      paintingArea: singleArea,
      size: "54px 27px",
      position: "23px 31px",
      repeat: "space no-repeat",
    });
    expect(single.repeat.x).toBe("no-repeat");
    expect(single.snappedDestination).toEqual({ x: 43, y: 51, width: 54, height: 27 });
  });

  it("uses edge origins and independent origin/clip offsets", () => {
    const edge = geometry({ size: "32px 20px", position: "right 20px bottom 9px", repeat: "no-repeat" });
    expect(edge.snappedDestination.x).toBe(128);
    expect(edge.snappedDestination.y).toBe(91);

    const crossed = geometry({
      positioningArea: { x: 40, y: 35, width: 100, height: 60 },
      paintingArea: { x: 20, y: 20, width: 140, height: 90 },
      position: "5px 7px",
    });
    // Full repeated tiles are aligned to positioning origin + position even
    // though paint begins in the larger border/padding clip.
    expect(crossed.phase).toEqual({ x: -7, y: -18 });
    expect(crossed.snappedDestination).toEqual({ x: 20, y: 20, width: 140, height: 90 });
  });

  it("fails closed only when natural facts are required", () => {
    const unknown: BackgroundNaturalSizing = {
      known: false,
      hasWidth: false,
      hasHeight: false,
      width: null,
      height: null,
      ratio: null,
    };
    expect(resolveBlinkBackgroundImageGeometry({
      positioningArea: box,
      paintingArea: box,
      size: "auto auto",
      position: "0% 0%",
      repeat: "repeat",
      natural: unknown,
    })).toBeNull();
    expect(resolveBlinkBackgroundImageGeometry({
      positioningArea: box,
      paintingArea: box,
      size: "32px 20px",
      position: "0% 0%",
      repeat: "repeat",
      natural: unknown,
    })?.tileSize).toEqual({ width: 32, height: 20 });
  });

  it("cycles every shorter longhand list instead of pinning later layers to index zero", () => {
    expect([0, 1, 2, 3, 4].map((index) => cyclicBackgroundLayer(["a", "b"], index, "z")))
      .toEqual(["a", "b", "a", "b", "a"]);
  });

  it("encodes no-repeat with the exact painting-area cell, never a fake oversized period", () => {
    const def = buildImagePatternDef(
      "bg", "data:image/png;base64,AA==",
      40, 35, 100, 60,
      "32px 20px", "5px 7px", "no-repeat",
      { w: 32, h: 20 }, "scroll", null, null,
      { x: 20, y: 20, width: 140, height: 90 },
    );
    expect(def).toContain('x="20" y="20" width="140" height="90"');
    expect(def).toContain('<image href="data:image/png;base64,AA==" x="25" y="22" width="32" height="20" preserveAspectRatio="none"');
    expect(def).not.toContain('width="280"');
  });
});
