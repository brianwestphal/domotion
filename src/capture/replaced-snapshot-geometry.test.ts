import { describe, expect, it } from "vitest";
import {
  axisAlignedQuadBounds,
  mapCssRectToSourcePixels,
  mapTranslatedQuadToScreenshot,
  translateQuad,
  type CssQuad,
} from "./replaced-snapshot-geometry.js";

const quad = (x: number, y: number, width: number, height: number): CssQuad => [
  x, y, x + width, y, x + width, y + height, x, y + height,
];

describe("replaced snapshot geometry", () => {
  it("keeps the content quad authoritative instead of accepting a transformed AABB", () => {
    expect(axisAlignedQuadBounds(quad(12.25, 19.5, 80, 40))).toEqual({
      x: 12.25, y: 19.5, width: 80, height: 40,
    });
    expect(axisAlignedQuadBounds([12, 10, 92, 30, 82, 70, 2, 50])).toBeNull();
    expect(axisAlignedQuadBounds([12, 10, 72, 5, 92, 70, 2, 50])).toBeNull();
  });

  it("maps an isolated off-page sample back with exactly one translation", () => {
    const output = quad(-28.25, 41.5, 90, 44);
    const sampled = translateQuad(output, 50.5, -20.25);
    expect(mapTranslatedQuadToScreenshot(output, sampled, {
      x: 0, y: 0, width: 160, height: 100,
    })).toEqual({
      clip: { x: 22, y: 21, width: 91, height: 45 },
      output: { x: -28.5, y: 41.25, width: 91, height: 45 },
    });
  });

  it("clips in sampled CSS space and transfers only that clip to output space", () => {
    const mapped = mapTranslatedQuadToScreenshot(
      quad(10.2, 30.2, 100, 50),
      quad(80.2, 70.2, 100, 50),
      { x: 0, y: 0, width: 150, height: 100 },
    );
    expect(mapped?.clip).toEqual({ x: 80, y: 70, width: 70, height: 30 });
    expect(mapped?.output.x).toBeCloseTo(10, 9);
    expect(mapped?.output.y).toBeCloseTo(30, 9);
    expect(mapped?.output.width).toBe(70);
    expect(mapped?.output.height).toBe(30);
  });

  it("rejects scale/stretch between the sampled and output quads", () => {
    expect(mapTranslatedQuadToScreenshot(
      quad(0, 0, 100, 50),
      quad(10, 10, 150, 50),
      { x: 0, y: 0, width: 300, height: 200 },
    )).toBeNull();
  });

  it("derives DPR source pixels and the matching CSS destination once", () => {
    expect(mapCssRectToSourcePixels(
      { x: -2.25, y: 10.25, width: 33, height: 20 },
      { width: 100, height: 50 },
      { width: 200, height: 150 },
    )).toEqual({
      crop: { left: 0, top: 30, width: 62, height: 61 },
      output: { x: 0, y: 10, width: 31, height: 61 / 3 },
    });
  });
});
