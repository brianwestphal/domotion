import { describe, expect, it } from "vitest";

import {
  nativeDecorationRectsOverlap,
  nativeDecorationTouchesBoundary,
} from "./native-control-decoration-raster.js";

describe("partial native-control decoration raster guards", () => {
  it("rejects overlapping atlas owners but permits touching edges", () => {
    const a = { x: 10, y: 10, width: 20, height: 15 };
    expect(nativeDecorationRectsOverlap(a, { x: 29, y: 12, width: 5, height: 5 })).toBe(true);
    expect(nativeDecorationRectsOverlap(a, { x: 30, y: 10, width: 5, height: 15 })).toBe(false);
    expect(nativeDecorationRectsOverlap(a, { x: 0, y: 25, width: 10, height: 5 })).toBe(false);
  });

  it("requires a transparent crop guard except at a viewport-clipped edge", () => {
    const pixels = new Uint8Array(4 * 4 * 4);
    pixels[(1 * 4 + 1) * 4 + 3] = 255;
    expect(nativeDecorationTouchesBoundary(pixels, 4, 4, {
      left: true, top: true, right: true, bottom: true,
    })).toBe(false);
    pixels[(2 * 4 + 3) * 4 + 3] = 80;
    expect(nativeDecorationTouchesBoundary(pixels, 4, 4, {
      left: true, top: true, right: true, bottom: true,
    })).toBe(true);
    expect(nativeDecorationTouchesBoundary(pixels, 4, 4, {
      left: true, top: true, right: false, bottom: true,
    })).toBe(false);
    expect(nativeDecorationTouchesBoundary(new Uint8Array(3), 1, 1, {
      left: false, top: false, right: false, bottom: false,
    })).toBe(true);
  });
});
