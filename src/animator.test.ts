/**
 * Unit tests for the SVG animator — specifically the keyframe timing and
 * shared-defs hoist. Regression tests for SK-662 (flicker + size).
 */

import { describe, it, expect } from "vitest";
import { generateAnimatedSvg } from "./animator.js";

describe("animator", () => {
  it("includes sharedDefs in the top-level <defs>", () => {
    const svg = generateAnimatedSvg({
      width: 100,
      height: 100,
      sharedDefs: `<path id="g0" d="M0 0L1 1Z"/>`,
      frames: [
        { svgContent: `<use href="#g0"/>`, duration: 200 },
      ],
    });
    // The sharedDefs markup should appear inside the top-level <defs> block,
    // immediately after the viewport clip, NOT inside any frame's <g class="f">.
    const topDefs = svg.match(/<defs>[\s\S]*?<\/defs>/);
    expect(topDefs).not.toBeNull();
    expect(topDefs![0]).toContain(`id="g0"`);
  });

  it("crossfade-only scenes route through the merge pipeline (no per-frame fv- groups)", () => {
    // With the merge pipeline, an all-crossfade scene is reduced to a single
    // element tree with per-element visibility timelines — NOT per-frame
    // opacity groups. fv-N keyframes (the old model) should be absent;
    // timeline classes (tN) should appear when frames differ.
    const svg = generateAnimatedSvg({
      width: 100,
      height: 100,
      frames: [
        { svgContent: `<rect fill="red" width="50" height="50"/>`, duration: 1000, transition: { type: "crossfade", duration: 200 } },
        { svgContent: `<rect fill="blue" width="50" height="50"/>`, duration: 1000 },
      ],
    });
    expect(svg).not.toMatch(/@keyframes fv-/);
    expect(svg).toMatch(/@keyframes t\d+/);
    expect(svg).toContain("--scene-dur");
  });

  it("crossfade: identical content across frames is rendered once", () => {
    // Regression test for SK-662 — stable elements should not be re-drawn per
    // frame. Two frames with the same <rect> should produce exactly one <rect>.
    const svg = generateAnimatedSvg({
      width: 100,
      height: 100,
      frames: [
        { svgContent: `<rect width="50" height="50" fill="green"/>`, duration: 500, transition: { type: "crossfade", duration: 100 } },
        { svgContent: `<rect width="50" height="50" fill="green"/>`, duration: 500 },
      ],
    });
    expect((svg.match(/<rect width="50" height="50" fill="green"\/>/g) ?? []).length).toBe(1);
  });

  it("non-crossfade transitions are unaffected", () => {
    const svg = generateAnimatedSvg({
      width: 100,
      height: 100,
      frames: [
        { svgContent: `<rect/>`, duration: 1000, transition: { type: "push-left", duration: 200 } },
        { svgContent: `<rect/>`, duration: 1000 },
      ],
    });
    // push-left uses translateX keyframes — presence is enough.
    expect(svg).toContain("translateX");
  });
});
