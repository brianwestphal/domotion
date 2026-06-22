import { describe, expect, it } from "vitest";
import { maskContainAlign } from "./element-tree-to-svg.js";

// DM-1251: mask-size: contain/cover positions the fitted mask image via the SVG
// preserveAspectRatio alignment (no intrinsic dims needed — the renderer fits by
// the image's own aspect). mask-position keyword/percent → align. Verified
// against Chrome's painted mask (center + top-left match exactly).
describe("maskContainAlign (DM-1251)", () => {
  it("maps keyword positions (order-independent)", () => {
    expect(maskContainAlign(["center"])).toBe("xMidYMid");
    expect(maskContainAlign(["top", "left"])).toBe("xMinYMin");
    expect(maskContainAlign(["left", "top"])).toBe("xMinYMin"); // order-independent
    expect(maskContainAlign(["right", "bottom"])).toBe("xMaxYMax");
    expect(maskContainAlign(["left"])).toBe("xMinYMid"); // single keyword → other axis center
    expect(maskContainAlign(["bottom"])).toBe("xMidYMax");
  });

  it("maps 0/50/100% positionally (first token = horizontal)", () => {
    expect(maskContainAlign(["0%", "0%"])).toBe("xMinYMin");
    expect(maskContainAlign(["100%", "100%"])).toBe("xMaxYMax");
    expect(maskContainAlign(["50%", "50%"])).toBe("xMidYMid");
    expect(maskContainAlign(["100%", "0%"])).toBe("xMaxYMin");
  });

  it("approximates intermediate %/px to the nearest Min/Mid/Max", () => {
    expect(maskContainAlign(["25%", "75%"])).toBe("xMidYMid"); // interior → Mid
    expect(maskContainAlign(["10px", "10px"])).toBe("xMidYMid"); // px → Mid (approx)
  });

  it("defaults to centered for empty input", () => {
    expect(maskContainAlign([])).toBe("xMidYMid");
  });
});
