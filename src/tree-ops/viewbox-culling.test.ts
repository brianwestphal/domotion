import { describe, expect, it } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import type { IntraFrameAnimation } from "../animation/animator.js";
import { cullElementsOutsideViewBox, decideCull } from "./viewbox-culling.js";

// Helper to construct a CapturedElement with sensible defaults.
function el(opts: Partial<CapturedElement> & { x: number; y: number; width: number; height: number }): CapturedElement {
  return {
    tag: "div",
    text: "",
    // These unit rows model a renderer-emitted painted rectangle. Individual
    // geometry-boundary tests override this for transparent/unknown owners.
    styles: { backgroundColor: "rgb(0, 0, 0)" } as CapturedElement["styles"],
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

// Scale-aware culling: `decideCull` maps the child bbox through the full
// translate+scale affine composed about the animation's transform-origin,
// instead of parsing only the translate component. Regression context: a
// `translate(-250px, 190px) scale(0.12)` glide had children judged at their
// UNSCALED positions offset by the translate only — elements the scale pulled
// INTO the viewBox were culled as off-viewBox (over-hide: invisible during
// their own frame), and scale-only glides parsed to {tx:0, ty:0} and forfeited
// culling entirely.
describe("decideCull — translate+scale affine", () => {
  const anim = (overrides: Partial<IntraFrameAnimation>): IntraFrameAnimation => ({
    animId: "a", property: "transform", from: "none", to: "none",
    duration: 1000, ...overrides,
  });
  const win = { animStartPct: 25, animEndPct: 50 };

  describe("scale-only glide with directional transform-origin", () => {
    // The window shrinks toward its bottom-right corner: scale(1) → scale(0.12)
    // about origin 100% 100% of the animated element (0,0,800,600) → origin
    // point (800, 600) in shared coords.
    const shrink = {
      ...win,
      anim: anim({ from: "scale(1)", to: "scale(0.12)", transformOrigin: "100% 100%" }),
      transformReferenceBox: { x: 0, y: 0, w: 800, h: 600 },
    };

    it("child that REMAINS inside the viewBox under the scaled composition: no hidden window", () => {
      // Child (0,0,200,200). At `to`: x' = 800 + 0.12·(x−800) → [704, 728],
      // y' = 600 + 0.12·(y−600) → [528, 552] — still inside 800×600. The old
      // translate-only parse saw {tx:0, ty:0} too, but the point is the affine
      // must NOT push it out: no over-hide.
      const d = decideCull({ x: 0, y: 0, w: 200, h: 200 }, VW, VH, shrink);
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBeUndefined();
      expect(d.visEndPct).toBeUndefined();
    });

    it("off-viewBox child that the shrink pulls INTO the viewBox: enter window (not alwaysHidden)", () => {
      // Child (-600,-400,100,100): static x+w = −500 < 0 → off-left at `from`.
      // At `to`: x' = 800 + 0.12·(−600−800) = 632 → [632, 644];
      // y' = 600 + 0.12·(−400−600) = 480 → [480, 492] — inside. Hiding this
      // child for the whole cycle (the old over-hide) would blank it during
      // its own frame.
      const d = decideCull({ x: -600, y: -400, w: 100, h: 100 }, VW, VH, shrink);
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(25);   // hidden before the glide starts
      expect(d.visEndPct).toBe(100);    // visible through end of cycle
    });

    it("zoom-in glide pushes a child out: exit window (the cull the old parser forfeited)", () => {
      // scale(1) → scale(3) about left top of (0,0,800,600) → origin (0,0).
      // Child (400,300,100,100): at `to` x' = 3x → [1200,1500], y' → [900,1200]
      // — fully off. Old parse: scale → {tx:0, ty:0} → "never moves" → no
      // window at all (culling forfeited). Now: visible [0%, animEnd].
      const d = decideCull({ x: 400, y: 300, w: 100, h: 100 }, VW, VH, {
        ...win,
        anim: anim({ from: "scale(1)", to: "scale(3)", transformOrigin: "left top" }),
        transformReferenceBox: { x: 0, y: 0, w: 800, h: 600 },
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(0);
      expect(d.visEndPct).toBe(50);
    });

    it("same zoom-in via the standalone `scale` property", () => {
      const d = decideCull({ x: 400, y: 300, w: 100, h: 100 }, VW, VH, {
        ...win,
        anim: anim({ property: "scale", from: "1", to: "3", transformOrigin: "left top" }),
        transformReferenceBox: { x: 0, y: 0, w: 800, h: 600 },
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(0);
      expect(d.visEndPct).toBe(50);
    });

    it("child that stays off-viewBox through the whole shrink: alwaysHidden (culling win)", () => {
      // Child (0, 2000, 100, 100) under the bottom-right shrink: y' interpolates
      // from 2000 down to 600 + 0.12·(2000−600) = 768 — never < 600, and every
      // sample in between is ≥ 768. Off-viewBox the whole cycle.
      const d = decideCull({ x: 0, y: 2000, w: 100, h: 100 }, VW, VH, shrink);
      expect(d.alwaysHidden).toBe(true);
    });
  });

  describe("translate+scale composed (the real-world glide shape)", () => {
    // The observed failure: `transform: none → translate(-250px, 190px)
    // scale(0.12)`, no transformOrigin → SVG default origin (0,0) (Blink UA
    // stylesheet svg.css: `transform-origin: 0 0` for SVG elements without a
    // CSS layout box). Mapping at `to`: p' = 0.12·p + (−250, 190).
    const glide = {
      ...win,
      anim: anim({ from: "translate(0px, 0px) scale(1)", to: "translate(-250px, 190px) scale(0.12)" }),
    };

    it("visible child that the glide carries off-viewBox: exit window with exact geometry", () => {
      // Child (100,100,100,100): at `to` x' = 0.12·100 − 250 = −238 →
      // [−238, −226] — off-left (x+w < 0); y' = [202, 214] in. From is
      // identity → visible. Expect visible [0%, animEnd].
      const d = decideCull({ x: 100, y: 100, w: 100, h: 100 }, VW, VH, glide);
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(0);
      expect(d.visEndPct).toBe(50);
    });

    it("off-viewBox child that the scale pulls INTO the viewBox: enter window (the over-hide bug)", () => {
      // Child (2200,100,100,100): static x = 2200 — far off-right. At `to`:
      // x' = 0.12·2200 − 250 = 14 → [14, 26] inside; y' = [202, 214] inside.
      // The old translate-only parse tested x = 2200 − 250 = 1950 → still off →
      // alwaysHidden → the element vanished during its own frame. Now: enter
      // window [animStart, 100%].
      const d = decideCull({ x: 2200, y: 100, w: 100, h: 100 }, VW, VH, glide);
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(25);
      expect(d.visEndPct).toBe(100);
    });
  });

  describe("continuous function-first sweep regressions (DM-2461)", () => {
    it("keeps a negative-scale list that enters between its offscreen endpoints", () => {
      const d = decideCull({ x: 0, y: 10, w: 20, h: 20 }, 50, VH, {
        ...win,
        anim: anim({
          from: "scale(-1) translateX(-100px)",
          to: "scale(1) translateX(100px)",
        }),
      });
      // Function-first interpolation reaches x=-1..1 near p=.45. Blending
      // already-composed endpoint affine components leaves x=98..100 instead.
      expect(d).toEqual({ alwaysHidden: false, visStartPct: 25, visEndPct: 50 });
    });

    it("keeps a 50.5% crossing narrower than the retired two-percent grid", () => {
      const d = decideCull({ x: 0, y: 10, w: 10, h: 10 }, 50, VH, {
        ...win,
        anim: anim({ property: "translateX", from: "-101000px", to: "99000px" }),
      });
      expect(d).toEqual({ alwaysHidden: false, visStartPct: 25, visEndPct: 50 });
    });
  });

  describe("transform-origin variants", () => {
    it("px origin: lengths offset from the animated element's top-left", () => {
      // Carrier (100,50,400,300), transformOrigin "40px 30px" → origin
      // (140, 80). scale(1) → scale(0.5): child (900,80,100,100) is static
      // off-right (x=900 > 800); at `to` x' = 140 + 0.5·(900−140) = 520 →
      // [520, 570] in; y' = 80 + 0.5·(80−80) = 80 → [80, 130] in. Enter window.
      const d = decideCull({ x: 900, y: 80, w: 100, h: 100 }, VW, VH, {
        ...win,
        anim: anim({ from: "scale(1)", to: "scale(0.5)", transformOrigin: "40px 30px" }),
        transformReferenceBox: { x: 100, y: 50, w: 400, h: 300 },
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(25);
      expect(d.visEndPct).toBe(100);
    });

    it("`center` keyword: origin at the animated element's center", () => {
      // Carrier (200,100,400,400) → center (400,300). scale(1) → scale(0.1):
      // child (200,100,100,100) converges to x' = 400 + 0.1·(200−400) = 380 →
      // [380, 390], y' = [280, 290] — stays inside. No window.
      const d = decideCull({ x: 200, y: 100, w: 100, h: 100 }, VW, VH, {
        ...win,
        anim: anim({ from: "scale(1)", to: "scale(0.1)", transformOrigin: "center" }),
        transformReferenceBox: { x: 200, y: 100, w: 400, h: 400 },
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBeUndefined();
    });

    it("unset transformOrigin: SVG default origin (0,0) of the canvas, NOT the element center", () => {
      // No transformOrigin → the animator emits no transform-box/origin, so
      // the anim wrapper scales about the SVG canvas origin. Child
      // (1000,800,200,200) — static off (x>800, y>600) — maps at `to`
      // (scale 0.5 about (0,0)) to [500,600]×[400,500] — inside. Enter window.
      const d = decideCull({ x: 1000, y: 800, w: 200, h: 200 }, VW, VH, {
        ...win,
        anim: anim({ from: "scale(1)", to: "scale(0.5)" }),
        transformReferenceBox: { x: 0, y: 0, w: 2560, h: 1440 },
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(25);
      expect(d.visEndPct).toBe(100);
    });

    it("scale with a set origin but NO known animated-element box: conservative, never hidden", () => {
      // decideCull can't resolve a percentage origin without the carrier's
      // box — over-hide risk → no window, not hidden, even off-viewBox.
      const d = decideCull({ x: 2000, y: 100, w: 100, h: 100 }, VW, VH, {
        ...win,
        anim: anim({ from: "scale(1)", to: "scale(0.1)", transformOrigin: "50% 50%" }),
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBeUndefined();
    });
  });

  describe("rotation bounds and fail-closed transforms", () => {
    it("rotate: retains the exact active arc between off-viewBox endpoints", () => {
      // Old behavior parsed rotate to {tx:0, ty:0} and applied the static
      // check → alwaysHidden. A rotation can sweep the element into view;
      // retain the full continuously bounded active interval.
      const d = decideCull({ x: 900, y: 100, w: 100, h: 100 }, VW, VH, {
        ...win, anim: anim({ from: "rotate(0deg)", to: "rotate(180deg)" }),
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(25);
      expect(d.visEndPct).toBe(50);
    });

    it("matrix: no window emitted even when endpoints suggest an exit", () => {
      const d = decideCull({ x: 100, y: 100, w: 100, h: 100 }, VW, VH, {
        ...win, anim: anim({ from: "matrix(1, 0, 0, 1, 0, 0)", to: "matrix(0.5, 0.5, -0.5, 0.5, 2000, 0)" }),
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBeUndefined();
      expect(d.visEndPct).toBeUndefined();
    });

    it("percentage translate: conservative (can't statically resolve)", () => {
      // Old behavior treated `-100%` as 0 → static check → hid an off-viewBox
      // element that the percent translate may move into view.
      const d = decideCull({ x: 900, y: 100, w: 100, h: 100 }, VW, VH, {
        ...win, anim: anim({ from: "translate(0%)", to: "translate(-100%)" }),
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBeUndefined();
    });
  });

  describe("fused transform tracks", () => {
    it("primary non-transform + fused translate: the fused track moves the bbox", () => {
      // Fade+slide fused into one animation: primary `opacity` with a fused
      // translateY that carries the element from off-bottom into view. The
      // captured bbox (100,650,100,100) is off-viewBox (y=650 > 600); ignoring
      // the fused track would alwaysHidden it (over-hide).
      const d = decideCull({ x: 100, y: 650, w: 100, h: 100 }, VW, VH, {
        ...win,
        anim: anim({
          property: "opacity", from: "0", to: "1",
          fuse: [{ property: "translateY", from: "0px", to: "-200px" }],
        }),
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(25);   // off at `from` (y 650) → hidden before
      expect(d.visEndPct).toBe(100);    // at `to` y' = 450 → visible after
    });

    it("fused transform track with its own timing: sweeps its own global window", () => {
      // Primary duration is 1000 ms = 25 scene points. The fused translate has
      // its own 500 ms = 12.5-point active interval, then fills at `to`.
      const d = decideCull({ x: 100, y: 100, w: 100, h: 100 }, VW, VH, {
        ...win,
        anim: anim({
          property: "opacity", from: "1", to: "0",
          fuse: [{ property: "translateY", from: "0px", to: "1000px", duration: 500 }],
        }),
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(0);
      expect(d.visEndPct).toBe(37.5);
    });
  });

  describe("repeating animations", () => {
    it("looping translate that exits the viewBox: no window (the loop runs the whole frame)", () => {
      // With `repeat`, the element does not rest at `to` after animEnd — it
      // loops. Emitting the exit window would blank it mid-loop.
      const d = decideCull({ x: 100, y: 100, w: 100, h: 100 }, VW, VH, {
        ...win,
        anim: anim({ property: "translateY", from: "0px", to: "1000px", repeat: "infinite", alternate: true }),
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBeUndefined();
      expect(d.visEndPct).toBeUndefined();
    });

    it("looping animation whose path never touches the viewBox: still alwaysHidden", () => {
      // The loop only covers positions between `from` and `to` — if none of
      // them intersect, hiding for the whole cycle is safe.
      const d = decideCull({ x: 100, y: 700, w: 100, h: 100 }, VW, VH, {
        ...win,
        anim: anim({ property: "translateY", from: "0px", to: "10px", repeat: "infinite" }),
      });
      expect(d.alwaysHidden).toBe(true);
    });
  });

  describe("pure-translate regression through the affine parser", () => {
    it("transform list `translateX(…) translateY(…)` composes to the same window as before", () => {
      const d = decideCull({ x: 100, y: 100, w: 100, h: 100 }, VW, VH, {
        ...win, anim: anim({ from: "translateX(0px) translateY(-1000px)", to: "translateX(0px) translateY(0px)" }),
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(25);
      expect(d.visEndPct).toBe(100);
    });

    it("`none` endpoint with a translate endpoint still parses (identity affine)", () => {
      const d = decideCull({ x: 100, y: 100, w: 100, h: 100 }, VW, VH, {
        ...win, anim: anim({ from: "none", to: "translate(0px, 1000px)" }),
      });
      expect(d.alwaysHidden).toBe(false);
      expect(d.visStartPct).toBe(0);
      expect(d.visEndPct).toBe(50);
    });
  });
});

describe("cullElementsOutsideViewBox — transform-origin threading through the tree walk", () => {
  it("resolves a percentage origin against generated descendant geometry, not the transparent carrier", () => {
    // The HTML carrier is 400×200 but paints nothing. Its generated SVG
    // animation group contains only the 20×20 child at x=300,y=100, so Blink's
    // fill-box is 300..320 × 100..120 and `100% 100%` is (320,120). At scale
    // .5 the child remains x=310..320. The retired carrier proxy used origin
    // (400,200) and incorrectly moved it to x=350..360 (outside width 330).
    const anim: IntraFrameAnimation = {
      animId: "glide", property: "transform",
      from: "scale(1)", to: "scale(0.5)",
      transformOrigin: "100% 100%",
      duration: 1000, easing: "linear",
    };
    const tree: CapturedElement = el({
      x: 0, y: 0, width: 400, height: 200, tag: "div", animId: "glide",
      styles: { backgroundColor: "rgba(0, 0, 0, 0)" } as CapturedElement["styles"],
      children: [
        el({ x: 300, y: 100, width: 20, height: 20, tag: "div" }),
      ],
    });
    // frameStart 1000, totalDur 4000 → animStart 25%, animEnd 50%.
    const { css } = cullElementsOutsideViewBox(tree, 330, 200, [anim], 1000, 4000);
    expect(tree.children![0].displayNone).toBeFalsy();
    expect(tree.children![0].cullClass).toBeUndefined();
    expect(tree.cullClass).toBeUndefined();
    expect(css).toBe("");
  });

  it("selects fill-box, stroke-box, and view-box independently", () => {
    const animation = (
      animId: string,
      transformBox: IntraFrameAnimation["transformBox"],
      from: string,
      to: string,
      transformOrigin: string,
    ): IntraFrameAnimation => ({
      animId,
      property: "transform",
      from,
      to,
      transformOrigin,
      transformBox,
      duration: 1000,
      easing: "linear",
    });

    // At width 250, this outlined surface is x=350..470. Its generated
    // fill-box starts at x=375 (the outline centerline) while stroke-box
    // starts at x=350 (outer stroke ink). Reflecting about fill-left stays
    // offscreen (x=280..400); stroke-left reaches x=230 and must be retained.
    const outlined = (animId: string): CapturedElement => el({
      x: 400,
      y: 100,
      width: 20,
      height: 20,
      animId,
      styles: {
        backgroundColor: "rgb(0, 0, 0)",
        outlineStyle: "solid",
        outlineWidth: "50px",
        outlineOffset: "0px",
        outlineColor: "rgb(0, 0, 0)",
      } as CapturedElement["styles"],
    });
    const fill = outlined("fill");
    const stroke = outlined("stroke");
    cullElementsOutsideViewBox(fill, 250, 220, [
      animation("fill", "fill-box", "scaleX(1)", "scaleX(-1)", "left top"),
    ], 0, 1000);
    cullElementsOutsideViewBox(stroke, 250, 220, [
      animation("stroke", "stroke-box", "scaleX(1)", "scaleX(-1)", "left top"),
    ], 0, 1000);
    expect(fill.displayNone).toBe(true);
    expect(stroke.displayNone).toBeFalsy();

    // A plain generated rect at x=340 is off a 330-wide viewport. Scale .5
    // around fill-left (x=340) cannot move it; view-left is the viewport x=0
    // and moves it to x=170, so view-box must retain it.
    const fillPlain = el({ x: 340, y: 40, width: 20, height: 20, animId: "fill-plain" });
    const viewPlain = el({ x: 340, y: 40, width: 20, height: 20, animId: "view-plain" });
    cullElementsOutsideViewBox(fillPlain, 330, 200, [
      animation("fill-plain", "fill-box", "scale(1)", "scale(.5)", "left top"),
    ], 0, 1000);
    cullElementsOutsideViewBox(viewPlain, 330, 200, [
      animation("view-plain", "view-box", "scale(1)", "scale(.5)", "left top"),
    ], 0, 1000);
    expect(fillPlain.displayNone).toBe(true);
    expect(viewPlain.displayNone).toBeFalsy();
  });

  it("resolves keyword, percentage, and px origins inside the selected box", () => {
    const run = (animId: string, transformOrigin: string): CapturedElement => {
      const target = el({ x: 340, y: 40, width: 20, height: 20, animId });
      cullElementsOutsideViewBox(target, 330, 200, [{
        animId,
        property: "transform",
        from: "scale(1)",
        to: "scale(.5)",
        transformOrigin,
        transformBox: "fill-box",
        duration: 1000,
        easing: "linear",
      }], 0, 1000);
      return target;
    };
    expect(run("keyword", "left top").displayNone).toBe(true);
    expect(run("percentage", "0% 0%").displayNone).toBe(true);
    // Fill-left minus 100px is x=240; scale(.5) moves the rect to x=290.
    expect(run("length", "-100px 0px").displayNone).toBeFalsy();
  });

  it("does not cull a descendant that defines an animated ancestor's fill box", () => {
    const subject = el({ x: 300, y: 40, width: 20, height: 20 });
    const offscreenExtent = el({ x: 900, y: 40, width: 20, height: 20 });
    const owner = el({
      x: 0,
      y: 0,
      width: 1000,
      height: 200,
      animId: "scale-owner",
      styles: { backgroundColor: "rgba(0, 0, 0, 0)" } as CapturedElement["styles"],
      children: [subject, offscreenExtent],
    });
    cullElementsOutsideViewBox(owner, 330, 200, [{
      animId: "scale-owner",
      property: "scale",
      from: "1",
      to: ".5",
      transformOrigin: "right top",
      transformBox: "fill-box",
      duration: 1000,
      easing: "linear",
    }], 0, 2000);

    // Removing x=900..920 would move fill-right from 920 to 320. The subject
    // would then paint at 310..320 after the animation even though the culler
    // had modelled it at 610..620. Keep the contributor in the generated box.
    expect(offscreenExtent.displayNone).toBeUndefined();
    expect(offscreenExtent.cullClass).toBeUndefined();

    const viewSubject = el({ x: 300, y: 80, width: 20, height: 20 });
    const viewOffscreen = el({ x: 900, y: 80, width: 20, height: 20 });
    const viewOwner = el({
      x: 0,
      y: 0,
      width: 1000,
      height: 200,
      animId: "view-owner",
      styles: { backgroundColor: "rgba(0, 0, 0, 0)" } as CapturedElement["styles"],
      children: [viewSubject, viewOffscreen],
    });
    cullElementsOutsideViewBox(viewOwner, 330, 200, [{
      animId: "view-owner",
      property: "scale",
      from: "1",
      to: ".5",
      transformOrigin: "right top",
      transformBox: "view-box",
      duration: 1000,
      easing: "linear",
    }], 0, 2000);
    // The viewport reference is invariant under descendant suppression, so
    // this negative control keeps the independent child-cull optimization.
    expect(viewOffscreen.displayNone).toBe(true);
  });
});

describe("cullElementsOutsideViewBox — renderer-owned visual surface", () => {
  it("maps frozen rotations that enter and leave before the static decision", () => {
    const entering = el({
      x: 900,
      y: 100,
      width: 100,
      height: 100,
      styles: {
        backgroundColor: "red",
        transform: "matrix(-1, 0, 0, -1, 0, 0)",
        transformOrigin: "-400px 0px",
      } as CapturedElement["styles"],
    });
    const leaving = el({
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      styles: {
        backgroundColor: "red",
        transform: "matrix(0, 1, -1, 0, 0, 0)",
        transformOrigin: "-100px -100px",
      } as CapturedElement["styles"],
    });
    cullElementsOutsideViewBox([entering, leaving], VW, VH, undefined, 0, 1000);
    expect(entering.displayNone).toBeFalsy();
    expect(leaving.displayNone).toBe(true);
  });

  it("retains visual overflow that reaches the viewport but culls clipped overflow", () => {
    const outlined = el({
      x: 810,
      y: 20,
      width: 20,
      height: 20,
      styles: {
        backgroundColor: "red",
        outlineStyle: "solid",
        outlineWidth: "15px",
        outlineOffset: "0px",
        outlineColor: "black",
      } as CapturedElement["styles"],
    });
    const clippedChild = el({ x: 790, y: 80, width: 30, height: 20 });
    const clipped = el({
      x: 810,
      y: 70,
      width: 50,
      height: 50,
      styles: {
        backgroundColor: "rgba(0, 0, 0, 0)",
        overflowX: "hidden",
        overflowY: "hidden",
      } as CapturedElement["styles"],
      children: [clippedChild],
    });
    cullElementsOutsideViewBox([outlined, clipped], VW, VH, undefined, 0, 1000);
    expect(outlined.displayNone).toBeFalsy();
    expect(clipped.displayNone).toBe(true);
    expect(clippedChild.displayNone).toBe(true);
  });

  it("uses an exact replaced raster surface instead of its HTML carrier", () => {
    const visibleRaster = el({
      x: 900, y: 20, width: 300, height: 150,
      styles: { backgroundColor: "rgba(0, 0, 0, 0)" } as CapturedElement["styles"],
      replacedSnapshot: {
        x: 780, y: 20, width: 40, height: 30,
        rid: "visible",
        dataUri: "data:image/png;base64,AA==",
      },
    });
    const hiddenRaster = el({
      x: 20, y: 20, width: 30, height: 30,
      styles: { backgroundColor: "rgba(0, 0, 0, 0)" } as CapturedElement["styles"],
      replacedSnapshot: {
        x: 900, y: 20, width: 40, height: 30,
        rid: "hidden",
        dataUri: "data:image/png;base64,AA==",
      },
    });
    cullElementsOutsideViewBox([visibleRaster, hiddenRaster], VW, VH, undefined, 0, 1000);
    expect(visibleRaster.displayNone).toBeFalsy();
    expect(hiddenRaster.displayNone).toBe(true);
  });

  it("does not let clone-suppressed descendants veto an atomic raster cull", () => {
    const suppressedChild = el({ x: 20, y: 20, width: 40, height: 30 });
    const owner = el({
      x: 20,
      y: 20,
      width: 40,
      height: 30,
      transformSubtreeRaster: {
        x: 900,
        y: 20,
        width: 40,
        height: 30,
        dataUri: "data:image/png;base64,AA==",
      },
      children: [suppressedChild],
    });
    cullElementsOutsideViewBox(owner, VW, VH, undefined, 0, 1000);
    expect(owner.displayNone).toBe(true);
    // The renderer never visits this clone child; the culler likewise leaves
    // it out of the atomic owner's visibility hull.
    expect(suppressedChild.displayNone).toBeUndefined();
  });

  it("never culls unknown, empty, singular, or split-raster facts", () => {
    const unknownText = el({ x: 900, y: 20, width: 30, height: 20, text: "ink" });
    const empty = el({
      x: 900, y: 50, width: 30, height: 20,
      styles: { backgroundColor: "rgba(0, 0, 0, 0)" } as CapturedElement["styles"],
    });
    const singular = el({
      x: 900, y: 80, width: 30, height: 20,
      styles: {
        backgroundColor: "red",
        transform: "matrix(0, 0, 0, 1, 0, 0)",
      } as CapturedElement["styles"],
    });
    const backdrop = el({
      x: 900, y: 110, width: 30, height: 20,
      backdropFilterRaster: {
        x: 900, y: 110, width: 30, height: 20,
        dataUri: "data:image/png;base64,AA==",
      },
    });
    cullElementsOutsideViewBox([unknownText, empty, singular, backdrop], VW, VH, undefined, 0, 1000);
    for (const target of [unknownText, empty, singular, backdrop]) {
      expect(target.displayNone).toBeFalsy();
      expect(target.cullClass).toBeUndefined();
    }
  });

  it("retains a scale path when visual chrome is bounded but its exact reference box is unknown", () => {
    const control = el({
      tag: "input",
      x: 900,
      y: 20,
      width: 100,
      height: 40,
      animId: "control",
      styles: { backgroundColor: "rgba(0, 0, 0, 0)" } as CapturedElement["styles"],
    });
    cullElementsOutsideViewBox(control, VW, VH, [{
      animId: "control",
      property: "scale",
      from: "1",
      to: "1",
      duration: 1000,
      transformOrigin: "center",
    }], 0, 1000);
    expect(control.displayNone).toBeFalsy();
    expect(control.cullClass).toBeUndefined();
  });
});

describe("cullElementsOutsideViewBox — tree walk", () => {
  it("hides off-viewBox static elements and recurses into in-viewBox parents", () => {
    const tree: CapturedElement = el({
      x: 0, y: 0, width: 800, height: 600, tag: "body",
      children: [
        el({ x: 100, y: 100, width: 100, height: 100, tag: "div" }),         // visible
        el({ x: 100, y: 700, width: 100, height: 100, tag: "div" }),         // below viewBox
        el({ x: 1000, y: 100, width: 100, height: 100, tag: "div" }),        // right of viewBox
      ],
    });
    const { css } = cullElementsOutsideViewBox(tree, VW, VH, undefined, 0, 1000);
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
    // same visible window so they should share a single cull class.
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
    const { css } = cullElementsOutsideViewBox(tree, VW, VH, [anim], 0, 2000);
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
    // Window-derived class name (visible [0%, 50%]): deterministic scene-wide.
    expect(tree.children![0].cullClass).toBe("cull-0_000-50_000");
    expect(tree.children![1].cullClass).toBe("cull-0_000-50_000");
    // One coalesced keyframes block, not two.
    expect((css.match(/@keyframes cull-[\w-]+/g) ?? []).length).toBe(1);
    // DM-641: keyframes now toggle visibility instead of display.
    expect(css).toContain("visibility: visible");
    expect(css).toContain("visibility: hidden");
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
    const { css } = cullElementsOutsideViewBox(tree, VW, VH, [anim], 0, 2000);
    expect(tree.children![0].displayNone).toBe(true);
    expect(tree.children![0].cullClass).toBeUndefined();
    expect(css).toBe("");
  });

  it("DM-650: parent bbox outside viewBox, child bbox inside — parent kept, child kept, all visible", () => {
    // Reproduces NYT-mobile-scroll: at scrollY=844 the body element has
    // height: 100vh (height=844) and rect.top=-844, so its bbox sits
    // exactly above the viewport (b.y + b.h = 0). Children are at their
    // own viewport-relative coordinates and ARE in-viewport. Before the
    // fix, the bottom-up walk culled the body and skipped recursion,
    // hiding the whole subtree → seg renders white.
    const tree: CapturedElement = el({
      x: 0, y: -844, width: 390, height: 844, tag: "body",
      children: [
        el({ x: 0, y: 100, width: 390, height: 200, tag: "div", text: "headline" }),
        el({ x: 0, y: 400, width: 390, height: 100, tag: "p", text: "body copy" }),
      ],
    });
    cullElementsOutsideViewBox(tree, 390, 844, undefined, 0, 1000);
    expect(tree.displayNone).toBeFalsy();
    expect(tree.children![0].displayNone).toBeFalsy();
    expect(tree.children![1].displayNone).toBeFalsy();
  });

  it("DM-650: parent bbox outside, every child also outside — parent AND children all hidden", () => {
    // Same shape as above but with children also outside viewBox. Now it
    // IS safe to mark the parent displayNone (and every descendant too).
    const tree: CapturedElement = el({
      x: 0, y: -844, width: 390, height: 844, tag: "body",
      children: [
        el({ x: 0, y: -800, width: 390, height: 100, tag: "div" }),     // above viewBox
        el({ x: 0, y: -700, width: 390, height: 200, tag: "p" }),       // above viewBox
      ],
    });
    cullElementsOutsideViewBox(tree, 390, 844, undefined, 0, 1000);
    expect(tree.displayNone).toBe(true);
    expect(tree.children![0].displayNone).toBe(true);
    expect(tree.children![1].displayNone).toBe(true);
  });

  it("composes a child's own clock with every animated ancestor", () => {
    // DM-2386 discriminator. At global 700 ms the outer wrapper contributes
    // +280 and the completed inner wrapper contributes -400, so the child at
    // x=200 paints at x=80..100. Nearest-animation replacement emitted a
    // 40..60% window and hid that valid 70% state.
    const parentAnim: IntraFrameAnimation = {
      animId: "outer", property: "translateX", from: "0px", to: "400px",
      duration: 1000, easing: "linear",
    };
    const childAnim: IntraFrameAnimation = {
      animId: "inner", property: "translateX", from: "0px", to: "-400px",
      duration: 200, easing: "linear", delay: 400,
    };
    const tree: CapturedElement = el({
      x: 200, y: 0, width: 20, height: 20, tag: "div", animId: "outer",
      children: [
        el({ x: 200, y: 10, width: 20, height: 20, tag: "div", animId: "inner" }),
      ],
    });
    const { css } = cullElementsOutsideViewBox(tree, 100, VH, [parentAnim, childAnim], 0, 1000);
    expect(tree.children![0].displayNone).toBeFalsy();
    expect(tree.children![0].cullClass).toBe("cull-40_000-100_000");
    // The ancestor's own bbox never enters, but its visibility governs the
    // subtree; it must inherit the child's broader safe hull rather than hide
    // the valid 70% child state.
    expect(tree.cullClass).toBe("cull-40_000-100_000");
    expect(css).toContain(`@keyframes ${tree.children![0].cullClass}`);
    expect(css).not.toContain("60.001% { visibility: hidden; }");
  });
});

// Regression: `cull-*` class names collided across frames. Class names used to
// come from a per-CALL counter (`cull-0`, `cull-1`, …) while every frame's
// keyframes CSS is concatenated into ONE scene-wide <style> — so the LAST
// frame's `@keyframes cull-0` won for every `class="cull-0"` carrier in every
// frame (observed on a 37-frame scene: frame 10's exit-window text runs were
// hidden during their own frame by frame 36's enter-type `cull-0`). Class names
// are now derived from the visibility window itself, so distinct windows can
// never collide and identical windows share one class + byte-identical block.
describe("cullElementsOutsideViewBox — multi-frame scene composition", () => {
  const TOTAL = 4000; // 4-frame scene, 1000 ms per frame

  // Frame A shape: element visible at `from`, animated out of the viewBox
  // during frame A → exit window [0%, animEnd].
  const exitTree = () => el({
    x: 100, y: 100, width: 100, height: 100, tag: "div", animId: "out",
  });
  const exitAnim: IntraFrameAnimation = {
    animId: "out", property: "translateY", from: "0px", to: "1000px",
    duration: 1000, easing: "linear",
  };

  // Frame B shape: element off-viewBox at `from`, animated into the viewBox
  // during frame B → enter window [animStart, 100%].
  const enterTree = () => el({
    x: 100, y: 100, width: 100, height: 100, tag: "div", animId: "in",
  });
  const enterAnim: IntraFrameAnimation = {
    animId: "in", property: "translateY", from: "-1000px", to: "0px",
    duration: 1000, easing: "linear",
  };

  it("frames with different windows get distinct class names and non-conflicting keyframes", () => {
    // Frame A at scene start (exit window: visible [0%, 25%])…
    const treeA = exitTree();
    const { css: cssA } = cullElementsOutsideViewBox(treeA, VW, VH, [exitAnim], 0, TOTAL);
    // …frame B at scene end (enter window: visible [75%, 100%]).
    const treeB = enterTree();
    const { css: cssB } = cullElementsOutsideViewBox(treeB, VW, VH, [enterAnim], 3000, TOTAL);

    expect(treeA.cullClass).toBeDefined();
    expect(treeB.cullClass).toBeDefined();
    // Different windows → different class names (this was the collision).
    expect(treeA.cullClass).not.toBe(treeB.cullClass);

    // The animator concatenates per-frame CSS into one <style>. No class name
    // may appear in two @keyframes blocks with different bodies.
    const sceneCss = [cssA, cssB].join("\n");
    const blocks = [...sceneCss.matchAll(/@keyframes (cull-[\w-]+) \{([^}]*(?:\}[^}]*)*?)\n\s*\}/g)];
    const bodiesByName = new Map<string, Set<string>>();
    for (const [, name, body] of blocks) {
      if (!bodiesByName.has(name)) bodiesByName.set(name, new Set());
      bodiesByName.get(name)!.add(body);
    }
    for (const [name, bodies] of bodiesByName) {
      expect(bodies.size, `@keyframes ${name} has conflicting bodies`).toBe(1);
    }

    // Frame A's carriers keep frame A's window semantics in the composed CSS:
    // its (single) keyframes block turns visible at 0% and hidden after 25%.
    const aBlock = sceneCss.match(new RegExp(`@keyframes ${treeA.cullClass} \\{[\\s\\S]*?\\n\\s*\\}`))![0];
    expect(sceneCss.match(new RegExp(`@keyframes ${treeA.cullClass} `, "g"))!.length).toBe(1);
    expect(aBlock).toContain("0.000% { visibility: visible; }");
    expect(aBlock).toContain("25.000% { visibility: visible; }");
    expect(aBlock).toContain("25.001% { visibility: hidden; }");
    // Frame B's block turns visible only at 75%.
    const bBlock = sceneCss.match(new RegExp(`@keyframes ${treeB.cullClass} \\{[\\s\\S]*?\\n\\s*\\}`))![0];
    expect(bBlock).toContain("75.000% { visibility: visible; }");
    expect(bBlock).toContain("74.999% { visibility: hidden; }");
  });

  it("frames with identical windows share one class name and byte-identical keyframes", () => {
    // Two frames whose elements resolve to the SAME window (both frame-0
    // exits with identical geometry/timing) — e.g. a scene that revisits a
    // layout. Their classes coincide and the blocks are byte-identical, so
    // scene-wide last-wins concatenation is a no-op (and the animator can
    // dedupe by name).
    const treeA = exitTree();
    const { css: cssA } = cullElementsOutsideViewBox(treeA, VW, VH, [exitAnim], 0, TOTAL);
    const treeC = exitTree();
    const { css: cssC } = cullElementsOutsideViewBox(treeC, VW, VH, [exitAnim], 0, TOTAL);
    expect(treeC.cullClass).toBe(treeA.cullClass);
    expect(cssC).toBe(cssA);
  });
});

describe("cullElementsOutsideViewBox — keyframes structure", () => {
  it("keyframes use step-end timing and var(--scene-dur)", () => {
    const anim: IntraFrameAnimation = {
      animId: "a", property: "translateY", from: "-1000px", to: "0px",
      duration: 500, easing: "linear", delay: 300,   // hold at off-screen `from` for 300 ms
    };
    const tree: CapturedElement = el({
      x: 100, y: 100, width: 100, height: 100, tag: "div", animId: "a",
    });
    const { css } = cullElementsOutsideViewBox(tree, VW, VH, [anim], 0, 1000);
    // DM-1454: step-end lives INSIDE the `animation:` shorthand (not a separate
    // `animation-timing-function` declaration, which SVGO/csso could reorder
    // after the shorthand and reset to `ease`).
    expect(css).toMatch(/animation:[^;}]*step-end/);
    expect(css).not.toContain("animation-timing-function: step-end");
    expect(css).toContain("var(--scene-dur)");
    // 0% / 100% bookends with visibility:hidden (DM-641 — was display:none).
    expect(css).toMatch(/0% \{ visibility: hidden/);
    expect(css).toMatch(/100% \{ visibility: hidden/);
  });
});
