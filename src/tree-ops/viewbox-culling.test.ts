import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../render/element-tree-to-svg.js";
import type { IntraFrameAnimation } from "../animator.js";
import { cullFrame, decideCull } from "./viewbox-culling.js";

// Helper to construct a CapturedElement with sensible defaults.
function el(opts: Partial<CapturedElement> & { x: number; y: number; width: number; height: number }): CapturedElement {
  return {
    tag: "div",
    text: "",
    styles: {} as CapturedElement["styles"],
    children: [],
    ...opts,
  };
}

const VW = 800;
const VH = 600;

describe("decideCull — static (no animation)", () => {
  it("element fully inside viewBox: not hidden", () => {
    const d = decideCull({ x: 100, y: 100, w: 200, h: 200 }, VW, VH, null);
    expect(d.alwaysHidden).toBe(false);
    expect(d.visStartPct).toBeUndefined();
  });

  it("element fully right of viewBox: alwaysHidden", () => {
    const d = decideCull({ x: 900, y: 100, w: 100, h: 100 }, VW, VH, null);
    expect(d.alwaysHidden).toBe(true);
  });

  it("element fully below viewBox: alwaysHidden", () => {
    const d = decideCull({ x: 100, y: 700, w: 100, h: 100 }, VW, VH, null);
    expect(d.alwaysHidden).toBe(true);
  });

  it("element partially overlapping: not hidden", () => {
    const d = decideCull({ x: 750, y: 100, w: 100, h: 100 }, VW, VH, null);
    expect(d.alwaysHidden).toBe(false);
  });
});

describe("decideCull — under a translate animation", () => {
  const anim = (overrides: Partial<IntraFrameAnimation>): IntraFrameAnimation => ({
    animId: "a", property: "translateY", from: "0px", to: "0px",
    duration: 1000, ...overrides,
  });

  it("enters viewBox during animation (from off, to on): hide BEFORE only", () => {
    const d = decideCull(
      { x: 100, y: 100, w: 100, h: 100 },
      VW, VH,
      { animStartPct: 30, animEndPct: 50, anim: anim({ property: "translateY", from: "-1000px", to: "0px" }) },
    );
    expect(d.alwaysHidden).toBe(false);
    expect(d.visStartPct).toBe(30);   // hidden 0% → 30%, then visible
    expect(d.visEndPct).toBe(100);    // visible all the way through end of cycle
  });

  it("exits viewBox during animation (from on, to off): hide AFTER only", () => {
    const d = decideCull(
      { x: 100, y: 100, w: 100, h: 100 },
      VW, VH,
      { animStartPct: 30, animEndPct: 50, anim: anim({ property: "translateY", from: "0px", to: "1000px" }) },
    );
    expect(d.alwaysHidden).toBe(false);
    expect(d.visStartPct).toBe(0);
    expect(d.visEndPct).toBe(50);     // hidden 50% → 100%
  });

  it("both from and to inside viewBox: always visible", () => {
    const d = decideCull(
      { x: 100, y: 100, w: 100, h: 100 },
      VW, VH,
      { animStartPct: 30, animEndPct: 50, anim: anim({ property: "translateY", from: "0px", to: "100px" }) },
    );
    expect(d.alwaysHidden).toBe(false);
    expect(d.visStartPct).toBeUndefined();
    expect(d.visEndPct).toBeUndefined();
  });

  it("both endpoints off-viewBox, animation path doesn't cross: alwaysHidden", () => {
    // bbox at y=100, animating from y=+1000 to y=+2000 — never re-enters viewBox.
    const d = decideCull(
      { x: 100, y: 100, w: 100, h: 100 },
      VW, VH,
      { animStartPct: 30, animEndPct: 50, anim: anim({ property: "translateY", from: "1000px", to: "2000px" }) },
    );
    expect(d.alwaysHidden).toBe(true);
  });

  it("both endpoints off-viewBox, animation path passes through: visible during", () => {
    // bbox at y=100, animating from y=-1000 to y=+1000 — passes through.
    // Per DM-599 feedback rule, visible during the animation.
    const d = decideCull(
      { x: 100, y: 100, w: 100, h: 100 },
      VW, VH,
      { animStartPct: 30, animEndPct: 50, anim: anim({ property: "translateY", from: "-1000px", to: "1000px" }) },
    );
    expect(d.alwaysHidden).toBe(false);
    expect(d.visStartPct).toBe(30);   // hide before
    expect(d.visEndPct).toBe(50);     // hide after
  });

  it("translateX animation: uses x-axis intersection", () => {
    // bbox at x=200, animating from x=-2000 to x=0 (still off-screen left at 200-1000=-800).
    // Wait: 200 + (-2000) = -1800 (off-left). 200 + 0 = 200 (visible). Enters.
    const d = decideCull(
      { x: 200, y: 100, w: 100, h: 100 },
      VW, VH,
      { animStartPct: 30, animEndPct: 50, anim: anim({ property: "translateX", from: "-2000px", to: "0px" }) },
    );
    expect(d.alwaysHidden).toBe(false);
    expect(d.visStartPct).toBe(30);
    expect(d.visEndPct).toBe(100);
  });

  it("non-translate animation (width): treated as static", () => {
    // The bbox doesn't move — width changes don't shift x/y. Static element
    // at (100,100,100,100) is inside viewBox.
    const d = decideCull(
      { x: 100, y: 100, w: 100, h: 100 },
      VW, VH,
      { animStartPct: 30, animEndPct: 50, anim: anim({ property: "width", from: "0px", to: "200px" }) },
    );
    expect(d.alwaysHidden).toBe(false);
  });
});

describe("cullFrame — tree walk", () => {
  it("hides off-viewBox static elements and recurses into in-viewBox parents", () => {
    const tree: CapturedElement = el({
      x: 0, y: 0, width: 800, height: 600, tag: "body",
      children: [
        el({ x: 100, y: 100, width: 100, height: 100, tag: "div" }),         // visible
        el({ x: 100, y: 700, width: 100, height: 100, tag: "div" }),         // below viewBox
        el({ x: 1000, y: 100, width: 100, height: 100, tag: "div" }),        // right of viewBox
      ],
    });
    const { css } = cullFrame(tree, VW, VH, undefined, 0, 1000);
    expect(tree.displayNone).toBeFalsy();
    expect(tree.children![0].displayNone).toBeFalsy();
    expect(tree.children![1].displayNone).toBe(true);
    expect(tree.children![2].displayNone).toBe(true);
    // No animation → no keyframes blocks emitted.
    expect(css).toBe("");
  });

  it("emits a coalesced keyframes block for animated descendants that share a visible window", () => {
    // Two children of a translateY-animated parent. Both off-viewBox at `from`,
    // both inside at `to` (animation moves them all into view). They share the
    // same visible window so they should share a single `cull-0` class.
    const anim: IntraFrameAnimation = {
      animId: "scroll", property: "translateY",
      from: "-2000px", to: "0px",
      duration: 1000, easing: "linear",
    };
    const tree: CapturedElement = el({
      x: 0, y: 0, width: 800, height: 4000, tag: "body", animId: "scroll",
      children: [
        el({ x: 100, y: 1800, width: 100, height: 50, tag: "div" }),  // static off; under translateY enters
        el({ x: 100, y: 1900, width: 100, height: 50, tag: "div" }),  // same
      ],
    });
    // frameStart 0, totalDur 2000 → animStart=0, animEnd=50%.
    const { css } = cullFrame(tree, VW, VH, [anim], 0, 2000);
    // Both children inherit the parent's translateY animation. From-position
    // (y=1800-2000=-200) is off-top (height=50, so bottom = -150 < 0, still
    // off). To-position (y=1800+0=1800) is below viewBox (h=600). So both
    // are NEVER visible — alwaysHidden? Let's check the bounding sample.
    // The animation interpolates y from 1800-2000 = -200 to 1800-0 = 1800.
    // At t=0.5, y = -200 + 0.5*2000 = 800 (off-bottom, since viewport=600).
    // Wait that's still off. Need a wider intersection check…
    // Actually at progress p, y = -200 + p*2000. Element top in viewport
    // = -200 + p*2000, bottom = top+50. Visible iff bottom>0 && top<600.
    //   bottom>0: -200+p*2000+50 > 0 → p > 0.075
    //   top<600: -200+p*2000 < 600 → p < 0.4
    // So visible for p ∈ (0.075, 0.4) — visible during animation.
    // From=off, To=off, but during=visible → per rule, visible during anim.
    // visStart should be animStartPct (0%), visEnd should be animEndPct (50%).
    // Actually wait — fromVisible=false, toVisible=false, anyDuringVisible=true.
    // visStart = fromVisible ? 0 : animStartPct = 0
    // visEnd = toVisible ? 100 : animEndPct = 50
    expect(tree.children![0].displayNone).toBeFalsy();
    expect(tree.children![0].cullClass).toBe("cull-0");
    expect(tree.children![1].cullClass).toBe("cull-0");
    // One coalesced keyframes block, not two.
    expect((css.match(/@keyframes cull-\d+/g) ?? []).length).toBe(1);
    expect(css).toContain("display: inline");
    expect(css).toContain("display: none");
  });

  it("element fully outside viewBox under an animation that never reaches it: alwaysHidden", () => {
    // A child whose static bbox + any animation transform never intersects.
    const anim: IntraFrameAnimation = {
      animId: "scroll", property: "translateY",
      from: "0px", to: "10px",                 // tiny move
      duration: 1000, easing: "linear",
    };
    const tree: CapturedElement = el({
      x: 0, y: 0, width: 800, height: 4000, tag: "body", animId: "scroll",
      children: [
        el({ x: 100, y: 2000, width: 100, height: 50, tag: "div" }),  // static at y=2000, far below 600
      ],
    });
    const { css } = cullFrame(tree, VW, VH, [anim], 0, 2000);
    expect(tree.children![0].displayNone).toBe(true);
    expect(tree.children![0].cullClass).toBeUndefined();
    expect(css).toBe("");
  });

  it("respects child's own animId over inherited animation", () => {
    // Parent has a scroll animation; child has its OWN slide-in animation.
    // Child's culling should use its OWN animation, not the parent's.
    const parentAnim: IntraFrameAnimation = {
      animId: "scroll", property: "translateY", from: "0px", to: "-1000px",
      duration: 1000, easing: "linear",
    };
    const childAnim: IntraFrameAnimation = {
      animId: "toast", property: "translateX", from: "-1000px", to: "0px",  // slides in from left
      duration: 500, easing: "linear", delay: 200,  // hold at `from` (off-screen) for 200 ms first
    };
    const tree: CapturedElement = el({
      x: 0, y: 0, width: 800, height: 600, tag: "body", animId: "scroll",
      children: [
        el({ x: 100, y: 100, width: 100, height: 100, tag: "div", animId: "toast" }),
      ],
    });
    const { css } = cullFrame(tree, VW, VH, [parentAnim, childAnim], 0, 2000);
    // Child should be hidden BEFORE its own toast animation (it starts off-left).
    // The child's `cullClass` should be set; not `displayNone`.
    expect(tree.children![0].displayNone).toBeFalsy();
    expect(tree.children![0].cullClass).toMatch(/^cull-\d+$/);
    expect(css).toContain("@keyframes cull-0");
  });
});

describe("cullFrame — keyframes structure", () => {
  it("keyframes use step-end timing and var(--scene-dur)", () => {
    const anim: IntraFrameAnimation = {
      animId: "a", property: "translateY", from: "-1000px", to: "0px",
      duration: 500, easing: "linear", delay: 300,   // hold at off-screen `from` for 300 ms
    };
    const tree: CapturedElement = el({
      x: 100, y: 100, width: 100, height: 100, tag: "div", animId: "a",
    });
    const { css } = cullFrame(tree, VW, VH, [anim], 0, 1000);
    expect(css).toContain("animation-timing-function: step-end");
    expect(css).toContain("var(--scene-dur)");
    // 0% bookend with display:none.
    expect(css).toMatch(/0% \{ display: none/);
    // 100% bookend with display:none.
    expect(css).toMatch(/100% \{ display: none/);
  });
});
