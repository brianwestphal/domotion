import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";

const BASE_STYLES = {
  backgroundColor: "rgb(1, 2, 3)", backgroundImage: "none",
  backgroundSize: "auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat",
  backgroundClip: "border-box", backgroundOrigin: "padding-box", backgroundAttachment: "scroll",
  backgroundBlendMode: "normal", borderWidth: "4px", borderRadius: "0px",
  borderTopLeftRadius: "0px", borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px", borderBottomLeftRadius: "0px",
  borderTopWidth: "4px", borderRightWidth: "4px", borderBottomWidth: "4px", borderLeftWidth: "4px",
  borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
  borderColor: "rgb(4, 5, 6)", borderTopColor: "rgb(4, 5, 6)",
  borderRightColor: "rgb(4, 5, 6)", borderBottomColor: "rgb(4, 5, 6)", borderLeftColor: "rgb(4, 5, 6)",
  color: "rgb(10, 11, 12)", fontSize: "16px", fontFamily: "sans-serif", fontWeight: "400",
  fontStyle: "normal", lineHeight: "normal", letterSpacing: "normal", textAlign: "left",
  textTransform: "none", textDecoration: "none", whiteSpace: "normal", direction: "ltr",
  writingMode: "horizontal-tb", boxShadow: "inset 0 0 0 3px rgb(7, 8, 9)", opacity: "1",
  transform: "none", visibility: "visible", overflowX: "visible", overflowY: "visible",
  paddingTop: "4px", paddingRight: "12px", paddingBottom: "4px", paddingLeft: "12px",
  display: "inline-block", position: "static", zIndex: "auto", mixBlendMode: "normal",
  filter: "none", backdropFilter: "none", outlineColor: "transparent", outlineWidth: "0px",
  outlineStyle: "none", outlineOffset: "0px", effectiveAppearance: "menulist-button",
  selectDisplayText: "PHASE_TEXT", selectChevron: true,
} as unknown as CapturedElement["styles"];

describe("partial native-control decoration composition", () => {
  it("places Blink's menulist-button decoration between background and inset-shadow/border/text", () => {
    const element: CapturedElement = {
      tag: "select",
      text: "",
      x: 20,
      y: 20,
      width: 180,
      height: 44,
      fontAscent: 12,
      fontDescent: 4,
      children: [],
      styles: BASE_STYLES,
      nativeControlDecorationRaster: {
        x: 19,
        y: 19,
        width: 182,
        height: 46,
        kinds: ["menulist-button-arrow"],
        dataUri: "data:image/png;base64,RE0yNDU1",
      },
    };
    const svg = elementTreeToSvgInner([element], 240, 100);
    const background = svg.indexOf("rgb(1,2,3)");
    const decoration = svg.indexOf("data:image/png;base64,RE0yNDU1");
    const insetShadow = svg.indexOf('<g clip-path="url(#ishc');
    const border = svg.indexOf("rgb(4,5,6)");
    const text = svg.indexOf("PHASE_TEXT");
    expect([background, decoration, insetShadow, border, text].every((index) => index >= 0)).toBe(true);
    expect(background).toBeLessThan(decoration);
    expect(decoration).toBeLessThan(insetShadow);
    expect(insetShadow).toBeLessThan(border);
    expect(border).toBeLessThan(text);
    expect(svg).not.toContain("polyline");
  });
});
