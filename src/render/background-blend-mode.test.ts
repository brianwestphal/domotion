import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";

const BASE_STYLES = {
  backgroundColor: "rgb(255,0,0)",
  backgroundImage: "linear-gradient(rgb(0,128,128), rgb(0,128,128))",
  backgroundSize: "auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat",
  backgroundClip: "border-box", backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  backgroundBlendMode: "multiply",
  borderWidth: "0", borderRadius: "0", borderTopLeftRadius: "0", borderTopRightRadius: "0",
  borderBottomRightRadius: "0", borderBottomLeftRadius: "0", borderTopWidth: "0", borderRightWidth: "0",
  borderBottomWidth: "0", borderLeftWidth: "0", borderTopStyle: "none", borderRightStyle: "none",
  borderBottomStyle: "none", borderLeftStyle: "none", borderColor: "rgb(0,0,0)",
  borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)",
  borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
  color: "rgb(0,0,0)", fontSize: "16px",
  fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal", lineHeight: "normal",
  letterSpacing: "normal", textAlign: "left", textTransform: "none", textDecoration: "none",
  whiteSpace: "normal", direction: "ltr", writingMode: "horizontal-tb", boxShadow: "none",
  opacity: "1", transform: "none", visibility: "visible", overflowX: "visible", overflowY: "visible",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0", display: "block",
  position: "static", zIndex: "auto", mixBlendMode: "normal", filter: "none", backdropFilter: "none",
  outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0",
} as unknown as CapturedElement["styles"];

function render(backgroundBlendMode: string): string {
  const element: CapturedElement = {
    tag: "div", text: "", x: 0, y: 0, width: 100, height: 80, children: [],
    styles: { ...BASE_STYLES, backgroundBlendMode },
  };
  return elementTreeToSvgInner([element], 100, 80);
}

describe("background-blend-mode paint stack", () => {
  it("isolates the background color together with blended image layers", () => {
    const svg = render("multiply");
    const group = svg.match(/<g style="isolation:isolate">([\s\S]*?)<\/g>/)?.[1] ?? "";

    expect(group).toContain('fill="rgb(255,0,0)"');
    expect(group).toContain('style="mix-blend-mode:multiply"');
    expect(group.indexOf('fill="rgb(255,0,0)"')).toBeLessThan(group.indexOf('style="mix-blend-mode:multiply"'));
  });

  it("does not add an isolation group when every layer uses normal blending", () => {
    expect(render("normal")).not.toContain('style="isolation:isolate"');
  });
});
