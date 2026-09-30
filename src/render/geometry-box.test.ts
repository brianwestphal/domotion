import { describe, expect, it } from "vitest";
import { geometryBoxOutsets } from "./geometry-box.js";

describe("physical geometry-box outsets", () => {
  const border = { top: 2, right: 3, bottom: 4, left: 5 };
  const padding = { top: 7, right: 11, bottom: 13, left: 17 };
  const margin = { top: 19, right: 23, bottom: 29, left: 31 };

  it("resolves each box from the border edge", () => {
    expect(geometryBoxOutsets("border-box", border, padding, margin)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(geometryBoxOutsets("padding-box", border, padding, margin)).toEqual({
      top: -2,
      right: -3,
      bottom: -4,
      left: -5,
    });
    expect(geometryBoxOutsets("content-box", border, padding, margin)).toEqual({
      top: -9,
      right: -14,
      bottom: -17,
      left: -22,
    });
    expect(geometryBoxOutsets("fill-box", border, padding, margin)).toEqual(
      geometryBoxOutsets("content-box", border, padding, margin),
    );
    expect(geometryBoxOutsets("margin-box", border, padding, margin)).toEqual(margin);
    expect(geometryBoxOutsets("half-border-box", border, padding, margin)).toEqual({
      top: -1,
      right: -1.5,
      bottom: -2,
      left: -2.5,
    });
  });
});
