import { describe, expect, it } from "vitest";
import { parseBoxShadow } from "../render/box-shadow.js";
import { curvedCornerShapes, shadowOnlyRootIsAdmissible, sharpBorderRadii } from "./shadow-root-admission.js";

const admits = (shadow: string, shapes: string[] = [], borderShape = "none") =>
  shadowOnlyRootIsAdmissible(parseBoxShadow(shadow), shapes, borderShape);

describe("shadowOnlyRootIsAdmissible", () => {
  it("refuses an empty list", () => {
    expect(admits("none")).toBe(false);
  });
  it("keeps inset-only lists admitted, blurred or not", () => {
    expect(admits("inset 0 0 0 3px red")).toBe(true);
    expect(admits("inset 0 0 3px red, inset 0 0 0 2px blue")).toBe(true);
  });
  it("admits zero-blur normal and mixed lists", () => {
    expect(admits("4px 4px 0 red")).toBe(true);
    expect(admits("4px 4px 0 red, -4px -4px 0 2px blue")).toBe(true);
    expect(admits("inset 0 0 0 3px blue, 4px 4px 0 red")).toBe(true);
  });
  it("refuses a blurred normal layer and a blurred inset layer mixed with a normal one", () => {
    expect(admits("4px 4px 4px red")).toBe(false);
    expect(admits("4px 4px 0 red, 0 0 1px blue")).toBe(false);
    expect(admits("inset 0 0 2px red, 4px 4px 0 blue")).toBe(false);
  });
  describe("a blurred normal layer (DM-RRWR8E)", () => {
    const sharp = { left: 20, top: 20, width: 10, height: 10, sharp: true };
    const withBox = (shadow: string, box = sharp) =>
      shadowOnlyRootIsAdmissible(parseBoxShadow(shadow), [], "none", box);
    it("admits a lone box-blurred layer on a sharp whole-pixel box", () => {
      expect(withBox("rgb(255, 0, 0) 4px 4px 8px 0px")).toBe(true);
      expect(withBox("rgba(0, 0, 0, 0.4) -3px 2px 6px 1px")).toBe(true);
      expect(withBox("rgb(0, 0, 255) 0px 0px 0px 3px inset, rgb(255, 0, 0) 4px 4px 9px 0px")).toBe(true);
    });
    it("refuses it without a box, on a rounded box, or on an analytic-profile rect", () => {
      expect(admits("rgb(255, 0, 0) 4px 4px 8px 0px")).toBe(false);
      expect(withBox("rgb(255, 0, 0) 4px 4px 8px 0px", { ...sharp, sharp: false })).toBe(false);
      expect(withBox("rgb(255, 0, 0) 4px 4px 4px 0px", { ...sharp, width: 20, height: 20 })).toBe(false);
    });
    it("refuses σ < 2, disagreeing windows, other colors and fractional rects", () => {
      expect(withBox("rgb(255, 0, 0) 4px 4px 3px 0px")).toBe(false);
      expect(withBox("rgb(255, 0, 0) 4px 4px 7px 0px")).toBe(false);
      expect(withBox("rgb(51, 102, 153) 4px 4px 8px 0px")).toBe(false);
      expect(withBox("rgb(255, 0, 0) 4.5px 4px 8px 0px")).toBe(false);
      expect(withBox("rgb(255, 0, 0) 4px 4px 8px 0px", { ...sharp, left: 20.5 })).toBe(false);
    });
    it("refuses a second normal layer or a blurred inset beside it", () => {
      expect(withBox("rgb(255, 0, 0) 4px 4px 8px 0px, rgb(0, 0, 255) -4px -4px 8px 0px")).toBe(false);
      expect(withBox("rgb(255, 0, 0) 4px 4px 8px 0px, rgb(0, 0, 255) 4px 4px 0px 0px")).toBe(false);
      expect(withBox("rgb(0, 0, 255) 0px 0px 2px 0px inset, rgb(255, 0, 0) 4px 4px 8px 0px")).toBe(false);
    });
  });
  it("refuses a normal layer drawn through a non-round curved corner", () => {
    expect(admits("4px 4px 0 red", ["round", "bevel"])).toBe(false);
    expect(admits("4px 4px 0 red", ["round", "round"])).toBe(true);
    expect(admits("4px 4px 0 red", [""])).toBe(true);
  });
  it("refuses an inset-only list drawn through a non-round curved corner or a border-shape", () => {
    expect(admits("inset 0 0 0 3px red", ["bevel"])).toBe(false);
    expect(admits("inset 0 0 0 3px red", ["round", "squircle"])).toBe(false);
    expect(admits("inset 0 0 0 3px red", [], "circle(50%)")).toBe(false);
    expect(admits("inset 0 0 0 3px red", ["round"])).toBe(true);
  });
  it("refuses a normal layer drawn through a border-shape", () => {
    expect(admits("4px 4px 0 red", [], "circle(50%)")).toBe(false);
    expect(admits("4px 4px 0 red", [], "")).toBe(true);
  });
});

describe("sharpBorderRadii", () => {
  it("is true only when every radius longhand is zero on both axes", () => {
    const read = (values: Record<string, string>) => (name: string) => values[name] ?? "0px";
    expect(sharpBorderRadii(read({}))).toBe(true);
    expect(sharpBorderRadii(read({ "border-top-left-radius": "0px 0px" }))).toBe(true);
    expect(sharpBorderRadii(read({ "border-bottom-right-radius": "5px" }))).toBe(false);
    expect(sharpBorderRadii(read({ "border-top-right-radius": "0px 3px" }))).toBe(false);
  });
});

describe("curvedCornerShapes", () => {
  const style =
    (values: Record<string, string>) =>
    (name: string): string =>
      values[name] ?? "";
  it("reads the shape of every corner with a nonzero radius on both axes", () => {
    expect(
      curvedCornerShapes(
        style({
          "border-top-left-radius": "5px",
          "corner-top-left-shape": "bevel",
          "border-top-right-radius": "8px 4px",
          "corner-top-right-shape": "round",
          "border-bottom-right-radius": "8px 0px",
          "corner-bottom-right-shape": "notch",
          "border-bottom-left-radius": "0px",
          "corner-bottom-left-shape": "squircle",
        }),
      ),
    ).toEqual(["bevel", "round"]);
  });
  it("yields no shapes for a sharp box", () => {
    expect(curvedCornerShapes(style({ "corner-top-left-shape": "bevel" }))).toEqual([]);
  });
});
