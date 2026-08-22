import { describe, expect, it } from "vitest";

import {
  nativeScrollbarCornerRect,
  SCROLLBAR_MARKERS,
  scrollbarMarkerComponents,
  usedScrollbarColorScheme,
} from "./scrollbar-capture.js";

function marker(kind: (typeof SCROLLBAR_MARKERS)[number]["kind"]): readonly [number, number, number] {
  return SCROLLBAR_MARKERS.find((entry) => entry.kind === kind)!.rgb;
}

function paint(
  rgba: Uint8Array,
  width: number,
  rect: { x: number; y: number; width: number; height: number },
  rgb: readonly [number, number, number],
): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const offset = (y * width + x) * 4;
      rgba.set([rgb[0], rgb[1], rgb[2], 255], offset);
    }
  }
}

describe("Blink live scrollbar marker classification", () => {
  it("derives the native corner from the physical horizontal/vertical frame overlap", () => {
    expect(nativeScrollbarCornerRect(
      { frameRect: { x: 12, y: 90, width: 78, height: 10 } },
      { frameRect: { x: 90, y: 10, width: 10, height: 80 }, logicalSide: "right" },
    )).toEqual({ x: 90, y: 90, width: 10, height: 10 });
    expect(nativeScrollbarCornerRect(
      { frameRect: { x: 10, y: 90, width: 80, height: 10 } },
      { frameRect: { x: 0, y: 10, width: 10, height: 80 }, logicalSide: "left" },
    )).toEqual({ x: 0, y: 90, width: 10, height: 10 });
    expect(nativeScrollbarCornerRect(null, undefined)).toBeNull();
  });

  it("resolves the used scheme from the computed allowance and live preference", () => {
    expect(usedScrollbarColorScheme("normal", true)).toBe("light");
    expect(usedScrollbarColorScheme("light", true)).toBe("light");
    expect(usedScrollbarColorScheme("dark", false)).toBe("dark");
    expect(usedScrollbarColorScheme("light dark", false)).toBe("light");
    expect(usedScrollbarColorScheme("light dark", true)).toBe("dark");
  });

  it("returns independent device-pixel part rectangles without merging marker kinds", () => {
    const width = 30;
    const height = 24;
    const rgba = new Uint8Array(width * height * 4);
    paint(rgba, width, { x: 22, y: 2, width: 5, height: 7 }, marker("back-track"));
    paint(rgba, width, { x: 22, y: 9, width: 5, height: 6 }, marker("thumb"));
    paint(rgba, width, { x: 22, y: 15, width: 5, height: 6 }, marker("forward-track"));
    paint(rgba, width, { x: 3, y: 19, width: 19, height: 3 }, marker("track"));
    paint(rgba, width, { x: 22, y: 21, width: 5, height: 3 }, marker("corner"));

    expect(scrollbarMarkerComponents(rgba, width, height)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "back-track", pixelRect: { x: 22, y: 2, width: 5, height: 7 } }),
      expect.objectContaining({ kind: "thumb", pixelRect: { x: 22, y: 9, width: 5, height: 6 } }),
      expect.objectContaining({ kind: "forward-track", pixelRect: { x: 22, y: 15, width: 5, height: 6 } }),
      expect.objectContaining({ kind: "track", pixelRect: { x: 3, y: 19, width: 19, height: 3 } }),
      expect.objectContaining({ kind: "corner", pixelRect: { x: 22, y: 21, width: 5, height: 3 } }),
    ]));
  });

  it("ignores coincidental marker pixels outside the source-owner crop and isolated noise", () => {
    const width = 20;
    const height = 20;
    const rgba = new Uint8Array(width * height * 4);
    paint(rgba, width, { x: 1, y: 1, width: 5, height: 5 }, marker("thumb"));
    paint(rgba, width, { x: 15, y: 15, width: 1, height: 1 }, marker("thumb"));
    paint(rgba, width, { x: 12, y: 4, width: 4, height: 8 }, marker("thumb"));

    expect(scrollbarMarkerComponents(rgba, width, height, { x: 10, y: 2, width: 8, height: 12 }))
      .toEqual([
        expect.objectContaining({ kind: "thumb", pixelRect: { x: 12, y: 4, width: 4, height: 8 }, pixels: 32 }),
      ]);
  });

  it("subtracts matching baseline pixels before classifying reserved marker colors", () => {
    const width = 16;
    const height = 12;
    const baseline = new Uint8Array(width * height * 4);
    const marked = new Uint8Array(width * height * 4);
    paint(baseline, width, { x: 1, y: 1, width: 4, height: 7 }, marker("thumb"));
    paint(marked, width, { x: 1, y: 1, width: 4, height: 7 }, marker("thumb"));
    paint(marked, width, { x: 10, y: 2, width: 3, height: 8 }, marker("thumb"));

    expect(scrollbarMarkerComponents(marked, width, height, undefined, baseline)).toEqual([
      expect.objectContaining({ kind: "thumb", pixelRect: { x: 10, y: 2, width: 3, height: 8 } }),
    ]);
  });
});
