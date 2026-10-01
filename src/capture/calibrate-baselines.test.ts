import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { calibrateBaselines } from "./index.js";
import type { CapturedElement } from "./types.js";

function textElement(): CapturedElement {
  return {
    tag: "p",
    children: [],
    text: "Hxgy",
    textTop: 20,
    textLeft: 20,
    textWidth: 72,
    textHeight: 36,
    x: 20,
    y: 20,
    width: 72,
    height: 36,
    styles: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderColor: "rgb(0, 0, 0)",
      borderWidth: "0px",
      borderRadius: "0px",
      borderTopWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
      borderTopStyle: "none",
      borderRightStyle: "none",
      borderBottomStyle: "none",
      borderLeftStyle: "none",
      borderTopColor: "rgb(0, 0, 0)",
      borderRightColor: "rgb(0, 0, 0)",
      borderBottomColor: "rgb(0, 0, 0)",
      borderLeftColor: "rgb(0, 0, 0)",
      borderCollapse: "separate",
      overflowX: "visible",
      overflowY: "visible",
      scrollbarGutter: "auto",
      scrollWidth: 72,
      scrollHeight: 36,
      clientWidth: 72,
      clientHeight: 36,
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
      listStylePosition: "outside",
      backgroundImage: "none",
      backgroundSize: "auto",
      backgroundPosition: "0% 0%",
      backgroundRepeat: "repeat",
      backgroundClip: "border-box",
      backgroundOrigin: "padding-box",
      backgroundAttachment: "scroll",
      paddingTop: "0px",
      paddingRight: "0px",
      paddingBottom: "0px",
      paddingLeft: "0px",
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
      fontSize: "32px",
      fontFamily: "Arial, sans-serif",
      fontWeight: "400",
      fontStyle: "normal",
      color: "rgb(0, 0, 0)",
      opacity: "1",
      lineHeight: "normal",
      letterSpacing: "normal",
      fontKerning: "auto",
      fontStretch: "100%",
      fontVariationSettings: "normal",
      fontFeatureSettings: "normal",
    },
  };
}

describe("calibrateBaselines result application", () => {
  it("writes a successful browser measurement even when it equals the captured ascent", async () => {
    const text = textElement();
    const empty = { ...textElement(), text: "", fontAscent: 17 };
    let ascent = 29;
    const writes: number[] = [];
    Object.defineProperty(text, "fontAscent", {
      get: () => ascent,
      set: (value: number) => {
        writes.push(value);
        ascent = value;
      },
    });
    const evaluate = vi.fn(async (expression: string) => {
      expect(expression).toContain('"text":"Hxgy"');
      return [{ key: "c0", ascent: 29 }];
    });
    const page = { evaluate } as unknown as Page;

    await calibrateBaselines(page, [text, empty], Buffer.from([0]));

    expect(evaluate).toHaveBeenCalledOnce();
    expect(writes).toEqual([29]);
    expect(text.fontAscent).toBe(29);
    expect(empty.fontAscent).toBe(17);
  });

  it("keeps the captured ascent when the browser reports no usable ink", async () => {
    const text = textElement();
    text.fontAscent = 29;
    const page = { evaluate: vi.fn(async () => [{ key: "c0", ascent: null }]) } as unknown as Page;
    await calibrateBaselines(page, [text], Buffer.from([0]));
    expect(text.fontAscent).toBe(29);
  });
});
