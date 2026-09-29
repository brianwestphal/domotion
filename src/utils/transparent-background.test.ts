import { describe, expect, it } from "vitest";
import { TRANSPARENT_BLACK, isPaintedColor, isTransparentBackground } from "./transparent-background.js";

describe("isPaintedColor / TRANSPARENT_BLACK", () => {
  it("treats null, empty and every transparent spelling as not painted", () => {
    for (const c of [
      undefined,
      null,
      "",
      "transparent",
      "rgba(0, 0, 0, 0)",
      "rgba(0,0,0,0)",
      "#0000",
      "hsla(0 0% 0% / 0)",
    ]) {
      expect(isPaintedColor(c)).toBe(false);
    }
  });

  it("treats real colors, including translucent ones, as painted", () => {
    for (const c of ["red", "rgb(0, 0, 0)", "rgba(0, 0, 0, 0.5)", "#000", "#00000080"]) {
      expect(isPaintedColor(c)).toBe(true);
    }
  });

  it("TRANSPARENT_BLACK is itself transparent", () => {
    expect(isTransparentBackground(TRANSPARENT_BLACK)).toBe(true);
  });
});
