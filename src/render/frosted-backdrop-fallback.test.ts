import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";

// Doc 19: the frosted-backdrop terminal fallback has one threshold. Capture
// stores `frostedBgFallback` when the background alpha is <= 0.1, and the
// renderer uses the stored fill whenever it is present and no Chromium
// backdrop raster was retained. It used to substitute only below 0.01, so a
// 0.01 < alpha <= 0.1 background silently kept its near-invisible real color.

/** Minimal valid `CapturedElement` (mirrors pseudo-box-background.test.ts). */
function makeElement(overrides: Partial<CapturedElement> = {}): CapturedElement {
  return {
    tag: "div",
    text: "",
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    children: [],
    ...overrides,
    styles: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "none",
      backgroundSize: "auto",
      backgroundPosition: "0% 0%",
      backgroundRepeat: "repeat",
      backgroundClip: "border-box",
      backgroundOrigin: "padding-box",
      backgroundAttachment: "scroll",
      borderColor: "rgb(0,0,0)",
      borderWidth: "0",
      borderRadius: "0",
      borderTopLeftRadius: "0",
      borderTopRightRadius: "0",
      borderBottomRightRadius: "0",
      borderBottomLeftRadius: "0",
      borderTopWidth: "0",
      borderRightWidth: "0",
      borderBottomWidth: "0",
      borderLeftWidth: "0",
      borderTopColor: "rgb(0,0,0)",
      borderRightColor: "rgb(0,0,0)",
      borderBottomColor: "rgb(0,0,0)",
      borderLeftColor: "rgb(0,0,0)",
      borderTopStyle: "none",
      borderRightStyle: "none",
      borderBottomStyle: "none",
      borderLeftStyle: "none",
      color: "rgb(0,0,0)",
      fontSize: "16px",
      fontFamily: "sans-serif",
      fontWeight: "400",
      fontStyle: "normal",
      lineHeight: "20px",
      letterSpacing: "normal",
      textAlign: "left",
      textTransform: "none",
      textDecoration: "none",
      textDecorationLine: "none",
      textDecorationStyle: "solid",
      textDecorationColor: "rgb(0,0,0)",
      textDecorationThickness: "auto",
      textUnderlineOffset: "auto",
      whiteSpace: "normal",
      wordSpacing: "0",
      verticalAlign: "baseline",
      direction: "ltr",
      writingMode: "horizontal-tb",
      textOverflow: "clip",
      cursor: "auto",
      caretColor: "auto",
      outlineColor: "rgb(0,0,0)",
      outlineWidth: "0",
      outlineStyle: "none",
      outlineOffset: "0",
      boxShadow: "none",
      opacity: "1",
      transform: "none",
      transformOrigin: "50% 50%",
      visibility: "visible",
      borderCollapse: "separate",
      overflowX: "visible",
      overflowY: "visible",
      scrollbarGutter: "auto",
      scrollWidth: 200,
      scrollHeight: 200,
      clientWidth: 200,
      clientHeight: 200,
      scrollTop: 0,
      scrollLeft: 0,
      objectFit: "fill",
      objectPosition: "50% 50%",
      filter: "none",
      backdropFilter: "none",
      mixBlendMode: "normal",
      clipPath: "none",
      mask: "none",
      maskImage: "none",
      maskMode: "match-source",
      maskSize: "auto",
      maskPosition: "0% 0%",
      maskRepeat: "repeat",
      maskComposite: "add",
      listStyleType: "disc",
      listStyleImage: "none",
      display: "block",
      listStylePosition: "outside",
      paddingTop: "0",
      paddingRight: "0",
      paddingBottom: "0",
      paddingLeft: "0",
      borderImageSource: "none",
      borderImageSlice: "100%",
      borderImageWidth: "1",
      borderImageOutset: "0",
      borderImageRepeat: "stretch",
      zIndex: "auto",
      position: "static",
      float: "none",
      order: "0",
      flexDirection: "row",
      ...(overrides.styles ?? {}),
    } as CapturedElement["styles"],
  };
}

function frosted(backgroundColor: string, frostedBgFallback?: string): CapturedElement {
  return makeElement({
    x: 10,
    y: 20,
    width: 120,
    height: 40,
    styles: {
      ...makeElement().styles,
      backgroundColor,
      backdropFilter: "blur(12px)",
      ...(frostedBgFallback == null ? {} : { frostedBgFallback }),
    },
  });
}

const fills = (svg: string) => [...svg.matchAll(/fill="([^"]+)"/g)].map((match) => match[1]);

describe("frosted-backdrop terminal fallback threshold", () => {
  it("uses the stored fallback across the whole capture threshold", () => {
    for (const alpha of ["0", "0.005", "0.05", "0.1"]) {
      const svg = elementTreeToSvgInner([frosted(`rgba(255, 255, 255, ${alpha})`, "rgb(12, 34, 56)")], 200, 100);
      expect(fills(svg)).toContain("rgb(12, 34, 56)");
    }
  });

  it("keeps the real background color when capture stored no fallback", () => {
    const svg = elementTreeToSvgInner([frosted("rgba(200, 10, 10, 0.5)")], 200, 100);
    expect(fills(svg).join(" ")).not.toContain("rgb(12, 34, 56)");
    expect(svg).toMatch(/fill="rgba?\(200, ?10, ?10/);
  });

  it("never paints the fallback once a Chromium backdrop raster is retained", () => {
    const el = frosted("rgba(255, 255, 255, 0.05)", "rgb(12, 34, 56)");
    el.backdropFilterRaster = {
      dataUri: "data:image/png;base64,iVBORw0KGgo=",
      x: 10,
      y: 20,
      width: 120,
      height: 40,
    } as CapturedElement["backdropFilterRaster"];
    const svg = elementTreeToSvgInner([el], 200, 100);
    expect(svg).toContain('data-domotion-no-hoist="effect-surface"');
    expect(fills(svg)).not.toContain("rgb(12, 34, 56)");
  });
});
