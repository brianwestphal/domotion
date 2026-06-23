/**
 * Unit tests for the SVG animator — specifically the keyframe timing and
 * shared-defs hoist. Regression tests for SK-662 (flicker + size).
 */

import { describe, it, expect } from "vitest";
import { generateAnimatedSvg, dedupeFrameIds } from "./animator.js";

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

  for (const transparent of ["transparent", "rgba(0, 0, 0, 0)", ""]) {
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

  it("DM-870: typing-overlay caret emits a position-tracked, step-end blinking bar", () => {
    const svg = generateAnimatedSvg({
      width: 200,
      height: 80,
      frames: [{ svgContent: `<rect/>`, duration: 3000, overlays: [{ kind: "typing", text: "hi there", x: 10, y: 40, caret: true }] }],
    });
    expect(svg).toContain(`class="t0-caret"`);
    expect(svg).toMatch(/@keyframes t0-caret-pos/);
    expect(svg).toMatch(/@keyframes t0-caret-blink/);
    // Position track is linear; the blink toggles with step-end (hard on/off).
    expect(svg).toMatch(/\.t0-caret\s*{[^}]*linear[^}]*step-end/);
  });

  it("DM-1204: typing-overlay reveal clip sweeps linearly so it tracks the caret", () => {
    const svg = generateAnimatedSvg({
      width: 200,
      height: 80,
      frames: [{ svgContent: `<rect/>`, duration: 3000, overlays: [{ kind: "typing", text: "hi there", x: 10, y: 40, caret: true }] }],
    });
    // The reveal-clip width animation must be `linear`, matching the caret's
    // linear position track. A default (ease) timing function makes the reveal
    // edge race ahead of the linear caret mid-sweep (caret appears to lag).
    expect(svg).toMatch(/\.t0-rev0\s*{[^}]*\blinear\b[^}]*}/);
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

  it("DM-599/DM-641: cut fv-N keyframes emit visibility alongside opacity", () => {
    // Cut composites (DM-865); its fv-N keyframes flip BOTH opacity and
    // visibility at the frame boundary (step-end) so the browser can skip
    // painting a frame that's off screen.
    const svg = generateAnimatedSvg({
      width: 100, height: 100,
      frames: [
        { svgContent: `<rect fill="red" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
        { svgContent: `<rect fill="blue" width="50" height="50"/>`, duration: 1000, transition: { type: "cut", duration: 0 } },
      ],
    });
    const fv = svg.match(/@keyframes fv-\d+\s*{[\s\S]*?\n\s*}/);
    expect(fv).not.toBeNull();
    expect(fv![0]).toMatch(/opacity:\s*1;\s*visibility:\s*visible/);
    expect(fv![0]).toMatch(/opacity:\s*0;\s*visibility:\s*hidden/);
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

  // DM-1134: wrap width (`wrapWidth`) and the placeholder mask (`mask: {width,
  // height, color}`) are now independent knobs; the legacy `bgWidth` / `bgHeight`
  // / `bgColor` keep working as deprecated aliases.
  describe("typing overlay wrap vs mask reconciliation (DM-1134)", () => {
    const longText = "The quick brown fox jumps over the lazy dog repeatedly";
    const typedLines = (svg: string): string[] =>
      [...svg.matchAll(/<text class="t0-text"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
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
  });
});
