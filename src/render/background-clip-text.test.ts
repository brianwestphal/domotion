import { describe, expect, it } from "vitest";

import type { CapturedBackgroundImage, CapturedElement } from "../capture/types.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";

// Source contracts for these assertions:
//   Blink BoxPainterBase::FillLayerInfo — background-color belongs to the
//   bottom FillLayer; PaintFillLayerBackground paints color before its image.
//   Blink BoxPainterBase::PaintFillLayerTextFillBox — color+image are grouped,
//   then clipped with the kTextClip/DstIn mask.
//   Blink BoxFragmentPainter::PaintTextClipMask — slice fragments offset paint
//   through the inline's stitched imaginary box and include descendants.

const SVG_TILE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath fill='%2300d4ff' d='M0 0h6v8H0z'/%3E%3Cpath fill='%23ff3d81' d='M6 0h6v8H6z'/%3E%3C/svg%3E";

const SELECTED_TILE: CapturedBackgroundImage = {
  layerIndex: 0,
  source: "url",
  selectedUrl: SVG_TILE,
  selectedCandidateIndex: 0,
  selectedResolution: 1,
  selectedType: "image/svg+xml",
  decodedImageKind: "svg",
  decodedNaturalWidth: 12,
  decodedNaturalHeight: 8,
  naturalWidth: 12,
  naturalHeight: 8,
  hasNaturalWidth: true,
  hasNaturalHeight: true,
  naturalAspectRatio: { width: 12, height: 8 },
  imageOrientation: "from-image",
  effectiveZoom: 1,
  loadState: "loaded",
  naturalSizingState: "resolved",
};

const BASE_STYLES = {
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  backgroundSize: "auto",
  backgroundPosition: "0% 0%",
  backgroundRepeat: "repeat",
  backgroundClip: "border-box",
  backgroundOrigin: "padding-box",
  backgroundAttachment: "scroll",
  backgroundBlendMode: "normal",
  borderColor: "rgb(0,0,0)", borderWidth: "0", borderRadius: "0",
  borderTopLeftRadius: "0", borderTopRightRadius: "0", borderBottomRightRadius: "0", borderBottomLeftRadius: "0",
  borderTopWidth: "0", borderRightWidth: "0", borderBottomWidth: "0", borderLeftWidth: "0",
  borderTopColor: "rgb(0,0,0)", borderRightColor: "rgb(0,0,0)", borderBottomColor: "rgb(0,0,0)", borderLeftColor: "rgb(0,0,0)",
  borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
  paddingTop: "0", paddingRight: "0", paddingBottom: "0", paddingLeft: "0",
  color: "rgba(0,0,0,0)", webkitTextFillColor: "rgba(0,0,0,0)",
  fontSize: "36px", fontFamily: "sans-serif", fontWeight: "700", fontStyle: "normal", lineHeight: "44px",
  overflowX: "visible", overflowY: "visible", display: "block",
  outlineColor: "rgb(0,0,0)", outlineWidth: "0", outlineStyle: "none", outlineOffset: "0",
  boxShadow: "none", textShadow: "none", filter: "none", backdropFilter: "none", mixBlendMode: "normal",
  clipPath: "none", mask: "none", maskImage: "none", opacity: "1", transform: "none",
  visibility: "visible", position: "static", zIndex: "auto",
} as unknown as CapturedElement["styles"];

function element(overrides: Partial<CapturedElement["styles"]> = {}, children: CapturedElement[] = []): CapturedElement {
  return {
    tag: "span",
    text: "VECTOR",
    x: 20,
    y: 30,
    width: 220,
    height: 52,
    textLeft: 20,
    textTop: 30,
    fontAscent: 34,
    children,
    styles: { ...BASE_STYLES, ...overrides } as CapturedElement["styles"],
  } as CapturedElement;
}

function visibleBody(svg: string): string {
  const defsEnd = svg.indexOf("</defs>");
  return defsEnd < 0 ? svg : svg.slice(defsEnd + 7);
}

describe("background-clip:text URL and color paint stack", () => {
  it("clips a color-only background to glyph alpha instead of painting its box", () => {
    const svg = elementTreeToSvgInner([
      element({ backgroundColor: "rgb(241, 70, 104)", backgroundClip: "text" }),
    ], 300, 120);
    const body = visibleBody(svg);
    expect(svg).toContain("mask-type:alpha");
    expect(body).toMatch(/<rect[^>]+fill="rgb\(241,\s*70,\s*104\)"[^>]+mask="url\(#tbgm/);
    const colorRects = [...body.matchAll(/<rect[^>]+fill="rgb\(241,\s*70,\s*104\)"[^>]*>/g)];
    expect(colorRects).toHaveLength(1);
    expect(colorRects[0][0]).toContain('mask="url(#tbgm');
  });

  it("paints bottom color, URL pattern, then top image layer through one glyph mask", () => {
    const svg = elementTreeToSvgInner([
      element({
        backgroundColor: "rgb(10, 18, 36)",
        backgroundImage: `linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.45)), url("${SVG_TILE}")`,
        backgroundImages: [null, { ...SELECTED_TILE, layerIndex: 1 }],
        backgroundIntrinsic: [null, { w: 12, h: 8 }],
        backgroundSize: "100% 100%, 12px 8px",
        backgroundPosition: "0% 0%, 3px 5px",
        backgroundRepeat: "no-repeat, repeat",
        backgroundClip: "text, text",
      }),
    ], 300, 120);
    const body = visibleBody(svg);
    const mask = /mask="url\(#(tbgm[^)]*)\)"/.exec(body)?.[1];
    expect(mask).toBeDefined();
    expect(svg).toContain("<pattern");
    const masked = [...body.matchAll(new RegExp(`<rect[^>]+fill="([^"]+)"[^>]+mask="url\\(#${mask}\\)"`, "g"))]
      .map((match) => match[1]);
    expect(masked).toHaveLength(3);
    expect(masked[0].replaceAll(" ", "")).toBe("rgb(10,18,36)");
    expect(masked[1]).toMatch(/^url\(#bg/);
    expect(masked[2]).toMatch(/^url\(#bg/);
  });

  it("paints an opaque foreground after the masked URL background", () => {
    const svg = elementTreeToSvgInner([
      element({
        color: "rgb(255, 244, 214)",
        webkitTextFillColor: "rgb(255, 244, 214)",
        backgroundImage: `url("${SVG_TILE}")`,
        backgroundImages: [SELECTED_TILE],
        backgroundIntrinsic: [{ w: 12, h: 8 }],
        backgroundClip: "text",
      }),
    ], 300, 120);
    const body = visibleBody(svg);
    const maskedIndex = body.indexOf('mask="url(#tbgm');
    const foreground = /fill="rgb\(255,\s*244,\s*214\)"/g;
    foreground.lastIndex = maskedIndex + 1;
    const foregroundIndex = foreground.exec(body)?.index ?? -1;
    expect(maskedIndex).toBeGreaterThan(-1);
    expect(foregroundIndex).toBeGreaterThan(maskedIndex);
  });

  it("lets descendant glyphs consume the nearest ancestor URL/color stack", () => {
    const child = element({ backgroundImage: "none", backgroundClip: "border-box" });
    child.x = 48; child.y = 42; child.width = 160;
    const owner = element({
      backgroundColor: "rgb(13, 28, 54)",
      backgroundImage: `url("${SVG_TILE}")`,
      backgroundImages: [SELECTED_TILE],
      backgroundIntrinsic: [{ w: 12, h: 8 }],
      backgroundSize: "12px 8px",
      backgroundPosition: "4px 6px",
      backgroundRepeat: "repeat",
      backgroundClip: "text",
    }, [child]);
    owner.text = "";
    const svg = elementTreeToSvgInner([owner], 300, 140);
    const body = visibleBody(svg);
    expect(svg).toContain("<pattern");
    expect(body).toMatch(/fill="rgb\(13,\s*28,\s*54\)"[^>]+mask="url\(#tbgm/);
    expect(body).toMatch(/fill="url\(#bg[^\"]+\)"[^>]+mask="url\(#tbgm/);
  });

  it("uses captured stitched slice geometry for wrapped URL text", () => {
    const wrapped = element({
      display: "inline",
      backgroundImage: `url("${SVG_TILE}")`,
      backgroundImages: [SELECTED_TILE],
      backgroundIntrinsic: [{ w: 12, h: 8 }],
      backgroundSize: "12px 8px",
      backgroundPosition: "3px 1px",
      backgroundRepeat: "repeat",
      backgroundClip: "text",
      backgroundOrigin: "padding-box",
      boxDecorationBreak: "slice",
    });
    wrapped.inlineFragments = [
      { x: 30, y: 25, width: 92, height: 46, backgroundPositioningArea: { x: 30, y: 25, width: 184, height: 46 } },
      { x: 30, y: 71, width: 92, height: 46, backgroundPositioningArea: { x: -62, y: 71, width: 184, height: 46 } },
    ];
    wrapped.height = 92;
    const svg = elementTreeToSvgInner([wrapped], 300, 160);
    const body = visibleBody(svg);
    const maskedRects = [...body.matchAll(/<rect[^>]+mask="url\(#tbgm/g)];
    expect(maskedRects).toHaveLength(2);
    // Per-fragment patterns are minted from the two distinct stitched boxes;
    // a union-bbox or fragment restart would emit one pattern or equal x phase.
    const patternXs = [...svg.matchAll(/<pattern id="bg\d+"[^>]+x="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(patternXs).size).toBeGreaterThan(1);
  });
});
