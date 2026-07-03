/**
 * Unit tests for the SVG animator — specifically the keyframe timing and
 * shared-defs hoist. Regression tests for SK-662 (flicker + size).
 */

import { describe, it, expect } from "vitest";
import { generateAnimatedSvg, dedupeFrameIds } from "./animator.js";
import { optimizeSvg } from "../post-processing/optimize.js";
import { getFontInstance, resolveFontKey } from "../render/font-resolution.js";

// DM-1557: a typing overlay's wrapped lines paint as GLYPH PATHS
// (`<g class="tN-text"><g transform="translate(x,baseline)" aria-label="…">`)
// when the font resolves, or a native `<text>` fallback otherwise. These
// helpers read either form so the wrap/baseline assertions are markup-agnostic.
function decodeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function typedLineTexts(svg: string, id = "t0"): string[] {
  const glyph = [...svg.matchAll(new RegExp(`<g class="${id}-text"[^>]*>\\s*<g [^>]*aria-label="([^"]*)"`, "g"))].map((m) => decodeXml(m[1]));
  if (glyph.length > 0) return glyph;
  return [...svg.matchAll(new RegExp(`<text class="${id}-text"[^>]*>([^<]*)</text>`, "g"))].map((m) => decodeXml(m[1]));
}
function typedLineBaselines(svg: string, id = "t0"): number[] {
  const glyph = [...svg.matchAll(new RegExp(`<g class="${id}-text"[^>]*>\\s*<g transform="translate\\([\\d.]+,([\\d.]+)\\)`, "g"))].map((m) => Number(m[1]));
  if (glyph.length > 0) return glyph;
  return [...svg.matchAll(new RegExp(`<text class="${id}-text" x="\\d+" y="([\\d.]+)"`, "g"))].map((m) => Number(m[1]));
}

// DM-1145: cross-frame id de-duplication. A caller that reuses identical
// svgContent for several frames (a cached/held frame) emits duplicate ids; on a
// SEEKED render (svg-to-video) a `clip-path="url(#id)"` resolves to the first
// match in an earlier hidden frame group and clips the element away. The animator
// renames the later frame's colliding ids so the SVG stays valid.
// DM-1148: by default the last frame holds solid to 100% (no loop fade); the
// `loopFade` flag restores the cross-dissolve back to frame 0.
describe("last-frame loop fade (DM-1148)", () => {
  const cfg = (loopFade?: boolean) => ({
    width: 100, height: 100,
    frames: [
      { svgContent: `<rect id="a" width="100" height="100" fill="red"/>`, duration: 500 },
      { svgContent: `<rect id="b" width="100" height="100" fill="blue"/>`, duration: 500 },
    ],
    ...(loopFade != null ? { loopFade } : {}),
  });

  // The fv-1 keyframe block has nested `{…}`, so span one level of nesting.
  const lastKeyframe = (svg: string) => svg.match(/@keyframes fv-1 \{(?:[^{}]|\{[^}]*\})*\}/)?.[0] ?? "";

  it("holds the last frame to 100% by default (no fade-out)", () => {
    const kf = lastKeyframe(generateAnimatedSvg(cfg()));
    // Held to the end (opacity 1 at 100%), and NOT faded out (no opacity 0 at 100%).
    // The leading `0%, … { opacity: 0 }` off-segment before the frame starts is expected.
    expect(kf).toMatch(/100%\s*\{\s*opacity:\s*1/);
    expect(kf).not.toMatch(/100%\s*\{\s*opacity:\s*0/);
  });

  it("fades the last frame out on loop when loopFade is true", () => {
    const kf = lastKeyframe(generateAnimatedSvg(cfg(true)));
    // Restores the cross-dissolve: opacity 0 at 100%.
    expect(kf).toMatch(/100%\s*\{\s*opacity:\s*0/);
  });
});

// DM-1207: the DM-1148 "hold last frame solid" rule must also cover the slide
// paths (push-left / scroll). Before this fix, a push-left LAST frame used the
// slide-out keyframes, which ramp opacity 1 -> 0 across the frame's hold — so a
// 2-frame "before -> after" push-left washed out the "after" punchline the whole
// time it was on screen. The fix: the last slide frame slides in then HOLDS
// (transform 0, opacity 1) to 100%, and the loop hard-cuts back to frame 0.
describe("push-left / scroll last-frame hold (DM-1207)", () => {
  const cfg = (type: "push-left" | "scroll", loopFade?: boolean) => ({
    width: 100, height: 100,
    frames: [
      { svgContent: `<rect id="a" width="100" height="100" fill="red"/>`, duration: 500, transition: { type, duration: 300 } as const },
      { svgContent: `<rect id="b" width="100" height="100" fill="blue"/>`, duration: 500, transition: { type, duration: 300 } as const },
    ],
    ...(loopFade != null ? { loopFade } : {}),
  });

  // The fv-1 / fp-1 keyframe blocks have nested `{…}`, so span one nesting level.
  const block = (svg: string, name: string) =>
    svg.match(new RegExp(`@keyframes ${name} \\{(?:[^{}]|\\{[^}]*\\})*\\}`))?.[0] ?? "";

  for (const type of ["push-left", "scroll"] as const) {
    it(`holds the last ${type} frame solid to 100% by default (opacity 1, no slide-out)`, () => {
      const svg = generateAnimatedSvg(cfg(type));
      const fv = block(svg, "fv-1");
      const fp = block(svg, "fp-1");
      // Opacity held to the end (1 at 100%), NOT faded out (no opacity 0 at 100%).
      expect(fv).toMatch(/100%\s*\{\s*opacity:\s*1/);
      expect(fv).not.toMatch(/100%\s*\{\s*opacity:\s*0/);
      // Transform held at translate(0) to 100% — no slide-out to -100px.
      expect(fp).toMatch(/100%\s*\{\s*transform:\s*translate[XY]\(0\)/);
      expect(fp).not.toMatch(/100%\s*\{\s*transform:\s*translate[XY]\(-\d/);
    });

    it(`still slides the last ${type} frame OUT when loopFade is true`, () => {
      const fp = block(generateAnimatedSvg(cfg(type, true)), "fp-1");
      // loopFade restores the cross-dissolve loop: the frame slides off-screen.
      expect(fp).toMatch(/100%\s*\{\s*transform:\s*translate[XY]\(-\d/);
    });
  }

  it("does not affect a NON-last push-left frame (frame 0 still slides out)", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect id="a" width="100" height="100"/>`, duration: 500, transition: { type: "push-left", duration: 300 } },
        { svgContent: `<rect id="b" width="100" height="100"/>`, duration: 500, transition: { type: "cut", duration: 0 } },
      ],
    });
    const fp0 = block(svg, "fp-0");
    // Frame 0 is not last → it must still slide out to the left.
    expect(fp0).toMatch(/transform:\s*translateX\(-\d/);
  });
});

describe("dedupeFrameIds (DM-1145)", () => {
  const f = (svgContent: string) => ({ svgContent, duration: 100 });

  it("renames ids that collide with an earlier frame, plus their in-frame refs", () => {
    const content =
      `<defs><clipPath id="c4-irc3"><rect/></clipPath><filter id="c4-sh0"/></defs>` +
      `<g filter="url(#c4-sh0)"><image clip-path="url(#c4-irc3)" href="#c4-irc3"/></g>`;
    const out = dedupeFrameIds([f(content), f(content)]);
    // First frame: untouched (it owns the original ids).
    expect(out[0].svgContent).toBe(content);
    // Second frame: every colliding id + reference renamed to a frame-unique form.
    expect(out[1].svgContent).not.toContain(`id="c4-irc3"`);
    expect(out[1].svgContent).toContain(`id="d1-c4-irc3"`);
    expect(out[1].svgContent).toContain(`url(#d1-c4-irc3)`);
    expect(out[1].svgContent).toContain(`href="#d1-c4-irc3"`);
    expect(out[1].svgContent).toContain(`url(#d1-c4-sh0)`);
    // No duplicate id="..." survives across the two frames.
    const allIds = [out[0].svgContent, out[1].svgContent].join("").match(/\sid="([^"]+)"/g) ?? [];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("leaves frames with already-unique ids byte-for-byte unchanged", () => {
    const a = `<clipPath id="c0-x"><rect/></clipPath><g clip-path="url(#c0-x)"/>`;
    const b = `<clipPath id="c1-x"><rect/></clipPath><g clip-path="url(#c1-x)"/>`;
    const out = dedupeFrameIds([f(a), f(b)]);
    expect(out[0].svgContent).toBe(a);
    expect(out[1].svgContent).toBe(b);
  });
});

// DM-893 / DM-894: the animator (and the scroll composer) must NOT paint a
// hardcoded canvas backdrop. A transparent capture has to stay transparent so
// the SVG composites over a host page; a colored root paints that color. These
// guard against the `#0d1117` regression coming back on the animator path.
describe("animator: canvas background", () => {
  const FR = [{ svgContent: `<rect width="10" height="10" fill="red"/>`, duration: 100 }];

  it("paints NO background rect by default — never the old hardcoded #0d1117 (DM-893)", () => {
    const svg = generateAnimatedSvg({ width: 200, height: 100, frames: FR });
    expect(svg).not.toContain('fill="#0d1117"');
    expect(svg).not.toMatch(/<rect width="200" height="100" fill=/); // no opaque viewport backdrop
  });

  // DM-1457: every transparent CSS form must suppress the backdrop rect — not
  // just "transparent" / "rgba(0, 0, 0, 0)" / "". The inline check used to treat
  // "none", zero-alpha hex, and unspaced rgba as opaque and paint a rect.
  for (const transparent of [
    "transparent", "rgba(0, 0, 0, 0)", "",
    "none", "#0000", "#00000000", "rgba(0,0,0,0)", "  TRANSPARENT  ", "hsla(0, 0%, 0%, 0)",
  ]) {
    it(`paints no background rect when background is ${JSON.stringify(transparent)}`, () => {
      const svg = generateAnimatedSvg({ width: 200, height: 100, frames: FR, background: transparent });
      expect(svg).not.toMatch(/<rect width="200" height="100" fill=/);
    });
  }

  it("paints the given background color as a full-viewport rect when one is supplied", () => {
    const svg = generateAnimatedSvg({ width: 200, height: 100, frames: FR, background: "rgb(255, 255, 255)" });
    expect(svg).toContain('<rect width="200" height="100" fill="rgb(255, 255, 255)" />');
  });
});

// DM-1319: a `cast` / `template` frame's svgContent is itself an animated SVG.
// `embeddedAnimationPeriodMs` tells the animator to re-anchor that nested timeline
// to the frame's master-loop offset (so a cast that isn't frame 0 plays from its
// start when shown, not from the back half). Guards the wiring in
// generateAnimatedSvg; the transform itself is unit-tested in embed-timeline.test.ts.
describe("embedded-animation timeline offset (DM-1319)", () => {
  const nested = (periodS: number) =>
    `<svg><style>.anim-a{animation:ka ${periodS.toFixed(3)}s linear infinite}@keyframes ka{0%{opacity:0}100%{opacity:1}}</style></svg>`;

  it("re-anchors a non-first embedded frame's keyframes into its visible window", () => {
    // Frame 0 holds 2s (+300ms default transition); the 4s cast starts at 2300ms
    // in a (2000+300 + 4000+300) = 6600ms master loop. offset = 2300/6600 ≈ 34.8%.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect id="a" width="10" height="10"/>`, duration: 2000 },
        { svgContent: nested(4), duration: 4000, embeddedAnimationPeriodMs: 4000 },
      ],
    });
    // The nested animation is retimed to the 6.6s master period…
    expect(svg).toContain("animation:ka 6.6s linear infinite");
    // …and its keyframes are offset off the origin (a leading 0% hold appears,
    // and the original 0% stop has moved to ~34.8%).
    expect(svg).toMatch(/@keyframes ka \{ 0% \{ opacity:0 \} 34\.\d+% \{ opacity:0 \}/);
  });

  it("leaves frames without embeddedAnimationPeriodMs untouched", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect id="a" width="10" height="10"/>`, duration: 2000 },
        { svgContent: nested(4), duration: 4000 },
      ],
    });
    // Nested animation keeps its own 4s period (no offsetting applied).
    expect(svg).toContain("animation:ka 4.000s linear infinite");
    expect(svg).toContain("@keyframes ka{0%{opacity:0}100%{opacity:1}}");
  });
});

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

  it("crossfade transition composites full frames (per-frame opacity fade, not an element merge)", () => {
    // A crossfade transition dissolves between two complete, independently
    // z-ordered sub-SVGs. It must NOT flatten them into one deduped element
    // tree — doing so loses per-frame stacking (a later frame's background can
    // occlude its own foreground) and step-end-switches at the midpoint
    // instead of fading. So a crossfade emits per-frame fv- groups with an
    // interpolated opacity fade, and each frame's content survives intact —
    // NOT the merge pipeline's tN timeline classes.
    const svg = generateAnimatedSvg({
      width: 100,
      height: 100,
      frames: [
        { svgContent: `<rect fill="red" width="50" height="50"/>`, duration: 1000, transition: { type: "crossfade", duration: 200 } },
        { svgContent: `<rect fill="blue" width="50" height="50"/>`, duration: 1000, transition: { type: "crossfade", duration: 200 } },
      ],
    });
    expect(svg).toMatch(/@keyframes fv-/);
    expect(svg).not.toMatch(/@keyframes t\d+/);
    expect(svg).toContain(`<rect fill="red" width="50" height="50"/>`);
    expect(svg).toContain(`<rect fill="blue" width="50" height="50"/>`);
    expect(svg).toContain("--scene-dur");
  });

  it("cut: composites each frame as a complete sub-SVG (DM-865 — no element merge)", () => {
    // DM-865: the element-merge fast path is gone — cut composites each frame
    // like crossfade. So identical content across frames is emitted once PER
    // frame (not deduped into one), gated by per-frame fv-N opacity. The merge
    // mis-rendered near-identical (continuous-session) frames; compositing
    // keeps each frame's layout intact.
    const svg = generateAnimatedSvg({
      width: 100,
      height: 100,
      frames: [
        { svgContent: `<rect width="50" height="50" fill="green"/>`, duration: 500, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect width="50" height="50" fill="green"/>`, duration: 500, transition: { type: "cut", duration: 0 } },
      ],
    });
    expect((svg.match(/<rect width="50" height="50" fill="green"\/>/g) ?? []).length).toBe(2);
    expect(svg).toMatch(/@keyframes fv-/);
    expect(svg).not.toMatch(/@keyframes t\d+\s*{/);
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

  it("DM-898: magic-move emits the bridge composite + slide/fade keyframes", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        {
          svgContent: `<rect class="prev"/>`,
          duration: 1000,
          transition: { type: "magic-move", duration: 200 },
          magicMove: {
            compositeSvg: `<g class="anim-mm0-mv0"><rect/></g>`,
            slides: [{ cls: "anim-mm0-mv0", from: "translate(-50px, -80px)", to: "none" }],
            fadeIn: ["anim-mm0-in0"],
            fadeOut: ["anim-mm0-out0"],
          },
        },
        { svgContent: `<rect class="next"/>`, duration: 1000 },
      ],
    });
    // Bridge composite group is emitted.
    expect(svg).toContain(`class="f mm-0"`);
    expect(svg).toContain(`<g class="anim-mm0-mv0">`);
    // Slide keyframe carries the `from` transform as the window-start state.
    expect(svg).toMatch(/@keyframes mms-anim-mm0-mv0/);
    expect(svg).toContain("transform: translate(-50px, -80px)");
    // Added fades in, removed fades out.
    expect(svg).toMatch(/@keyframes mmf-anim-mm0-in0/);
    expect(svg).toMatch(/@keyframes mmf-anim-mm0-out0/);
    // DM-901: reduced-motion cancels the slide so it doesn't glide.
    expect(svg).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(svg).toContain(".anim-mm0-mv0 { animation: none; transform: none; }");
  });

  it("DM-898: magic-move with no bridge layer falls back to a crossfade-style fade (never throws)", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        // type is magic-move but magicMove is null → must degrade gracefully.
        { svgContent: `<rect/>`, duration: 1000, transition: { type: "magic-move", duration: 200 }, magicMove: null },
        { svgContent: `<rect/>`, duration: 1000 },
      ],
    });
    // No bridge group emitted; the opacity (fv-) crossfade path is used instead.
    expect(svg).not.toContain(`class="f mm-0"`);
    expect(svg).toMatch(/@keyframes fv-0/);
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

  it("cut transition: composites with per-frame fv-N groups (DM-865 — no element merge)", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="blue" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="green" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
      ],
    });
    expect(svg).toMatch(/@keyframes fv-/);
    expect(svg).not.toMatch(/@keyframes t\d+\s*{/);
    expect((svg.match(/class="f f-\d+"/g) ?? []).length).toBe(3);
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

  it("DM-869: repeating animation loops on its own clock with iteration-count + alternate", () => {
    const svg = generateAnimatedSvg({
      width: 100,
      height: 100,
      frames: [
        {
          svgContent: `<rect class="anim-caret"/>`,
          duration: 2000,
          animations: [{ animId: "caret", property: "opacity", from: "1", to: "0", duration: 530, repeat: "infinite", alternate: true }],
        },
      ],
    });
    // Loops on its own 530ms clock, infinite + alternating — NOT the global scene clock.
    // DM-1289: timing-function / delay / fill-mode live inside the `animation`
    // shorthand (so the optimizer can't hoist fill-mode out and reset it).
    expect(svg).toMatch(/\.anim-caret\s*{[^}]*animation:\s*f0-caret-0\s+530ms\s+linear\s+0ms\s+infinite\s+alternate\s+both/);
    // Simple two-stop from→to cycle (no 4-stop global-clock hold).
    expect(svg).toMatch(/@keyframes f0-caret-0\s*{\s*0%\s*{\s*opacity:\s*1;\s*}\s*100%\s*{\s*opacity:\s*0;\s*}\s*}/);
  });

  it("DM-869: finite repeat emits the count and (without alternate) no direction", () => {
    const svg = generateAnimatedSvg({
      width: 100,
      height: 100,
      frames: [
        {
          svgContent: `<rect class="anim-p"/>`,
          duration: 2000,
          animations: [{ animId: "p", property: "opacity", from: "1", to: "0.3", duration: 400, repeat: 3 }],
        },
      ],
    });
    expect(svg).toMatch(/\.anim-p\s*{[^}]*animation:\s*f0-p-0\s+400ms\s+linear\s+0ms\s+3\s+both\s*;/);
    expect(svg).not.toContain("alternate");
  });

  it("DM-870 / DM-1518: typing-overlay caret emits a step-end position + blink bar", () => {
    const svg = generateAnimatedSvg({
      width: 200,
      height: 80,
      frames: [{ svgContent: `<rect/>`, duration: 3000, overlays: [{ kind: "typing", text: "hi there", x: 10, y: 40, caret: true }] }],
    });
    expect(svg).toContain(`class="t0-caret"`);
    expect(svg).toMatch(/@keyframes t0-caret-pos/);
    expect(svg).toMatch(/@keyframes t0-caret-blink/);
    // DM-1518: both tracks are step-end — the caret JUMPS to each glyph's edge
    // as it is typed (real per-keystroke typing) and hard-toggles the blink.
    expect(svg).toMatch(/\.t0-caret\s*{[^}]*step-end[^}]*step-end/);
  });

  it("DM-1590: the caret height + top come from the face's EXACT ascent/descent, not the 1.15×em fallback", () => {
    const fontSize = 14;
    const baseline = 40;
    const svg = generateAnimatedSvg({
      width: 300, height: 80,
      frames: [{ svgContent: `<rect/>`, duration: 3000, overlays: [{ kind: "typing", text: "hi there", x: 10, y: baseline, caret: true }] }],
    });
    const caret = /<rect class="t0-caret"[^>]*>/.exec(svg)?.[0] ?? "";
    const y = parseFloat(/\by="([-\d.]+)"/.exec(caret)?.[1] ?? "NaN");
    const h = parseFloat(/\bheight="([-\d.]+)"/.exec(caret)?.[1] ?? "NaN");

    // Derive the expectation from the SAME font resolution the renderer uses, so
    // the assertion holds on any platform: where the face resolves we expect the
    // exact metrics-height caret placed at `baseline − ascent`; where it doesn't
    // (no SF Mono) we expect the 1.15×em fallback at `baseline + 2 − height`.
    const font = getFontInstance(resolveFontKey("'SF Mono', Menlo, Monaco, monospace"), 400, fontSize, 0);
    if (font != null) {
      const scale = fontSize / font.unitsPerEm;
      const ascentPx = font.ascent * scale;
      const descentPx = -font.descent * scale;
      expect(h).toBe(Math.round(ascentPx + descentPx));
      expect(y).toBeCloseTo(baseline - ascentPx, 1);
      // The caret bottom sits at baseline + descent (the line box), NOT the old
      // fixed 2px below the baseline.
      expect(y + h).toBeCloseTo(baseline + descentPx, 0);
    } else {
      expect(h).toBe(Math.round(fontSize * 1.15));
      expect(y).toBeCloseTo(baseline + 2 - h, 5);
    }
  });

  it("DM-1518: reveal clip steps per keystroke and the caret parks exactly at the measured text edge", () => {
    const svg = generateAnimatedSvg({
      width: 200,
      height: 80,
      frames: [{ svgContent: `<rect/>`, duration: 3000, overlays: [{ kind: "typing", text: "hi there", x: 10, y: 40, caret: true }] }],
    });
    // The reveal clip is a per-keystroke staircase (step-end), locked to the
    // caret's own step-end track — one shared plan, so they can't desync.
    expect(svg).toMatch(/\.t0-rev0\s*{[^}]*\bstep-end\b[^}]*}/);
    // "hi there" is 8 chars, so the reveal emits a width stop per glyph.
    const revBlock = svg.match(/@keyframes t0-rev0\s*{([\s\S]*?)}\s*\.t0-rev0/)?.[1] ?? "";
    const widthStops = [...revBlock.matchAll(/width:\s*([\d.]+)px/g)].map((m) => parseFloat(m[1]));
    expect(widthStops.length).toBeGreaterThanOrEqual(8);
    // The parked caret x must equal the fully-revealed line width (minus the 1px
    // antialiasing slack): both come from the SAME fontkit-measured cumulative
    // advances, so the caret sits AT the trailing edge — not ~0.5px/char behind
    // it as the old uniform 0.6em estimate left it (the reported lag). Platform-
    // independent: it ties the two tracks together rather than pinning a metric.
    const holdWidth = Math.max(...widthStops);
    const parkedCaretX = parseFloat(svg.match(/t0-caret-pos\s*{[\s\S]*?100%\s*{\s*transform:\s*translate\(([\d.]+)px/)?.[1] ?? "NaN");
    expect(Math.abs(parkedCaretX + 1 - holdWidth)).toBeLessThan(0.1);
  });

  it("DM-1518: paste mode reveals the whole field at once with the caret at the end", () => {
    const svg = generateAnimatedSvg({
      width: 300,
      height: 80,
      frames: [{ svgContent: `<rect/>`, duration: 3000, overlays: [{ kind: "typing", text: "hello world", x: 10, y: 40, delay: 200, mode: "paste", caret: true }] }],
    });
    // The reveal jumps hidden → full within a hair of the paste instant (no
    // per-glyph staircase): the width block has a single grown stop.
    const revBlock = svg.match(/@keyframes t0-rev0\s*{([\s\S]*?)}\s*\.t0-rev0/)?.[1] ?? "";
    const grownStops = [...revBlock.matchAll(/width:\s*([\d.]+)px/g)].map((m) => parseFloat(m[1])).filter((w) => w > 1);
    // Two entries: the reveal-to-full and the hold-at-full (same value).
    expect(new Set(grownStops.map((w) => w.toFixed(2))).size).toBe(1);
    // The caret jumps straight to the end (a single glyph stop, not 11).
    const posBlock = svg.match(/@keyframes t0-caret-pos\s*{([\s\S]*?)}\s*@keyframes/)?.[1] ?? "";
    const translateStops = [...posBlock.matchAll(/translate\(/g)].length;
    expect(translateStops).toBeLessThanOrEqual(4);
  });

  it("DM-1518: jitter humanizes the cadence deterministically", () => {
    const mk = (jitter?: number): string => generateAnimatedSvg({
      width: 200,
      height: 80,
      frames: [{ svgContent: `<rect/>`, duration: 3000, overlays: [{ kind: "typing", text: "the quick brown fox", x: 10, y: 40, jitter, caret: true }] }],
    });
    // Same input → byte-identical output (seeded PRNG): the SVG stays stable.
    expect(mk(0.5)).toBe(mk(0.5));
    // Jitter perturbs the reveal timing away from the even cadence.
    expect(mk(0.5)).not.toBe(mk());
  });

  it("DM-1204: multi-line typing caret tracks each line instead of sticking at x=0", () => {
    const svg = generateAnimatedSvg({
      width: 320,
      height: 140,
      // wrapWidth forces wrapping into multiple lines.
      frames: [{ svgContent: `<rect/>`, duration: 6000, overlays: [{ kind: "typing", text: "hello world this is a long first line second", x: 10, y: 30, fontSize: 14, caret: true, wrapWidth: 220 }] }],
    });
    const block = svg.match(/@keyframes t0-caret-pos\s*{([\s\S]*?)}\s*@keyframes/)?.[1] ?? "";
    const stops = [...block.matchAll(/([\d.]+)%(?:,\s*[\d.]+%)*\s*{\s*transform:\s*translate\(([\d.]+)px,\s*([\d.]+)px\)/g)].map((m) => ({
      pct: parseFloat(m[1]),
      x: parseFloat(m[2]),
      y: parseFloat(m[3]),
    }));
    // Must actually wrap (more than one row of caret stops).
    const rows = new Set(stops.map((s) => s.y));
    expect(rows.size).toBeGreaterThan(1);
    // No two caret stops may share a keyframe percentage — a collision drops the
    // end-of-line x position (CSS keeps the later declaration), pinning the
    // caret at x=0 for the whole line and sliding it straight down.
    const pcts = stops.map((s) => s.pct);
    expect(new Set(pcts).size).toBe(pcts.length);
    // Every non-final row must reach a non-zero x (the end-of-line caret
    // position survived rather than being clobbered by the next line's margin).
    for (const y of rows) {
      const maxX = Math.max(...stops.filter((s) => s.y === y).map((s) => s.x));
      expect(maxX).toBeGreaterThan(0);
    }
  });

  it("DM-1205: typing reveal clip hides with a non-zero width (WebKit empty-clip bug)", () => {
    const svg = generateAnimatedSvg({
      width: 320,
      height: 140,
      frames: [{ svgContent: `<rect/>`, duration: 6000, overlays: [{ kind: "typing", text: "hello world this is a long first line second", x: 10, y: 30, fontSize: 14, caret: true, wrapWidth: 220 }] }],
    });
    // WebKit/Safari treats a zero-area clip path as "no clip" and paints the
    // whole element, so a `width: 0` hidden state made not-yet-typed lines show
    // in full. The hidden state must therefore use a tiny non-zero width.
    // The static clip rects must not be width="0".
    expect(svg).not.toMatch(/class="t0-rev\d+"[^>]*\bwidth="0"/);
    // The reveal keyframes must not collapse the hidden state to exactly 0.
    for (const block of svg.matchAll(/@keyframes t0-rev\d+\s*{([^}]*)}/g)) {
      expect(block[1]).not.toMatch(/width:\s*0\s*[;}]/);
      expect(block[1]).toMatch(/width:\s*0\.\d+px/); // tiny non-zero hidden width
    }
  });

  it("DM-870: typing overlay without the caret option emits no caret", () => {
    const svg = generateAnimatedSvg({
      width: 200,
      height: 80,
      frames: [{ svgContent: `<rect/>`, duration: 3000, overlays: [{ kind: "typing", text: "hi", x: 10, y: 40 }] }],
    });
    expect(svg).not.toContain("-caret");
  });

  // DM-1555: mistake → backspace → correct. An explicit or rate-driven typo
  // paints a wrong glyph, the caret advances past it, then RETREATS (backspace)
  // to the prefix edge and re-advances on retype.
  describe("typing mistakes (DM-1555)", () => {
    const mk = (overlay: Record<string, unknown>): string =>
      generateAnimatedSvg({
        width: 400, height: 120,
        frames: [{ svgContent: `<rect width="400" height="120" fill="#0d1117"/>`, duration: 4000,
          overlays: [{ kind: "typing", text: "hello world", x: 20, y: 50, fontSize: 24, caret: true, ...overlay } as never] }],
      });
    const caretEdges = (svg: string): number[] => {
      const pos = svg.match(/@keyframes t0-caret-pos\s*{([\s\S]*?)}\s*@keyframes/)?.[1] ?? "";
      return [...pos.matchAll(/translate\(([\d.]+)px,\s*[\d.]+px\)/g)].map((m) => parseFloat(m[1]));
    };
    const hasRetreat = (edges: number[]): boolean => {
      for (let i = 1; i < edges.length; i++) if (edges[i] < edges[i - 1] - 0.01) return true;
      return false;
    };
    // The wrong glyph paints as a glyph-path group (`<g class="t0-mis0"><g
    // aria-label="x">`) or a `<text>` fallback — read either.
    const mistakeChar = (svg: string, n = 0): string | undefined =>
      svg.match(new RegExp(`<g class="t0-mis${n}"[^>]*>\\s*<g [^>]*aria-label="([^"]*)"`))?.[1]
      ?? svg.match(new RegExp(`<text class="t0-mis${n}"[^>]*>([^<]*)</text>`))?.[1];

    it("an explicit mistake paints the wrong glyph and retreats the caret", () => {
      const svg = mk({ mistakes: [{ at: 2, wrong: "x" }] });
      // The mistyped glyph is painted with its own show/hide opacity track.
      expect(mistakeChar(svg)).toBe("x");
      expect(svg).toMatch(/@keyframes t0-mis0\s*{[^]*?opacity:\s*1[^]*?opacity:\s*0/);
      // The caret advances past the typo then steps BACK (backspace) before re-advancing.
      expect(hasRetreat(caretEdges(svg))).toBe(true);
    });

    it("no mistakes → no wrong glyph and a monotonic caret (regression guard)", () => {
      const svg = mk({});
      expect(svg).not.toContain("t0-mis0");
      expect(hasRetreat(caretEdges(svg))).toBe(false);
    });

    it("wrong glyph defaults to a deterministic QWERTY neighbor when unspecified", () => {
      // 'l' (index 2) → neighbor 'k'.
      const svg = mk({ mistakes: [{ at: 2 }] });
      expect(mistakeChar(svg)).toBe("k");
    });

    it("rate-driven mistakes are deterministic (byte-stable) and honor the rate", () => {
      const a = mk({ mistakes: 0.5 });
      const b = mk({ mistakes: 0.5 });
      expect(a).toBe(b);                       // same seed → identical SVG
      expect(a).toContain("t0-mis0");          // at 0.5 over 11 chars, at least one fires
      expect(mk({ mistakes: 0 })).not.toContain("t0-mis0"); // rate 0 → none
    });

    it("paste mode never mistypes (no keystrokes to slip on)", () => {
      const svg = mk({ mode: "paste", mistakes: [{ at: 2, wrong: "x" }] });
      expect(svg).not.toContain("t0-mis0");
    });

    it("the correct final text is still fully revealed after a typo", () => {
      const svg = mk({ mistakes: [{ at: 2, wrong: "x" }] });
      // Every wrapped line still carries the CORRECT content (aria-label / text).
      expect(typedLineTexts(svg).join("")).toBe("hello world");
    });
  });

  // DM-1557: typed text renders as GLYPH PATHS (viewer-independent advances),
  // its glyph defs hoisted into the top-level <defs>, and the whole thing is
  // byte-stable across repeat generations.
  describe("typing glyph-path rendering (DM-1557)", () => {
    const mk = (): string => generateAnimatedSvg({
      width: 300, height: 90,
      frames: [{ svgContent: `<rect width="300" height="90" fill="#0d1117"/>`, duration: 3000,
        overlays: [{ kind: "typing", text: "hello", x: 20, y: 50, fontSize: 28, caret: true }] }],
    });

    it("paints the line as glyph <use> refs, not a <text> element", () => {
      const svg = mk();
      expect(svg).toMatch(/<g class="t0-text"[^>]*>\s*<g [^>]*aria-label="hello"/);
      expect(svg).toContain('<use href="#g');
      expect(svg).not.toMatch(/<text class="t0-text"/);
    });

    it("hoists the glyph <path> defs into the top-level <defs>", () => {
      const svg = mk();
      const defs = svg.match(/<defs>([\s\S]*?)<\/defs>/)?.[1] ?? "";
      expect(defs).toMatch(/<path id="g\d+"/);
      // Every glyph a <use> references must have a matching def in the document.
      const refs = new Set([...svg.matchAll(/<use href="#(g\d+)"/g)].map((m) => m[1]));
      for (const id of refs) expect(svg).toContain(`<path id="${id}"`);
    });

    it("is byte-stable across repeat generations (glyph ids restored)", () => {
      expect(mk()).toBe(mk());
    });

    it("the parked caret sits at the measured trailing edge of the glyph run", () => {
      const svg = mk();
      const parked = parseFloat(svg.match(/t0-caret-pos\s*{[\s\S]*?100%\s*{\s*transform:\s*translate\(([\d.]+)px/)?.[1] ?? "NaN");
      // 5 monospace glyphs at 28px (~0.618em ≈ 17.3px each) → ~86px.
      expect(parked).toBeGreaterThan(60);
      expect(parked).toBeLessThan(110);
    });
  });

  // DM-1558: `fontFamily` override — the reveal measures + paints with an
  // author-chosen family (e.g. the captured field's own font), wrapping
  // proportionally via the glyph-path path (DM-1557).
  describe("typing fontFamily override (DM-1558)", () => {
    const text = "Wire Wave William milliliter";
    const mk = (fontFamily?: string): string => generateAnimatedSvg({
      width: 360, height: 140,
      frames: [{ svgContent: `<rect width="360" height="140" fill="#fff"/>`, duration: 4000,
        overlays: [{ kind: "typing", text, x: 20, y: 40, fontSize: 26, color: "#111", caret: true, wrapWidth: 220, ...(fontFamily != null ? { fontFamily } : {}) }] }],
    });

    it("a proportional family wraps by measured pixel width, not char count", () => {
      // Georgia's narrow i/l/t let more fit per line than the monospace default.
      const prop = typedLineTexts(mk("Georgia, serif"));
      const mono = typedLineTexts(mk());
      expect(prop).not.toEqual(mono);
      expect(prop.join(" ")).toContain("William milliliter"); // fits one line proportionally
      expect(mono).toContain("milliliter");                    // mono breaks it apart
      // Every line stays within the field either way.
      expect(prop.join("").replace(/ /g, "")).toBe(mono.join("").replace(/ /g, ""));
    });

    it("paints with the overridden family as glyph paths", () => {
      const svg = mk("Georgia, serif");
      expect(svg).toMatch(/<g class="t0-text"[^>]*>\s*<g [^>]*aria-label="Wire Wave"/);
      expect(svg).toContain('<use href="#g');
    });

    it("omitting fontFamily keeps the monospace default (backward compatible)", () => {
      // Same output whether the default is implicit or spelled out explicitly.
      expect(mk()).toBe(mk("'SF Mono', Menlo, Monaco, monospace"));
    });
  });

  it("DM-871: blink overlay emits a step-end toggling rect", () => {
    const svg = generateAnimatedSvg({
      width: 100,
      height: 100,
      frames: [{ svgContent: `<rect/>`, duration: 2000, overlays: [{ kind: "blink", x: 10, y: 10, width: 12, height: 12, periodMs: 800, color: "#ef4444", radius: 6 }] }],
    });
    expect(svg).toMatch(/<rect class="blink0"[^>]*fill="#ef4444"/);
    expect(svg).toContain('rx="6"');
    expect(svg).toMatch(/@keyframes blink0/);
    expect(svg).toMatch(/\.blink0\s*{[^}]*step-end/);
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

  it("DM-1297: scale desugars to transform: scale(), and transformOrigin emits transform-box: fill-box", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        {
          svgContent: `<rect/>`,
          duration: 1000,
          animations: [{
            animId: "pop",
            property: "scale",
            from: "0.3",
            to: "1",
            duration: 400,
            transformOrigin: "center",
          }],
        },
      ],
    });
    expect(svg).toContain("transform: scale(0.3)");
    expect(svg).toContain("transform: scale(1)");
    // The center-origin makes the scale resolve about the element's own box.
    expect(svg).toContain("transform-box: fill-box; transform-origin: center");
    expect(svg).toMatch(/\.anim-pop\s*\{[^}]*transform-box: fill-box; transform-origin: center/);
  });

  it("DM-1297: no transformOrigin → no transform-box decl (unchanged for translate)", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [{ svgContent: `<rect/>`, duration: 1000, animations: [{ animId: "t", property: "translateX", from: "0px", to: "10px", duration: 200 }] }],
    });
    expect(svg).not.toContain("transform-box");
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

  it("DM-1511: cut frames decouple visibility into a separate wide fd-N (Firefox flash fix)", () => {
    // Three explicit `cut` frames with a non-mergeable transition mixed in
    // (push-left) so this routes through the unmerged path's cut branch.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red"/>`,  duration: 1000, transition: { type: "push-left", duration: 100 } },
        { svgContent: `<rect fill="blue"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="green"/>`, duration: 1000 },
      ],
    });
    // DM-1511: the cut frame's opacity `fv-1` drives the visual cut and carries
    // NO visibility (Firefox composites `visibility` off the opacity clock and
    // flashed a transparent gap at the hand-off). Visibility moves to a SEPARATE
    // step-end `fd-1` paint-cull track.
    const fv1Match = svg.match(/@keyframes fv-1\s*{[\s\S]*?\n\s*}/);
    expect(fv1Match).not.toBeNull();
    expect(fv1Match![0]).not.toMatch(/visibility/);
    expect(fv1Match![0]).toMatch(/opacity/);
    expect(svg).toMatch(/@keyframes fd-1\s*{/);
    // .f-1 runs both tracks.
    expect(svg).toMatch(/\.f-1\s*{\s*animation:\s*fv-1[^,}]*,\s*fd-1/);
  });

  it("DM-1511: cut fv-N is opacity-only; fd-N visibility window is WIDER than the opacity cut", () => {
    // The Firefox flash fix: opacity does the tight cut, visibility is a wide
    // paint-cull gate so adjacent frames' paint windows overlap past any
    // compositor slop — no instant where both neighbors are visibility:hidden.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="blue" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="green" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
      ],
    });
    const fv1 = svg.match(/@keyframes fv-1\s*{[\s\S]*?\n\s*}/)![0];
    const fd1 = svg.match(/@keyframes fd-1\s*{[\s\S]*?\n\s*}/)![0];
    // fv-1 is opacity-only (no visibility declarations).
    expect(fv1).not.toMatch(/visibility/);
    // Pull the visible windows: opacity:1 stops vs visibility:visible stops.
    const opStops = [...fv1.matchAll(/([\d.]+)%\s*{\s*opacity:\s*1/g)].map((m) => parseFloat(m[1]));
    const visStops = [...fd1.matchAll(/([\d.]+)%\s*{\s*visibility:\s*visible/g)].map((m) => parseFloat(m[1]));
    expect(opStops.length).toBe(2);
    expect(visStops.length).toBe(2);
    // Visibility window strictly contains (is wider on both sides than) the
    // opacity cut window.
    expect(visStops[0]).toBeLessThan(opStops[0]);
    expect(visStops[1]).toBeGreaterThan(opStops[1]);
  });

  it("DM-1511/1512/1513: a single looping frame keeps opacity + visibility decoupled", () => {
    // The single-frame looping demos (kinetic-text, lower-third) rendered "as two
    // separate steps" / flashed at the loop edge in Firefox because the lone
    // frame's opacity and visibility flipped together in one step-end keyframe —
    // the same visibility-off-the-opacity-clock race as the multi-frame cut flash.
    // A single frame must still keep visibility in its OWN fd-0 track.
    const svg = generateAnimatedSvg({
      width: 200, height: 200,
      frames: [{ svgContent: `<rect width="200" height="200" fill="#123"/>`, duration: 2650 }],
    });
    const fv0 = svg.match(/@keyframes fv-0\s*{[\s\S]*?\n\s*}/)![0];
    // fv-0 drives opacity only — NO visibility folded in.
    expect(fv0).not.toMatch(/visibility/);
    expect(fv0).toMatch(/opacity/);
    // Visibility lives in a separate fd-0 track, and .f-0 runs both.
    expect(svg).toMatch(/@keyframes fd-0\s*{[\s\S]*?visibility/);
    expect(svg).toMatch(/\.f-0\s*{\s*animation:\s*fv-0[^,}]*,\s*fd-0/);
  });

  it("DM-1512/1513: `fuse` emits all tracks in ONE @keyframes on one element", () => {
    // A fused move + fade must become a single CSS animation (one timeline) so
    // the two can't desync under Firefox's off-main-thread compositing. The
    // animator should emit transform AND opacity in the SAME keyframe stops,
    // driven by one `.anim-<id>` rule (one @keyframes name).
    const svg = generateAnimatedSvg({
      width: 200, height: 200,
      frames: [{
        svgContent: `<g data-domotion-anim="f0a0"><rect width="80" height="80"/></g>`,
        duration: 2000,
        animations: [{
          animId: "f0a0", property: "scale", from: "0.3", to: "1", duration: 500,
          easing: "cubic-bezier(0.34,1.56,0.64,1)", transformOrigin: "center",
          fuse: [{ property: "opacity", from: "0", to: "1" }],
        }],
      }],
    });
    const kf = svg.match(/@keyframes f0-f0a0-0\s*{[\s\S]*?\n\s*}/)![0];
    // Both properties present in the fused keyframes.
    expect(kf).toMatch(/transform:\s*scale\(0\.3\)/);
    expect(kf).toMatch(/transform:\s*scale\(1\)/);
    expect(kf).toMatch(/opacity:\s*0/);
    expect(kf).toMatch(/opacity:\s*1/);
    // Exactly ONE animation drives the element (one @keyframes name, one rule).
    const animRules = svg.match(/\.anim-f0a0\s*{[^}]*}/g) ?? [];
    expect(animRules).toHaveLength(1);
    expect(animRules[0]).toMatch(/animation:\s*f0-f0a0-0\b/);
    // A fused stop composes into a single transform: (not two transform: decls).
    const startStop = kf.match(/0%\s*{([^}]*)}/)![1];
    expect((startStop.match(/transform:/g) ?? []).length).toBe(1);
  });

  it("DM-1512/1513: multiple transform tracks compose into one transform declaration", () => {
    const svg = generateAnimatedSvg({
      width: 200, height: 200,
      frames: [{
        svgContent: `<g data-domotion-anim="f0a0"><rect width="80" height="80"/></g>`,
        duration: 2000,
        animations: [{
          animId: "f0a0", property: "scale", from: "0.3", to: "1", duration: 500,
          fuse: [{ property: "translateY", from: "20px", to: "0px" }, { property: "opacity", from: "0", to: "1" }],
        }],
      }],
    });
    const kf = svg.match(/@keyframes f0-f0a0-0\s*{[\s\S]*?\n\s*}/)![0];
    const startStop = kf.match(/0%\s*{([^}]*)}/)![1];
    // scale + translateY collapse into ONE transform:, opacity alongside.
    expect((startStop.match(/transform:/g) ?? []).length).toBe(1);
    expect(startStop).toMatch(/transform:\s*scale\(0\.3\)\s+translateY\(20px\)/);
    expect(startStop).toMatch(/opacity:\s*0/);
  });

  it("DM-1517: a fused track with its own duration/easing samples into one linear-timed animation", () => {
    // Fast fade (200ms ease-out) fused with a slower slide (600ms cubic). They
    // have different windows AND easings, so the animator samples both into ONE
    // @keyframes with `linear` timing (easing baked) — still one timeline.
    const svg = generateAnimatedSvg({
      width: 200, height: 200,
      frames: [{
        svgContent: `<g data-domotion-anim="f0a0"><rect width="80" height="80"/></g>`,
        duration: 2000,
        animations: [{
          animId: "f0a0", property: "translateY", from: "24px", to: "0px", duration: 600, easing: "cubic-bezier(0.22,1,0.36,1)",
          fuse: [{ property: "opacity", from: "0", to: "1", duration: 200, easing: "ease-out" }],
        }],
      }],
    });
    const rule = svg.match(/\.anim-f0a0\s*{[^}]*}/)![0];
    // ONE animation, timing baked to linear.
    expect(rule).toMatch(/animation:\s*f0-f0a0-0\b[^,;]*\blinear\b/);
    const kf = svg.match(/@keyframes f0-f0a0-0\s*{[\s\S]*?\n\s*}/)![0];
    // Many sampled stops (not just from/to), each carrying both properties.
    const stops = [...kf.matchAll(/([\d.]+)%\s*{([^}]*)}/g)];
    expect(stops.length).toBeGreaterThan(6);
    // The fast fade finishes well before the slow slide: find the earliest stop
    // where opacity has reached 1, and confirm the slide is still mid-flight there.
    const firstOpaque = stops.find((m) => /opacity:\s*1\b/.test(m[2]) && /translateY\(/.test(m[2]))!;
    expect(firstOpaque).toBeDefined();
    const ty = parseFloat(firstOpaque[2].match(/translateY\(([-\d.]+)px\)/)![1]);
    expect(ty).toBeGreaterThan(0.5); // slide not done yet while opacity is already 1
    expect(parseFloat(firstOpaque[1])).toBeLessThan(15); // and it happened early (fade window ≈ 8.7%)
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

    const typedLines = (svg: string): string[] => typedLineTexts(svg);

    it("wraps the typed text into multiple lines bounded by bgWidth", () => {
      const svg = typedSvg({ bgWidth: 120 });
      const lines = typedLines(svg);
      expect(lines.length).toBeGreaterThan(1);
      // DM-1557: pixel-accurate wrap — each line's monospace width stays within
      // the usable field (120-4=116px), so at ~8.65px/char no line exceeds ~13.
      const maxChars = Math.ceil((120 - 4) / (14 * 0.6));
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(maxChars);
      // No glyph escapes the field: each line's right edge stays within the bg.
      expect(lines.join("")).not.toContain("  "); // wrap consumed the break spaces
    });

    it("advances y by a line-height per wrapped line", () => {
      const svg = typedSvg({ bgWidth: 120 });
      const ys = typedLineBaselines(svg);
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

  // DM-1134: wrap width (`wrapWidth`) and the placeholder mask (`mask: {width,
  // height, color}`) are now independent knobs; the legacy `bgWidth` / `bgHeight`
  // / `bgColor` keep working as deprecated aliases.
  describe("typing overlay wrap vs mask reconciliation (DM-1134)", () => {
    const longText = "The quick brown fox jumps over the lazy dog repeatedly";
    const typedLines = (svg: string): string[] => typedLineTexts(svg);
    const bgRect = (svg: string): { width: number; height: number; fill: string } | null => {
      const m = /<rect class="t0-bg"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"[^>]*fill="([^"]+)"/.exec(svg);
      return m == null ? null : { width: Number(m[1]), height: Number(m[2]), fill: m[3] };
    };
    const make = (overlay: Record<string, unknown>): string =>
      generateAnimatedSvg({
        width: 400, height: 200,
        frames: [{ svgContent: `<rect width="400" height="200" fill="#fff"/>`, duration: 4000,
          overlays: [{ kind: "typing", text: longText, x: 20, y: 40, fontSize: 14, ...overlay } as never] }],
      });

    it("`wrapWidth` wraps identically to the legacy `bgWidth`", () => {
      const viaNew = typedLines(make({ wrapWidth: 120, mask: { color: "#fff" } }));
      const viaOld = typedLines(make({ bgWidth: 120, bgColor: "#fff" }));
      expect(viaNew.length).toBeGreaterThan(1);
      expect(viaNew).toEqual(viaOld);
    });

    it("`mask.width` sizes the cover INDEPENDENTLY of the wrap width", () => {
      // Wrap at 120 (text breaks to several lines) but mask 300 wide.
      const svg = make({ wrapWidth: 120, mask: { width: 300, color: "#fff" } });
      expect(typedLines(svg).length).toBeGreaterThan(1);     // still wraps at 120
      expect(bgRect(svg)!.width).toBe(300);                  // mask is the wider 300
    });

    it("`mask.color` paints the cover; `mask.height` sets its height floor", () => {
      const svg = make({ wrapWidth: 400, mask: { color: "rgb(1,2,3)", height: 80 } });
      const bg = bgRect(svg)!;
      expect(bg.fill).toBe("rgb(1,2,3)");
      expect(bg.height).toBeGreaterThanOrEqual(80);
    });

    it("paints no mask when neither `mask.color` nor `bgColor` is set", () => {
      const svg = make({ wrapWidth: 120 });
      expect(svg).not.toContain('class="t0-bg"');
    });

    it("new `mask` overrides the legacy aliases when both are present", () => {
      const svg = make({ bgWidth: 120, bgColor: "#000", bgHeight: 24, mask: { width: 260, color: "rgb(9,9,9)" } });
      const bg = bgRect(svg)!;
      expect(bg.width).toBe(260);          // mask.width wins over bgWidth
      expect(bg.fill).toBe("rgb(9,9,9)");  // mask.color wins over bgColor
    });

    // DM-1344: the placeholder mask must VERTICALLY STRADDLE the typed text's
    // baseline (overlay.y) — its top above the baseline, its bottom below — so
    // the typed glyphs always land on the masked field, never above/below it.
    // The showcase-transitions demo mispositioned its overlay below the search
    // bar; this pins the renderer's mask-vs-baseline contract demo authors rely
    // on when placing an overlay against a captured element's box.
    it("mask rect vertically straddles the typed-text baseline", () => {
      const baseline = 40; // overlay.y
      const fontSize = 14;
      const svg = make({ wrapWidth: 400, mask: { color: "#161b22", height: 24 } });
      const bg = /<rect class="t0-bg"[^>]*y="([\d.-]+)"[^>]*height="([\d.]+)"/.exec(svg);
      expect(bg).not.toBeNull();
      const maskTop = Number(bg![1]);
      const maskBottom = maskTop + Number(bg![2]);
      // First line's text baseline equals overlay.y.
      const firstTextY = typedLineBaselines(svg)[0];
      expect(firstTextY).toBe(baseline);
      // The glyph ink runs from (baseline - ascent) up to ~(baseline + descent).
      // The mask must cover the ascent (top above baseline) and reach past the
      // baseline (bottom below it).
      expect(maskTop).toBeLessThan(baseline);
      expect(maskTop).toBeLessThanOrEqual(baseline - fontSize + 4); // covers the ascent
      expect(maskBottom).toBeGreaterThan(baseline);
    });
  });
});

// DM-1454: the optimizer (SVGO/csso `minifyStyles`) must NOT change the rendered
// animation. Hard cuts emit `step-end` timing so each frame's opacity flips
// instantly; when that was a SEPARATE `animation-timing-function: step-end`
// declaration, csso `restructure` factored it out / reordered it after the
// `animation:` shorthand, which resets timing to `ease` — so the last frame
// faded to black over its whole duration. The fix folds the timing function
// INTO the `animation:` shorthand (one declaration, nothing to reorder).
describe("optimizer preserves hard-cut step-end timing (DM-1454)", () => {
  const cutCfg = {
    width: 100, height: 100,
    frames: [
      { svgContent: `<rect width="100" height="100" fill="red"/>`, duration: 1000, transition: { type: "cut" as const, duration: 0 } },
      { svgContent: `<rect width="100" height="100" fill="green"/>`, duration: 1000, transition: { type: "cut" as const, duration: 0 } },
      { svgContent: `<rect width="100" height="100" fill="blue"/>`, duration: 1000, transition: { type: "cut" as const, duration: 0 } },
    ],
  };

  const frameRules = (svg: string): string[] =>
    [...svg.matchAll(/\.f-\d+\s*\{[^}]*\}/g)].map((m) => m[0]);

  it("emits step-end inside the animation shorthand (no separate declaration)", () => {
    const rules = frameRules(generateAnimatedSvg(cutCfg));
    expect(rules.length).toBe(3);
    for (const r of rules) {
      expect(r).toMatch(/animation:[^;}]*step-end/); // timing function is in the shorthand
      expect(r).not.toContain("animation-timing-function"); // not a reorder-vulnerable separate decl
    }
  });

  it("every cut-frame rule keeps step-end after optimizeSvg", () => {
    const optimized = optimizeSvg(generateAnimatedSvg(cutCfg));
    const rules = frameRules(optimized);
    expect(rules.length).toBe(3);
    for (const r of rules) {
      // An `.f-N` rule that binds an animation must still carry step-end.
      if (/animation:/.test(r)) expect(r, `step-end lost after optimize in: ${r}`).toContain("step-end");
    }
  });
});

describe("root svg accessible name (DM-1488)", () => {
  it("emits role=img + <title>/<desc> on the root svg when an accessible name is given", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      title: "Product flow", desc: "A dashboard assembling itself",
      frames: [
        { svgContent: `<rect/>`, duration: 1000 },
        { svgContent: `<rect/>`, duration: 1000 },
      ],
    });
    expect(svg).toMatch(/<svg [^>]*\brole="img"/);
    expect(svg).toContain("<title>Product flow</title><desc>A dashboard assembling itself</desc>");
  });

  it("default animated output has no root role/title", () => {
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [{ svgContent: `<rect/>`, duration: 1000 }, { svgContent: `<rect/>`, duration: 1000 }],
    });
    expect(svg).toMatch(/viewBox="0 0 100 100" width="100" height="100">/);
  });
});

// DM-1524 / DM-1542: transition + effect expansion. All new transitions must
// express motion via transform / clip-path / opacity / gradients only — never an
// animated CSS `filter` (Chromium-only inside <img>, docs/84).
describe("transition expansion (DM-1524)", () => {
  const twoFrame = (type: string) => generateAnimatedSvg({
    width: 400, height: 200,
    frames: [
      { svgContent: `<rect id="a" width="400" height="200" fill="red"/>`, duration: 500, transition: { type, duration: 400 } as never },
      { svgContent: `<rect id="b" width="400" height="200" fill="blue"/>`, duration: 500, transition: { type, duration: 400 } as never },
    ],
  });

  it("never animates a CSS filter in ANY new transition (cross-engine-safe)", () => {
    for (const type of ["push-right", "push-up", "push-down", "wipe", "iris", "zoom-in", "zoom-out", "shine"]) {
      const svg = twoFrame(type);
      expect(svg, type).not.toContain("filter:");
      expect(svg, type).not.toMatch(/blur\(/);
    }
  });

  it("push-right exits toward +X and push-down toward +Y (opposite of push-left/up)", () => {
    // Frame 0's fp-0 EXIT transform carries the signed direction: push-right
    // exits +X (push-left exits -X on the same block), push-down exits +Y.
    const fp0 = (svg: string) => svg.match(/@keyframes fp-0 \{(?:[^{}]|\{[^}]*\})*\}/)?.[0] ?? "";
    expect(fp0(twoFrame("push-right"))).toContain("translateX(400px)");
    expect(fp0(twoFrame("push-left"))).toContain("translateX(-400px)");
    expect(fp0(twoFrame("push-down"))).toContain("translateY(200px)");
    expect(fp0(twoFrame("push-up"))).toContain("translateY(-200px)");
  });

  it("push-up is the byte-identical alias of scroll", () => {
    // scroll and push-up map to the same {axis:Y, sign:-1} direction.
    expect(twoFrame("push-up")).toBe(twoFrame("scroll"));
  });

  it("wipe reveals the incoming frame via an inset clip-path (no box motion)", () => {
    const svg = twoFrame("wipe");
    // Frame 1 (entered from frame 0's wipe) gets an fr-1 clip reveal 100% -> 0%.
    expect(svg).toContain(`class="fr-1"`);
    expect(svg).toContain("@keyframes fr-1");
    expect(svg).toContain("clip-path: inset(0 100% 0 0)"); // hidden
    expect(svg).toContain("clip-path: inset(0 0 0 0)"); // fully revealed (rest)
  });

  it("iris reveals the incoming frame via an expanding circle clip-path", () => {
    const svg = twoFrame("iris");
    expect(svg).toContain("clip-path: circle(0px at 200px 100px)"); // pinhole
    expect(svg).toContain("clip-path: circle(224px at 200px 100px)"); // ceil(hypot(200,100))
  });

  it("zoom-in scales the incoming frame 0.9 -> 1 (dolly) resting at scale(1)", () => {
    const svg = twoFrame("zoom-in");
    expect(svg).toContain(`class="fz-1"`);
    expect(svg).toContain("@keyframes fz-1");
    expect(svg).toContain("transform: scale(0.9)");
    expect(svg).toContain("transform: scale(1)"); // rests at identity
    // Center-origin about the viewport (400x200 -> 200,100).
    expect(svg).toContain("transform-origin: 200px 100px");
  });

  it("zoom-out settles the incoming frame 1.1 -> 1", () => {
    expect(twoFrame("zoom-out")).toContain("transform: scale(1.1)");
  });

  it("shine transition adds a gradient sweep over the handoff (transform-driven)", () => {
    const svg = twoFrame("shine");
    expect(svg).toContain("shine-grad-tr0"); // frame-0 handoff sweep
    expect(svg).toContain("@keyframes shine-tr0");
    expect(svg).toContain(".shine-tr0 { animation:");
    expect(svg).toContain("transform: translateX"); // transform-driven, not filter
    // Still cross-dissolves underneath (opacity keyframes present).
    expect(svg).toContain("@keyframes fv-0");
  });

  it("a shine OVERLAY renders a clipped repeating shimmer over a box", () => {
    const svg = generateAnimatedSvg({
      width: 400, height: 200,
      frames: [{
        svgContent: `<rect width="400" height="200" fill="#333"/>`,
        duration: 1500,
        overlays: [{ kind: "shine", x: 20, y: 30, width: 200, height: 60, repeat: "infinite" }],
      }],
    });
    expect(svg).toContain(`<clipPath id="shine-clip-sh0">`);
    expect(svg).toContain("shine-grad-sh0");
    expect(svg).not.toContain("filter:");
  });

  // DM-1551: a shine OVERLAY's `radius` rounds its clip so the glint follows a
  // pill/button's corners instead of showing square edges.
  it("a shine overlay's radius rounds the clip rect", () => {
    const svg = generateAnimatedSvg({
      width: 400, height: 200,
      frames: [{
        svgContent: `<rect width="400" height="200" fill="#333"/>`,
        duration: 1500,
        overlays: [{ kind: "shine", x: 20, y: 30, width: 200, height: 60, radius: 8, repeat: "infinite" }],
      }],
    });
    expect(svg).toContain(`rx="8" ry="8"`);
  });
});

// DM-1550: the wipe / iris clip-path reveal and the zoom-in / zoom-out scale
// dolly can carry an optional named easing (from the motion-preset vocabulary —
// including the sampled `spring-*` linear(...) curves) authored on the transition
// that drives the NEXT frame's entrance. It's applied to the reveal/dolly SEGMENT
// via a per-keyframe `animation-timing-function`, leaving the holds linear.
describe("reveal/zoom easing (DM-1550)", () => {
  const twoFrameEased = (type: string, easing?: string) => generateAnimatedSvg({
    width: 400, height: 200,
    frames: [
      { svgContent: `<rect id="a" width="400" height="200" fill="red"/>`, duration: 500, transition: { type, duration: 400, easing } as never },
      { svgContent: `<rect id="b" width="400" height="200" fill="blue"/>`, duration: 500, transition: { type, duration: 400 } as never },
    ],
  });
  const frBlock = (svg: string) => svg.match(/@keyframes fr-1 \{(?:[^{}]|\{[^}]*\})*\}/)?.[0] ?? "";
  const fzBlock = (svg: string) => svg.match(/@keyframes fz-1 \{(?:[^{}]|\{[^}]*\})*\}/)?.[0] ?? "";

  it("bakes a sampled spring linear(...) onto the wipe reveal segment", () => {
    const kf = frBlock(twoFrameEased("wipe", "spring-bouncy"));
    // The spring resolves to a CSS linear(...) curve applied at the reveal-open
    // stop (governs the enter -> start interval); overshoot rides in the samples.
    expect(kf).toMatch(/animation-timing-function: linear\(/);
  });

  it("resolves a named bezier easing on an iris reveal", () => {
    const kf = frBlock(twoFrameEased("iris", "ease-out-quart"));
    expect(kf).toContain("animation-timing-function: cubic-bezier(0.165,0.84,0.44,1)");
  });

  it("passes a raw CSS easing string through unchanged on a zoom dolly", () => {
    const kf = fzBlock(twoFrameEased("zoom-in", "cubic-bezier(0.2,0.9,0.3,1.4)"));
    expect(kf).toContain("animation-timing-function: cubic-bezier(0.2,0.9,0.3,1.4)");
  });

  it("eases the zoom-out scale segment with a spring", () => {
    const kf = fzBlock(twoFrameEased("zoom-out", "spring-soft"));
    expect(kf).toMatch(/animation-timing-function: linear\(/);
  });

  it("omits the per-keyframe timing function when no easing is given (linear, byte-compatible)", () => {
    expect(frBlock(twoFrameEased("wipe"))).not.toContain("animation-timing-function");
    expect(fzBlock(twoFrameEased("zoom-in"))).not.toContain("animation-timing-function");
  });
});

// DM-1547: radial / clock wipe transitions (docs/88). `wipe-radial` is the
// expanding-circle reveal (an alias of `iris`); `wipe-clock` is an angular
// "clock hand" polygon sweep. Both express motion via clip-path only — never an
// animated conic mask, never an animated filter (cross-engine-safe, docs/84).
describe("radial / clock wipe transitions (DM-1547)", () => {
  const twoFrame = (type: string) => generateAnimatedSvg({
    width: 400, height: 200,
    frames: [
      { svgContent: `<rect id="a" width="400" height="200" fill="red"/>`, duration: 500, transition: { type, duration: 400 } as never },
      { svgContent: `<rect id="b" width="400" height="200" fill="blue"/>`, duration: 500, transition: { type, duration: 400 } as never },
    ],
  });

  it("wipe-radial reveals via an expanding circle (same geometry as iris)", () => {
    const svg = twoFrame("wipe-radial");
    expect(svg).toContain(`class="fr-1"`);
    expect(svg).toContain("clip-path: circle(0px at 200px 100px)"); // pinhole
    expect(svg).toContain("clip-path: circle(224px at 200px 100px)"); // ceil(hypot(200,100))
  });

  it("wipe-radial is the byte-identical alias of iris", () => {
    // Both fold to the same expanding-circle reveal shape (cf. push-up == scroll).
    // Frame-group ids/classes don't depend on the transition NAME, so the SVGs match.
    expect(twoFrame("wipe-radial")).toBe(twoFrame("iris"));
  });

  it("wipe-clock reveals the incoming frame via an animated clip-path polygon()", () => {
    const svg = twoFrame("wipe-clock");
    expect(svg).toContain(`class="fr-1"`);
    expect(svg).toContain("@keyframes fr-1");
    // Angular sweep expressed as a polygon() clip, NOT a circle/inset/conic mask.
    expect(svg).toMatch(/clip-path: polygon\(/);
    expect(svg).not.toContain("conic-gradient");
  });

  it("wipe-clock uses a FIXED 7-vertex polygon at every stop (smooth interpolation)", () => {
    const svg = twoFrame("wipe-clock");
    const block = svg.match(/@keyframes fr-1 \{[\s\S]*?\n {4}\}/)?.[0] ?? "";
    const polys = [...block.matchAll(/polygon\(([^)]*)\)/g)];
    expect(polys.length).toBeGreaterThan(6); // hidden + several sweep stops + shown
    for (const p of polys) {
      // 7 comma-separated "x y" vertices at every keyframe so CSS interpolates
      // smoothly rather than falling back to a discrete jump.
      expect(p[1].split(",")).toHaveLength(7);
    }
  });

  it("wipe-clock starts hidden (degenerate) and rests at the full-rectangle polygon", () => {
    const svg = twoFrame("wipe-clock");
    // Hidden: the sweep collapses to the 12-o'clock point (all vertices at 200,0).
    expect(svg).toContain("polygon(200.00px 100.00px, 200.00px 0.00px, 200.00px 0.00px, 200.00px 0.00px, 200.00px 0.00px, 200.00px 0.00px, 200.00px 0.00px)");
    // Fully revealed (rest): the polygon threads all four corners.
    expect(svg).toContain("400.00px 0.00px, 400.00px 200.00px, 0.00px 200.00px, 0.00px 0.00px");
  });

  it("neither radial nor clock wipe animates a CSS filter", () => {
    for (const type of ["wipe-radial", "wipe-clock"]) {
      const svg = twoFrame(type);
      expect(svg, type).not.toContain("filter:");
      expect(svg, type).not.toMatch(/blur\(/);
      expect(svg, type).not.toContain("conic-gradient");
    }
  });
});

// DM-1565: synthetic interaction-feedback overlay (docs/94 Option 4) — a fake
// hover / focus / press treatment over a region with no real CSS state. It fades
// in a fill / ring / scale-pop, then RESTS at identity. transform + opacity only.
describe("interaction-feedback overlay (DM-1565)", () => {
  const withOverlay = (overlay: Record<string, unknown>) => generateAnimatedSvg({
    width: 300, height: 160,
    frames: [{
      svgContent: `<rect width="300" height="160" fill="#111"/>`,
      duration: 2000,
      overlays: [{ kind: "interact", x: 40, y: 50, width: 160, height: 44, ...overlay } as never],
    }],
  });

  it("hover paints a translucent fill + scale pop, fused into one animation", () => {
    const svg = withOverlay({ treatment: "hover" });
    expect(svg).toContain(`class="ix0"`);
    expect(svg).toContain("@keyframes ix0");
    expect(svg).toContain("fill-opacity"); // highlight fill
    // opacity AND transform animate on the SAME keyframes (one timeline).
    expect(svg).toMatch(/@keyframes ix0 \{[\s\S]*opacity: 1; transform: scale\(1\.03\)/);
    // scale pivots about the box center (40+80, 50+22).
    expect(svg).toContain("transform-origin: 120px 72px");
  });

  it("rests at identity — opacity 0 / scale(1) at the loop boundaries", () => {
    const svg = withOverlay({ treatment: "hover" });
    const block = svg.match(/@keyframes ix0 \{[\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(block).toMatch(/0% \{ opacity: 0; transform: scale\(1\);/);
    expect(block).toMatch(/100% \{ opacity: 0; transform: scale\(1\); \}/);
  });

  it("focus draws a stroked ring (fill=none stroke)", () => {
    const svg = withOverlay({ treatment: "focus" });
    expect(svg).toMatch(/stroke="#4c9ffe"/);
    expect(svg).toContain(`fill="none"`);
  });

  it("press scales DOWN (press-in) with a darken fill", () => {
    const svg = withOverlay({ treatment: "press" });
    expect(svg).toContain("transform: scale(0.96)");
    expect(svg).toMatch(/fill="#000000"/);
  });

  it("fill:\"none\" omits the fill rect; ring can be added to any treatment", () => {
    const svg = withOverlay({ treatment: "hover", fill: "none", ring: "#ff0000" });
    expect(svg).not.toContain("fill-opacity");
    expect(svg).toMatch(/stroke="#ff0000"/);
  });

  it("never animates a CSS filter (cross-engine-safe)", () => {
    for (const treatment of ["hover", "focus", "press"]) {
      const svg = withOverlay({ treatment });
      expect(svg, treatment).not.toContain("filter:");
      expect(svg, treatment).not.toMatch(/blur\(/);
    }
  });
});
