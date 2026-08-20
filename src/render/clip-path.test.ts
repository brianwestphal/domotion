import { describe, expect, it } from "vitest";
import { svgEffectReferenceBox, type SvgEffectGeometryBox } from "./clip-path.js";

describe("svgEffectReferenceBox (DM-2328)", () => {
  const boxes = {
    fillBox: { x: 60, y: 30, width: 80, height: 40 },
    strokeBox: { x: 50, y: 20, width: 100, height: 60 },
    viewport: { width: 200, height: 120 },
  };

  it.each([
    ["content-box", boxes.fillBox], ["padding-box", boxes.fillBox], ["fill-box", boxes.fillBox],
    ["border-box", boxes.strokeBox], ["margin-box", boxes.strokeBox], ["stroke-box", boxes.strokeBox],
    ["view-box", { x: 0, y: 0, width: 200, height: 120 }],
  ] as Array<[SvgEffectGeometryBox, { x: number; y: number; width: number; height: number }]>)
  ("maps %s through Blink's SVG effect reference-box classes", (geometryBox, expected) => {
    expect(svgEffectReferenceBox(boxes, geometryBox)).toEqual(expected);
  });
});
