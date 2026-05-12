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

  it("cut transition: ignores duration on the input", () => {
    // `cut` is supposed to be instant regardless of what `duration` was passed
    // (so a config that mistakenly leaves `duration: 9999` on a cut doesn't
    // bloat the scene). Compare a 9999-duration cut against a 0-duration cut:
    // they should produce the same scene length.
    const a = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red"/>`, duration: 1000, transition: { type: "cut", duration: 9999 } },
        { svgContent: `<rect fill="blue"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
      ],
    });
    const b = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="blue"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
      ],
    });
    const aDur = a.match(/--scene-dur:\s*([0-9.]+)s/)?.[1];
    const bDur = b.match(/--scene-dur:\s*([0-9.]+)s/)?.[1];
    expect(aDur).toBe(bDur);
  });

  it("cut transition: routes through the merge fast path (no fv-N groups)", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="blue" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="green" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
      ],
    });
    expect(svg).not.toMatch(/@keyframes fv-/);
    expect(svg).toMatch(/@keyframes t\d+/);
    // 3 frames × 1000ms hold + 3 × 0ms cut transitions = 3000ms total.
    expect(svg).toMatch(/--scene-dur:\s*3\.00s/);
  });

  it("intra-frame animation: emits @keyframes scoped to frame's visibility window", () => {
    // DM-209: an animation declared on a frame should compile into a
    // @keyframes block whose timing maps onto the global scene clock,
    // gated by the frame's start position.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        {
          svgContent: `<rect/>`,
          duration: 2000,
          transition: { type: "cut", duration: 0 },
          animations: [{
            animId: "bar",
            property: "width",
            from: "0%",
            to: "100%",
            duration: 2000,
            easing: "ease-out",
          }],
        },
      ],
    });
    // Total scene = 3000ms. Frame 1 starts at 33.333%. Animation is during
    // [frame-start + 0ms, frame-start + 2000ms] = [33.333%, 100%].
    expect(svg).toMatch(/@keyframes f1-bar-0/);
    expect(svg).toMatch(/\.anim-bar\s*{[^}]*animation:\s*f1-bar-0/);
    // Both `from` and `to` values must appear in the keyframe block.
    expect(svg).toContain("width: 0%");
    expect(svg).toContain("width: 100%");
    // Timing function passes through.
    expect(svg).toContain("ease-out");
  });

  it("intra-frame animation: translateY desugars to transform: translateY()", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        {
          svgContent: `<rect/>`,
          duration: 1000,
          animations: [{
            animId: "slide",
            property: "translateY",
            from: "240px",
            to: "0px",
            duration: 400,
          }],
        },
      ],
    });
    expect(svg).toContain("transform: translateY(240px)");
    expect(svg).toContain("transform: translateY(0px)");
  });

  it("DM-599: push-left frame gets a paired fd-N display animation alongside fv-N", () => {
    // push-left is unmergeable (the merge fast path only takes crossfade/cut),
    // so it goes through the unmerged emit path that emits per-frame fv-/fp-
    // blocks. The DM-599 optimization adds an fd-N keyframes block that
    // toggles `display: none ↔ inline` so the frame is dropped from paint
    // outside its show window.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect/>`, duration: 1000, transition: { type: "push-left", duration: 200 } },
        { svgContent: `<rect/>`, duration: 1000 },
      ],
    });
    // Both frames get an fd-N keyframes block …
    expect(svg).toMatch(/@keyframes fd-0\s*{/);
    expect(svg).toMatch(/@keyframes fd-1\s*{/);
    // … alongside the existing fv-N opacity block.
    expect(svg).toMatch(/@keyframes fv-0\s*{/);
    // The keyframes flip display between none and inline.
    expect(svg).toMatch(/display:\s*none/);
    expect(svg).toMatch(/display:\s*inline/);
    // The frame's CSS rule lists BOTH animations, with the fd one tagged
    // step-end so the display flip is instant (not snap-at-50% of segment).
    expect(svg).toMatch(/\.f-0\s*{\s*animation:[^}]*fv-0[^}]*,[^}]*fd-0[^}]*step-end/);
    // The base .f rule sets display:none so frames start hidden until the
    // keyframe flips them in.
    expect(svg).toMatch(/\.f\s*{[^}]*display:\s*none/);
  });

  it("DM-599: cut frames fold display into fv-N (same step-end timing)", () => {
    // Three explicit `cut` frames — the all-mergeable check trips and these
    // route through the MERGE pipeline. But a non-mergeable transition mixed
    // in (e.g. push-left) would route this through the unmerged path. We
    // verify the unmerged path's cut branch here by mixing.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red"/>`,  duration: 1000, transition: { type: "push-left", duration: 100 } },
        { svgContent: `<rect fill="blue"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="green"/>`, duration: 1000 },
      ],
    });
    // The "cut" frame's fv-N keyframes carry the display toggle inline (no
    // separate fd-N block) since cut already uses step-end on fv-N.
    const fv1Match = svg.match(/@keyframes fv-1\s*{[\s\S]*?\n\s*}/);
    expect(fv1Match).not.toBeNull();
    expect(fv1Match![0]).toMatch(/display:\s*none/);
    expect(fv1Match![0]).toMatch(/display:\s*inline/);
    // The "cut" frame uses ONLY fv-1 (no fd-1 — it's folded in).
    expect(svg).not.toMatch(/@keyframes fd-1\s*{/);
  });

  it("DM-599: merged-path keyframes emit display alongside opacity", () => {
    // Two crossfade frames with different content route through the merge
    // pipeline. Per-element visibility classes (tN) now toggle BOTH opacity
    // and display so the browser can skip painting hidden elements.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="blue" width="50" height="50"/>`, duration: 1000 },
      ],
    });
    // Each tN keyframe stop with opacity:1 also has display:inline; each
    // opacity:0 stop has display:none.
    const tN = svg.match(/@keyframes t\d+\s*{[\s\S]*?\n\s*}/);
    expect(tN).not.toBeNull();
    expect(tN![0]).toMatch(/opacity:\s*1;\s*display:\s*inline/);
    expect(tN![0]).toMatch(/opacity:\s*0;\s*display:\s*none/);
  });

  it("cut transition: timeline boundary is exactly at the frame edge", () => {
    // For two frames each held 1000ms with cut transitions and no overlap,
    // the visibility flip should land at exactly 50% of the scene.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="blue"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
      ],
    });
    expect(svg).toMatch(/--scene-dur:\s*2\.00s/);
    // 50.000% boundary — frame 0 fades out and frame 1 fades in at the same instant.
    expect(svg).toMatch(/50\.000%/);
  });
});
