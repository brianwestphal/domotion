import { describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// DM-1275: a border with MIXED per-side 3D styles (e.g. `ridge` top/bottom +
// `groove` left/right — the "3D pair flip") is not style-uniform, so it skipped
// paintBevelBorder (uniform-only) and fell through to paintPerSideBorder, which
// painted a FLAT solid border with no light/dark bevel at all. paintMixedBevelBorder
// now renders it with the same Chrome-calibrated shading (darker = base × 2/3,
// lighter = base) the uniform path uses. These tests lock that in.

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundSize: "auto",
  backgroundPosition: "0% 0%", backgroundRepeat: "repeat", backgroundClip: "border-box",
  backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  borderColor: "rgb(180,83,9)", borderWidth: "8px", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "8px", borderRightWidth: "8px", borderBottomWidth: "8px", borderLeftWidth: "8px",
  borderTopColor: "rgb(180,83,9)", borderRightColor: "rgb(180,83,9)", borderBottomColor: "rgb(180,83,9)", borderLeftColor: "rgb(180,83,9)",
  borderTopStyle: "ridge", borderRightStyle: "groove", borderBottomStyle: "ridge", borderLeftStyle: "groove",
  color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
  lineHeight: "20px", letterSpacing: "normal", textAlign: "left", textTransform: "none",
  textDecoration: "none", textDecorationLine: "none", textDecorationStyle: "solid", textDecorationColor: "rgb(0,0,0)",
  textDecorationThickness: "auto", textUnderlineOffset: "auto", whiteSpace: "normal", wordSpacing: "0",
  verticalAlign: "baseline", direction: "ltr", writingMode: "horizontal-tb", textOverflow: "clip",
  cursor: "auto", caretColor: "auto", outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0",
  boxShadow: "none", opacity: "1", transform: "none", transformOrigin: "50% 50%", visibility: "visible",
  borderCollapse: "separate", overflowX: "visible", overflowY: "visible", scrollbarGutter: "auto",
  scrollWidth: 200, scrollHeight: 100, clientWidth: 200, clientHeight: 100, scrollTop: 0, scrollLeft: 0,
  objectFit: "fill", objectPosition: "50% 50%", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source", maskSize: "auto",
  maskPosition: "0% 0%", maskRepeat: "repeat", maskComposite: "add",
  listStyleType: "disc", listStyleImage: "none", display: "block", listStylePosition: "outside",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
  borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
  zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row",
} as unknown as CapturedElement["styles"];

function boxWith(styleOverrides: Partial<Record<string, string>>): CapturedElement[] {
  return [{
    tag: "div", text: "", x: 10, y: 10, width: 200, height: 100, children: [],
    styles: { ...BASE_STYLES, ...styleOverrides } as CapturedElement["styles"],
  }];
}

const LIGHTER = 'fill="rgb(180,83,9)"';        // base color
const DARKER = 'fill="rgb(120,55,6)"';          // base × 2/3 (Chrome's 3D shade)
const polyCount = (svg: string, fill: string) => svg.split(`<polygon`).filter((p) => p.includes(fill)).length;

describe("mixed per-side 3D bevel border (DM-1275)", () => {
  it("ridge top/bottom + groove left/right renders the light/dark bevel, not a flat solid", () => {
    const svg = elementTreeToSvgInner(boxWith({}), 220, 120);
    // Both shades present = a real 3D bevel (pre-fix only the base color appeared).
    expect(svg).toContain(LIGHTER);
    expect(svg).toContain(DARKER);
    // 8 polygons: each of the 4 sides splits into an outer + inner half.
    expect(polyCount(svg, LIGHTER) + polyCount(svg, DARKER)).toBe(8);
    expect(polyCount(svg, LIGHTER)).toBe(4);
    expect(polyCount(svg, DARKER)).toBe(4);
  });

  it("does NOT regress a uniform single-style 3D border (still goes through paintBevelBorder)", () => {
    // All four sides `ridge` → uniform path; still beveled (8 polygons), proving
    // the new mixed path didn't steal the uniform case.
    const svg = elementTreeToSvgInner(boxWith({ borderRightStyle: "ridge", borderLeftStyle: "ridge" }), 220, 120);
    expect(svg).toContain(LIGHTER);
    expect(svg).toContain(DARKER);
    expect(polyCount(svg, LIGHTER) + polyCount(svg, DARKER)).toBe(8);
  });

  it("inset top/bottom + outset left/right uses single-shade trapezoids per side", () => {
    const svg = elementTreeToSvgInner(boxWith({
      borderTopStyle: "inset", borderBottomStyle: "inset", borderLeftStyle: "outset", borderRightStyle: "outset",
    }), 220, 120);
    expect(svg).toContain(LIGHTER);
    expect(svg).toContain(DARKER);
    // inset/outset are single-color per side → one trapezoid each → 4 polygons.
    expect(polyCount(svg, LIGHTER) + polyCount(svg, DARKER)).toBe(4);
  });
});
