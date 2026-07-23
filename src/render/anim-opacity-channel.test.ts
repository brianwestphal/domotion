import { describe, expect, it } from "vitest";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// An intra-frame `opacity` animation must OWN the element's opacity channel
// (single-channel invariant): the renderer used to bake the captured opacity
// onto the outer wrapper `<g opacity="...">` while the `anim-<id>` class landed
// on an inner group, so an animated 0.2→1 fade composed MULTIPLICATIVELY with
// the baked 0.2 and could never brighten past the captured value. And
// `opacity: 0` elements were dropped entirely — nothing in the SVG to fade in.
// The `annotateAnimatedProperties` tree-ops pass marks animated channels on the
// element (`animatedProperties`); the renderer then suppresses the baked
// wrapper opacity and exempts the element from the opacity-0 drop.

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
  scrollWidth: 60, scrollHeight: 60, clientWidth: 60, clientHeight: 60, scrollTop: 0, scrollLeft: 0,
  objectFit: "fill", objectPosition: "50% 50%", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", maskMode: "match-source", maskSize: "auto",
  maskPosition: "0% 0%", maskRepeat: "repeat", maskComposite: "add",
  listStyleType: "disc", listStyleImage: "none", display: "block", listStylePosition: "outside",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
  borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: "1", borderImageOutset: "0", borderImageRepeat: "stretch",
  zIndex: "auto", position: "static", float: "none", order: "0", flexDirection: "row",
} as unknown as CapturedElement["styles"];

function box(overrides: Partial<CapturedElement>, styleOverrides: Partial<Record<string, string>> = {}): CapturedElement {
  return {
    tag: "div", text: "", x: 10, y: 10, width: 60, height: 60, children: [],
    styles: { ...BASE_STYLES, backgroundColor: "rgb(255,0,0)", ...styleOverrides } as CapturedElement["styles"],
    ...overrides,
  };
}

describe("intra-frame opacity animation owns the opacity channel", () => {
  it("suppresses the baked wrapper opacity when the animation animates opacity (single channel)", () => {
    const svg = elementTreeToSvgInner(
      [box({ animId: "f0a0", animatedProperties: ["opacity"] }, { opacity: "0.2" })],
      100, 100,
    );
    // The anim hook exists, the paint exists...
    expect(svg).toContain('class="anim-f0a0"');
    expect(svg).toContain("rgb(255,0,0)");
    // ...and there is NO baked opacity wrapper to multiply against the keyframes.
    expect(svg).not.toContain("opacity=");
  });

  it("keeps baking the wrapper opacity for an animated element whose animation does NOT touch opacity", () => {
    const svg = elementTreeToSvgInner(
      [box({ animId: "f0a0", animatedProperties: ["translateY"] }, { opacity: "0.2" })],
      100, 100,
    );
    expect(svg).toContain('class="anim-f0a0"');
    expect(svg).toContain('opacity="0.2"');
  });

  it("keeps baking the wrapper opacity when the annotation pass did not run (animId alone is not enough)", () => {
    const svg = elementTreeToSvgInner(
      [box({ animId: "f0a0" }, { opacity: "0.2" })],
      100, 100,
    );
    expect(svg).toContain('class="anim-f0a0"');
    expect(svg).toContain('opacity="0.2"');
  });

  it("emits markup for an opacity:0 element with an opacity-animating animId (no zero-opacity wrapper pinning it)", () => {
    const svg = elementTreeToSvgInner(
      [box({ animId: "f0a0", animatedProperties: ["opacity"] }, { opacity: "0" })],
      100, 100,
    );
    expect(svg).toContain('class="anim-f0a0"');
    expect(svg).toContain("rgb(255,0,0)");
    expect(svg).not.toContain("opacity=");
  });

  it("still drops a plain opacity:0 element (the size win stands)", () => {
    const svg = elementTreeToSvgInner(
      [box({}, { opacity: "0" })],
      100, 100,
    );
    expect(svg).not.toContain("rgb(255,0,0)");
  });

  it("still drops an opacity:0 element whose animation does not animate opacity", () => {
    const svg = elementTreeToSvgInner(
      [box({ animId: "f0a0", animatedProperties: ["translateY"] }, { opacity: "0" })],
      100, 100,
    );
    expect(svg).not.toContain("rgb(255,0,0)");
    expect(svg).not.toContain('class="anim-f0a0"');
  });

  it("renders the whole subtree of an exempted opacity:0 element inside the anim wrapper", () => {
    const child = box({ x: 20, y: 20, width: 20, height: 20 }, { backgroundColor: "rgb(0,0,255)" });
    const svg = elementTreeToSvgInner(
      [box({ animId: "f0a0", animatedProperties: ["opacity"], children: [child] }, { opacity: "0" })],
      100, 100,
    );
    const animOpen = svg.indexOf('class="anim-f0a0"');
    const childPaint = svg.indexOf("rgb(0,0,255)");
    expect(animOpen).toBeGreaterThan(-1);
    expect(childPaint).toBeGreaterThan(animOpen);
  });
});
