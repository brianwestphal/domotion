import { describe, expect, it } from "vitest";
import type { CapturedElement } from "../capture/types.js";
import { gatherStackingContextChildren, sortChildrenByPaintOrder } from "./stacking.js";

// DM-T0CE2X: a non-positioned stacking context is a stacked layer
// (LayoutObject::IsStacked), collected into the nearest stacking context's
// z-order list through non-stacking ancestors at EffectiveZIndex 0 unless
// z-index applies (PaintLayerStackingNode::CollectLayers, Chromium 7d859f27).
function node(styles: Record<string, string>, children: CapturedElement[] = []): CapturedElement {
  return {
    tag: "div",
    text: "",
    x: 0,
    y: 0,
    width: 60,
    height: 60,
    styles: { display: "block", position: "static", zIndex: "auto", float: "none", opacity: "1", ...styles },
    children,
  } as CapturedElement;
}

describe("non-positioned stacking contexts", () => {
  it.each([
    ["opacity", { opacity: "0.99" }],
    ["filter", { filter: "blur(0px)" }],
    ["isolation", { isolation: "isolate" }],
    ["will-change", { willChange: "opacity" }],
  ])("hoists a %s stacking context through static ancestors", (_name, styles) => {
    const sc = node(styles);
    const inner = node({}, [sc]);
    const wrapper = node({}, [inner]);
    const hoisted = new Set<CapturedElement>();
    expect(gatherStackingContextChildren([wrapper], hoisted, "block")).toEqual([wrapper, sc]);
    expect(hoisted.has(sc)).toBe(true);
  });

  it("does not hoist ordinary blocks or an overflow-only scroller", () => {
    const plain = node({});
    const scroller = node({ overflowX: "hidden", overflowY: "hidden" });
    const wrapper = node({}, [plain, scroller]);
    const hoisted = new Set<CapturedElement>();
    expect(gatherStackingContextChildren([wrapper], hoisted, "block")).toEqual([wrapper]);
    expect(hoisted.size).toBe(0);
  });

  it("does not descend into a stacking context it hoists", () => {
    const deep = node({ opacity: "0.5" });
    const sc = node({ opacity: "0.99" }, [deep]);
    const hoisted = new Set<CapturedElement>();
    expect(gatherStackingContextChildren([node({}, [sc])], hoisted, "block")).toHaveLength(2);
    expect(hoisted.has(deep)).toBe(false);
  });

  it("ignores an authored z-index that does not apply (EffectiveZIndex 0)", () => {
    const blue = node({ position: "absolute", zIndex: "1" });
    const sc = node({ opacity: "0.99", zIndex: "5" });
    const negative = node({ opacity: "0.99", zIndex: "-1" });
    const earlier = node({ position: "absolute" });
    // Without the guard the z:5 box sorted above a positioned z:1 sibling and
    // the z:-1 one below the block background phase.
    expect(sortChildrenByPaintOrder([sc, blue], "block")).toEqual([sc, blue]);
    expect(sortChildrenByPaintOrder([earlier, negative], "block")).toEqual([earlier, negative]);
  });

  it("keeps applying z-index to flex items", () => {
    const later = node({ position: "relative", zIndex: "1" });
    const item = node({ opacity: "0.99", zIndex: "5" });
    expect(sortChildrenByPaintOrder([item, later], "flex")).toEqual([later, item]);
  });
});
