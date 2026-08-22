import { describe, expect, it } from "vitest";

import type { CapturedScrollbarPlatformFingerprint } from "./types.js";
import {
  analyzeNativeOverlayInk,
  classifyNativeOverlayInk,
  materializeNativeScrollbarRaster,
  type NativeScrollbarFrame,
} from "./native-scrollbar-raster.js";

const FINGERPRINT: CapturedScrollbarPlatformFingerprint = {
  platform: "darwin", architecture: "arm64", osRelease: "25.6.0",
  runnerImage: "macos15", runnerImageVersion: "20260822.1",
  chromiumVersion: "147.0.7727.15", chromiumRevision: "1234",
  playwrightVersion: "1.59.1", launchArguments: ["--headless"],
  hideScrollbarsDefaultRemoved: true,
};

function frame(fill: (x: number, y: number) => [number, number, number, number]): NativeScrollbarFrame {
  const data = Buffer.alloc(8 * 6 * 4);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
    data.set(fill(x, y), (y * 8 + x) * 4);
  }
  return { data, width: 8, height: 6, pngSha256: "a".repeat(64) };
}

describe("platform-native scrollbar strip raster", () => {
  it("classifies visible, empty, unstable, and unavailable overlay frames", () => {
    const underlay = frame(() => [10, 20, 30, 255]);
    const visible = frame((x) => x >= 7 ? [90, 100, 110, 255] : [10, 20, 30, 255]);
    const changedAfterRestore = frame((x, y) => x === 6 && y === 0 ? [91, 100, 110, 255] : x >= 7 ? [90, 100, 110, 255] : [10, 20, 30, 255]);
    const rect = { x: 6, y: 0, width: 2, height: 6 };
    const viewport = { x: 0, y: 0, width: 8, height: 6 };
    expect(classifyNativeOverlayInk(visible, underlay, visible, rect, null, viewport)).toBe("visible");
    expect(classifyNativeOverlayInk(underlay, underlay, underlay, rect, null, viewport)).toBe("empty");
    expect(classifyNativeOverlayInk(visible, underlay, changedAfterRestore, rect, null, viewport)).toBe("unstable");
    expect(classifyNativeOverlayInk(null, underlay, underlay, rect, null, viewport)).toBe("unavailable");
    expect(analyzeNativeOverlayInk(visible, underlay, visible, rect, null, viewport)).toEqual({
      verdict: "visible",
      rects: [{ x: 7, y: 0, width: 1, height: 6 }],
    });
  });

  it("crops at real device pixels, intersects the source clip, and never resamples", async () => {
    const source = frame((x, y) => [x, y, 200, 255]);
    const raster = await materializeNativeScrollbarRaster(
      source,
      { x: 2.625, y: 0.125, width: 1.375, height: 2.875 },
      { x: 2.75, y: 0.5, width: 1.25, height: 2 },
      { x: 0, y: 0, width: 4, height: 3 },
      2,
      FINGERPRINT,
      { hostHovered: true, hostPressed: false },
    );
    expect(raster).toMatchObject({
      x: 2.5, y: 0.5, width: 1.5, height: 2,
      pixelWidth: 3, pixelHeight: 4, captureDpr: 2,
      precomposited: true, opacitySource: "precomposited-source-frame",
      interaction: { hostHovered: true, hostPressed: false },
    });
    expect(raster?.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(raster?.cropSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records a proven empty overlay without inventing pixels", async () => {
    const raster = await materializeNativeScrollbarRaster(
      frame(() => [0, 0, 0, 0]),
      { x: 6, y: 0, width: 2, height: 6 },
      null,
      { x: 0, y: 0, width: 8, height: 6 },
      1,
      FINGERPRINT,
      { hostHovered: false, hostPressed: false },
      true,
    );
    expect(raster).toMatchObject({ empty: true, precomposited: true });
    expect(raster?.dataUri).toBeUndefined();
  });
});
