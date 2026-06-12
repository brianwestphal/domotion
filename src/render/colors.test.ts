import { describe, it, expect } from "vitest";
import { parseColor, colorStr, sameColor, shadeColor } from "./colors.js";

describe("parseColor", () => {
  it("parses rgb() and rgba()", () => {
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });

  it("treats empty / transparent as fully-transparent black", () => {
    expect(parseColor("")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("parses 6- and 8-digit hex", () => {
    expect(parseColor("#0a141e")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("#ff000080")).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 });
  });

  it("parses 3- and 4-digit short hex (each digit doubled)", () => {
    expect(parseColor("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
    expect(parseColor("#abcf")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  });

  it("parses the named-color subset (case-insensitive)", () => {
    expect(parseColor("red")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("Purple")).toEqual({ r: 128, g: 0, b: 128, a: 1 });
    expect(parseColor("grey")).toEqual(parseColor("gray"));
  });

  it("parses color(srgb …) with 0..1 floats, clamping out-of-gamut + scientific notation", () => {
    expect(parseColor("color(srgb 1 0 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    // negative channel clamps to 0; >1 clamps to 255; 0.5 → 128.
    expect(parseColor("color(srgb -6.85e-9 0.5 2)")).toEqual({ r: 0, g: 128, b: 255, a: 1 });
    expect(parseColor("color(srgb 0 0 0 / 0.25)")).toEqual({ r: 0, g: 0, b: 0, a: 0.25 });
  });

  it("applies the linear→sRGB inverse-EOTF for color(srgb-linear …) (DM-519)", () => {
    // 0.215 in linear light maps to ~0.5 in sRGB → ~128/255.
    expect(parseColor("color(srgb-linear 0.215 0.215 0.215)")).toEqual({ r: 128, g: 128, b: 128, a: 1 });
    // endpoints are stable: 0 → 0, 1 → 255.
    expect(parseColor("color(srgb-linear 0 0 0)")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor("color(srgb-linear 1 1 1)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("returns null for unparseable input", () => {
    expect(parseColor("garbage")).toBeNull();
    expect(parseColor("hsl(0, 100%, 50%)")).toBeNull(); // hsl isn't a parseColor input form
  });
});

describe("colorStr", () => {
  it("emits rgb() when opaque and rgba() when translucent", () => {
    expect(colorStr({ r: 1, g: 2, b: 3, a: 1 })).toBe("rgb(1,2,3)");
    expect(colorStr({ r: 1, g: 2, b: 3, a: 0.5 })).toBe("rgba(1,2,3,0.5)");
  });
});

describe("sameColor", () => {
  it("compares channels exactly and alpha within a 0.01 tolerance", () => {
    expect(sameColor({ r: 1, g: 2, b: 3, a: 1 }, { r: 1, g: 2, b: 3, a: 1 })).toBe(true);
    expect(sameColor({ r: 1, g: 2, b: 3, a: 1 }, { r: 1, g: 2, b: 3, a: 0.995 })).toBe(true);
    expect(sameColor({ r: 1, g: 2, b: 3, a: 1 }, { r: 1, g: 2, b: 4, a: 1 })).toBe(false);
    expect(sameColor({ r: 1, g: 2, b: 3, a: 1 }, { r: 1, g: 2, b: 3, a: 0.9 })).toBe(false);
  });
});

describe("shadeColor", () => {
  it("lightens / darkens an achromatic color in the lightness domain", () => {
    // gray 100 → L=0.392; +20 → 0.592 → round(0.592*255)=151; -20 → 0.192 → 49.
    expect(shadeColor({ r: 100, g: 100, b: 100, a: 1 }, 20)).toEqual({ r: 151, g: 151, b: 151, a: 1 });
    expect(shadeColor({ r: 100, g: 100, b: 100, a: 1 }, -20)).toEqual({ r: 49, g: 49, b: 49, a: 1 });
  });

  it("preserves hue while shifting lightness for a chromatic color, and keeps alpha", () => {
    const base = { r: 200, g: 50, b: 50, a: 0.7 };
    const lighter = shadeColor(base, 15);
    const darker = shadeColor(base, -15);
    expect(lighter.a).toBe(0.7);
    // red stays the dominant channel; lighter is brighter overall than darker.
    expect(lighter.r).toBeGreaterThan(lighter.g);
    expect(lighter.r + lighter.g + lighter.b).toBeGreaterThan(darker.r + darker.g + darker.b);
  });

  it("clamps lightness at the extremes", () => {
    expect(shadeColor({ r: 255, g: 255, b: 255, a: 1 }, 50)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(shadeColor({ r: 0, g: 0, b: 0, a: 1 }, -50)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });
});
