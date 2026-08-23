import { describe, expect, it } from "vitest";

import { backdropLayerMapping, invertBackdropAffine } from "./backdrop-layer-space.js";

describe("DM-2497 Blink/Skia backdrop layer mapping", () => {
  it("solves the neutral border box to the live compositor quad", () => {
    const mapping = backdropLayerMapping(
      { x: 54, y: 192, width: 110, height: 72 },
      [58.633279, 195.528028, 168.622554, 197.063868, 167.617277, 269.056849, 57.627999, 267.521009],
    );
    expect(mapping).not.toBeNull();
    expect(mapping!.forward.slice(0, 4)).toEqual(expect.arrayContaining([
      expect.closeTo(0.9999025, 6),
      expect.closeTo(0.0139622, 6),
      expect.closeTo(-0.0139622, 6),
      expect.closeTo(0.9999025, 6),
    ]));
    expect(mapping!.bounds).toEqual(expect.objectContaining({
      x: expect.closeTo(57.627999, 6),
      y: expect.closeTo(195.528028, 6),
    }));
  });

  it("returns the exact inverse and rejects a singular mapping", () => {
    expect(invertBackdropAffine([2, 0, 0, 4, 8, 12])).toEqual([0.5, -0, -0, 0.25, -4, -3]);
    expect(invertBackdropAffine([1, 2, 2, 4, 0, 0])).toBeNull();
  });
});
