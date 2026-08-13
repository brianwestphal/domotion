import { describe, expect, it } from "vitest";
import { isOutsideCaptureViewport } from "../utils.js";
import { pseudoCanvasFont } from "./pseudo-content.js";
import { isMixedVerticalUpright, resolveCharOrientation } from "./text-segments.js";

describe("capture stage boundaries", () => {
  it("classifies viewport overlap without rejecting edge contact", () => {
    const vp = { x: 10, y: 20, width: 100, height: 50 };
    expect(isOutsideCaptureViewport({ left: 110, right: 120, top: 20, bottom: 30 }, vp)).toBe(false);
    expect(isOutsideCaptureViewport({ left: 111, right: 120, top: 20, bottom: 30 }, vp)).toBe(true);
  });

  it("pins UAX #50 mixed-orientation routing", () => {
    expect(isMixedVerticalUpright("漢".codePointAt(0))).toBe(true);
    expect(isMixedVerticalUpright("A".codePointAt(0))).toBe(false);
    expect(resolveCharOrientation("漢", "mixed")).toBe("upright");
    expect(resolveCharOrientation("A", "mixed")).toBe("rotated");
    expect(resolveCharOrientation("A", "upright")).toBe("upright");
    expect(resolveCharOrientation("漢", "sideways")).toBe("rotated");
  });

  it("builds the pseudo emoji canvas font with browser defaults", () => {
    expect(pseudoCanvasFont({})).toBe("normal normal 16px sans-serif");
    expect(pseudoCanvasFont({ fontStyle: "italic", fontWeight: "700", fontSize: "20px", fontFamily: "Arial" }))
      .toBe("italic 700 20px Arial");
  });
});
