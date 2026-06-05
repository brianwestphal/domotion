import { describe, expect, it } from "vitest";
import { clampCrop, cropSvgViewBox } from "./crop.js";

describe("clampCrop (DM-1104)", () => {
  it("returns the rect unchanged when fully inside the frame", () => {
    expect(clampCrop({ x: 10, y: 20, w: 100, h: 50 }, 400, 300)).toEqual({ x: 10, y: 20, w: 100, h: 50 });
  });
  it("clamps a rect that overflows the frame edges", () => {
    expect(clampCrop({ x: -20, y: -10, w: 500, h: 400 }, 400, 300)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });
  it("clamps the far edge", () => {
    expect(clampCrop({ x: 350, y: 250, w: 100, h: 100 }, 400, 300)).toEqual({ x: 350, y: 250, w: 50, h: 50 });
  });
  it("returns null for a zero/negative-area or off-canvas rect", () => {
    expect(clampCrop({ x: 0, y: 0, w: 0, h: 100 }, 400, 300)).toBeNull();
    expect(clampCrop({ x: 500, y: 0, w: 100, h: 100 }, 400, 300)).toBeNull();
  });
});

describe("cropSvgViewBox (DM-1104)", () => {
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600"><rect x="0" y="0" width="800" height="600" fill="#111"/><circle cx="400" cy="300" r="50"/></svg>`;

  it("rewrites viewBox + width + height to the crop rect", () => {
    const out = cropSvgViewBox(SVG, { x: 100, y: 80, w: 300, h: 200 });
    expect(out).toMatch(/viewBox="100 80 300 200"/);
    expect(out).toMatch(/width="300"/);
    expect(out).toMatch(/height="200"/);
    // exactly one viewBox / width / height on the root
    expect(out.match(/viewBox=/g)).toHaveLength(1);
    // content is untouched
    expect(out).toContain('<circle cx="400" cy="300" r="50"/>');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("forces overflow:hidden on the root and merges an existing style", () => {
    const styled = `<svg xmlns="http://www.w3.org/2000/svg" style="overflow:visible;background:#000" viewBox="0 0 10 10" width="10" height="10"></svg>`;
    const out = cropSvgViewBox(styled, { x: 1, y: 1, w: 4, h: 4 });
    expect(out).toMatch(/style="overflow:hidden;background:#000;?"/);
    expect(out).not.toMatch(/overflow:visible/);
  });

  it("adds width/height/viewBox even when the source lacks them", () => {
    const bare = `<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`;
    const out = cropSvgViewBox(bare, { x: 0, y: 0, w: 50, h: 40 });
    expect(out).toMatch(/viewBox="0 0 50 40"/);
    expect(out).toMatch(/width="50"/);
    expect(out).toMatch(/height="40"/);
  });

  it("throws when there is no <svg>", () => {
    expect(() => cropSvgViewBox("<div></div>", { x: 0, y: 0, w: 1, h: 1 })).toThrow(/no <svg>/);
  });
});
