import { describe, expect, it } from "vitest";
import { requireField } from "./require-field.js";

describe("requireField", () => {
  it("returns present values unchanged, including falsy ones", () => {
    expect(requireField("x", "l")).toBe("x");
    expect(requireField(0, "l")).toBe(0);
    expect(requireField("", "l")).toBe("");
    expect(requireField(false, "l")).toBe(false);
  });

  it("throws a named error for null and undefined", () => {
    expect(() => requireField(undefined, "composite layer.svg")).toThrow(
      /composite layer\.svg is required but missing/,
    );
    expect(() => requireField(null, "x")).toThrow(/x is required/);
  });
});
