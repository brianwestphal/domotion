import { describe, expect, it } from "vitest";
import { blinkPhysicalSymbolMarkerRect, blinkSymbolMarkerGeometry, disclosureTriangle, pixelSnapRect } from "./list-marker-geometry.js";

describe("Blink symbol marker geometry oracle (DM-2192)", () => {
  it.each([
    { ascent: 12, font: 16, width: 4, box: 6, block: 6, end: 10 },
    { ascent: 18, font: 24, width: 6, box: 8, block: 9, end: 12 },
    { ascent: 24, font: 32, width: 8, box: 10, block: 12, end: 14 },
  ])("transcribes integer disc/circle/square geometry at ascent $ascent", ({ ascent, font, width, box, block, end }) => {
    for (const type of ["disc", "circle", "square"] as const) {
      expect(blinkSymbolMarkerGeometry(ascent, font, type)).toEqual({
        markerInlineSize: box, inlineOffset: 1, blockOffset: block,
        inlineSize: width, blockSize: width, outsideEndMargin: end,
      });
    }
  });

  it("uses 0.66 specified-em disclosure geometry and the fixed 8px outside margin", () => {
    expect(blinkSymbolMarkerGeometry(18, 24, "disclosure-open")).toEqual({
      markerInlineSize: 15.84, inlineOffset: 0, blockOffset: 2.16,
      inlineSize: 15.84, blockSize: 15.84, outsideEndMargin: 8,
    });
  });

  it("snaps both physical edges like ToPixelSnappedRect", () => {
    expect(pixelSnapRect(10.4, 20.6, 4.4, 4.4)).toEqual({ x: 10, y: 21, width: 5, height: 4 });
  });

  it("maps the captured first-line marker fragment through Blink's line writing mode", () => {
    const fragment = { x: 100, y: 40, width: 30, height: 24 };
    expect(blinkPhysicalSymbolMarkerRect(fragment, 18, 24, 1, "disclosure-closed", "horizontal-tb"))
      .toEqual({ x: 100, y: 42.16, width: 15.84, height: 15.84 });
    // ToLineWritingMode maps vertical-lr to vertical-rl for the relative
    // symbol rect, so both vertical modes place it from the fragment's right
    // edge. Sideways-lr retains its counter-clockwise line mode.
    expect(blinkPhysicalSymbolMarkerRect(fragment, 18, 24, 1, "disclosure-closed", "vertical-rl"))
      .toEqual({ x: 112, y: 40, width: 15.84, height: 15.84 });
    expect(blinkPhysicalSymbolMarkerRect(fragment, 18, 24, 1, "disclosure-closed", "vertical-lr"))
      .toEqual({ x: 112, y: 40, width: 15.84, height: 15.84 });
    expect(blinkPhysicalSymbolMarkerRect(fragment, 18, 24, 1, "disclosure-closed", "sideways-lr"))
      .toEqual({ x: 102.16, y: 40, width: 15.84, height: 15.84 });
  });

  it("applies effective zoom to DisclosureSymbolSize without scaling the captured fragment twice", () => {
    expect(blinkPhysicalSymbolMarkerRect(
      { x: 59.125, y: 37.125, width: 24.75, height: 42 },
      29, 30, 1.25, "disclosure-closed", "horizontal-tb",
    )).toEqual({ x: 59.125, y: 41.375, width: 24.75, height: 24.75 });
  });

  it("maps disclosure orientation through writing direction", () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(disclosureTriangle(rect, "disclosure-closed", "horizontal-tb", "ltr")).toBe("0,0 8.6,5 0,10");
    expect(disclosureTriangle(rect, "disclosure-closed", "horizontal-tb", "rtl")).toBe("10,0 1.4000000000000001,5 10,10");
    expect(disclosureTriangle(rect, "disclosure-open", "horizontal-tb", "ltr")).toBe("0,0.7000000000000001 5,9.3 10,0.7000000000000001");
    expect(disclosureTriangle(rect, "disclosure-open", "vertical-rl", "ltr")).toBe("10,0 1.4000000000000001,5 10,10");
    expect(disclosureTriangle(rect, "disclosure-open", "sideways-rl", "ltr")).toBe("10,0 1.4000000000000001,5 10,10");
    expect(disclosureTriangle(rect, "disclosure-open", "vertical-lr", "ltr")).toBe("0,0 8.6,5 0,10");
    expect(disclosureTriangle(rect, "disclosure-closed", "sideways-lr", "ltr")).toBe("0,9.3 5,0.7000000000000001 10,9.3");
  });
});
