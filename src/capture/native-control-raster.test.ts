import { describe, expect, it } from "vitest";

import {
  composeNativeControlFrames,
  cropNativeControlRgba,
  nativeControlAlphaStats,
  nativeControlPixelCrop,
  planNativeControlClip,
} from "./native-control-raster.js";

describe("native control raster frame planning", () => {
  it("retains the one-pixel overflow rectangle while clipping every viewport edge", () => {
    expect(planNativeControlClip(
      { x: -1.25, y: 6.5, width: 24.5, height: 18.25 },
      { x: 40, y: 70, width: 20, height: 20 },
    )).toEqual({
      output: { x: 0, y: 6, width: 20, height: 14 },
      pageClip: { x: 40, y: 76, width: 20, height: 14 },
    });
    expect(planNativeControlClip(
      { x: 25, y: 4, width: 3, height: 3 },
      { x: 0, y: 0, width: 20, height: 20 },
    )).toBeNull();
  });

  it("maps a snapped CSS clip through DPR without assuming one pixel per CSS px", () => {
    expect(nativeControlPixelCrop(
      { x: 10, y: 5, width: 21, height: 13 },
      { width: 100, height: 50 },
      { width: 200, height: 100 },
    )).toEqual({ left: 20, top: 10, width: 42, height: 26 });
    expect(nativeControlPixelCrop(
      { x: 10, y: 5, width: 21, height: 13 },
      { width: 100, height: 50 },
      { width: 200, height: 80 },
    )).toBeNull();
  });

  it("rejects malformed crops instead of stretching or reading outside the frame", () => {
    const frame = { data: new Uint8Array(3 * 2 * 4), width: 3, height: 2 };
    expect(cropNativeControlRgba(frame, { left: 1, top: 0, width: 2, height: 2 })).toHaveLength(16);
    expect(cropNativeControlRgba(frame, { left: 2, top: 0, width: 2, height: 2 })).toBeNull();
    expect(cropNativeControlRgba({ ...frame, data: new Uint8Array(7) }, { left: 0, top: 0, width: 1, height: 1 })).toBeNull();
  });

  it("uses source-frame RGB only where isolated alpha proves full opacity", () => {
    const isolated = new Uint8Array([
      1, 2, 3, 255,
      4, 5, 6, 127,
      7, 8, 9, 0,
    ]);
    const source = new Uint8Array([
      90, 91, 92, 255,
      93, 94, 95, 255,
      96, 97, 98, 255,
    ]);
    expect(Array.from(composeNativeControlFrames(isolated, source, false)!)).toEqual([
      90, 91, 92, 255,
      4, 5, 6, 127,
      7, 8, 9, 0,
    ]);
    expect(Array.from(composeNativeControlFrames(isolated, source, true)!)).toEqual(Array.from(isolated));
    expect(composeNativeControlFrames(isolated, source.subarray(0, 4), false)).toBeNull();
  });

  it("classifies transparent, premultiplied edge, and opaque pixels explicitly", () => {
    expect(nativeControlAlphaStats(new Uint8Array([
      0, 0, 0, 0,
      1, 2, 3, 1,
      4, 5, 6, 254,
      7, 8, 9, 255,
    ]))).toEqual({ transparent: 1, translucent: 2, opaque: 1 });
    expect(nativeControlAlphaStats(new Uint8Array())).toBeNull();
    expect(nativeControlAlphaStats(new Uint8Array(3))).toBeNull();
  });

});
