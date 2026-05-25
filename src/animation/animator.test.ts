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

  it("DM-609: scroll transition is now a vertical push (translateY), not opacity-only", () => {
    // The `scroll` transition used to be opacity-only (a misnomer). Per
    // DM-604 §10a, it's been replaced with real geometric semantics: the
    // outgoing frame slides up off the top while the next slides up from
    // the bottom. We verify by checking for translateY in the emitted CSS.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect/>`, duration: 1000, transition: { type: "scroll", duration: 200 } },
        { svgContent: `<rect/>`, duration: 1000 },
      ],
    });
    expect(svg).toContain("translateY");
    // The clipPath wrapper is added too (frames are clipped to viewport
    // during the slide so they don't show outside their region).
    expect(svg).toMatch(/<clipPath id="fc-\d+">/);
    // The fp-N keyframes (transform animation) get emitted alongside fv-N
    // (opacity) and fd-N (display) — mirrors the push-left structure.
    expect(svg).toMatch(/@keyframes fp-0/);
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

  it("DM-599/DM-641: push-left frame gets a paired fd-N visibility animation alongside fv-N", () => {
    // push-left is unmergeable (the merge fast path only takes crossfade/cut),
    // so it goes through the unmerged emit path that emits per-frame fv-/fp-
    // blocks. The DM-599 optimization adds an fd-N keyframes block that
    // toggles a paint-skip property so the frame is dropped from paint
    // outside its show window. DM-641 changed that toggle from `display`
    // (which parks the CSS-animations engine when an element starts out of
    // the render tree) to `visibility` (which keeps the element rendered
    // but skips painting it).
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
    // The keyframes flip visibility (DM-641 — formerly display).
    expect(svg).toMatch(/visibility:\s*hidden/);
    expect(svg).toMatch(/visibility:\s*visible/);
    // DM-641: must NOT emit display toggles anywhere — those broke the
    // infinite animation in Chromium.
    expect(svg).not.toMatch(/display:\s*none/);
    expect(svg).not.toMatch(/display:\s*inline/);
    // The frame's CSS rule lists BOTH animations, with the fd one tagged
    // step-end so the visibility flip is instant.
    expect(svg).toMatch(/\.f-0\s*{\s*animation:[^}]*fv-0[^}]*,[^}]*fd-0[^}]*step-end/);
    // The base .f rule sets visibility:hidden (was display:none pre-DM-641).
    expect(svg).toMatch(/\.f\s*{[^}]*visibility:\s*hidden/);
  });

  it("DM-599/DM-641: cut frames fold visibility into fv-N (same step-end timing)", () => {
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
    // The "cut" frame's fv-N keyframes carry the visibility toggle inline
    // (no separate fd-N block) since cut already uses step-end on fv-N.
    const fv1Match = svg.match(/@keyframes fv-1\s*{[\s\S]*?\n\s*}/);
    expect(fv1Match).not.toBeNull();
    expect(fv1Match![0]).toMatch(/visibility:\s*hidden/);
    expect(fv1Match![0]).toMatch(/visibility:\s*visible/);
    // The "cut" frame uses ONLY fv-1 (no fd-1 — it's folded in).
    expect(svg).not.toMatch(/@keyframes fd-1\s*{/);
  });

  it("DM-599/DM-641: merged-path keyframes emit visibility alongside opacity", () => {
    // Two crossfade frames with different content route through the merge
    // pipeline. Per-element visibility classes (tN) now toggle BOTH opacity
    // and visibility so the browser can skip painting hidden elements.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="blue" width="50" height="50"/>`, duration: 1000 },
      ],
    });
    // Each tN keyframe stop with opacity:1 also has visibility:visible; each
    // opacity:0 stop has visibility:hidden.
    const tN = svg.match(/@keyframes t\d+\s*{[\s\S]*?\n\s*}/);
    expect(tN).not.toBeNull();
    expect(tN![0]).toMatch(/opacity:\s*1;\s*visibility:\s*visible/);
    expect(tN![0]).toMatch(/opacity:\s*0;\s*visibility:\s*hidden/);
  });

  it("DM-641: never emits `display: none` keyframes (would park Chromium's animation engine)", () => {
    // Regression. The repro from the ticket: a multi-frame animation with
    // `cut` transitions produced `@keyframes fv-0 { 0% { opacity:0; display:none } … }`
    // plus `.f { display: none }`, which Chromium would never tick — so
    // EVERY frame stayed permanently hidden when the SVG was loaded into a
    // browser. The fix swapped both sites onto `visibility`. This test pins
    // the fix on every code path that emits keyframes for the animator.
    const cutSvg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect/>`, duration: 1000 },
      ],
    });
    expect(cutSvg).not.toMatch(/display:\s*none/);
    expect(cutSvg).not.toMatch(/display:\s*inline/);

    const pushSvg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect/>`, duration: 1000, transition: { type: "push-left", duration: 100 } },
        { svgContent: `<rect/>`, duration: 1000 },
      ],
    });
    expect(pushSvg).not.toMatch(/display:\s*none/);
    expect(pushSvg).not.toMatch(/display:\s*inline/);
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

  // DM-840: a typing overlay over a bgWidth-constrained field must wrap like a
  // browser textarea instead of running the text off the right edge.
  describe("typing overlay text wrapping (DM-840)", () => {
    const longText = "The quick brown fox jumps over the lazy dog repeatedly";

    function typedSvg(opts: { bgWidth?: number }): string {
      return generateAnimatedSvg({
        width: 400, height: 200,
        frames: [{
          svgContent: `<rect width="400" height="200" fill="#fff"/>`,
          duration: 4000,
          overlays: [{
            kind: "typing", text: longText, x: 20, y: 40,
            fontSize: 14, bgColor: "#fff", bgWidth: opts.bgWidth, bgHeight: 24,
          }],
        }],
      });
    }

    // Pull the text content out of every `<text class="t0-text" …>…</text>`.
    function typedLines(svg: string): string[] {
      return [...svg.matchAll(/<text class="t0-text"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    }

    it("wraps the typed text into multiple lines bounded by bgWidth", () => {
      const svg = typedSvg({ bgWidth: 120 });
      const lines = typedLines(svg);
      expect(lines.length).toBeGreaterThan(1);
      // bgWidth 120, charWidth = 14*0.6 = 8.4 → usable (120-4)/8.4 ≈ 13 chars/line.
      const maxChars = Math.floor((120 - 4) / (14 * 0.6));
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(maxChars);
      // No glyph escapes the field: each line's right edge stays within the bg.
      expect(lines.join("")).not.toContain("  "); // wrap consumed the break spaces
    });

    it("advances y by a line-height per wrapped line", () => {
      const svg = typedSvg({ bgWidth: 120 });
      const ys = [...svg.matchAll(/<text class="t0-text" x="20" y="([\d.]+)"/g)].map((m) => Number(m[1]));
      expect(ys.length).toBeGreaterThan(1);
      // Strictly increasing baselines, ~lineHeight (round(14*1.35)=19) apart.
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i]).toBeGreaterThan(ys[i - 1]);
        expect(ys[i] - ys[i - 1]).toBe(19);
      }
    });

    it("keeps single-line behavior when no bgWidth is given (backward compatible)", () => {
      const svg = typedSvg({});
      const lines = typedLines(svg);
      expect(lines.length).toBe(1);
      expect(lines[0]).toBe(longText);
    });

    it("grows the bg mask to cover all wrapped lines", () => {
      const svg = typedSvg({ bgWidth: 120 });
      const bg = /<rect class="t0-bg"[^>]*height="([\d.]+)"/.exec(svg);
      expect(bg).not.toBeNull();
      // More than the single-line bgHeight (24) since the text wraps to several lines.
      expect(Number(bg![1])).toBeGreaterThan(24);
    });
  });
});
