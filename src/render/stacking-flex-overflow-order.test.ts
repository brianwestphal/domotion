import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { gatherStackingContextChildren } from "./stacking.js";

function node(display: string, children: CapturedElement[] = []): CapturedElement {
  return { tag: "div", text: "", x: 0, y: 0, width: 100, height: 100,
    styles: { display, position: "static", zIndex: "auto", float: "none" }, children } as CapturedElement;
}

describe("stacking-context gathering for ordinary flex items", () => {
  it("keeps an overflowing flex item nested so later flow content paints after it (DM-2286)", () => {
    const item = node("block");
    const flex = node("flex", [item]);
    const later = node("block");
    const hoisted = new Set<CapturedElement>();

    expect(gatherStackingContextChildren([flex, later], hoisted, "block"))
      .toEqual([flex, later]);
    expect(hoisted.has(item)).toBe(false);
  });
});
