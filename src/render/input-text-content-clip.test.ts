import { describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// DM-1266: an <input>'s value text clips to the element's CONTENT box (inside
// border + padding), not the border box. Chrome paints an overflowing value
// clipped at the content edge — a long value shows "…cu" with the next glyph cut
// ~border+padding px inside the right border. Clipping to the border box let the
// overflowing glyph paint into the padding strip. The renderer insets the text
// clip horizontally by border + padding for <input>/<textarea>; these tests lock
// the emitted clip geometry (the perceptual diff reads a single extra glyph as a
// sub-% diff).

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundSize: "auto",
  backgroundPosition: "0% 0%", backgroundRepeat: "repeat", backgroundClip: "border-box",
  backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "1", borderRightWidth: "1", borderBottomWidth: "1", borderLeftWidth: "1",
  borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
  color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
  lineHeight: "20px", letterSpacing: "normal", textAlign: "left", textTransform: "none",
  textDecoration: "none", textDecorationLine: "none", textDecorationStyle: "solid", textDecorationColor: "rgb(0,0,0)",
  textDecorationThickness: "auto", textUnderlineOffset: "auto", whiteSpace: "normal", wordSpacing: "0",
  verticalAlign: "baseline", direction: "ltr", writingMode: "horizontal-tb", textOverflow: "clip",
  cursor: "auto", caretColor: "auto", outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0",
  boxShadow: "none", opacity: "1", transform: "none", transformOrigin: "50% 50%", visibility: "visible",
  borderCollapse: "separate", overflowX: "clip", overflowY: "clip", scrollbarGutter: "auto",
  scrollWidth: 200, scrollHeight: 200, clientWidth: 200, clientHeight: 200, scrollTop: 0, scrollLeft: 0,
  objectFit: "fill", objectPosition: "50% 50%", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source", maskSize: "auto",
  maskPosition: "0% 0%", maskRepeat: "repeat", maskComposite: "add",
  listStyleType: "disc", listStyleImage: "none", display: "inline-block", listStylePosition: "outside",
  paddingTop: "6", paddingRight: "10", paddingBottom: "6", paddingLeft: "10",
  borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
  zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row",
} as unknown as CapturedElement["styles"];

// input border-box: x=100..300 (w=200). border 1, padding 10 → content box
// x = 100+1+10 = 111, width = 200-2-20 = 178.
function inputTree(tag: "input" | "div"): CapturedElement[] {
  const el: CapturedElement = {
    tag, text: "Buenos Aires, Argentina (cut off)",
    x: 100, y: 100, width: 200, height: 32, children: [],
    textLeft: 111, textTop: 106, textWidth: 400, textHeight: 20, fontAscent: 15,
    styles: { ...BASE_STYLES },
  } as CapturedElement;
  return [el];
}

/** Find the clipPath rect referenced by the value-text `<g clip-path>` and return
 *  its x / width. */
function textClipRect(svg: string): { x: number; w: number } | null {
  // The input text path is wrapped in `<g clip-path="url(#ctN)">`; find that id,
  // then its clipPath rect.
  const idM = /clip-path="url\(#(ct\d+)\)"/.exec(svg);
  if (idM == null) return null;
  const rectM = new RegExp(`<clipPath id="${idM[1]}">\\s*<rect[^>]*\\bx="([\\d.]+)"[^>]*\\bwidth="([\\d.]+)"`).exec(svg);
  return rectM != null ? { x: parseFloat(rectM[1]), w: parseFloat(rectM[2]) } : null;
}

describe("input value text clips to the content box (DM-1266)", () => {
  it("insets the <input> text clip by border + padding horizontally", () => {
    const rect = textClipRect(elementTreeToSvgInner(inputTree("input"), 500, 200));
    expect(rect, "input text clip rect emitted").not.toBeNull();
    expect(rect!.x).toBeCloseTo(111, 1);   // border-box x(100) + border(1) + padding(10)
    expect(rect!.w).toBeCloseTo(178, 1);   // width(200) − 2×border − 2×padding
  });

  it("leaves a non-form element's text clip at the border box", () => {
    const rect = textClipRect(elementTreeToSvgInner(inputTree("div"), 500, 200));
    expect(rect, "div text clip rect emitted").not.toBeNull();
    expect(rect!.x).toBeCloseTo(100, 1);   // full border box — not inset
    expect(rect!.w).toBeCloseTo(200, 1);
  });
});
