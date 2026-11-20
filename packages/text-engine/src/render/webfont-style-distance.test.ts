import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __pickWebfontVariantMetaForCodepointForTest,
  __pickWebfontVariantMetaForTest,
  clearWebfonts,
  quantizeFontSelectionValue,
  registerWebfont,
  webfontRequestSlope,
  webfontStyleDistance,
} from "./webfont-registry.js";

// Blink's FontSelectionAlgorithm::StyleDistance
// (platform/fonts/font_selection_algorithm.cc:53-96, Chromium 7d859f27), by branch.
describe("webfontStyleDistance transcription", () => {
  const bounds = { min: -30, max: 30 };
  it.each<[readonly [number, number], number, number, string]>([
    // [caps, request, expected, branch]
    [[-10, 10], 0, 0, "range includes the request"],
    [[14, 14], 14, 0, "italic face, italic request"],
    // request >= 14
    [[20, 25], 14, 6, ">=14: face above scores its gap"],
    [[0, 0], 14, 30, ">=14: face below scores from max(request, bounds.max)"],
    [[0, 0], 40, 40, ">=14: request above the bounds is its own threshold"],
    // 0 <= request < 14
    [[0, 3], 5, 2, "[0,14): face top in [0, request) scores its gap"],
    [[8, 9], 5, 8, "[0,14): face above scores its own minimum (line 73)"],
    [[-4, -2], 5, 32, "[0,14): face below zero scores from max(request, bounds.max)"],
    [[3, 3], 0, 3, "[0,14): normal request, face above zero scores its minimum"],
    [[-3, -3], 0, 33, "[0,14): normal request, face below zero"],
    // -14 < request < 0
    [[-2, 0], -5, 3, "(-14,0): face bottom in (request, 0] scores its gap"],
    [[-9, -8], -5, 8, "(-14,0): face below scores -maximum (line 84)"],
    [[4, 6], -5, 34, "(-14,0): face above zero scores from min(request, bounds.min)"],
    // request <= -14
    [[-20, -18], -14, 4, "<=-14: face below scores its gap"],
    [[-5, -5], -20, 25, "<=-14: face above scores from min(request, bounds.min)"],
  ])("%j at %d → %d (%s)", (caps, request, expected) => {
    expect(webfontStyleDistance(caps, request, bounds)).toBe(expected);
  });

  it("uses the request, not the bounds, when the request is outside them", () => {
    expect(webfontStyleDistance([-5, -5], -60, { min: -30, max: 30 })).toBe(55);
  });
});

describe("FontSelectionValue quantization", () => {
  it.each([
    [10.3, 10.25],
    [13.9, 13.75],
    [14.1, 14],
    [-10.3, -10.25],
    [9000, 8191.75],
  ])("%d → %d", (input, expected) => {
    expect(quantizeFontSelectionValue(input)).toBe(expected);
  });

  it("maps the pickers' slant to Blink's request slope", () => {
    expect(webfontRequestSlope(0)).toBe(0);
    expect(webfontRequestSlope(-9.99)).toBe(14);
    expect(webfontRequestSlope(-9.99, -10.3)).toBe(-10.25);
    expect(webfontRequestSlope(0, 20)).toBe(20);
  });
});

const font = readFileSync(new URL("../../assets/fonts/fixture/DomotionFixtureMono-Regular.ttf", import.meta.url));
const face = (family: string, style: string) =>
  expect(registerWebfont(family, 400, style, font, undefined, "100%", "400", style)).toBe(true);

beforeEach(() => clearWebfonts());
afterEach(() => clearWebfonts());

// Two capability groups that differ only in slope. The legacy boolean rule
// called every non-normal descriptor "italic", tied them, and took the last
// declaration; StyleDistance separates them, so the winner must not depend on
// source order.
describe("capability-group selection by StyleDistance", () => {
  it.each([
    {
      name: "italic request prefers italic over oblique 0-12",
      request: 14,
      a: "oblique 0deg 12deg",
      b: "italic",
      win: "b",
    },
    {
      name: "normal request prefers a low oblique over italic",
      request: 0,
      a: "oblique 5deg 10deg",
      b: "italic",
      win: "a",
    },
    { name: "negative oblique request", request: -10, a: "oblique -20deg", b: "oblique 5deg", win: "a" },
    { name: "steep oblique request", request: 20, a: "oblique 30deg", b: "oblique 10deg", win: "a" },
    { name: "shallow oblique request", request: 5, a: "oblique 10deg", b: "oblique -2deg", win: "a" },
    { name: "steep negative request", request: -20, a: "oblique -30deg", b: "oblique -5deg", win: "a" },
    { name: "quantized descriptors", request: 14, a: "oblique 13.9deg", b: "oblique 14.1deg", win: "b" },
  ])("$name, in both declaration orders", ({ request, a, b, win }) => {
    const winner = win === "a" ? a : b;
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      clearWebfonts();
      for (const style of order) face("Slope", style);
      const picked = __pickWebfontVariantMetaForTest("Slope", 400, request !== 0, 100, request);
      expect(picked?.declarationIndex).toBe(order.indexOf(winner));
      const perCodepoint = __pickWebfontVariantMetaForCodepointForTest("Slope", 400, request !== 0, 0x41, 100, request);
      expect(perCodepoint?.declarationIndex).toBe(order.indexOf(winner));
    }
  });

  it("keeps style above weight", () => {
    registerWebfont("Order", 400, "italic", font, undefined, "100%", "400", "oblique 20deg");
    registerWebfont("Order", 900, "italic", font, undefined, "100%", "900", "oblique 12deg");
    // Request oblique 12deg at weight 400: the slope match wins despite weight.
    expect(__pickWebfontVariantMetaForTest("Order", 400, true, 100, 12)?.declarationIndex).toBe(1);
  });
});

describe("descriptor-less inference stays outside Blink's capabilities", () => {
  it("still prefers an inferred italic face for an italic request", () => {
    registerWebfont("Inferred", 400, "italic", font);
    registerWebfont("Inferred", 400, "normal", font);
    expect(__pickWebfontVariantMetaForTest("Inferred", 400, true)?.declarationIndex).toBe(0);
    expect(__pickWebfontVariantMetaForTest("Inferred", 400, false)?.declarationIndex).toBe(1);
  });

  it("does not penalize a CSS face whose font-style descriptor is absent", () => {
    // `""` is how capture passes an absent descriptor. Both faces select as
    // normal style [0, 0] in one group, so the last declaration wins for an
    // italic request regardless of the defaulted `normal` flag.
    registerWebfont("Auto", 400, "normal", font, undefined, "100%", "400", "normal");
    registerWebfont("Auto", 400, "normal", font, undefined, "100%", "400", "");
    expect(__pickWebfontVariantMetaForTest("Auto", 400, true)?.declarationIndex).toBe(1);
    expect(__pickWebfontVariantMetaForTest("Auto", 400, true)?.slopeCaps).toBeUndefined();
  });
});
