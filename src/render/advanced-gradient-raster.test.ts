import { describe, expect, it } from "vitest";
import { needsChromiumGradientRaster } from "./advanced-gradient-raster.js";

describe("needsChromiumGradientRaster (DM-2308)", () => {
  it.each(["lab", "oklab", "lch", "oklch", "hsl", "hwb"])("routes %s interpolation through Chromium", (space) => {
    expect(needsChromiumGradientRaster(`linear-gradient(90deg in ${space}, red, blue)`)).toBe(true);
  });

  it("routes polar hue methods through Chromium", () => {
    expect(needsChromiumGradientRaster("linear-gradient(in oklch longer hue, red, blue)")).toBe(true);
  });

  it("routes varying alpha because SVG interpolation is unpremultiplied", () => {
    expect(needsChromiumGradientRaster("linear-gradient(in srgb, rgba(255,0,0,0), blue)")).toBe(true);
  });

  it("keeps opaque sRGB and linear-sRGB vector-native", () => {
    expect(needsChromiumGradientRaster("linear-gradient(in srgb, red, blue)")).toBe(false);
    expect(needsChromiumGradientRaster("linear-gradient(in srgb-linear, red, blue)")).toBe(false);
  });
});
