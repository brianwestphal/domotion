import { describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// DM-1264: a <fieldset>'s rendered <legend> is part of the block-start BORDER,
// not the scrollport — per Blink `fieldset_layout_algorithm.cc`: "the rendered
// legend shouldn't be part of the scrollport; the legend is essentially a part
// of the block-start border." So when a fieldset has `overflow != visible`
// (which `resize` requires), its overflow clip must NOT cut the legend, which
// straddles the border line and protrudes above the padding box. The renderer
// raises the clip's top edge to the legend's top when `fieldsetLegendNotch` is
// present. These tests lock that — the perceptual diff reads a clipped legend as
// a "minor" sub-% diff, so assert the emitted clipPath rect geometry directly.

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", backgroundSize: "auto",
  backgroundPosition: "0% 0%", backgroundRepeat: "repeat", backgroundClip: "border-box",
  backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "2", borderRightWidth: "2", borderBottomWidth: "2", borderLeftWidth: "2",
  borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
  color: "rgb(0,0,0)", fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400", fontStyle: "normal",
  lineHeight: "20px", letterSpacing: "normal", textAlign: "left", textTransform: "none",
  textDecoration: "none", textDecorationLine: "none", textDecorationStyle: "solid", textDecorationColor: "rgb(0,0,0)",
  textDecorationThickness: "auto", textUnderlineOffset: "auto", whiteSpace: "normal", wordSpacing: "0",
  verticalAlign: "baseline", direction: "ltr", writingMode: "horizontal-tb", textOverflow: "clip",
  cursor: "auto", caretColor: "auto", outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0",
  boxShadow: "none", opacity: "1", transform: "none", transformOrigin: "50% 50%", visibility: "visible",
  borderCollapse: "separate", overflowX: "auto", overflowY: "auto", scrollbarGutter: "auto",
  scrollWidth: 200, scrollHeight: 200, clientWidth: 200, clientHeight: 200, scrollTop: 0, scrollLeft: 0,
  objectFit: "fill", objectPosition: "50% 50%", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source", maskSize: "auto",
  maskPosition: "0% 0%", maskRepeat: "repeat", maskComposite: "add",
  listStyleType: "disc", listStyleImage: "none", display: "block", listStylePosition: "outside",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
  borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
  zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row",
} as unknown as CapturedElement["styles"];

// fieldset border-box top at y=100, border 2 → padding box top at 102.
// legend straddles the border: its top sits at 91 (11px above the padding box).
const LEGEND_TOP = 91;
const PADDING_BOX_TOP = 102;

function fieldsetTree(withNotch: boolean): CapturedElement[] {
  const legend: CapturedElement = {
    tag: "legend", text: "Options", x: 14, y: LEGEND_TOP, width: 60, height: 18, children: [],
    styles: { ...BASE_STYLES, overflowX: "visible", overflowY: "visible", borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0", borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none" } as CapturedElement["styles"],
  };
  const fieldset: CapturedElement = {
    tag: "fieldset", text: "", x: 0, y: 100, width: 300, height: 120, children: [legend],
    styles: { ...BASE_STYLES },
    ...(withNotch ? { fieldsetLegendNotch: { x: 14, y: LEGEND_TOP, w: 60, h: 18 } } : {}),
  } as CapturedElement;
  return [fieldset];
}

/** The minimum y across the FIELDSET-width <clipPath> rects (width > 200 — the
 *  fieldset is 300px wide; this excludes the legend's own narrow ~60px text clip).
 *  The fieldset emits both an outer element-group clip at the border box and a
 *  children clip at the padding box; the legend-protrusion fix raises both. */
function minClipRectY(svg: string): number | null {
  const ys: number[] = [];
  for (const m of svg.matchAll(/<clipPath[^>]*>\s*<rect[^>]*\by="([\d.]+)"[^>]*\bwidth="([\d.]+)"/g)) {
    if (parseFloat(m[2]) > 200) ys.push(parseFloat(m[1]));
  }
  return ys.length > 0 ? Math.min(...ys) : null;
}

describe("fieldset+legend overflow clip (DM-1264)", () => {
  it("raises the overflow clip top to clear the legend's protrusion above the box", () => {
    const svg = elementTreeToSvgInner(fieldsetTree(true), 400, 300);
    const clipY = minClipRectY(svg);
    expect(clipY, "an overflow clipPath rect is emitted").not.toBeNull();
    // The clip top must reach the legend top (91), NOT stop at the border /
    // padding box (100 / 102) which would crop the legend's protruding half.
    expect(clipY!).toBeLessThanOrEqual(LEGEND_TOP + 0.5);
  });

  it("without a legend notch, the overflow clip is NOT lowered toward the legend", () => {
    const svg = elementTreeToSvgInner(fieldsetTree(false), 400, 300);
    const clipY = minClipRectY(svg);
    expect(clipY, "an overflow clipPath rect is emitted").not.toBeNull();
    // No notch → no protrusion adjustment → the clip stays at its natural top
    // (the element border box, el.y = 100); it must not be raised to the legend.
    expect(clipY!).toBeGreaterThanOrEqual(100 - 0.5);
    expect(PADDING_BOX_TOP).toBe(102); // doc anchor for the geometry above
  });
});
