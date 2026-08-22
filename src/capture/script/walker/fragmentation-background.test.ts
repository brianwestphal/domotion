import { afterEach, describe, expect, it, vi } from "vitest";

import { detectInlineFragments } from "./fragmentation.js";

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
});

function capturedWithUrlBackground(): any {
  return {
    styles: {
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: 'url("data:image/png;base64,AA==")',
      borderTopWidth: "0px",
      borderRightWidth: "0px",
      borderBottomWidth: "0px",
      borderLeftWidth: "0px",
      boxDecorationBreak: "slice",
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("fragmented background positioning capture (DM-2365)", () => {
  it("stitches horizontal inline fragments in logical LTR order", () => {
    const el = {
      getClientRects: () => [rect(40, 10, 30, 12), rect(15, 30, 50, 12)],
    };
    const captured = capturedWithUrlBackground();

    detectInlineFragments(el, {
      display: "inline",
      direction: "ltr",
      writingMode: "horizontal-tb",
    }, { x: 5, y: 2 }, captured);

    expect(captured.inlineFragments).toMatchObject([
      {
        x: 35,
        y: 8,
        backgroundOffsetInStitchedBox: { x: 0, y: 0 },
        backgroundPositioningArea: { x: 35, y: 8, width: 80, height: 12 },
      },
      {
        x: 10,
        y: 28,
        backgroundOffsetInStitchedBox: { x: 30, y: 0 },
        backgroundPositioningArea: { x: -20, y: 28, width: 80, height: 12 },
      },
    ]);
  });

  it("uses Blink's before/after swap for RTL inline strips", () => {
    const el = {
      getClientRects: () => [rect(40, 10, 30, 12), rect(15, 30, 50, 12)],
    };
    const captured = capturedWithUrlBackground();

    detectInlineFragments(el, {
      display: "inline",
      direction: "rtl",
      writingMode: "horizontal-tb",
    }, { x: 0, y: 0 }, captured);

    expect(captured.inlineFragments.map((fragment: any) => ({
      offset: fragment.backgroundOffsetInStitchedBox,
      area: fragment.backgroundPositioningArea,
    }))).toEqual([
      { offset: { x: 50, y: 0 }, area: { x: -10, y: 10, width: 80, height: 12 } },
      { offset: { x: 0, y: 0 }, area: { x: 15, y: 30, width: 80, height: 12 } },
    ]);
  });

  it("maps a vertical inline strip onto the physical Y axis", () => {
    const el = {
      getClientRects: () => [rect(60, 20, 14, 25), rect(35, 12, 14, 45)],
    };
    const captured = capturedWithUrlBackground();

    detectInlineFragments(el, {
      display: "inline",
      direction: "ltr",
      writingMode: "vertical-rl",
    }, { x: 0, y: 0 }, captured);

    expect(captured.inlineFragments[1]).toMatchObject({
      backgroundOffsetInStitchedBox: { x: 0, y: 25 },
      backgroundPositioningArea: { x: 35, y: -13, width: 14, height: 70 },
    });
  });

  it("stitches multicol block fragments on horizontal and vertical-rl block axes", () => {
    const parent = {};
    vi.stubGlobal("window", {
      getComputedStyle: () => ({ columnCount: "2", columnWidth: "auto" }),
    });
    const horizontal = {
      parentElement: parent,
      children: [],
      getClientRects: () => [rect(10, 20, 70, 40), rect(100, 20, 70, 60)],
    };
    const horizontalCapture = capturedWithUrlBackground();
    detectInlineFragments(horizontal, {
      display: "block",
      direction: "ltr",
      writingMode: "horizontal-tb",
    }, { x: 0, y: 0 }, horizontalCapture);

    expect(horizontalCapture.fragmentAxis).toBe("block");
    expect(horizontalCapture.inlineFragments[1]).toMatchObject({
      backgroundOffsetInStitchedBox: { x: 0, y: 40 },
      backgroundPositioningArea: { x: 100, y: -20, width: 70, height: 100 },
    });

    const vertical = {
      parentElement: parent,
      children: [],
      getClientRects: () => [rect(110, 10, 35, 70), rect(60, 10, 55, 70)],
    };
    const verticalCapture = capturedWithUrlBackground();
    detectInlineFragments(vertical, {
      display: "block",
      direction: "ltr",
      writingMode: "vertical-rl",
    }, { x: 0, y: 0 }, verticalCapture);

    expect(verticalCapture.inlineFragments.map((fragment: any) => ({
      offset: fragment.backgroundOffsetInStitchedBox,
      area: fragment.backgroundPositioningArea,
    }))).toEqual([
      { offset: { x: 55, y: 0 }, area: { x: 55, y: 10, width: 90, height: 70 } },
      { offset: { x: 0, y: 0 }, area: { x: 60, y: 10, width: 90, height: 70 } },
    ]);
  });
});
