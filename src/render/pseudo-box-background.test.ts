import { describe, expect, it } from "vitest";
import {
  buildRadialGradientDef,
  elementTreeToSvgInner,
  parseBgPositionPx,
} from "./element-tree-to-svg.js";
import type { CapturedElement } from "../capture/types.js";

// DM-1121: a gradient pseudo-element's `background-position` and `opacity` were
// dropped on the floor — the renderer hardcoded position `"0% 0%"` and never
// dimmed the box. On Stripe's mobile homepage the keynote-speaker photo carries
// `::after { background: radial-gradient(rgb(255,46,222) 10%, transparent 70%);
// background-position: -90px 90px; opacity: .45 }`, a soft pink glow meant to
// sit in the lower-left corner BEHIND the (opaque) photo content. Dropping the
// position painted the pink core centered over the speaker's face; dropping the
// opacity made it a hard magenta blob. These tests lock in both fixes.

describe("parseBgPositionPx (DM-1121)", () => {
  it("extracts the px component of a two-value position", () => {
    expect(parseBgPositionPx("-90px 90px")).toEqual([-90, 90]);
    expect(parseBgPositionPx("12px 0px")).toEqual([12, 0]);
  });

  it("treats percentages and keywords as zero offset (image fills an auto-sized gradient box)", () => {
    // For an auto-sized gradient the image == the box, so (box − image) × pct = 0
    // for any percentage / keyword — only a px component actually slides it.
    expect(parseBgPositionPx("0% 100%")).toEqual([0, 0]);
    expect(parseBgPositionPx("left top")).toEqual([0, 0]);
    expect(parseBgPositionPx("center")).toEqual([0, 0]);
    expect(parseBgPositionPx("50% 50%")).toEqual([0, 0]);
  });

  it("handles the edge-offset form (keyword + px), signing right/bottom inward", () => {
    expect(parseBgPositionPx("right 10px bottom 20px")).toEqual([-10, -20]);
    expect(parseBgPositionPx("left 10px top 20px")).toEqual([10, 20]);
  });

  it("returns [0,0] for an empty / unparseable position", () => {
    expect(parseBgPositionPx("")).toEqual([0, 0]);
    expect(parseBgPositionPx("   ")).toEqual([0, 0]);
  });
});

describe("buildRadialGradientDef background-position offset (DM-1121)", () => {
  it("shifts the center by the px offset while leaving the radii unchanged", () => {
    // Box 200×200 at (111, 4412). With no offset the (default-centered)
    // farthest-corner ellipse is centered at (211, 4512) with r = √(100²+100²).
    const centered = buildRadialGradientDef(
      "g", "rgb(255,46,222) 10%, rgba(255,255,255,0) 70%", false,
      111, 4412, 200, 200,
    );
    expect(centered).toContain('cx="211"');
    expect(centered).toContain('cy="4512"');

    // Stripe's `-90px 90px` slides the center to the lower-left corner; the
    // radius (derived from the image-box half-extents) is identical.
    const offset = buildRadialGradientDef(
      "g", "rgb(255,46,222) 10%, rgba(255,255,255,0) 70%", false,
      111, 4412, 200, 200, -90, 90,
    );
    expect(offset).toContain('cx="121"');
    expect(offset).toContain('cy="4602"');
    const rCentered = /r="([\d.]+)"/.exec(centered)![1];
    const rOffset = /r="([\d.]+)"/.exec(offset)![1];
    expect(rOffset).toBe(rCentered);
  });
});

/** Minimal valid `CapturedElement` (mirrors stacking-context.test.ts). */
function makeElement(overrides: Partial<CapturedElement> = {}): CapturedElement {
  return {
    tag: "div", text: "", x: 0, y: 0, width: 200, height: 200, children: [],
    ...overrides,
    styles: {
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
      ...(overrides.styles ?? {}),
    } as CapturedElement["styles"],
  };
}

describe("pseudoBox radial-gradient glow end-to-end (DM-1121)", () => {
  // The Stripe keynote glow: an `::after` carrying ONLY a radial-gradient
  // background (no bg-color, no border, non-negative z) is classified as a
  // "fade overlay" and deferred to paint on top — that ordering is correct
  // (verified against Chrome). What was wrong was the position + opacity.
  const glowEl = makeElement({
    x: 111, y: 4412, width: 200, height: 200,
    styles: { ...makeElement().styles, position: "relative" },
    pseudoBoxes: [{
      pseudo: "::after",
      x: 111, y: 4412, width: 200, height: 200,
      backgroundImage: "radial-gradient(rgb(255, 46, 222) 10%, rgba(255, 255, 255, 0) 70%)",
      backgroundPosition: "-90px 90px",
      backgroundSize: "auto",
      opacity: 0.45,
    }],
  });

  it("offsets the gradient core to the lower-left and dims it via <g opacity>", () => {
    const svg = elementTreeToSvgInner([glowEl], 390, 6000);
    // Position honored: the radial center is the lower-left corner, not (211,4512).
    expect(svg).toContain('cx="121"');
    expect(svg).toContain('cy="4602"');
    expect(svg).not.toContain('cx="211"');
    // Opacity honored: the gradient rect is wrapped in a 0.45-opacity group.
    expect(svg).toMatch(/<g opacity="0\.45"><rect[^>]*fill="url\(#[^)]*pbg[^)]*\)"/);
  });

  it("emits an opaque, centered gradient when neither position nor opacity is set", () => {
    const plain = makeElement({
      x: 111, y: 4412, width: 200, height: 200,
      pseudoBoxes: [{
        pseudo: "::after",
        x: 111, y: 4412, width: 200, height: 200,
        backgroundImage: "radial-gradient(rgb(255, 46, 222) 10%, rgba(255, 255, 255, 0) 70%)",
      }],
    });
    const svg = elementTreeToSvgInner([plain], 390, 6000);
    expect(svg).toContain('cx="211"');
    expect(svg).not.toContain("<g opacity=");
  });
});
