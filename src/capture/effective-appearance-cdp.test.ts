import { describe, expect, it } from "vitest";
import { controlBoxMayPaintViewport } from "./effective-appearance-cdp.js";

const viewport = { x: 0, y: 0, width: 1280, height: 800 };

describe("effective appearance viewport filter", () => {
  it("converts DOMSnapshot document bounds using the live scroll offset", () => {
    expect(controlBoxMayPaintViewport([148, 1964, 60, 94], 0, 800, viewport)).toBe(false);
    expect(controlBoxMayPaintViewport([148, 1000, 60, 94], 0, 800, viewport)).toBe(true);
    expect(controlBoxMayPaintViewport([339, 784, 100, 58], 0, 800, viewport)).toBe(true);
  });

  it("retains degenerate or unavailable layout for exact CDP probing", () => {
    expect(controlBoxMayPaintViewport([0, 0, 0, 0], 0, 0, viewport)).toBe(true);
    expect(controlBoxMayPaintViewport([], 0, 0, viewport)).toBe(true);
  });
});
