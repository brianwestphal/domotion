import { describe, expect, it } from "vitest";
import { capturedElement } from "../test-support/captured-fixtures.js";
import type { CapturedElement, CapturedPseudoFragmentSet } from "../capture/types.js";
import { collectPseudoStackingContexts } from "./pseudo-stacking-contexts.js";

function owner(styles: Partial<CapturedElement["styles"]> = {}, order: number | undefined = 0): CapturedElement {
  return capturedElement({
    tag: "div",
    x: 0,
    y: 0,
    width: 40,
    height: 40,
    children: [],
    styles: {
      display: "block",
      position: "relative",
      zIndex: "auto",
      opacity: "1",
      overflowX: "visible",
      overflowY: "visible",
      ...styles,
    },
    pseudoFragments: [
      { pseudo: "::after", paint: { position: "absolute", zIndex: 2, ...(order == null ? {} : { order }) } },
    ],
  });
}
function record(element: CapturedElement): CapturedPseudoFragmentSet {
  return element.pseudoFragments![0];
}

describe("positioned generated paint context ownership", () => {
  it("does not mutate captured children/records while moving ownership through non-context hosts", () => {
    const host = owner();
    const child = owner({ zIndex: "1" });
    host.children.push(child);
    const parent = capturedElement({ tag: "div", children: [host], styles: { position: "static", display: "block" } });
    Object.freeze(parent.children);
    Object.freeze(host.children);
    Object.freeze(host.pseudoFragments);
    const before = JSON.stringify(parent);
    const plan = collectPseudoStackingContexts([parent]);
    expect(plan.contexts.get(null)?.map((entry) => entry.owner)).toEqual([host]);
    expect(plan.contexts.get(child)?.map((entry) => entry.owner)).toEqual([child]);
    expect(plan.contexts.get(null)?.[0].ancestors).toEqual([parent, host]);
    expect(JSON.stringify(parent)).toBe(before);
  });

  it.each([{ opacity: ".5" }, { zIndex: "-1" }, { contain: "layout", paintOrLayoutContainmentEligible: true }])(
    "retains a real context barrier %j",
    (styles) => {
      const context = owner(styles);
      context.pseudoFragments = [];
      const host = owner();
      context.children.push(host);
      const plan = collectPseudoStackingContexts([context]);
      expect(plan.contexts.get(null)).toBeUndefined();
      expect(plan.contexts.get(context)?.[0]).toMatchObject({ owner: host, ancestors: [host] });
    },
  );

  it("respects a capture-owned surface even when its pixels are unavailable", () => {
    const opaque = owner();
    opaque.nativeControlRaster = { x: 0, y: 0, width: 40, height: 40 };
    opaque.children.push(owner());
    const plan = collectPseudoStackingContexts([opaque]);
    expect(plan.managed.size).toBe(0);
    expect(plan.contexts.size).toBe(0);
    expect(plan.treeOrder.has(opaque.children[0])).toBe(true);
  });

  it("preserves negative and legacy3D ownership rather than projecting a new phase", () => {
    const negative = owner();
    record(negative).paint.zIndex = -1;
    const projective = owner({ transformStyle: "preserve-3d" });
    expect(collectPseudoStackingContexts([negative, projective]).managed.size).toBe(0);
  });

  it("uses native grid order for in-flow generated items and effective0 for out-of-flow", () => {
    const grid = owner({ display: "grid" }, -1);
    const child = capturedElement({
      tag: "div",
      children: [],
      styles: { position: "relative", zIndex: "1", order: "0" },
    });
    grid.children.push(child);
    record(grid).paint.position = "relative";
    let plan = collectPseudoStackingContexts([grid]);
    expect(plan.recordOrder.get(record(grid))).toBeLessThan(plan.treeOrder.get(child)!);
    record(grid).paint.position = "absolute";
    plan = collectPseudoStackingContexts([grid]);
    expect(plan.recordOrder.get(record(grid))).toBeGreaterThan(plan.treeOrder.get(child)!);
  });

  it("retains legacy host-local paint when an in-flow generated item's source order is absent", () => {
    const grid = owner({ display: "grid" }, undefined);
    delete record(grid).paint.order;
    record(grid).paint.position = "relative";
    const plan = collectPseudoStackingContexts([grid]);
    expect(plan.managed.has(record(grid))).toBe(false);
    expect(plan.unavailable[0].reason).toContain("source order");
  });

  it("preserves a whole context when deep ordered ancestry lacks native layer facts", () => {
    const host = owner({ position: "static" });
    const wrapper = capturedElement({ children: [host], styles: { display: "block", position: "static" } });
    const item = capturedElement({ children: [wrapper], styles: { display: "block", position: "static", order: "1" } });
    const flex = capturedElement({ children: [item], styles: { display: "flex", position: "relative" } });
    const plan = collectPseudoStackingContexts([flex]);
    expect(plan.contexts.size).toBe(0);
    expect(plan.managed.size).toBe(0);
    expect(plan.unavailable[0].reason).toContain("native layer order");
  });
});
