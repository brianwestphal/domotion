import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvg } from "./element-tree-to-svg.js";

const styles = {
  backgroundColor: "rgb(255,0,0)", backgroundImage: "none", borderWidth: "0", borderColor: "rgb(0,0,0)",
  borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  borderRadius: "0", color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif",
  fontWeight: "400", fontStyle: "normal", opacity: "1", transform: "none",
  overflowX: "visible", overflowY: "visible", display: "block", position: "static",
  zIndex: "auto", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", boxShadow: "none",
} as unknown as CapturedElement["styles"];

function projected(hidden = false): CapturedElement {
  return {
    tag: "div", text: "", x: 10, y: 20, width: 100, height: 50, children: [], styles,
    projectiveTransform: [0.8, 0.1, 12, -0.2, 0.9, 7, 0, 0, 1],
    projectiveHidden: hidden,
  } as CapturedElement;
}

describe("static CSS 3D plane projection", () => {
  it("keeps the painted plane vector and applies its measured relative matrix", () => {
    const svg = elementTreeToSvg([projected()], 200, 120);
    expect(svg).toContain('transform="matrix(0.8 -0.2 0.1 0.9 12 7)"');
    expect(svg).toContain('<rect x="10" y="20" width="100" height="50"');
    expect(svg).not.toContain("<image");
  });

  it("does not paint a reverse-facing hidden plane", () => {
    const svg = elementTreeToSvg([projected(true)], 200, 120);
    expect(svg).not.toContain('fill="rgb(255,0,0)"');
  });
});
