import { describe, it, expect } from "vitest";
import { generateAnimatedSvg, type AnimationFrame } from "./animator.js";
import { buildMagicMove } from "./magic-move.js";
import type { CapturedElement } from "../capture/types.js";

/** Minimal CapturedElement factory for buildMagicMove (mirrors magic-move.test.ts). */
function mkEl(opts: Partial<CapturedElement> & { tag: string; x: number; y: number }): CapturedElement {
  return { text: "", width: 100, height: 20, styles: {} as CapturedElement["styles"], children: [], ...opts };
}

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

// DM-1548: the unified entrance/exit compositor. Where DM-1414 composed the
// slide/fade families, these boundaries mix a REVEAL (wipe/iris/…) or a DOLLY
// (zoom) entrance with a DIFFERENT-family exit — cases the single-branch dispatch
// used to drop half of. `emitComposedFrame` composes both halves as independent
// tracks (fv/fd + fp/fz/fr) on one frame group.
describe("animator: unified mixed-family compositor (DM-1548)", () => {
  it("zoom-out → wipe: the wipe-exit frame still DOLLIES in (fz), then holds for the wipe", () => {
    // The ticket's canonical example. Frame 1 enters from a zoom-out (dolly) and
    // exits via wipe (hold-then-cut). The old reveal branch cut it in, dropping
    // the dolly; the compositor keeps the scale entrance.
    const svg = gen(["zoom-out", "wipe", "crossfade"]);
    const fz1 = keyframeBlock(svg, "fz-1");
    expect(fz1, "no dolly scale track on the zoom→wipe frame").toContain("scale(1.1)");
    expect(fz1).toContain("scale(1)");
    // It still holds solid to its transition end (reveal-hold exit), not a fade-out.
    const fv1 = keyframeBlock(svg, "fv-1");
    expect(fv1).toMatch(/\{ opacity: 1; \}\s*\n\s*[\d.]+% \{ opacity: 0; \}/); // hold 1 → step 0
  });

  it("wipe → crossfade: the frame REVEALS in (fr clip-path) then FADES out", () => {
    // Old behavior forced a hold-then-cut exit here (crossfade dropped). The
    // compositor keeps the reveal entrance AND the crossfade exit.
    const svg = gen(["wipe", "crossfade", "crossfade"]);
    const fr1 = keyframeBlock(svg, "fr-1");
    expect(fr1, "no reveal clip-path entrance on the wipe→crossfade frame").toContain("inset(0 100% 0 0)");
    expect(fr1).toContain("inset(0 0 0 0)");
    // Crossfade EXIT: opacity ramps 1 → 0 over the trans window (not a hard step).
    const fv1 = keyframeBlock(svg, "fv-1");
    expect(fv1).toMatch(/\{ opacity: 1; \}[\s\S]*\{ opacity: 0; \}[\s\S]*100% \{ opacity: 0; \}/);
  });

  it("iris → push-left: the frame REVEALS in (circle) then SLIDES out to the left", () => {
    const svg = gen(["iris", "push-left", "crossfade"]);
    const fr1 = keyframeBlock(svg, "fr-1");
    expect(fr1).toContain("circle(0px at"); // iris expanding-circle entrance
    const fp1 = keyframeBlock(svg, "fp-1");
    expect(fp1, "reveal-in frame should still slide out on its own push axis").toContain(`translate(-${W}px, 0px)`);
  });

  it("crossfade → wipe: the wipe-exit frame FADES in (ramp) then holds for its wipe", () => {
    const svg = gen(["crossfade", "wipe", "crossfade"]);
    const fv1 = keyframeBlock(svg, "fv-1");
    // Fade-IN ramp (held 0 then → 1), not a snap.
    expect(fv1).toMatch(/\{ opacity: 0; \}[\s\S]*\{ opacity: 0; \}[\s\S]*\{ opacity: 1; \}/);
    // No reveal-clip entrance (it enters by fade, not by clip).
    expect(keyframeBlock(svg, "fr-1")).toBe("");
  });

  it("push-left → iris: the iris-exit frame SLIDES in from the right then holds", () => {
    const svg = gen(["push-left", "iris", "crossfade"]);
    const fp1 = keyframeBlock(svg, "fp-1");
    expect(fp1, "slide-in entrance from the push predecessor").toContain(`translate(${W}px, 0px)`);
  });

  it("wipe-clock → crossfade composes a polygon reveal entrance with a fade exit", () => {
    const svg = gen(["wipe-clock", "crossfade", "crossfade"]);
    const fr1 = keyframeBlock(svg, "fr-1");
    expect(fr1).toContain("polygon("); // clock-wipe polygon sweep entrance
  });

  it("single-type reveal chains stay on the old reveal branch (no fz/fp tracks)", () => {
    // All-wipe must NOT route through the compositor — its output is byte-identical
    // to the committed golden, which has no fz/fp tracks on the reveal frames.
    const svg = gen(["wipe", "wipe"]);
    expect(svg).not.toContain("@keyframes fz-");
    expect(svg).not.toContain("@keyframes fp-");
    // It still reveals via clip-path (the fr track from the old reveal branch).
    expect(svg).toContain("@keyframes fr-1");
  });
});

// DM-1598: the entrance of the frame AFTER a magic-move depends on whether the
// magic-move built a bridge — `classifyEntrance`'s `prevType === "magic-move"`
// branch returns `cut` when bridged (frame.magicMove present) else `fade`. Both
// arms had no assertion (the DM-1414/1548 matrix above skips magic-move as a
// prevType). This drives both via a real `buildMagicMove` bridge vs its absence.
describe("animator: frame entrance after a magic-move — bridged cuts, unbridged fades (DM-1598)", () => {
  // A real bridge: a div moves (10,10)→(60,90), so buildMagicMove pairs it.
  const bridge = buildMagicMove(
    mkEl({ tag: "body", x: 0, y: 0, children: [mkEl({ tag: "div", x: 10, y: 10, text: "card" })] }),
    mkEl({ tag: "body", x: 0, y: 0, children: [mkEl({ tag: "div", x: 60, y: 90, text: "card" })] }),
    (roots) => `<g>${roots.length}</g>`, "mm0-",
  );

  // 4 frames so frame 2 (the one entering AFTER the magic-move) is NOT the last
  // frame (avoids the hold-to-loop special-casing) and uses a crossfade so its
  // entrance is a visible opacity ramp rather than a hard step.
  const genAfterMagicMove = (withBridge: boolean): string => generateAnimatedSvg({
    width: W, height: H,
    frames: [
      { svgContent: rect("#3366ff"), duration: 1000, transition: { type: "crossfade", duration: 400 } },
      { svgContent: rect("#33cc66"), duration: 1000, transition: { type: "magic-move", duration: 400 }, ...(withBridge ? { magicMove: bridge } : {}) },
      { svgContent: rect("#ffaa00"), duration: 1000, transition: { type: "crossfade", duration: 400 } },
      { svgContent: rect("#cc3366"), duration: 1000, transition: { type: "cut", duration: 0 } },
    ],
  });

  /** The fade-in span of frame 2 = (first opacity:1 stop) − (the opacity:0 stop
   *  just below it). ~0 ⇒ a hard cut; a wide span ⇒ a gradual fade-in. */
  function fadeInSpan(svg: string): number {
    const block = keyframeBlock(svg, "fv-2");
    const pctsFor = (op: string): number[] => block
      .split("\n").filter((l) => l.includes(`opacity: ${op}`))
      .flatMap((l) => [...l.matchAll(/([\d.]+)%/g)].map((m) => parseFloat(m[1])));
    const zeros = pctsFor("0"), ones = pctsFor("1");
    const firstOne = Math.min(...ones);
    const zeroJustBelow = Math.max(...zeros.filter((z) => z < firstOne));
    return firstOne - zeroJustBelow;
  }

  it("bridged (frame.magicMove present) → the next frame CUTS in (fade-in span ≈ 0)", () => {
    expect(fadeInSpan(genAfterMagicMove(true))).toBeLessThan(1);
  });

  it("unbridged (no bridge) → the next frame FADES in (a gradual opacity ramp)", () => {
    expect(fadeInSpan(genAfterMagicMove(false))).toBeGreaterThan(3);
  });

  it("the two entrances actually differ (the bridge changes the composition)", () => {
    expect(fadeInSpan(genAfterMagicMove(false))).toBeGreaterThan(fadeInSpan(genAfterMagicMove(true)));
  });
});
