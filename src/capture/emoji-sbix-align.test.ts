// DM-1728: pure pieces of the sbix overlay self-calibration.
import { describe, expect, it } from "vitest";

import { scanInk, screenshotInkBoundsInCssPixels } from "./emoji.js";

function rgba(w: number, h: number, inked: Array<[number, number]>): Uint8Array {
  const buf = new Uint8Array(w * h * 4);
  for (const [x, y] of inked) {
    const i = (y * w + x) * 4;
    buf[i] = 255; buf[i + 3] = 255;
  }
  return buf;
}

describe("scanInk", () => {
  it("finds the tight ink bbox", () => {
    const buf = rgba(8, 8, [[2, 3], [5, 3], [3, 6]]);
    expect(scanInk(buf, 8, 8)).toEqual({ minX: 2, minY: 3, maxX: 5, maxY: 6 });
  });

  it("ignores near-transparent pixels (alpha ≤ 16)", () => {
    const buf = rgba(4, 4, [[1, 1]]);
    buf[(0 * 4 + 3) * 4 + 3] = 16; // (3,0) alpha exactly 16 — below threshold
    expect(scanInk(buf, 4, 4)).toEqual({ minX: 1, minY: 1, maxX: 1, maxY: 1 });
  });

  it("returns null for a fully transparent buffer", () => {
    expect(scanInk(new Uint8Array(4 * 4 * 4), 4, 4)).toBeNull();
  });

  it("full-bleed ink spans the whole frame", () => {
    const w = 3, h = 2;
    const buf = new Uint8Array(w * h * 4).fill(255);
    expect(scanInk(buf, w, h)).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 1 });
  });
});

describe("screenshotInkBoundsInCssPixels", () => {
  it("removes device scale from DPR-2 screenshot coordinates", () => {
    expect(screenshotInkBoundsInCssPixels(
      { minX: 8, minY: 10, maxX: 47, maxY: 49 },
      { width: 60, height: 60 },
      { x: 304, y: 130, width: 30, height: 30 },
    )).toEqual({ x: 308, y: 135, width: 20, height: 20, scaleX: 2, scaleY: 2 });
  });
});
