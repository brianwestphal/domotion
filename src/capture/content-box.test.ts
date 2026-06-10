import { describe, it, expect } from "vitest";
import { boxAnchorPoint } from "./content-box.js";

/**
 * DM-1133: the corner/edge/center math behind `contentBox(page, selector, { at,
 * dx, dy })`. The page-measurement half needs a browser (covered by the
 * scripting-API probe), but the anchor-point resolution is pure and pinned here
 * — it must match the declarative overlay `anchor.at` vocabulary exactly.
 */
describe("boxAnchorPoint (DM-1133)", () => {
  const box = { x: 100, y: 200, width: 40, height: 20 }; // center (120,210), right 140, bottom 220

  it("resolves all nine named anchors", () => {
    expect(boxAnchorPoint(box, "top-left")).toEqual([100, 200]);
    expect(boxAnchorPoint(box, "top")).toEqual([120, 200]);
    expect(boxAnchorPoint(box, "top-right")).toEqual([140, 200]);
    expect(boxAnchorPoint(box, "left")).toEqual([100, 210]);
    expect(boxAnchorPoint(box, "center")).toEqual([120, 210]);
    expect(boxAnchorPoint(box, "right")).toEqual([140, 210]);
    expect(boxAnchorPoint(box, "bottom-left")).toEqual([100, 220]);
    expect(boxAnchorPoint(box, "bottom")).toEqual([120, 220]);
    expect(boxAnchorPoint(box, "bottom-right")).toEqual([140, 220]);
  });

  it("defaults to top-left", () => {
    expect(boxAnchorPoint(box)).toEqual([100, 200]);
  });

  it("applies the dx/dy nudge", () => {
    expect(boxAnchorPoint(box, "top-left", 5, -3)).toEqual([105, 197]);
    expect(boxAnchorPoint(box, "center", -10, 4)).toEqual([110, 214]);
  });
});
