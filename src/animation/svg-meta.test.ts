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
    expect(parseSvgIntrinsicSize('<svg width="0" height="0">')).toBeNull();
    expect(parseSvgIntrinsicSize('<svg viewBox="0 0 0 10">')).toBeNull();
  });
  it("lets width/height win over a conflicting viewBox (Blink: viewBox is only a ratio)", () => {
    expect(parseSvgIntrinsicSize('<svg viewBox="0 0 1280 720" width="640" height="360">')).toEqual({ w: 640, h: 360 });
  });
  it("accepts single quotes and whitespace around values", () => {
    expect(parseSvgIntrinsicSize("<svg width=' 300 ' height='150px'>")).toEqual({ w: 300, h: 150 });
    expect(parseSvgIntrinsicSize("<svg viewBox='0,0,320,180'>")).toEqual({ w: 320, h: 180 });
    expect(parseSvgIntrinsicSize('<svg viewBox=" -10 -10 320 180 ">')).toEqual({ w: 320, h: 180 });
  });
  it("converts absolute units to px", () => {
    expect(parseSvgIntrinsicSize('<svg width="1in" height="72pt">')).toEqual({ w: 96, h: 96 });
    const mm = parseSvgIntrinsicSize('<svg width="25.4mm" height="2.54cm">');
    expect(mm?.w).toBeCloseTo(96, 9);
    expect(mm?.h).toBeCloseTo(96, 9);
    expect(parseSvgIntrinsicSize('<svg width="1PC" height="1e2">')).toEqual({ w: 16, h: 100 });
  });
  it("treats 0, negative, percentage, auto and font-relative sizes as no natural size", () => {
    expect(parseSvgIntrinsicSize('<svg width="0" height="0" viewBox="0 0 200 100">')).toEqual({ w: 200, h: 100 });
    expect(parseSvgIntrinsicSize('<svg width="-5" height="10" viewBox="0 0 200 100">')).toEqual({ w: 200, h: 100 });
    expect(parseSvgIntrinsicSize('<svg width="auto" height="auto" viewBox="0 0 200 100">')).toEqual({ w: 200, h: 100 });
    expect(parseSvgIntrinsicSize('<svg width="10em" height="5em" viewBox="0 0 200 100">')).toEqual({ w: 200, h: 100 });
  });
  it("derives a single missing dimension from the viewBox ratio", () => {
    expect(parseSvgIntrinsicSize('<svg width="400" viewBox="0 0 200 100">')).toEqual({ w: 400, h: 200 });
    expect(parseSvgIntrinsicSize('<svg height="50" viewBox="0 0 200 100">')).toEqual({ w: 100, h: 50 });
    expect(parseSvgIntrinsicSize('<svg width="400" height="100%" viewBox="0 0 200 100">')).toEqual({ w: 400, h: 200 });
  });
  it("does not read width from a hyphenated attribute such as stroke-width", () => {
    expect(parseSvgIntrinsicSize('<svg stroke-width="2" data-height="3" viewBox="0 0 200 100">')).toEqual({
      w: 200,
      h: 100,
    });
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
