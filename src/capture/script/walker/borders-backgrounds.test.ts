import { describe, expect, it } from "vitest";
import {
  physicalComputedPaintLength,
  physicalComputedGradientImage,
  physicalComputedTileSize,
  tableGridRectFromCaptions,
} from "./borders-backgrounds.js";

describe("zoomed border and outline paint lengths (DM-2323)", () => {
  it("restores Blink internal paint lengths from CSSOM serialization", () => {
    // At zoom .8 Chromium serializes a 5px outline as 5px and a 3px offset
    // as 2.5px; at zoom 1.25 they serialize as 4.8px and 2.4px. Multiplying
    // by EffectiveZoom recovers the integer values OutlinePainter consumes.
    expect(physicalComputedPaintLength("5px", 0.8)).toBe("4px");
    expect(physicalComputedPaintLength("2.5px", 0.8)).toBe("2px");
    expect(physicalComputedPaintLength("4.8px", 1.25)).toBe("6px");
    expect(physicalComputedPaintLength("2.4px", 1.25)).toBe("3px");
  });

  it("crosses effective zoom once for gradient px terms without touching URL layers", () => {
    expect(physicalComputedGradientImage(
      'url("data:image/svg+xml,<svg id=\\"8px\\"/>") , repeating-linear-gradient(37deg, red -5px 7px, blue calc(11px + 10%))',
      2,
    )).toBe('url("data:image/svg+xml,<svg id=\\"8px\\"/>") , repeating-linear-gradient(37deg, red -10px 14px, blue calc(22px + 10%))');
  });

  it("scales only deprecated point/radius numbers, never percentages or stop offsets", () => {
    expect(physicalComputedGradientImage(
      "-webkit-gradient(linear, 12 8, 80% 75%, color-stop(-0.2, red), color-stop(1.2, blue))",
      2,
    )).toBe("-webkit-gradient(linear, 24 16, 80% 75%, color-stop(-0.2, red), color-stop(1.2, blue))");
    expect(physicalComputedGradientImage(
      "-webkit-gradient(radial, 10 20, 5, 80% 70%, 40, from(red), color-stop(0.5, blue))",
      1.25,
    )).toBe("-webkit-gradient(radial, 12.5 25, 6.25, 80% 70%, 50, from(red), color-stop(0.5, blue))");
  });

  it("does not interpret gradient-looking bytes inside a URL payload", () => {
    expect(physicalComputedGradientImage(
      'url("data:image/svg+xml,<svg data-x=\'-webkit-gradient(linear, 10 20, 30 40)\'/>")',
      2,
    )).toBe('url("data:image/svg+xml,<svg data-x=\'-webkit-gradient(linear, 10 20, 30 40)\'/>")');
  });

  it("preserves unzoomed bytes and signed offsets", () => {
    expect(physicalComputedPaintLength("5px", 1)).toBe("5px");
    expect(physicalComputedPaintLength("-2.5px", 0.8)).toBe("-2px");
  });
});

describe("zoomed background tile lengths (DM-2327)", () => {
  it("scales px and calc px terms but leaves percentages physical-box-relative", () => {
    expect(physicalComputedTileSize("40px 30px", 1.25)).toBe("50px 37.5px");
    expect(physicalComputedTileSize("50% calc(40% - 2px)", 1.25)).toBe("50% calc(40% - 2.5px)");
  });
});

describe("caption-excluding table grid geometry (DM-2412)", () => {
  it("uses the last top and first bottom caption boundaries in horizontal writing", () => {
    const table = { left: 10, top: 20, right: 210, bottom: 220, width: 200, height: 200 };
    expect(tableGridRectFromCaptions(table, "horizontal-tb", [
      {
        rect: { left: 10, top: 20, right: 210, bottom: 50 },
        side: "top",
        marginBlockStart: 0,
        marginBlockEnd: 5,
      },
      {
        rect: { left: 10, top: 170, right: 210, bottom: 220 },
        side: "bottom",
        marginBlockStart: 10,
        marginBlockEnd: 0,
      },
    ])).toEqual({ x: 10, y: 55, width: 200, height: 105 });
  });

  it("maps Blink logical block offsets back through vertical-rl", () => {
    const table = { left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100 };
    expect(tableGridRectFromCaptions(table, "vertical-rl", [
      {
        rect: { left: 180, top: 20, right: 210, bottom: 120 },
        side: "top",
        marginBlockStart: 0,
        marginBlockEnd: 5,
      },
      {
        rect: { left: 10, top: 20, right: 50, bottom: 120 },
        side: "bottom",
        marginBlockStart: 10,
        marginBlockEnd: 0,
      },
    ])).toEqual({ x: 60, y: 20, width: 115, height: 100 });
  });

  it("preserves a negative top-caption end margin instead of fitting the grid", () => {
    const table = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    expect(tableGridRectFromCaptions(table, "horizontal-tb", [
      {
        rect: { left: 0, top: 0, right: 100, bottom: 30 },
        side: "top",
        marginBlockStart: 0,
        marginBlockEnd: -8,
      },
    ])).toEqual({ x: 0, y: 22, width: 100, height: 78 });
  });

  it("allows Blink's table grid to extend outside a wrapper shortened by a negative margin", () => {
    const table = { left: 50, top: 50, right: 150, bottom: 56, width: 100, height: 6 };
    expect(tableGridRectFromCaptions(table, "horizontal-tb", [
      {
        rect: { left: 50, top: 50, right: 150, bottom: 70 },
        side: "top",
        marginBlockStart: 0,
        marginBlockEnd: -50,
      },
    ])).toEqual({ x: 50, y: 20, width: 100, height: 36 });
  });
});
