import { describe, expect, it } from "vitest";

import type {
  CapturedElement,
  CapturedNativeScrollbarRaster,
  CapturedScrollbar,
  CapturedScrollbarSet,
} from "../capture/types.js";
import { paintNativeScrollbarRasters } from "./native-scrollbar-raster.js";

const raster = (x: number, dataUri = "data:image/png;base64,AA=="): CapturedNativeScrollbarRaster => ({
  x, y: 3, width: 4, height: 5,
  pixelWidth: 8, pixelHeight: 10, captureDpr: 2,
  dataUri, precomposited: true,
  sourceFrameSha256: "a".repeat(64), cropSha256: "b".repeat(64),
  opacitySource: "precomposited-source-frame",
  interaction: { hostHovered: false, hostPressed: false },
  platformFingerprint: {
    platform: "darwin", architecture: "arm64", osRelease: "25.6.0",
    runnerImage: "macos15", runnerImageVersion: "20260822.1",
    chromiumVersion: "147.0.7727.15", chromiumRevision: "1234",
    playwrightVersion: "1.59.1", launchArguments: ["--headless"],
    hideScrollbarsDefaultRemoved: true,
  },
});

const bar = (orientation: "horizontal" | "vertical", nativeRaster?: CapturedNativeScrollbarRaster): CapturedScrollbar => ({
  orientation, route: "native-raster", frameRect: { x: 0, y: 0, width: 4, height: 5 },
  usedWidth: "auto", logicalSide: orientation === "horizontal" ? "bottom" : "right",
  visibleSize: 10, totalSize: 20, currentPosition: 0, enabled: true,
  hoveredPart: null, pressedPart: null, hiddenIfOverlay: false, opacity: 1,
  usedColorScheme: "light", standardColors: null, parts: [], missingFacts: [], nativeRaster,
});

const set = (overrides: Partial<CapturedScrollbarSet> = {}): CapturedScrollbarSet => ({
  status: "captured", source: "blink-live-marker-probe-v1", rootScroller: false,
  horizontal: bar("horizontal", raster(1)), vertical: bar("vertical", raster(2)),
  nativeCornerRaster: raster(3), overlay: false, paintPhase: "background",
  overflowControlsClip: null,
  outputTransform: { space: "capture-viewport", matrix: [1, 0, 0, 1, 0, 0] },
  effectiveZoom: 1, captureDpr: 2, forcedColors: false, missingFacts: [],
  ...overrides,
});

describe("native scrollbar raster paint", () => {
  it("emits horizontal, vertical, then corner before the caller paints the resizer", () => {
    const output = paintNativeScrollbarRasters({ scrollbars: set() } as CapturedElement, "  ").join("\n");
    expect(output.indexOf("native-horizontal")).toBeLessThan(output.indexOf("native-vertical"));
    expect(output.indexOf("native-vertical")).toBeLessThan(output.indexOf("native-corner"));
    expect(output).toContain('data-domotion-scrollbar-phase="background"');
    expect(output).not.toContain("transform=");
  });

  it("fails closed for missing and proven-empty native crops", () => {
    const empty = { ...raster(1), dataUri: undefined, empty: true };
    expect(paintNativeScrollbarRasters({
      scrollbars: set({
        status: "partial",
        horizontal: bar("horizontal"),
        vertical: bar("vertical", empty),
        nativeCornerRaster: undefined,
      }),
    } as CapturedElement, "")).toEqual([]);
  });

  it("ignores absent sets and author-custom axes", () => {
    const author = { ...bar("horizontal", raster(1)), route: "author-custom" as const };
    expect(paintNativeScrollbarRasters({
      scrollbars: set({ status: "absent", horizontal: author, vertical: undefined, nativeCornerRaster: undefined }),
    } as CapturedElement, "")).toEqual([]);
  });
});
