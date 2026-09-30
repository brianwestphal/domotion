import { describe, expect, it } from "vitest";
import { paintClipForLayer, parsePaintClipLayers } from "./paint-clip-layers.js";

describe("paint clip layers", () => {
  it("preserves the fallback and repeats shorter lists in layer order", () => {
    expect(parsePaintClipLayers(undefined)).toEqual(["border-box"]);
    expect([0, 1, 2, 3].map((index) => paintClipForLayer("text, padding-box", index))).toEqual([
      "text",
      "padding-box",
      "text",
      "padding-box",
    ]);
  });
});
