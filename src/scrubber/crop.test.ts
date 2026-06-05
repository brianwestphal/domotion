import { describe, expect, it } from "vitest";
import { clampCrop, constrainResizeToAspect, cropSvgViewBox, fitRectToAspect } from "./crop.js";

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

describe("constrainResizeToAspect (DM-1107)", () => {
  it("se corner with 1:1 keeps the nw corner fixed and squares off (width authoritative)", () => {
    const free = { x: 0, y: 0, w: 200, h: 100 };
    expect(constrainResizeToAspect(free, "se", 1, 400, 400, 8)).toEqual({ x: 0, y: 0, w: 200, h: 200 });
  });
  it("nw corner with 1:1 keeps the se corner fixed", () => {
    const free = { x: 50, y: 50, w: 150, h: 150 };
    expect(constrainResizeToAspect(free, "nw", 1, 400, 400, 8)).toEqual({ x: 50, y: 50, w: 150, h: 150 });
  });
  it("e edge derives height from width and grows symmetrically about the vertical center", () => {
    const free = { x: 0, y: 100, w: 300, h: 100 };
    // ar=2 → h=150; vertical center stays at 150 → y = 150 - 75
    expect(constrainResizeToAspect(free, "e", 2, 400, 400, 8)).toEqual({ x: 0, y: 75, w: 300, h: 150 });
  });
  it("n edge derives width from height and grows symmetrically about the horizontal center", () => {
    const free = { x: 100, y: 0, w: 200, h: 100 };
    // height authoritative (n is vertical) → ar=1 → w=100; horizontal center 200 → x = 200 - 50
    expect(constrainResizeToAspect(free, "n", 1, 400, 400, 8)).toEqual({ x: 150, y: 0, w: 100, h: 100 });
  });
  it("ratio-preservingly clamps to the frame when the derived size overflows", () => {
    const free = { x: 0, y: 0, w: 380, h: 100 };
    // se, ar=1 → h=380 but frameH=300 → shrink to 300×300
    expect(constrainResizeToAspect(free, "se", 1, 400, 300, 8)).toEqual({ x: 0, y: 0, w: 300, h: 300 });
  });
  it("returns the free rect unchanged for a non-positive ratio", () => {
    const free = { x: 1, y: 2, w: 3, h: 4 };
    expect(constrainResizeToAspect(free, "se", 0, 400, 400, 8)).toEqual(free);
  });
});

describe("fitRectToAspect (DM-1107)", () => {
  it("snaps a wide rect to 1:1 inside its own box, keeping the center", () => {
    // {0,0,200,100} center (100,50); ar=1 → fits to 100×100 inside the box
    expect(fitRectToAspect({ x: 0, y: 0, w: 200, h: 100 }, 1, 400, 400)).toEqual({ x: 50, y: 0, w: 100, h: 100 });
  });
  it("clamps the snapped rect into the frame", () => {
    // tall rect near the bottom edge, ar=1 → 100×100 centered then clamped up
    const out = fitRectToAspect({ x: 0, y: 250, w: 100, h: 100 }, 1, 300, 300);
    expect(out).toEqual({ x: 0, y: 200, w: 100, h: 100 });
  });
  it("returns the rect unchanged for a non-positive ratio", () => {
    const rect = { x: 5, y: 6, w: 7, h: 8 };
    expect(fitRectToAspect(rect, 0, 400, 400)).toEqual(rect);
  });
});
