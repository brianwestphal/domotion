import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { capturedElement } from "../test-support/captured-fixtures.js";
import { elementTreeToSvgInner } from "./element-tree-to-svg.js";
import { paintOrderHitSequence } from "./paint-order.js";
import { establishesStackingContext, isOverflowOnlySC } from "./stacking.js";

// DM-GXK8X1: Blink's overflow clip lives on LayoutBox; a non-replaced inline
// box (LayoutInline) never clips, whatever its computed overflow. An <img>
// laid out as an ordinary box (its UA shadow as a non-replaced fallback) is
// such an inline box, so its UA `overflow: clip` must not clip its icon.
const COLORS = { color: "rgb(0, 0, 0)", borderColor: "rgb(0, 0, 0)", backgroundColor: "rgba(0, 0, 0, 0)" };

function host(tag: string, display: string, extra: Partial<CapturedElement> = {}): CapturedElement {
  return capturedElement({
    tag,
    text: "",
    x: 16,
    y: 0,
    width: 0,
    height: 0,
    styles: { ...COLORS, display, overflowX: "clip", overflowY: "clip" },
    children: [
      capturedElement({
        tag: "div",
        text: "",
        x: 0,
        y: 0,
        width: 16,
        height: 16,
        styles: { ...COLORS, backgroundColor: "rgb(255, 0, 0)" },
        children: [],
      }),
    ],
    ...extra,
  });
}

const clips = (el: CapturedElement) => elementTreeToSvgInner([el], 100, 100).includes("<clipPath");

describe("overflow clip on inline boxes (DM-GXK8X1)", () => {
  it("does not clip a non-replaced inline box", () => {
    expect(clips(host("span", "inline"))).toBe(false);
  });

  it("still clips an inline-block box", () => {
    expect(clips(host("span", "inline-block"))).toBe(true);
  });

  it("clips a replaced inline img but not one laid out as a non-replaced fallback", () => {
    expect(clips(host("img", "inline"))).toBe(true);
    const fallback = host("img", "inline", {
      brokenImageFallback: { disposition: "non-replaced-fallback" } as CapturedElement["brokenImageFallback"],
    });
    expect(clips(fallback)).toBe(false);
  });
});

// DM-SFY5S7: stacking and hit-testing read the same rule.
describe("overflow on inline boxes in stacking and hit-testing (DM-SFY5S7)", () => {
  it("does not make a non-replaced inline box a scroll-container stacking context", () => {
    expect(establishesStackingContext(host("span", "inline"))).toBe(false);
    expect(isOverflowOnlySC(host("span", "inline"))).toBe(false);
    expect(establishesStackingContext(host("span", "inline-block"))).toBe(true);
    expect(isOverflowOnlySC(host("span", "inline-block"))).toBe(true);
  });

  it("does not clip descendants' hit boxes to a non-replaced inline box", () => {
    const clipsOf = (el: CapturedElement) =>
      paintOrderHitSequence([el]).find((entry) => entry.el.tag === "div")?.clips.length;
    expect(clipsOf(host("span", "inline"))).toBe(0);
    expect(clipsOf(host("span", "inline-block"))).toBe(1);
  });
});
