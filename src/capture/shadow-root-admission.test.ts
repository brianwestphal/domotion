import { describe, expect, it } from "vitest";
import { parseBoxShadow } from "../render/box-shadow.js";
import { curvedCornerShapes, shadowOnlyRootIsAdmissible } from "./shadow-root-admission.js";

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
  it("refuses a normal layer drawn through a non-round curved corner", () => {
    expect(admits("4px 4px 0 red", ["round", "bevel"])).toBe(false);
    expect(admits("4px 4px 0 red", ["round", "round"])).toBe(true);
    expect(admits("4px 4px 0 red", [""])).toBe(true);
  });
  it("refuses a normal layer drawn through a border-shape", () => {
    expect(admits("4px 4px 0 red", [], "circle(50%)")).toBe(false);
    expect(admits("4px 4px 0 red", [], "")).toBe(true);
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
