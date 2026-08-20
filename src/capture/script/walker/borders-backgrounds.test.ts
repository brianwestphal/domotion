import { describe, expect, it } from "vitest";
import { physicalComputedPaintLength, physicalComputedTileSize } from "./borders-backgrounds.js";

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
