import { describe, expect, it } from "vitest";
import { isOutsideCaptureViewport } from "../utils.js";
import { parsePseudoContentValue, physicalPseudoTransform, pseudoCanvasFont } from "./pseudo-content.js";
import { isMixedVerticalUpright, resolveCharOrientation } from "./text-segments.js";

describe("capture stage boundaries", () => {
  it("classifies viewport overlap without rejecting edge contact", () => {
    const vp = { x: 10, y: 20, width: 100, height: 50 };
    expect(isOutsideCaptureViewport({ left: 110, right: 120, top: 20, bottom: 30 }, vp)).toBe(false);
    expect(isOutsideCaptureViewport({ left: 111, right: 120, top: 20, bottom: 30 }, vp)).toBe(true);
  });

  it("pins UAX #50 mixed-orientation routing", () => {
    // ICU values: R rotates; U, Tu, and Tr all remain upright in Blink.
    expect(isMixedVerticalUpright("A".codePointAt(0))).toBe(false); // R
    expect(isMixedVerticalUpright("漢".codePointAt(0))).toBe(true); // U
    expect(isMixedVerticalUpright(0x3001)).toBe(true); // Tu
    expect(isMixedVerticalUpright(0x2018)).toBe(true); // Tr
    expect(isMixedVerticalUpright(0x20000)).toBe(true); // supplementary U
    expect(resolveCharOrientation("漢", "mixed")).toBe("upright");
    expect(resolveCharOrientation("A", "mixed")).toBe("rotated");
    expect(resolveCharOrientation("A", "upright")).toBe("upright");
    expect(resolveCharOrientation("漢", "sideways")).toBe("rotated");
  });

  it("builds the pseudo emoji canvas font with browser defaults", () => {
    expect(pseudoCanvasFont({})).toBe("normal normal 16px sans-serif");
    expect(pseudoCanvasFont({ fontStyle: "italic", fontWeight: "700", fontSize: "20px", fontFamily: "Arial" })).toBe(
      "italic 700 20px Arial",
    );
  });

  it("scales only matrix translation terms for physical pseudo transforms", () => {
    const zoom = () => 2;
    expect(physicalPseudoTransform({}, "matrix(1, 0, 0, 1, 3, 4)", zoom)).toBe("matrix(1, 0, 0, 1, 6, 8)");
    expect(physicalPseudoTransform({}, "rotate(20deg)", zoom)).toBe("rotate(20deg)");
  });

  it("parses mixed pseudo content through explicit counter and quote services", () => {
    const element = { getAttribute: (name: string) => (name === "data-label" ? "Ready" : null) };
    const counterSnapshot = new Map([[element, { element: [{ name: "step", value: 4 }] }]]);
    expect(
      parsePseudoContentValue({
        content: 'attr(data-label) " " counter(step, upper-roman) open-quote url("icon.svg")',
        el: element,
        counterSnapshot,
        pseudo: "::before",
        resolveCounterValue: (_style: string, value: number) => (value === 4 ? "IV" : String(value)),
        pickQuoteChar: () => "«",
      }),
    ).toEqual({ text: "Ready IV«", imageUrl: "icon.svg" });
  });
});
