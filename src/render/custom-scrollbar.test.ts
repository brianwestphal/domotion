import { describe, expect, it, vi } from "vitest";

import type {
  CapturedElement,
  CapturedScrollbar,
  CapturedScrollbarPart,
  CapturedScrollbarSet,
} from "../capture/types.js";
import { orderedCustomScrollbarParts, paintCustomScrollbars } from "./custom-scrollbar.js";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const part = (kind: CapturedScrollbarPart["kind"], x: number): CapturedScrollbarPart => ({
  kind,
  rect: rect(x, 20, 10, 12),
});

function bar(parts: CapturedScrollbarPart[]): CapturedScrollbar {
  return {
    orientation: "horizontal",
    route: "author-custom",
    frameRect: rect(10, 20, 100, 12),
    usedWidth: "auto",
    logicalSide: "bottom",
    visibleSize: 100,
    totalSize: 300,
    currentPosition: 80,
    enabled: true,
    hoveredPart: null,
    pressedPart: null,
    hiddenIfOverlay: false,
    opacity: 1,
    usedColorScheme: "light",
    standardColors: null,
    parts,
    missingFacts: [],
  };
}

function set(parts: CapturedScrollbarPart[]): CapturedScrollbarSet {
  return {
    status: "captured",
    source: "blink-live-marker-probe-v1",
    rootScroller: false,
    horizontal: bar(parts),
    overlay: false,
    paintPhase: "background",
    overflowControlsClip: rect(0, 0, 120, 90),
    outputTransform: { space: "capture-viewport", matrix: [1, 0, 0, 1, 0, 0] },
    effectiveZoom: 1,
    captureDpr: 1,
    forcedColors: false,
    missingFacts: [],
  };
}

describe("author custom scrollbar paint planning", () => {
  it("uses Blink's background/buttons/track/pieces/thumb order, not marker scan order", () => {
    expect(orderedCustomScrollbarParts(bar([
      part("thumb", 50),
      part("forward-track", 70),
      part("background", 10),
      part("track", 20),
      part("back-button", 10),
      part("back-track", 30),
    ])).map(({ kind }) => kind)).toEqual([
      "background",
      "back-button",
      "track",
      "back-track",
      "forward-track",
      "thumb",
    ]);
  });

  it("clips the route once and keeps a dynamic fallback confined to its owning part", () => {
    const raster = part("thumb", 50);
    raster.raster = {
      ...raster.rect,
      captureDpr: 2,
      provenance: "dynamic-author-part",
      dataUri: "data:image/png;base64,AAAA",
    };
    const vector = vi.fn((item: { part: CapturedScrollbarPart }, indent: string) => [
      `${indent}<rect data-vector="${item.part.kind}" />`,
    ]);
    const defsParts: string[] = [];
    const svg = paintCustomScrollbars({
      defsParts,
      nextId: () => "clip1",
      paintVectorPart: vector,
    }, { w: 120, h: 90 }, { scrollbars: set([part("track", 20), raster]) } as CapturedElement, "  ").join("\n");

    expect(defsParts.join("\n")).toContain('id="clip1"');
    expect(svg).toContain('data-domotion-scrollbar-route="author-custom"');
    expect(svg).toContain('data-domotion-scrollbar-part="track"');
    expect(svg).toContain('data-domotion-scrollbar-part="thumb"');
    expect(svg).toContain('href="data:image/png;base64,AAAA"');
    expect(vector).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unavailable records and missing owner-part crops", () => {
    const missing = part("thumb", 50);
    missing.raster = {
      ...missing.rect,
      captureDpr: 1,
      provenance: "unsupported-author-part",
    };
    const unavailable = set([part("track", 20)]);
    unavailable.status = "unavailable";
    const vector = vi.fn(() => ["<rect />"]);
    const context = { defsParts: [], nextId: () => "clip", paintVectorPart: vector };
    expect(paintCustomScrollbars(context, { w: 120, h: 90 }, { scrollbars: unavailable } as CapturedElement, "")).toEqual([]);
    const output = paintCustomScrollbars(context, { w: 120, h: 90 }, { scrollbars: set([missing]) } as CapturedElement, "").join("");
    expect(output).not.toContain("<image");
    expect(vector).not.toHaveBeenCalled();
  });
});
