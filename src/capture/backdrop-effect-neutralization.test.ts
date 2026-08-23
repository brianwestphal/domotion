import { describe, expect, it } from "vitest";

import { backdropNeutralizationDeclarations } from "./backdrop-effect-neutralization.js";

describe("DM-2487 backdrop screenshot neutralization", () => {
  it("lowers every SVG-owned ancestor effect without erasing backdrop input", () => {
    expect(backdropNeutralizationDeclarations([
      "opacity",
      "filter",
      "clip-path",
      "mask",
    ])).toEqual([
      ["opacity", "1"],
      ["filter", "none"],
      ["clip-path", "none"],
      ["mask", "none"],
      ["-webkit-mask", "none"],
    ]);
  });

  it("uses the same containing-block-preserving rotate/skew freeze as capture", () => {
    expect(backdropNeutralizationDeclarations(["rotate-skew"])).toEqual([
      ["transform", "translate(0)"],
      ["translate", "none"],
      ["rotate", "none"],
      ["scale", "none"],
    ]);
  });
});
