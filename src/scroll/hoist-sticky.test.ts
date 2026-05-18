import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import { extractStickyWindows } from "./hoist-sticky.js";

function el(
  partial: Partial<CapturedElement> & { tag: string; x: number; y: number },
  position: string = "static",
): CapturedElement {
  return {
    text: partial.text ?? "",
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

// Each segment-tree below is just a list of top-level siblings; production
// trees go several levels deep but `extractStickyWindows` walks recursively
// so shallow trees exercise the same logic.

describe("extractStickyWindows", () => {
  it("never stuck: sticky element whose y strictly decreases across segments → left inline, no overlays", () => {
    const seg0 = [el({ tag: "div", x: 0, y: 0 }), el({ tag: "nav", x: 0, y: 200, width: 800, height: 60 }, "sticky")];
    const seg1 = [el({ tag: "div", x: 0, y: 0 }), el({ tag: "nav", x: 0, y: 100, width: 800, height: 60 }, "sticky")];
    const seg2 = [el({ tag: "div", x: 0, y: 0 }), el({ tag: "nav", x: 0, y:   0, width: 800, height: 60 }, "sticky")];
    const r = extractStickyWindows([seg0, seg1, seg2]);
    expect(r.overlays).toEqual([]);
    // Trees are unmodified (returned by reference when no strikes apply).
    expect(r.stripped[0]).toBe(seg0);
    expect(r.stripped[1]).toBe(seg1);
    expect(r.stripped[2]).toBe(seg2);
  });

  it("always stuck: sticky element at the same y in every segment → one overlay spanning all, stripped from every tree", () => {
    const stickyEl = (text: string): CapturedElement =>
      el({ tag: "nav", text, x: 0, y: 0, width: 800, height: 60 }, "sticky");
    const seg0 = [el({ tag: "div", x: 0, y: 0 }), stickyEl("a")];
    const seg1 = [el({ tag: "div", x: 0, y: 0 }), stickyEl("b")];
    const seg2 = [el({ tag: "div", x: 0, y: 0 }), stickyEl("c")];
    const r = extractStickyWindows([seg0, seg1, seg2]);
    expect(r.overlays).toHaveLength(1);
    expect(r.overlays[0].firstSegmentIdx).toBe(0);
    expect(r.overlays[0].lastSegmentIdx).toBe(2);
    // Each segment has the sticky element stripped — only the original div remains.
    for (const tree of r.stripped) {
      expect(tree).toHaveLength(1);
      expect(tree[0].tag).toBe("div");
    }
  });

  it("stuck mid-scroll: sticky scrolls for first K segments then stays → inline for K, overlay for the rest", () => {
    // Seg 0..1: y decreases (in-flow). Seg 2..4: y stays at 60 (stuck).
    const stick = (y: number): CapturedElement => el({ tag: "nav", x: 0, y, width: 800, height: 50 }, "sticky");
    const seg0 = [el({ tag: "main", x: 0, y: 0 }), stick(300)];
    const seg1 = [el({ tag: "main", x: 0, y: 0 }), stick(180)];
    const seg2 = [el({ tag: "main", x: 0, y: 0 }), stick(60)];
    const seg3 = [el({ tag: "main", x: 0, y: 0 }), stick(60)];
    const seg4 = [el({ tag: "main", x: 0, y: 0 }), stick(60)];
    const r = extractStickyWindows([seg0, seg1, seg2, seg3, seg4]);
    expect(r.overlays).toHaveLength(1);
    expect(r.overlays[0].firstSegmentIdx).toBe(2);
    expect(r.overlays[0].lastSegmentIdx).toBe(4);
    // Segs 0–1: still contain the nav (it's in flow, still scrolling).
    expect(r.stripped[0].find((n) => n.tag === "nav")).not.toBeUndefined();
    expect(r.stripped[1].find((n) => n.tag === "nav")).not.toBeUndefined();
    // Segs 2–4: nav has been stripped (it's now on the overlay).
    expect(r.stripped[2].find((n) => n.tag === "nav")).toBeUndefined();
    expect(r.stripped[3].find((n) => n.tag === "nav")).toBeUndefined();
    expect(r.stripped[4].find((n) => n.tag === "nav")).toBeUndefined();
  });

  it("two stuck windows: sticks, un-sticks, sticks again → two overlay entries", () => {
    // Seg 0: in-flow (y=400). Seg 1–2: stuck (y=0). Seg 3: in-flow (y=200).
    // Seg 4–5: stuck again (y=0).
    const stick = (y: number): CapturedElement =>
      el({ tag: "nav", x: 0, y, width: 800, height: 50 }, "sticky");
    const trees: CapturedElement[][] = [
      [stick(400)],
      [stick(0)],
      [stick(0)],
      [stick(200)],
      [stick(0)],
      [stick(0)],
    ];
    const r = extractStickyWindows(trees);
    expect(r.overlays).toHaveLength(2);
    expect(r.overlays.map((o) => [o.firstSegmentIdx, o.lastSegmentIdx])).toEqual([[1, 2], [4, 5]]);
    // Seg 0, 3 retain the nav (in-flow).
    expect(r.stripped[0]).toHaveLength(1);
    expect(r.stripped[3]).toHaveLength(1);
    // Seg 1, 2, 4, 5 have the nav stripped.
    expect(r.stripped[1]).toHaveLength(0);
    expect(r.stripped[2]).toHaveLength(0);
    expect(r.stripped[4]).toHaveLength(0);
    expect(r.stripped[5]).toHaveLength(0);
  });

  it("single-segment 'stuck' (length 1 run) does NOT qualify — element stays inline", () => {
    // A sticky element captured at the same y in only ONE segment is not
    // stuck (could just be a momentary zero-velocity sample); needs ≥ 2
    // consecutive same-y segments to count.
    const stick = (y: number): CapturedElement =>
      el({ tag: "nav", x: 0, y, width: 800, height: 50 }, "sticky");
    const r = extractStickyWindows([
      [stick(100)],
      [stick(50)],
      [stick(50)],   // start of a potential run (but only 1 segment so far)
      [stick(0)],    // run breaks here
    ]);
    // segs 1–2 are at the same y → that's a stuck window of length 2. Length-1
    // "windows" wouldn't qualify, but 2 does. This case demonstrates the ≥2
    // threshold actually catches its boundary.
    expect(r.overlays).toHaveLength(1);
    expect(r.overlays[0].firstSegmentIdx).toBe(1);
    expect(r.overlays[0].lastSegmentIdx).toBe(2);
  });

  it("non-sticky elements are untouched even at constant y", () => {
    // A normal element at the same x/y in every segment should NOT be hoisted —
    // it's not sticky.
    const trees: CapturedElement[][] = [
      [el({ tag: "header", x: 0, y: 0, width: 800, height: 60 }, "static")],
      [el({ tag: "header", x: 0, y: 0, width: 800, height: 60 }, "static")],
      [el({ tag: "header", x: 0, y: 0, width: 800, height: 60 }, "static")],
    ];
    const r = extractStickyWindows(trees);
    expect(r.overlays).toEqual([]);
  });

  it("doesn't mutate the input trees", () => {
    const stickyChild = el({ tag: "nav", x: 0, y: 0, width: 800, height: 50 }, "sticky");
    const body0 = el({
      tag: "body", x: 0, y: 0, width: 800, height: 600,
      children: [el({ tag: "main", x: 0, y: 60 }), stickyChild],
    });
    const body1 = el({
      tag: "body", x: 0, y: 0, width: 800, height: 600,
      children: [el({ tag: "main", x: 0, y: 60 }), stickyChild],
    });
    const tree0 = [body0];
    const tree1 = [body1];
    const originalChildren0 = body0.children;
    extractStickyWindows([tree0, tree1]);
    expect(body0.children).toBe(originalChildren0);
    expect(body0.children).toHaveLength(2);
  });

  it("matches sticky elements across segments by (tag, size, path-in-tree)", () => {
    // Same tag/size, but different path-in-tree → treated as DIFFERENT
    // logical elements and NOT collapsed.
    const stick1 = (y: number): CapturedElement =>
      el({ tag: "nav", x: 0, y, width: 800, height: 50 }, "sticky");
    const trees: CapturedElement[][] = [
      // Sticky nav as the 0th child.
      [stick1(0), el({ tag: "main", x: 0, y: 50 })],
      // Sticky nav as the 1st child (different path → different identity).
      [el({ tag: "main", x: 0, y: 50 }), stick1(0)],
      [stick1(0), el({ tag: "main", x: 0, y: 50 })],
    ];
    const r = extractStickyWindows(trees);
    // Neither nav matches across segments (path-in-tree differs), so no
    // stuck windows form. The two seg-0 / seg-2 occurrences would
    // otherwise be at the same y but only 2 segments are involved and
    // they're not consecutive — so no run.
    expect(r.overlays).toEqual([]);
  });
});
