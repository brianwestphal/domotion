import { describe, expect, it } from "vitest";
import { blurRadiusToStdDev, emitGaussianBlurFilter } from "./gaussian-blur.js";

describe("shared Blink shadow blur filter", () => {
  it("uses ShadowData's blur radius conversion and the default filter region", () => {
    expect(blurRadiusToStdDev(8)).toBe(4);
    expect(emitGaussianBlurFilter("f", 8)).toBe(
      '<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>',
    );
  });

  it("preserves source alpha tinting and an absolute control-shadow region", () => {
    expect(emitGaussianBlurFilter("s", 6, { sourceAlphaColor: "rgb(1,2,3)" })).toContain(
      '<feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur"/><feFlood flood-color="rgb(1,2,3)"',
    );
    expect(emitGaussianBlurFilter("u", 2, { region: { x: 1, y: 2, width: 30, height: 40 } })).toContain(
      'filterUnits="userSpaceOnUse" x="1" y="2" width="30" height="40"',
    );
  });
});
