import { describe, it, expect } from "vitest";
import { parseSvgIntrinsicSize, detectAnimationPeriodMs } from "./svg-meta.js";

describe("parseSvgIntrinsicSize", () => {
  it("reads width/height attributes (unitless or px)", () => {
    expect(parseSvgIntrinsicSize('<svg width="640" height="320" viewBox="0 0 1 1">')).toEqual({ w: 640, h: 320 });
    expect(parseSvgIntrinsicSize('<svg width="640px" height="320px">')).toEqual({ w: 640, h: 320 });
  });
  it("falls back to viewBox when width/height are missing or non-px", () => {
    expect(parseSvgIntrinsicSize('<svg viewBox="0 0 800 600">')).toEqual({ w: 800, h: 600 });
    expect(parseSvgIntrinsicSize('<svg width="100%" height="100%" viewBox="0 0 200 100">')).toEqual({ w: 200, h: 100 });
  });
  it("returns null when neither is parseable", () => {
    expect(parseSvgIntrinsicSize('<svg width="100%" height="100%">')).toBeNull();
    expect(parseSvgIntrinsicSize("<svg>")).toBeNull();
  });
});

describe("detectAnimationPeriodMs", () => {
  it("reads --scene-dur when present", () => {
    expect(detectAnimationPeriodMs("<style>:root{--scene-dur: 13.60s}</style>")).toBe(13600);
  });
  it("falls back to the longest animation: shorthand duration", () => {
    const svg = "<style>.a{animation:k 4.000s linear infinite}.b{animation:k2 13.600s step-end infinite}</style>";
    expect(detectAnimationPeriodMs(svg)).toBe(13600);
  });
  it("returns undefined for a static SVG", () => {
    expect(detectAnimationPeriodMs("<svg><rect/></svg>")).toBeUndefined();
  });
});
