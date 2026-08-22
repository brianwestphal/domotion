import { describe, expect, it } from "vitest";
import { parseSameDocumentClipPathUrl, svgEffectReferenceBox, type SvgEffectGeometryBox } from "./clip-path.js";

describe("parseSameDocumentClipPathUrl", () => {
  it.each([
    ["url(#clip)", "clip"],
    ['url("#clip")', "clip"],
    ["url( '#clip' )", "clip"],
  ])("accepts Blink's exclusive URL-reference syntax: %s", (value, expected) => {
    expect(parseSameDocumentClipPathUrl(value)).toBe(expected);
  });

  it.each([
    "url(#clip) content-box",
    "url(#clip) padding-box",
    "url(#clip) border-box",
    "url(#clip) margin-box",
    "url(#clip) fill-box",
    "url(#clip) stroke-box",
    "url(#clip) view-box",
    "padding-box url(#clip)",
    "url(other.svg#clip)",
    "none",
  ])("rejects a non-reference operation or trailing geometry box: %s", (value) => {
    expect(parseSameDocumentClipPathUrl(value)).toBeNull();
  });
});

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
