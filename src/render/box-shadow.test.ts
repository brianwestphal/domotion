import { describe, it, expect } from "vitest";
import { parseBoxShadow } from "./box-shadow.js";

describe("parseBoxShadow", () => {
  it("returns [] for none / empty", () => {
    expect(parseBoxShadow("none")).toEqual([]);
    expect(parseBoxShadow("")).toEqual([]);
    expect(parseBoxShadow(undefined as unknown as string)).toEqual([]);
  });

  it("parses a full color-first shadow (x y blur spread)", () => {
    expect(parseBoxShadow("rgb(0, 0, 0) 2px 4px 6px 8px")).toEqual([
      { inset: false, x: 2, y: 4, blur: 6, spread: 8, color: "rgb(0, 0, 0)" },
    ]);
  });

  it("parses the inset keyword and partial lengths", () => {
    expect(parseBoxShadow("rgba(0,0,0,0.5) 1px 2px inset")).toEqual([
      { inset: true, x: 1, y: 2, blur: 0, spread: 0, color: "rgba(0,0,0,0.5)" },
    ]);
  });

  it("recovers a trailing (non-functional) color token", () => {
    expect(parseBoxShadow("2px 4px red")).toEqual([
      { inset: false, x: 2, y: 4, blur: 0, spread: 0, color: "red" },
    ]);
  });

  it("defaults to currentcolor when no color is present", () => {
    expect(parseBoxShadow("3px 3px")).toEqual([
      { inset: false, x: 3, y: 3, blur: 0, spread: 0, color: "currentcolor" },
    ]);
  });

  it("splits multiple comma-separated layers (respecting parens in color funcs)", () => {
    const shadows = parseBoxShadow("rgba(0, 0, 0, 0.5) 1px 2px 3px, rgb(255, 0, 0) 4px 5px");
    expect(shadows).toHaveLength(2);
    expect(shadows[0]).toMatchObject({ x: 1, y: 2, blur: 3, color: "rgba(0, 0, 0, 0.5)" });
    expect(shadows[1]).toMatchObject({ x: 4, y: 5, blur: 0, color: "rgb(255, 0, 0)" });
  });

  it("parses negative offsets and skips blank layers", () => {
    expect(parseBoxShadow("rgb(1,2,3) -2px -4px,  ")).toEqual([
      { inset: false, x: -2, y: -4, blur: 0, spread: 0, color: "rgb(1,2,3)" },
    ]);
  });
});
