import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";

const BASE_STYLES = {
  backgroundColor: "rgba(0,0,0,0)", backgroundImage: "none", backgroundSize: "auto",
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
  borderCollapse: "separate", overflowX: "clip", overflowY: "clip", overflowClipMargin: "0px", scrollbarGutter: "auto",
  scrollWidth: 200, scrollHeight: 200, clientWidth: 100, clientHeight: 60, scrollTop: 0, scrollLeft: 0,
  objectFit: "fill", objectPosition: "50% 50%", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source", maskSize: "auto",
  maskPosition: "0% 0%", maskRepeat: "repeat", maskComposite: "add",
  listStyleType: "disc", listStyleImage: "none", display: "block", listStylePosition: "outside",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
  borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
  zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row", contain: "none",
} as unknown as CapturedElement["styles"];

function tree(style: Partial<CapturedElement["styles"]> = {}, rect = { x: 10.4, y: 20.6, width: 100.3, height: 60.4 }): CapturedElement[] {
  const child: CapturedElement = {
    tag: "div", text: "", x: rect.x - 30, y: rect.y - 30, width: rect.width + 60, height: rect.height + 60, children: [],
    styles: { ...BASE_STYLES, overflowX: "visible", overflowY: "visible", backgroundColor: "rgb(255,0,0)" },
  };
  return [{
    tag: "div", text: "", ...rect, children: [child],
    styles: { ...BASE_STYLES, ...style } as CapturedElement["styles"],
  }];
}

function childClip(svg: string): string {
  const match = /<clipPath id="[^"]*ov[^"]*">([\s\S]*?)<\/clipPath>/.exec(svg);
  expect(match, "child overflow clipPath").not.toBeNull();
  return match![1];
}

function rectGeometry(markup: string): { x: number; y: number; width: number; height: number } {
  const number = (name: string) => Number(new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(markup)![1]);
  return { x: number("x"), y: number("y"), width: number("width"), height: number("height") };
}

const ASYMMETRIC_BOX = {
  borderTopWidth: "2.25px", borderRightWidth: "3.5px", borderBottomWidth: "4.25px", borderLeftWidth: "1.25px",
  borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
  paddingTop: "9px", paddingRight: "11px", paddingBottom: "13px", paddingLeft: "7px",
} satisfies Partial<CapturedElement["styles"]>;

describe("overflow-clip-margin renderer wiring (DM-2419)", () => {
  it.each([
    ["padding-box 5px", { x: 7, y: 18, width: 105, height: 64 }],
    ["border-box", { x: 10.8, y: 20.8, width: 99.8, height: 60.5 }],
    ["content-box", { x: 19, y: 32, width: 77, height: 32 }],
  ])("emits the pixel-snapped %s reference geometry", (overflowClipMargin, expected) => {
    const svg = elementTreeToSvgInner(tree({ ...ASYMMETRIC_BOX, overflowClipMargin }), 300, 200);
    expect(rectGeometry(childClip(svg))).toEqual(expected);
  });

  it("emits the corrected elliptical contour instead of a rectangular extension", () => {
    const svg = elementTreeToSvgInner(tree({
      overflowClipMargin: "32px",
      borderTopLeftRadius: "4px 8px", borderTopRightRadius: "12px 16px",
      borderBottomRightRadius: "64px 0px", borderBottomLeftRadius: "0px 32px",
    }, { x: 0, y: 0, width: 200, height: 200 }), 300, 300);
    const markup = childClip(svg);
    expect(markup).toContain("<path");
    expect(markup).toContain("A14.6,26.5");
    expect(markup).toContain("A36.2,44");
    expect(markup).not.toContain("A4,8");
  });

  it("keeps one-axis visible+clip and scroll-container modes unchanged", () => {
    const both = rectGeometry(childClip(elementTreeToSvgInner(tree({ ...ASYMMETRIC_BOX, overflowClipMargin: "5px" }), 300, 200)));
    const oneAxis = rectGeometry(childClip(elementTreeToSvgInner(tree({
      ...ASYMMETRIC_BOX, overflowX: "visible", overflowY: "clip", overflowClipMargin: "5px",
    }), 300, 200)));
    const hidden = rectGeometry(childClip(elementTreeToSvgInner(tree({
      ...ASYMMETRIC_BOX, overflowX: "hidden", overflowY: "hidden", overflowClipMargin: "5px",
    }), 300, 200)));
    const auto = rectGeometry(childClip(elementTreeToSvgInner(tree({
      ...ASYMMETRIC_BOX, overflowX: "auto", overflowY: "auto", overflowClipMargin: "5px",
    }), 300, 200)));
    expect(both).toEqual({ x: 7, y: 18, width: 105, height: 64 });
    expect(oneAxis).toEqual({ x: -99989.6, y: 22.9, width: 200100.3, height: 53.9 });
    expect(hidden).toEqual({ x: 11.7, y: 22.9, width: 95.5, height: 53.9 });
    expect(auto).toEqual(hidden);
  });

  it("treats an invalid negative length as the unchanged padding clip", () => {
    const negative = rectGeometry(childClip(elementTreeToSvgInner(tree({
      ...ASYMMETRIC_BOX, overflowClipMargin: "-4px",
    }), 300, 200)));
    expect(negative).toEqual({ x: 11.7, y: 22.9, width: 95.5, height: 53.9 });
  });

  it("uses the both-axis paint-containment edge without unbounding an authored visible axis", () => {
    const geometry = rectGeometry(childClip(elementTreeToSvgInner(tree({
      ...ASYMMETRIC_BOX,
      overflowX: "visible",
      overflowY: "clip",
      contain: "paint",
      overflowClipMargin: "5px",
    }), 300, 200)));
    expect(geometry).toEqual({ x: 7, y: 18, width: 105, height: 64 });
  });

  it("moves all four edges predictably when the margin mutates", () => {
    const a = rectGeometry(childClip(elementTreeToSvgInner(tree({ overflowClipMargin: "7px" }), 300, 200)));
    const b = rectGeometry(childClip(elementTreeToSvgInner(tree({ overflowClipMargin: "8px" }), 300, 200)));
    expect(b).toEqual({ x: a.x - 1, y: a.y - 1, width: a.width + 2, height: a.height + 2 });
  });
});
