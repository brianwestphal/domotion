import { describe, it, expect } from "vitest";
import { generateAnimatedSvg, type AnimationFrame } from "./animator.js";

// DM-1414: a frame's ENTRANCE must be composed from the PREVIOUS frame's
// transition type, independently of its OWN (exit) type. Before the fix, a slide
// frame after a non-matching transition got no slide-IN / fade-IN keyframes — it
// cut in (crossfade dipped to black, the scroll revealed empty canvas). These
// tests pin the composed entrance keyframes for mixed-type chains.
const W = 600;
const H = 360;
const rect = (c: string) => `<rect width="${W}" height="${H}" fill="${c}"/>`;

/** Extract a single `@keyframes NAME { … }` block (ends at the dedented `}`). */
function keyframeBlock(svg: string, name: string): string {
  const m = svg.match(new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n    \\}`));
  return m ? m[0] : "";
}

function gen(types: NonNullable<AnimationFrame["transition"]>["type"][]): string {
  const colors = ["#3366ff", "#33cc66", "#ffaa00", "#cc3366"];
  return generateAnimatedSvg({
    width: W,
    height: H,
    frames: types.map((type, i) => ({
      svgContent: rect(colors[i % colors.length]),
      duration: 1000,
      transition: { type, duration: 400 },
    })),
  });
}

describe("animator: mixed transition entrance/exit composition (DM-1414)", () => {
  it("a push frame after a crossfade FADES in (no slide-in) and exits sliding left", () => {
    const svg = gen(["crossfade", "push-left", "scroll", "crossfade"]);
    const fp1 = keyframeBlock(svg, "fp-1"); // frame 1 = push, prev = crossfade
    const fv1 = keyframeBlock(svg, "fv-1");
    // No slide-IN: the entrance transform is the identity (translateX(0px)), not
    // an off-screen +width.
    expect(fp1).toContain("translateX(0px)");
    expect(fp1).not.toContain(`translateX(${W}px)`);
    // Exit is still its own push (slide left to -width).
    expect(fp1).toContain(`translateX(-${W}px)`);
    // Fade-IN ramp: opacity holds 0 at the entrance start, then ramps to 1 — a
    // snap entrance would jump straight to opacity:1 with no held-0 stop.
    expect(fv1).toMatch(/\{ opacity: 0; \}[\s\S]*\{ opacity: 0; \}[\s\S]*\{ opacity: 1; \}/);
  });

  it("a scroll frame after a push SLIDES in from the right (cross-axis) and exits up", () => {
    const svg = gen(["crossfade", "push-left", "scroll", "crossfade"]);
    const fp2 = keyframeBlock(svg, "fp-2"); // frame 2 = scroll, prev = push
    // Cross-axis compose: enters on the push axis (+width on X), exits on its own
    // scroll axis (-height on Y).
    expect(fp2).toContain(`translate(${W}px, 0px)`);
    expect(fp2).toContain(`translate(0px, -${H}px)`);
  });

  it("same-type chains are unchanged: a push frame after a push still SLIDES in", () => {
    const svg = gen(["push-left", "push-left"]);
    const fp1 = keyframeBlock(svg, "fp-1");
    // Same-axis slide-in keeps the single-axis form (byte-identical to pre-fix).
    expect(fp1).toContain(`translateX(${W}px)`);
    // And no cross-axis translate() leaks into a same-type chain.
    expect(svg).not.toContain(`translate(${W}px, 0px)`);
  });
});
