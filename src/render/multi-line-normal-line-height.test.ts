import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { renderMultiLineText } from "./text.js";

/**
 * `renderMultiLineText` places each source line at `top + index * pitch`. With `line-height: normal` the
 * pitch is Blink's LineSpacing() for the element's font, which the capture measures
 * (`CapturedElement.normalLineHeight`); a numeric line-height is used as authored, and the 1.2em stand-in
 * survives only for older cached trees that carry no measurement.
 */
function element(overrides: Record<string, unknown>, lineHeight = "normal"): CapturedElement {
  return {
    tag: "pre",
    x: 10,
    y: 10,
    width: 200,
    height: 120,
    text: "aa\nbb\ncc\ndd",
    textLeft: 10,
    textTop: 10,
    fontAscent: 12,
    fontDescent: 4,
    styles: {
      fontSize: "16px",
      fontFamily: "Courier",
      fontWeight: "400",
      fontStyle: "normal",
      lineHeight,
      color: "rgb(0,0,0)",
      whiteSpace: "pre",
      letterSpacing: "normal",
      wordSpacing: "0",
      textAlign: "left",
      direction: "ltr",
    },
    children: [],
    ...overrides,
  } as unknown as CapturedElement;
}

/** The baseline y of each rendered line. */
function baselines(el: CapturedElement): number[] {
  const svg = renderMultiLineText({ el, idPrefix: "t", clipId: "c", fillColor: "#000" });
  return [...svg.matchAll(/<text [^>]*\by="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
}

const pitches = (ys: number[]) => ys.slice(1).map((y, i) => Number((y - ys[i]).toFixed(3)));

describe("renderMultiLineText line pitch", () => {
  it("uses the measured LineSpacing for line-height: normal", () => {
    expect(pitches(baselines(element({ normalLineHeight: 21 })))).toEqual([21, 21, 21]);
    expect(pitches(baselines(element({ normalLineHeight: 18 })))).toEqual([18, 18, 18]);
  });

  it("uses an authored line-height as written, ignoring the measurement", () => {
    expect(pitches(baselines(element({ normalLineHeight: 21 }, "30px")))).toEqual([30, 30, 30]);
  });

  it("falls back to 1.2em only when no measurement was captured", () => {
    expect(pitches(baselines(element({})))).toEqual([19.2, 19.2, 19.2]);
  });
});
