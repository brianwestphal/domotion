import { describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// DM-1244: <body>'s overflow only propagates to the viewport (so <body> renders
// WITHOUT its own clip) when <html> is `overflow: visible`. When <html> itself
// has a non-visible overflow it is the propagated one and <body> must apply its
// OWN overflow clip. The capture stamps <html>'s overflow on the root element as
// `rootOverflowX`/`rootOverflowY`; these tests lock the renderer's use of it.

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundSize: "auto",
  backgroundPosition: "0% 0%", backgroundRepeat: "repeat", backgroundClip: "border-box",
  backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
  borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
  lineHeight: "20px", letterSpacing: "normal", textAlign: "left", textTransform: "none",
  textDecoration: "none", textDecorationLine: "none", textDecorationStyle: "solid", textDecorationColor: "rgb(0,0,0)",
  textDecorationThickness: "auto", textUnderlineOffset: "auto", whiteSpace: "normal", wordSpacing: "0",
  verticalAlign: "baseline", direction: "ltr", writingMode: "horizontal-tb", textOverflow: "clip",
  cursor: "auto", caretColor: "auto", outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0",
  boxShadow: "none", opacity: "1", transform: "none", transformOrigin: "50% 50%", visibility: "visible",
  borderCollapse: "separate", overflowX: "visible", overflowY: "visible", scrollbarGutter: "auto",
  scrollWidth: 200, scrollHeight: 200, clientWidth: 200, clientHeight: 200, scrollTop: 0, scrollLeft: 0,
  objectFit: "fill", objectPosition: "50% 50%", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source", maskSize: "auto",
  maskPosition: "0% 0%", maskRepeat: "repeat", maskComposite: "add",
  listStyleType: "disc", listStyleImage: "none", display: "block", listStylePosition: "outside",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
  borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
  zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row",
} as unknown as CapturedElement["styles"];

/** A `<body>` with `overflow: hidden`, an overflowing child, and the given
 *  captured `<html>` overflow stamped on it (the root element). */
function bodyTree(rootOverflow: { x?: string; y?: string }): CapturedElement[] {
  const child: CapturedElement = {
    tag: "div", text: "", x: 0, y: 0, width: 200, height: 2000, children: [],
    styles: { ...BASE_STYLES, backgroundColor: "rgb(255,0,0)" },
  };
  const body: CapturedElement = {
    tag: "body", text: "", x: 0, y: 0, width: 400, height: 300, children: [child],
    styles: {
      ...BASE_STYLES, overflowX: "hidden", overflowY: "hidden",
      rootOverflowX: rootOverflow.x, rootOverflowY: rootOverflow.y,
    } as CapturedElement["styles"],
  };
  return [body];
}

describe("body→html overflow propagation (DM-1244)", () => {
  it("skips the body clip when <html> is overflow: visible (body propagates to viewport)", () => {
    const svg = elementTreeToSvgInner(bodyTree({ x: "visible", y: "visible" }), 400, 300);
    expect(svg).not.toContain("clip-path");
  });

  it("applies the body clip when <html> has a non-visible overflow", () => {
    const svg = elementTreeToSvgInner(bodyTree({ x: "hidden", y: "hidden" }), 400, 300);
    expect(svg).toContain("clip-path");
  });

  it("falls back to assume-visible (skip clip) for old captures without rootOverflow", () => {
    const svg = elementTreeToSvgInner(bodyTree({}), 400, 300);
    expect(svg).not.toContain("clip-path");
  });
});
