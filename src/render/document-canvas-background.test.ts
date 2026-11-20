import { describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import { capturedElement } from "../test-support/captured-fixtures.js";
import type { CapturedElement } from "../capture/types.js";

// DM-GFE90Q: a <body> whose background moved to the view paints it as the
// document canvas (whole canvas, positioned against the root box), before any
// content, and not on its own box.
const rootBox = {
  x: 0,
  y: 0,
  width: 120,
  height: 60,
  borderTopWidth: "3px",
  borderRightWidth: "3px",
  borderBottomWidth: "3px",
  borderLeftWidth: "3px",
  paddingTop: "7px",
  paddingRight: "7px",
  paddingBottom: "7px",
  paddingLeft: "7px",
};
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function body(overrides: Partial<CapturedElement> = {}, image = "none"): CapturedElement {
  return capturedElement({
    tag: "body",
    text: "",
    x: 20,
    y: 20,
    width: 80,
    height: 30,
    styles: {
      backgroundColor: "rgb(0, 200, 255)",
      backgroundImage: image,
      backgroundSize: "15px 15px",
      backgroundPosition: "5px 5px",
      backgroundRepeat: "repeat",
      backgroundClip: "padding-box",
      backgroundOrigin: "padding-box",
      backgroundAttachment: "scroll",
      color: "black",
      borderColor: "black",
    },
    children: [
      capturedElement({
        tag: "div",
        text: "",
        x: 30,
        y: 30,
        width: 10,
        height: 10,
        children: [],
        styles: { backgroundColor: "rgb(128, 0, 128)", color: "black", borderColor: "black" },
      }),
    ],
    ...overrides,
  });
}

describe("document canvas background (DM-GFE90Q)", () => {
  it("paints a transferred body color over the whole canvas first and not on the body box", () => {
    const svg = elementTreeToSvgInner([body({ backgroundTransfersToView: true, documentRootBox: rootBox })], 120, 120);
    const canvas = svg.indexOf('<rect x="0" y="0" width="120" height="120" fill="rgb(0,200,255)" />');
    expect(canvas).toBeGreaterThanOrEqual(0);
    expect(canvas).toBeLessThan(svg.indexOf("rgb(128,0,128)"));
    expect(svg.match(/rgb\(0,200,255\)/g)).toHaveLength(1);
  });

  it("keeps the body box background when the background did not transfer", () => {
    const legacy = elementTreeToSvgInner([body({ documentRootBox: rootBox })], 120, 120);
    expect(legacy).not.toContain('width="120" height="120" fill="rgb(0,200,255)"');
    expect(legacy).toContain("rgb(0,200,255)");
    // A transfer flag without the root positioning area keeps the legacy box.
    expect(elementTreeToSvgInner([body({ backgroundTransfersToView: true })], 120, 120)).toEqual(
      elementTreeToSvgInner([body()], 120, 120),
    );
  });

  it("positions image layers against the root box and paints them over the canvas", () => {
    const svg = elementTreeToSvgInner(
      [body({ backgroundTransfersToView: true, documentRootBox: rootBox }, `url("${png}")`)],
      120,
      120,
    );
    // Padding-box origin of the root box (border 3) plus the 5px position: a
    // tile phase of 8 px modulo the 15 px tile on both axes.
    const tile = /<pattern [^>]*x="(-?[\d.]+)" y="(-?[\d.]+)" width="15" height="15"/.exec(svg);
    expect(tile).not.toBeNull();
    expect((((Number(tile![1]) - 8) % 15) + 15) % 15).toBe(0);
    expect((((Number(tile![2]) - 8) % 15) + 15) % 15).toBe(0);
    expect(svg).toMatch(/<rect x="0" y="0" width="120" height="120" rx="0" fill="url\(#bg\d+\)"/);
  });
});
