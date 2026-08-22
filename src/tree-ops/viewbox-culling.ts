/**
 * Element-level viewBox culling (DM-603, Phase 2 of DM-599).
 *
 * Walks a captured-element tree and emits `display: none` for elements whose
 * visual bound never intersects the viewBox at any time during the scene
 * cycle. Animated transforms are bounded continuously on the global scene
 * clock: matching functions interpolate before composition, independently
 * timed tracks and nested wrappers compose, and every timing boundary is
 * partitioned. An unsupported or unbounded interval retains paint.
 *
 * See `docs/33-element-out-of-viewbox-hiding.md`.
 */

import type { CapturedElement } from "../capture/types.js";
import type { IntraFrameAnimation } from "../animation/animator.js";
import { KEYFRAME_EPSILON, padAfter, padBefore } from "../utils/keyframe-pad.js";
import {
  conservativeSweptBoxes,
  type SweptAnimationContext,
  type SweptBox,
} from "./swept-transform-bounds.js";

type Bbox = SweptBox;

function bboxIntersectsViewport(b: Bbox, vw: number, vh: number): boolean {
  return b.x < vw && b.x + b.w > 0 && b.y < vh && b.y + b.h > 0;
}

type AnimationFrameContext = SweptAnimationContext;

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
 * - With animations: obtain a conservative swept bound for every partition of
 *   the global scene clock, composing all root-to-leaf wrappers. The visible
 *   window is the hull of partitions whose bound can intersect the viewBox.
 * - With an unmodelable transform/timing interval: always visible, no window.
 *   Over-hide is catastrophic; a missed cull is only a missed optimization.
 */
export function decideCull(
  staticBbox: Bbox,
  vw: number, vh: number,
  ctx: AnimationFrameContext | readonly AnimationFrameContext[] | null,
): CullDecision {
  if (ctx == null) {
    return {
      alwaysHidden: !bboxIntersectsViewport(staticBbox, vw, vh),
    };
  }
  const contexts = Array.isArray(ctx) ? ctx : [ctx];
  const swept = conservativeSweptBoxes(staticBbox, contexts);
  if (swept == null) {
    // Mirrors Chromium's false-return contract: uncertainty keeps paint.
    return { alwaysHidden: false };
  }
  const possiblyVisible = swept.filter((interval) =>
    bboxIntersectsViewport(interval.bounds, vw, vh));
  if (possiblyVisible.length === 0) return { alwaysHidden: true };

  // One visibility class can express only one interval. Use the hull of all
  // possibly-visible partitions; gaps remain visible (safe over-retention).
  const visStart = possiblyVisible[0].startPct;
  const visEnd = possiblyVisible[possiblyVisible.length - 1].endPct;
  if (visStart <= 0 && visEnd >= 100) {
    return { alwaysHidden: false };
  }
  return { alwaysHidden: false, visStartPct: visStart, visEndPct: visEnd };
}

/**
 * Decide a cull for `el` under whichever inherited animation is in effect
 * (every ancestor/element `animId` matching one of `animations`, if any).
 * Nested wrappers compose in the same root-to-leaf order as emitted SVG.
 */
function decideForElement(
  el: CapturedElement,
  vw: number, vh: number,
  inheritedCtx: readonly AnimationFrameContext[],
  animsById: Map<string, AnimationFrameContext>,
): { contexts: AnimationFrameContext[]; decision: CullDecision } {
  const contexts = [...inheritedCtx];
  if (el.animId != null && el.animId !== "" && animsById.has(el.animId)) {
    contexts.push({
      ...animsById.get(el.animId)!,
      animatedBbox: { x: el.x, y: el.y, w: el.width, h: el.height },
    });
  }
  const bbox = { x: el.x, y: el.y, w: el.width, h: el.height };
  const decision = decideCull(bbox, vw, vh, contexts.length === 0 ? null : contexts);
  return { contexts, decision };
}

/** Round to 3 decimal places for stable class-key coalescing. */
function r3(n: number): string {
  return n.toFixed(3);
}

/**
 * Class name for a visibility window, derived from the window values themselves
 * (e.g. `cull-8_419-91_581` for visible during [8.419%, 91.581%]). The name must
 * be a pure function of the window — NOT a per-call counter — because a scene is
 * culled one frame at a time but every frame's keyframes CSS is concatenated
 * into ONE scene-wide `<style>`: counter-based names (`cull-0`, `cull-1`, …)
 * restarted from 0 on every frame, so a later frame's `@keyframes cull-0`
 * clobbered an earlier frame's different window and hid that frame's elements
 * during their own frame. With window-derived names, identical windows share a
 * class (their keyframes blocks are byte-identical, so re-emission is harmless
 * and the animator can dedupe them) and distinct windows can never collide.
 * Percent values are non-negative, so after `.` → `_` this is a valid CSS
 * identifier.
 */
function cullClassName(visStartPct: number, visEndPct: number): string {
  return `cull-${r3(visStartPct).replace(".", "_")}-${r3(visEndPct).replace(".", "_")}`;
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
export function cullElementsOutsideViewBox(
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
        frameStartPct: (frameStartMs / totalDurationMs) * 100,
        anim: a,
      });
    }
  }

  // Coalesce: elements that resolve to the same (visStartPct, visEndPct)
  // share a class so we emit one keyframes block per unique interval.
  const windowToClass = new Map<string, string>();
  const cssBlocks: string[] = [];

  type VisibleHull = { startPct: number; endPct: number };
  const unionHull = (left: VisibleHull | null, right: VisibleHull | null): VisibleHull | null => {
    if (left == null) return right;
    if (right == null) return left;
    return {
      startPct: Math.min(left.startPct, right.startPct),
      endPct: Math.max(left.endPct, right.endPct),
    };
  };
  const decisionHull = (decision: CullDecision): VisibleHull | null => {
    if (decision.alwaysHidden) return null;
    if (decision.visStartPct == null || decision.visEndPct == null) return { startPct: 0, endPct: 100 };
    return { startPct: decision.visStartPct, endPct: decision.visEndPct };
  };
  const attachWindow = (el: CapturedElement, hull: VisibleHull): void => {
    const key = `${r3(hull.startPct)},${r3(hull.endPct)}`;
    let className = windowToClass.get(key);
    if (className == null) {
      className = cullClassName(hull.startPct, hull.endPct);
      windowToClass.set(key, className);
      cssBlocks.push(buildCullKeyframes(className, hull.startPct, hull.endPct));
    }
    el.cullClass = el.cullClass == null || el.cullClass === "" ? className : `${el.cullClass} ${className}`;
  };

  // Walk bottom-up and return the conservative visibility hull of the entire
  // subtree. Both `display:none` and an ancestor `visibility` window affect
  // descendants, including overflow-visible ink, so a parent's own box can
  // never narrow a broader child interval (DM-650 / DM-2461).
  const walk = (
    el: CapturedElement,
    inheritedCtx: readonly AnimationFrameContext[],
  ): VisibleHull | null => {
    const { contexts, decision } = decideForElement(el, viewportW, viewportH, inheritedCtx, animsById);
    let subtreeHull = decisionHull(decision);
    if (el.children != null) {
      for (const child of el.children) {
        subtreeHull = unionHull(subtreeHull, walk(child, contexts));
      }
    }
    if (subtreeHull == null) {
      el.displayNone = true;
      return null;
    }
    if (subtreeHull.startPct > 0 || subtreeHull.endPct < 100) {
      attachWindow(el, subtreeHull);
    }
    return subtreeHull;
  };
  for (const root of roots) walk(root, []);

  return { css: cssBlocks.join("\n") };
}

/**
 * Step-end `@keyframes` block + class rule that toggles `visibility: visible`
 * during [visStart, visEnd] and `visibility: hidden` outside. The 0.001 % gap
 * pattern keeps the discrete snap point inside a sliver-thin keyframe pair
 * regardless of how the animation timing function is configured on the
 * element.
 *
 * DM-641: toggling `display` here breaks the same way `fv-${i}` did — when
 * a culled element starts the cycle at `display: none` the animation engine
 * never starts ticking and the element stays hidden forever. Using
 * `visibility` keeps the element in the render tree (still skips painting)
 * so the animation runs every cycle.
 */
function buildCullKeyframes(name: string, visStartPct: number, visEndPct: number): string {
  const startMinus = padBefore(visStartPct, KEYFRAME_EPSILON.cull, 3);
  const endPlus = padAfter(visEndPct, KEYFRAME_EPSILON.cull, 3);
  return `    @keyframes ${name} {
      0% { visibility: hidden; }
      ${startMinus}% { visibility: hidden; }
      ${visStartPct.toFixed(3)}% { visibility: visible; }
      ${visEndPct.toFixed(3)}% { visibility: visible; }
      ${endPlus}% { visibility: hidden; }
      100% { visibility: hidden; }
    }
    .${name} { animation: ${name} var(--scene-dur) step-end infinite; }`;
}
