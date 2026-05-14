/**
 * Element-level viewBox culling (DM-603, Phase 2 of DM-599).
 *
 * Walks a captured-element tree and emits `display: none` for elements whose
 * bbox never intersects the viewBox at any time during the scene cycle. For
 * elements whose `from`/`to` straddle the boundary (intra-frame `translate*`
 * animations), follows the DM-599 feedback rule: hide only BEFORE the
 * animation starts (if `from` is off-viewBox) or AFTER it ends (if `to` is
 * off-viewBox), never DURING.
 *
 * Non-linear easings are handled by N=50-sample probing: take the bounding
 * interval over which the bbox intersects viewBox. Slight under-hide (we hide
 * less than we strictly could) is visually correct; we never over-hide,
 * because the bounding interval covers every sample that intersects.
 *
 * See `docs/33-element-out-of-viewbox-hiding.md`.
 */

import type { CapturedElement } from "../capture/types.js";
import type { IntraFrameAnimation } from "../animation/animator.js";

interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function bboxIntersectsViewport(b: Bbox, vw: number, vh: number): boolean {
  return b.x < vw && b.x + b.w > 0 && b.y < vh && b.y + b.h > 0;
}

/**
 * Parse a length value in pixels. Accepts `<n>`, `<n>px`, or `0`. Returns 0
 * for any other unit (percentage, vh/vw, etc.) — those don't move pixels in
 * a way we can statically resolve, so we conservatively treat them as
 * non-translating (the element appears visible everywhere, no hide).
 */
function parsePixelValue(v: string): number {
  const m = /^(-?\d+(?:\.\d+)?)\s*(px)?$/i.exec(v.trim());
  if (m == null) return 0;
  return Number(m[1]);
}

/**
 * Extract a 2-tuple of (tx, ty) in pixels for the given animation property
 * and value. Returns null when the property doesn't translate (e.g. `width`,
 * `opacity`, `clipPath`) — those leave the element's bbox in place, so the
 * culler can ignore them for visibility purposes.
 */
function translateFromAnimValue(prop: IntraFrameAnimation["property"], value: string): { tx: number; ty: number } | null {
  if (prop === "translateX") return { tx: parsePixelValue(value), ty: 0 };
  if (prop === "translateY") return { tx: 0, ty: parsePixelValue(value) };
  if (prop === "transform") {
    // Accept `translateX(<n>px)`, `translateY(<n>px)`, `translate(<x>, <y>)`,
    // `translate(<x>)` (y=0), or `none`/empty (no translate). We only
    // recognise pure translate functions — `scale`, `rotate`, etc. don't
    // produce a static x/y offset, so we treat them as non-translating.
    const s = value.trim();
    if (s === "" || s === "none") return { tx: 0, ty: 0 };
    let tx = 0, ty = 0;
    const mx = /translateX\(\s*(-?\d+(?:\.\d+)?)\s*px?\s*\)/i.exec(s);
    if (mx != null) tx += Number(mx[1]);
    const my = /translateY\(\s*(-?\d+(?:\.\d+)?)\s*px?\s*\)/i.exec(s);
    if (my != null) ty += Number(my[1]);
    const mxy = /translate\(\s*(-?\d+(?:\.\d+)?)\s*px?\s*(?:,\s*(-?\d+(?:\.\d+)?)\s*px?\s*)?\)/i.exec(s);
    if (mxy != null) {
      tx += Number(mxy[1]);
      ty += mxy[2] != null ? Number(mxy[2]) : 0;
    }
    return { tx, ty };
  }
  // `width`, `height`, `opacity`, `clipPath` — don't move the bbox.
  return null;
}

/**
 * Evaluate the named CSS easing at `t ∈ [0, 1]`. Recognised: `linear` (the
 * default if `easing` is undefined or unparseable), `ease`, `ease-in`,
 * `ease-out`, `ease-in-out`, `step-start`, `step-end`, `cubic-bezier(...)`.
 * Anything else falls back to linear — over-show (visible-but-shouldn't-be)
 * is the conservative direction since the alternative is flicker.
 */
function evalEasing(easing: string | undefined, t: number): number {
  if (easing == null || easing === "linear") return t;
  if (easing === "step-start") return t > 0 ? 1 : 0;
  if (easing === "step-end") return t >= 1 ? 1 : 0;
  // Named cubic-bezier curves (W3C CSS Easing Functions L1).
  if (easing === "ease")        return cubicBezier(0.25, 0.1, 0.25, 1.0, t);
  if (easing === "ease-in")     return cubicBezier(0.42, 0.0, 1.0, 1.0, t);
  if (easing === "ease-out")    return cubicBezier(0.0, 0.0, 0.58, 1.0, t);
  if (easing === "ease-in-out") return cubicBezier(0.42, 0.0, 0.58, 1.0, t);
  const cb = /^cubic-bezier\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/i.exec(easing);
  if (cb != null) return cubicBezier(Number(cb[1]), Number(cb[2]), Number(cb[3]), Number(cb[4]), t);
  return t;
}

/** Numerical inverse of x(s) = bezier-x for `cubic-bezier(x1,y1,x2,y2)`. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  // Find the curve parameter s such that bezierX(s) = t, then evaluate
  // bezierY(s). Bisection over s ∈ [0, 1] — 16 iterations is enough for
  // CSS-class precision.
  const bezier = (a: number, b: number, s: number): number => {
    const omt = 1 - s;
    return 3 * omt * omt * s * a + 3 * omt * s * s * b + s * s * s;
  };
  let lo = 0, hi = 1, s = t;
  for (let i = 0; i < 16; i++) {
    s = (lo + hi) / 2;
    const x = bezier(x1, x2, s);
    if (x < t) lo = s;
    else hi = s;
  }
  return bezier(y1, y2, s);
}

/** Number of samples in (0, 1) used to probe the animation interpolation. */
const SAMPLE_COUNT = 50;

interface AnimationFrameContext {
  /** Animation start time as a percent of the whole scene cycle. */
  animStartPct: number;
  /** Animation end time as a percent of the whole scene cycle. */
  animEndPct: number;
  /** The intra-frame animation we're evaluating. */
  anim: IntraFrameAnimation;
}

interface CullDecision {
  /** Always hidden — emit `style="display:none"` on the element. */
  alwaysHidden: boolean;
  /** Window-hide: visible during [visStartPct, visEndPct] only. */
  visStartPct?: number;
  visEndPct?: number;
}

/**
 * Compute the visibility decision for an element under (optional) animation.
 *
 * - No animation: pure static intersection check.
 * - With animation: intersection at `from`, at `to`, and N=50 samples in
 *   between. Per the DM-599 feedback rule, the element is visible during the
 *   animation if ANY sample intersects; pre-animation hide iff `from` is
 *   off-viewBox; post-animation hide iff `to` is off-viewBox.
 */
export function decideCull(
  staticBbox: Bbox,
  vw: number, vh: number,
  ctx: AnimationFrameContext | null,
): CullDecision {
  if (ctx == null) {
    // Pure static.
    return {
      alwaysHidden: !bboxIntersectsViewport(staticBbox, vw, vh),
    };
  }
  const fromT = translateFromAnimValue(ctx.anim.property, ctx.anim.from);
  const toT   = translateFromAnimValue(ctx.anim.property, ctx.anim.to);
  if (fromT == null || toT == null) {
    // Non-translate animation: bbox doesn't move. Treat as static.
    return {
      alwaysHidden: !bboxIntersectsViewport(staticBbox, vw, vh),
    };
  }
  const bboxAt = (tx: number, ty: number): Bbox => ({
    x: staticBbox.x + tx, y: staticBbox.y + ty,
    w: staticBbox.w, h: staticBbox.h,
  });
  const fromVisible = bboxIntersectsViewport(bboxAt(fromT.tx, fromT.ty), vw, vh);
  const toVisible   = bboxIntersectsViewport(bboxAt(toT.tx,   toT.ty),   vw, vh);

  // Sample the animation interpolation. If any sample intersects, the element
  // is visible during the animation (per user's rule we don't hide during
  // animation that crosses the boundary).
  let anyDuringVisible = false;
  for (let i = 1; i < SAMPLE_COUNT; i++) {
    const t = i / SAMPLE_COUNT;
    const p = evalEasing(ctx.anim.easing, t);
    const tx = fromT.tx + p * (toT.tx - fromT.tx);
    const ty = fromT.ty + p * (toT.ty - fromT.ty);
    if (bboxIntersectsViewport(bboxAt(tx, ty), vw, vh)) {
      anyDuringVisible = true;
      break;
    }
  }
  const everVisible = fromVisible || toVisible || anyDuringVisible;
  if (!everVisible) {
    return { alwaysHidden: true };
  }

  // Compute the visible window in scene-percent terms.
  // Visible during [animStartPct, animEndPct] always (per feedback rule).
  // Visible before animation iff `from` is on-viewBox.
  // Visible after animation iff `to` is on-viewBox.
  const visStart = fromVisible ? 0 : ctx.animStartPct;
  const visEnd   = toVisible   ? 100 : ctx.animEndPct;
  if (visStart <= 0 && visEnd >= 100) {
    return { alwaysHidden: false };  // always visible — nothing to emit
  }
  return { alwaysHidden: false, visStartPct: visStart, visEndPct: visEnd };
}

/**
 * Decide a cull for `el` under whichever inherited animation is in effect
 * (the nearest ancestor with `animId` matching one of `animations`, if any).
 * `el.animId` overrides inherited animation.
 */
function decideForElement(
  el: CapturedElement,
  vw: number, vh: number,
  inheritedCtx: AnimationFrameContext | null,
  animsById: Map<string, AnimationFrameContext>,
): { ctx: AnimationFrameContext | null; decision: CullDecision } {
  let ctx = inheritedCtx;
  if (el.animId != null && el.animId !== "" && animsById.has(el.animId)) {
    ctx = animsById.get(el.animId)!;
  }
  const bbox = { x: el.x, y: el.y, w: el.width, h: el.height };
  const decision = decideCull(bbox, vw, vh, ctx);
  return { ctx, decision };
}

/** Round to 3 decimal places for stable class-key coalescing. */
function r3(n: number): string {
  return n.toFixed(3);
}

/**
 * Per-frame culling pass. Walks the captured tree, mutates each element's
 * `displayNone` and `cullClass` fields, and returns the keyframes CSS to
 * append to the scene-wide `<style>` block.
 *
 * `animations` is the frame's intra-frame `animations` array. `frameStartMs`
 * / `totalDurationMs` map an animation's frame-relative `delay`+`duration`
 * onto the global scene cycle.
 */
export function cullFrame(
  tree: CapturedElement | CapturedElement[],
  viewportW: number,
  viewportH: number,
  animations: IntraFrameAnimation[] | undefined,
  frameStartMs: number,
  totalDurationMs: number,
): { css: string } {
  const roots = Array.isArray(tree) ? tree : [tree];
  const animsById = new Map<string, AnimationFrameContext>();
  if (animations != null) {
    for (const a of animations) {
      const delay = a.delay ?? 0;
      const startMs = frameStartMs + delay;
      const endMs = startMs + a.duration;
      animsById.set(a.animId, {
        animStartPct: (startMs / totalDurationMs) * 100,
        animEndPct: (endMs / totalDurationMs) * 100,
        anim: a,
      });
    }
  }

  // Coalesce: elements that resolve to the same (visStartPct, visEndPct)
  // share a class so we emit one keyframes block per unique interval.
  const windowToClass = new Map<string, string>();
  const cssBlocks: string[] = [];

  const walk = (el: CapturedElement, inheritedCtx: AnimationFrameContext | null): void => {
    const { ctx, decision } = decideForElement(el, viewportW, viewportH, inheritedCtx, animsById);
    if (decision.alwaysHidden) {
      el.displayNone = true;
      // Children inherit displayNone implicitly; don't recurse.
      return;
    }
    if (decision.visStartPct != null && decision.visEndPct != null) {
      const key = `${r3(decision.visStartPct)},${r3(decision.visEndPct)}`;
      let className = windowToClass.get(key);
      if (className == null) {
        className = `cull-${windowToClass.size}`;
        windowToClass.set(key, className);
        cssBlocks.push(buildCullKeyframes(className, decision.visStartPct, decision.visEndPct));
      }
      // Merge with any existing cullClass (shouldn't happen — each pass
      // assigns at most one — but be defensive).
      el.cullClass = el.cullClass == null || el.cullClass === "" ? className : `${el.cullClass} ${className}`;
    }
    // Recurse into children with the (possibly newly inherited) animation context.
    if (el.children != null) {
      for (const child of el.children) walk(child, ctx);
    }
  };
  for (const root of roots) walk(root, null);

  return { css: cssBlocks.join("\n") };
}

/**
 * Step-end `@keyframes` block + class rule that toggles `display: inline`
 * during [visStart, visEnd] and `display: none` outside. The 0.001 % gap
 * pattern keeps the discrete snap point inside a sliver-thin keyframe pair
 * regardless of how the animation timing function is configured on the
 * element.
 */
function buildCullKeyframes(name: string, visStartPct: number, visEndPct: number): string {
  const startMinus = Math.max(0, visStartPct - 0.001).toFixed(3);
  const endPlus = Math.min(100, visEndPct + 0.001).toFixed(3);
  return `    @keyframes ${name} {
      0% { display: none; }
      ${startMinus}% { display: none; }
      ${visStartPct.toFixed(3)}% { display: inline; }
      ${visEndPct.toFixed(3)}% { display: inline; }
      ${endPlus}% { display: none; }
      100% { display: none; }
    }
    .${name} { animation: ${name} var(--scene-dur) infinite; animation-timing-function: step-end; }`;
}
