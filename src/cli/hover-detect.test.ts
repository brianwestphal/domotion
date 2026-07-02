/**
 * DM-1563 (docs/94 Option 2): hover-response auto-detection — the browser-free
 * pieces. `diffHoverSnapshots` (paint vs motion deltas) and
 * `classifyHoverTransition` (which synthesis to pick) are pure, so they're
 * exhaustively covered here; the real-Chromium probe + rendered-SVG synthesis is
 * the e2e twin (`hover-detect.e2e.test.ts`).
 */
import { describe, it, expect } from "vitest";
import {
  diffHoverSnapshots,
  classifyHoverTransition,
  type ElementStyleSnapshot,
} from "./hover-detect.js";

function snap(key: string, styles: Record<string, string>): ElementStyleSnapshot {
  return { key, styles, rect: { x: 0, y: 0, width: 100, height: 40 } };
}

describe("diffHoverSnapshots (DM-1563)", () => {
  it("reports a background-color change as a paint delta", () => {
    const rest = [snap("", { backgroundColor: "rgb(35,134,54)" })];
    const hover = [snap("", { backgroundColor: "rgb(46,160,67)" })];
    const diff = diffHoverSnapshots(rest, hover);
    expect(diff.paint).toEqual([{ key: "", property: "backgroundColor", from: "rgb(35,134,54)", to: "rgb(46,160,67)" }]);
    expect(diff.motion).toEqual([]);
  });

  it("reports a transform change as a motion delta", () => {
    const rest = [snap("", { transform: "none" })];
    const hover = [snap("", { transform: "matrix(1.05, 0, 0, 1.05, 0, 0)" })];
    const diff = diffHoverSnapshots(rest, hover);
    expect(diff.motion).toEqual([{ key: "", property: "transform", from: "none", to: "matrix(1.05, 0, 0, 1.05, 0, 0)" }]);
    expect(diff.paint).toEqual([]);
  });

  it("ignores unchanged properties", () => {
    const rest = [snap("", { backgroundColor: "rgb(1,2,3)", transform: "none", opacity: "1" })];
    const hover = [snap("", { backgroundColor: "rgb(1,2,3)", transform: "none", opacity: "1" })];
    const diff = diffHoverSnapshots(rest, hover);
    expect(diff.paint).toEqual([]);
    expect(diff.motion).toEqual([]);
  });

  it("diffs descendants by key (a child that changes on :hover of the parent)", () => {
    const rest = [snap("", { color: "rgb(0,0,0)" }), snap("0", { color: "rgb(10,10,10)" })];
    const hover = [snap("", { color: "rgb(0,0,0)" }), snap("0", { color: "rgb(255,255,255)" })];
    const diff = diffHoverSnapshots(rest, hover);
    expect(diff.paint).toEqual([{ key: "0", property: "color", from: "rgb(10,10,10)", to: "rgb(255,255,255)" }]);
  });

  it("skips a descendant missing from one snapshot (added/removed node is out of scope)", () => {
    const rest = [snap("", { color: "rgb(0,0,0)" })];
    const hover = [snap("", { color: "rgb(0,0,0)" }), snap("0", { color: "rgb(1,1,1)" })];
    const diff = diffHoverSnapshots(rest, hover);
    expect(diff.paint).toEqual([]);
    expect(diff.motion).toEqual([]);
  });
});

describe("classifyHoverTransition (DM-1563)", () => {
  it("returns none when nothing changed", () => {
    expect(classifyHoverTransition({ paint: [], motion: [] })).toBe("none");
  });

  it("returns motion for a clean target-only transform change", () => {
    const diff = { paint: [], motion: [{ key: "", property: "transform", from: "none", to: "matrix(1.05, 0, 0, 1.05, 0, 0)" }] };
    expect(classifyHoverTransition(diff)).toBe("motion");
  });

  it("returns motion for a clean target-only opacity change", () => {
    const diff = { paint: [], motion: [{ key: "", property: "opacity", from: "1", to: "0.8" }] };
    expect(classifyHoverTransition(diff)).toBe("motion");
  });

  it("returns paint when any color/background delta is present", () => {
    const diff = {
      paint: [{ key: "", property: "backgroundColor", from: "rgb(1,1,1)", to: "rgb(2,2,2)" }],
      motion: [{ key: "", property: "transform", from: "none", to: "matrix(1.05, 0, 0, 1.05, 0, 0)" }],
    };
    expect(classifyHoverTransition(diff)).toBe("paint");
  });

  it("falls back to paint for a transform change with a non-identity rest baseline", () => {
    // Rest transform isn't `none`, so the captured paint already bakes it in —
    // an absolute-value keyframe would double-apply; crossfade is the safe path.
    const diff = { paint: [], motion: [{ key: "", property: "transform", from: "matrix(1, 0, 0, 1, 5, 0)", to: "matrix(1.05, 0, 0, 1.05, 0, 0)" }] };
    expect(classifyHoverTransition(diff)).toBe("paint");
  });

  it("falls back to paint when the motion delta is on a descendant, not the target", () => {
    const diff = { paint: [], motion: [{ key: "0", property: "transform", from: "none", to: "matrix(1.05, 0, 0, 1.05, 0, 0)" }] };
    expect(classifyHoverTransition(diff)).toBe("paint");
  });

  it("falls back to paint for a non-clean opacity baseline (rest already dimmed)", () => {
    const diff = { paint: [], motion: [{ key: "", property: "opacity", from: "0.5", to: "1" }] };
    expect(classifyHoverTransition(diff)).toBe("paint");
  });
});
