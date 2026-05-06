import { describe, expect, it } from "vitest";
import { preserveAspectRatioFor } from "./dom-to-svg.js";

describe("preserveAspectRatioFor — CSS object-fit/object-position → SVG preserveAspectRatio (DM-472)", () => {
  it("object-fit:fill → none (stretch both axes)", () => {
    expect(preserveAspectRatioFor("fill", "50% 50%")).toBe("none");
  });

  it("object-fit defaulted to fill when undefined → none", () => {
    expect(preserveAspectRatioFor(undefined, undefined)).toBe("none");
  });

  it("object-fit:none → none (renderer special-cases via intrinsic-size path)", () => {
    expect(preserveAspectRatioFor("none", "50% 50%")).toBe("none");
  });

  it("object-fit:contain default position → xMidYMid meet", () => {
    expect(preserveAspectRatioFor("contain", "50% 50%")).toBe("xMidYMid meet");
  });

  it("object-fit:cover default position → xMidYMid slice", () => {
    expect(preserveAspectRatioFor("cover", "50% 50%")).toBe("xMidYMid slice");
  });

  it("object-fit:scale-down treated as contain", () => {
    expect(preserveAspectRatioFor("scale-down", "50% 50%")).toBe("xMidYMid meet");
  });

  it("object-position:left top → xMinYMin alignment", () => {
    expect(preserveAspectRatioFor("contain", "left top")).toBe("xMinYMin meet");
    expect(preserveAspectRatioFor("cover", "left top")).toBe("xMinYMin slice");
  });

  it("object-position:right bottom → xMaxYMax alignment", () => {
    expect(preserveAspectRatioFor("contain", "right bottom")).toBe("xMaxYMax meet");
  });

  it("object-position:0% 0% → xMin alignment (same as left top)", () => {
    expect(preserveAspectRatioFor("contain", "0% 0%")).toBe("xMinYMin meet");
  });

  it("object-position:100% 100% → xMax alignment", () => {
    expect(preserveAspectRatioFor("cover", "100% 100%")).toBe("xMaxYMax slice");
  });

  it("undefined object-position defaults to center (xMidYMid)", () => {
    expect(preserveAspectRatioFor("contain", undefined)).toBe("xMidYMid meet");
  });
});
