import { describe, expect, it } from "vitest";
import {
  embeddedBaselineY,
  synthesizedSmallCapsScale,
  textFontRequest,
} from "./text-to-path.js";

describe("text rendering stages", () => {
  it("normalizes the CSS font request shared by path and embedded modes", () => {
    expect(textFontRequest("700", "italic", "75%")).toEqual({
      weight: 700, slant: -9.99, stretch: 75,
    });
    expect(textFontRequest("normal", undefined, undefined)).toEqual({
      weight: 400, slant: 0, stretch: 100,
    });
  });

  it("uses captured ascent before scaled font metrics", () => {
    expect(embeddedBaselineY(10, 20, 1000, 800, 13)).toBe(23);
    expect(embeddedBaselineY(10, 20, 1000, 800, undefined)).toBe(26);
  });

  it("matches Blink's whole-pixel synthesized small-caps size", () => {
    expect(16 * synthesizedSmallCapsScale(16)).toBe(11);
    expect(20 * synthesizedSmallCapsScale(20)).toBe(14);
  });
});
