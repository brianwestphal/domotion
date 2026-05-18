import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { extractFixedSubtrees, dedupeFixedAcrossSegments } from "./hoist-fixed.js";

function el(
  partial: Partial<CapturedElement> & { tag: string; x: number; y: number },
  position: string = "static",
): CapturedElement {
  return {
    text: "",
    width: partial.width ?? 100,
    height: partial.height ?? 20,
    children: partial.children ?? [],
    ...partial,
    styles: {
      position,
      ...(partial.styles ?? {}),
    } as CapturedElement["styles"],
  };
}

describe("extractFixedSubtrees", () => {
  it("returns input unchanged when no fixed elements exist", () => {
    const tree: CapturedElement[] = [
      el({ tag: "div", x: 0, y: 0 }, "static"),
      el({ tag: "p", x: 0, y: 30 }, "relative"),
    ];
    const r = extractFixedSubtrees(tree);
    expect(r.fixed).toEqual([]);
    expect(r.stripped).toBe(tree);
  });

  it("hoists a top-level position:fixed subtree", () => {
    const header = el({ tag: "header", x: 0, y: 0, width: 800, height: 60 }, "fixed");
    const main = el({ tag: "main", x: 0, y: 60 }, "static");
    const r = extractFixedSubtrees([header, main]);
    expect(r.fixed).toEqual([header]);
    expect(r.stripped).toHaveLength(1);
    expect(r.stripped[0].tag).toBe("main");
  });

  it("hoists a fixed subtree nested inside a normal-positioned ancestor", () => {
    const fixedNav = el({ tag: "nav", x: 0, y: 0, width: 800, height: 50 }, "fixed");
    const root = el({
      tag: "body",
      x: 0, y: 0, width: 800, height: 600,
      children: [fixedNav, el({ tag: "section", x: 0, y: 100 }, "static")],
    }, "static");
    const r = extractFixedSubtrees([root]);
    expect(r.fixed).toEqual([fixedNav]);
    // body shallow-copied with the nav stripped out
    expect(r.stripped).toHaveLength(1);
    expect(r.stripped[0]).not.toBe(root);
    expect(r.stripped[0].children).toHaveLength(1);
    expect(r.stripped[0].children![0].tag).toBe("section");
  });

  it("treats a fixed subtree atomically — inner fixed descendants ride along", () => {
    // Real-world: a fixed header with a fixed dropdown inside it. The
    // dropdown is part of the header's stacking context; we shouldn't try
    // to extract it separately.
    const innerFixed = el({ tag: "div", x: 10, y: 10 }, "fixed");
    const outerFixed = el({
      tag: "header",
      x: 0, y: 0, width: 800, height: 60,
      children: [innerFixed],
    }, "fixed");
    const r = extractFixedSubtrees([outerFixed]);
    expect(r.fixed).toEqual([outerFixed]);
    expect(r.fixed[0].children).toContain(innerFixed);
  });

  it("does not mutate the input tree when stripping", () => {
    const fixedChild = el({ tag: "div", x: 0, y: 0 }, "fixed");
    const original = el({
      tag: "body",
      x: 0, y: 0,
      children: [fixedChild, el({ tag: "p", x: 0, y: 20 }, "static")],
    }, "static");
    const originalChildren = original.children;
    extractFixedSubtrees([original]);
    // The original wasn't mutated — its children array reference and contents are intact.
    expect(original.children).toBe(originalChildren);
    expect(original.children).toHaveLength(2);
  });
});

describe("dedupeFixedAcrossSegments", () => {
  it("returns first occurrence per (tag, position, size) key", () => {
    const segA: CapturedElement[] = [
      el({ tag: "header", x: 0, y: 0, width: 800, height: 60, text: "v1" }, "fixed"),
    ];
    const segB: CapturedElement[] = [
      el({ tag: "header", x: 0, y: 0, width: 800, height: 60, text: "v2" }, "fixed"),
    ];
    const r = dedupeFixedAcrossSegments([segA, segB]);
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe("v1");
  });

  it("keeps distinct fixed elements that differ in size or position", () => {
    const segA: CapturedElement[] = [
      el({ tag: "header", x: 0, y: 0, width: 800, height: 60 }, "fixed"),
    ];
    const segB: CapturedElement[] = [
      el({ tag: "header", x: 0, y: 0, width: 800, height: 60 }, "fixed"),
      el({ tag: "div",    x: 0, y: 540, width: 800, height: 60 }, "fixed"),
    ];
    const r = dedupeFixedAcrossSegments([segA, segB]);
    expect(r).toHaveLength(2);
  });

  it("returns empty when no segment contributed fixed elements", () => {
    expect(dedupeFixedAcrossSegments([[], [], []])).toEqual([]);
  });
});
