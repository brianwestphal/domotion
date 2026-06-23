import { describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// An element targeted by an intra-frame animation (`animId` → `class="anim-<id>"`)
// must render its WHOLE subtree nested inside that wrapper, so the animation
// (opacity / transform / …) moves the entire subtree — not just the element's
// own box. The renderer's paint-order flattening normally hoists flex/grid
// items up to the nearest stacking-context root (so overflow paint order is
// correct); that hoist used to drain an animated flex container's `anim-`
// wrapper, leaving the animation to move an empty group while the (hoisted)
// content stayed put. The lower-third built-in template hit this exactly: a
// panel that should fade + slide as a unit only animated its background, with
// the accent bar and text left behind. We now treat an `animId` element as a
// stacking-context root (which is what an animated transform/opacity does in
// CSS), keeping its subtree atomic and inside the wrapper.

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

/**
 * A lower-third-shaped tree: an animated flex container (`.lt`, opacity anim)
 * whose flex-item child is an animated panel (`.lt-panel`, slide anim) that
 * clips its overflow and holds an accent bar + a flex-item content child.
 */
function lowerThirdTree(): CapturedElement[] {
  const accent: CapturedElement = {
    tag: "div", text: "", x: 10, y: 10, width: 6, height: 40, children: [],
    styles: { ...BASE_STYLES, backgroundColor: "rgb(255,0,0)" },
  };
  const content: CapturedElement = {
    tag: "div", text: "Headline", x: 16, y: 10, width: 120, height: 40, children: [],
    styles: { ...BASE_STYLES, display: "block" },
  };
  const panel: CapturedElement = {
    tag: "div", text: "", x: 10, y: 10, width: 140, height: 40, children: [accent, content],
    animId: "B",
    styles: {
      ...BASE_STYLES, display: "flex", overflowX: "hidden", overflowY: "hidden",
      backgroundColor: "rgb(255,255,255)",
    } as CapturedElement["styles"],
  };
  const lt: CapturedElement = {
    tag: "div", text: "", x: 10, y: 10, width: 140, height: 40, children: [panel],
    animId: "A",
    styles: { ...BASE_STYLES, display: "flex" } as CapturedElement["styles"],
  };
  return [lt];
}

describe("intra-frame animation keeps its subtree nested in the anim wrapper", () => {
  it("nests the animated flex item (and its content) inside the outer anim group", () => {
    const svg = elementTreeToSvgInner(lowerThirdTree(), 200, 80);

    // Both wrappers exist...
    expect(svg).toContain('class="anim-A"');
    expect(svg).toContain('class="anim-B"');

    // ...and the OUTER animated group is not empty: `anim-B` opens after
    // `anim-A` opens and before `anim-A` closes. Previously the flex-item
    // hoist drained `anim-A`, emitting `<g class="anim-A"></g>` immediately.
    const openA = svg.indexOf('class="anim-A"');
    const openB = svg.indexOf('class="anim-B"');
    expect(openA).toBeGreaterThanOrEqual(0);
    expect(openB).toBeGreaterThan(openA);
    expect(svg).not.toMatch(/<g class="anim-A"\s*>\s*<\/g>/);

    // The accent fill and the headline text both live AFTER `anim-B` opens —
    // i.e. inside the sliding panel, not hoisted out as later siblings.
    const accentAt = svg.indexOf("rgb(255,0,0)");
    expect(accentAt).toBeGreaterThan(openB);
  });
});
