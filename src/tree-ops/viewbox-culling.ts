/**
 * Element-level viewBox culling (DM-603, Phase 2 of DM-599).
 *
 * Walks a captured-element tree and emits `display: none` for elements whose
 * bbox never intersects the viewBox at any time during the scene cycle. For
 * elements whose `from`/`to` straddle the boundary (intra-frame translate /
 * scale animations, modeled as an axis-aligned affine about the animation's
 * transform-origin), follows the DM-599 feedback rule: hide only BEFORE the
 * animation starts (if `from` is off-viewBox) or AFTER it ends (if `to` is
 * off-viewBox), never DURING. Rotate / skew / matrix (and anything else we
 * can't model as translate+scale) go conservative: always visible, no hide —
 * over-hiding visible content is a bug, a missed cull is only a missed
 * optimization.
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
import { KEYFRAME_EPSILON, padAfter, padBefore } from "../utils/keyframe-pad.js";

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
 * Axis-aligned 2D affine: `x' = sx·x + tx`, `y' = sy·y + ty`. Translate +
 * scale compositions (the only transform functions we model) never introduce
 * rotation or shear, so four components suffice. Rotation / skew / matrix
 * values are NOT represented — they parse to `null` and the culler goes
 * conservative (always visible, no window), because over-hide (content
 * invisible during its own frame) is the catastrophic direction while a
 * forfeited cull is merely a missed optimization.
 */
interface Affine {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

const AFFINE_IDENTITY: Affine = { sx: 1, sy: 1, tx: 0, ty: 0 };

/** `m ∘ f` — the affine that applies `f` first, then `m` (matrix product m·f). */
function composeAffine(m: Affine, f: Affine): Affine {
  return {
    sx: m.sx * f.sx,
    sy: m.sy * f.sy,
    tx: m.sx * f.tx + m.tx,
    ty: m.sy * f.ty + m.ty,
  };
}

/**
 * Parse a pixel length. Accepts `<n>`, `<n>px`, or `0`. Returns null for any
 * other unit (`%`, `em`, `vh`, …) — those can't be statically resolved here,
 * and guessing 0 risks over-hide, so the caller must go conservative.
 */
function parsePx(v: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*(px)?$/i.exec(v.trim());
  if (m == null) return null;
  return Number(m[1]);
}

/** Parse a unitless number (scale factor). Null on anything else. */
function parseUnitless(v: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)$/.exec(v.trim());
  if (m == null) return null;
  return Number(m[1]);
}

/**
 * Parse a CSS `transform` list into an axis-aligned affine, composing the
 * functions left-to-right exactly as CSS does (`translate(…) scale(…)` means
 * scale first, then translate). Recognized: `translate` / `translateX` /
 * `translateY` (px), `scale` / `scaleX` / `scaleY` (unitless), `none`/empty.
 * Returns null — the conservative "can't model" signal — for anything else:
 * rotate, skew, matrix, 3D functions, percentage translations.
 */
function transformListToAffine(value: string): Affine | null {
  const s = value.trim();
  if (s === "" || s.toLowerCase() === "none") return AFFINE_IDENTITY;
  // The list must be nothing but `fn(args)` tokens separated by whitespace.
  const fnRe = /([a-zA-Z0-9]+)\(([^()]*)\)/g;
  if (/\S/.test(s.replace(fnRe, " "))) return null;
  fnRe.lastIndex = 0;
  let m = AFFINE_IDENTITY;
  let match: RegExpExecArray | null;
  while ((match = fnRe.exec(s)) != null) {
    const name = match[1].toLowerCase();
    const args = match[2].split(",").map((a) => a.trim());
    let f: Affine;
    if (name === "translate") {
      const x = parsePx(args[0] ?? "");
      const y = args.length > 1 ? parsePx(args[1]) : 0;
      if (x == null || y == null) return null;
      f = { sx: 1, sy: 1, tx: x, ty: y };
    } else if (name === "translatex") {
      const x = parsePx(args[0] ?? "");
      if (x == null || args.length > 1) return null;
      f = { sx: 1, sy: 1, tx: x, ty: 0 };
    } else if (name === "translatey") {
      const y = parsePx(args[0] ?? "");
      if (y == null || args.length > 1) return null;
      f = { sx: 1, sy: 1, tx: 0, ty: y };
    } else if (name === "scale") {
      const x = parseUnitless(args[0] ?? "");
      const y = args.length > 1 ? parseUnitless(args[1]) : x;
      if (x == null || y == null) return null;
      f = { sx: x, sy: y, tx: 0, ty: 0 };
    } else if (name === "scalex") {
      const x = parseUnitless(args[0] ?? "");
      if (x == null || args.length > 1) return null;
      f = { sx: x, sy: 1, tx: 0, ty: 0 };
    } else if (name === "scaley") {
      const y = parseUnitless(args[0] ?? "");
      if (y == null || args.length > 1) return null;
      f = { sx: 1, sy: y, tx: 0, ty: 0 };
    } else {
      // rotate / skew / matrix / 3D / unknown — can't model as axis-aligned.
      return null;
    }
    m = composeAffine(m, f);
  }
  return m;
}

const TRANSFORM_FAMILY = new Set<string>(["transform", "translateX", "translateY", "scale"]);

/**
 * Affine for one transform-family track's endpoint value. Null = can't model.
 */
function trackAffine(property: string, value: string): Affine | null {
  if (property === "translateX") {
    const v = parsePx(value);
    return v == null ? null : { sx: 1, sy: 1, tx: v, ty: 0 };
  }
  if (property === "translateY") {
    const v = parsePx(value);
    return v == null ? null : { sx: 1, sy: 1, tx: 0, ty: v };
  }
  if (property === "scale") {
    // CSS `scale` property: `<sx>` or `<sx> <sy>`, space-separated, unitless.
    const parts = value.trim().split(/\s+/);
    if (parts.length > 2) return null;
    const x = parseUnitless(parts[0] ?? "");
    const y = parts.length > 1 ? parseUnitless(parts[1]) : x;
    if (x == null || y == null) return null;
    return { sx: x, sy: y, tx: 0, ty: 0 };
  }
  if (property === "transform") return transformListToAffine(value);
  return null;
}

/**
 * Resolve the animation's full transform geometry — the affine at `from` and
 * at `to`, composed across the primary property track AND any fused
 * transform-family tracks (the animator composes fused transform tracks into
 * one `transform:` declaration in track order, so we mirror that order).
 *
 * - `"static"`: no transform-family track — the bbox doesn't move (`width`,
 *   `opacity`, `clipPath`, …), so the caller can use the plain static check.
 * - `"unsupported"`: a transform-family track exists but can't be modeled
 *   (rotate/matrix/percent value, or a fused transform track on its own
 *   timeline) — the caller must treat the element as always visible.
 */
function affinesFromAnim(anim: IntraFrameAnimation): { from: Affine; to: Affine } | "static" | "unsupported" {
  type Track = { property: string; from: string; to: string; ownTiming: boolean };
  const tracks: Track[] = [{ property: anim.property, from: anim.from, to: anim.to, ownTiming: false }];
  for (const t of anim.fuse ?? []) {
    tracks.push({
      property: t.property, from: t.from, to: t.to,
      ownTiming: t.duration != null || t.delay != null || t.easing != null,
    });
  }
  const transformTracks = tracks.filter((t) => TRANSFORM_FAMILY.has(t.property));
  if (transformTracks.length === 0) return "static";
  // A fused transform track with its own duration/delay/easing runs on a
  // separate timeline (the animator samples them independently) — the
  // composed position at a given instant isn't a single from→to lerp, so we
  // can't model it. Conservative: always visible.
  if (transformTracks.some((t) => t.ownTiming)) return "unsupported";
  let from = AFFINE_IDENTITY;
  let to = AFFINE_IDENTITY;
  for (const t of transformTracks) {
    const f = trackAffine(t.property, t.from);
    const g = trackAffine(t.property, t.to);
    if (f == null || g == null) return "unsupported";
    from = composeAffine(from, f);
    to = composeAffine(to, g);
  }
  return { from, to };
}

/**
 * Resolve the animation's `transformOrigin` to a point in the shared
 * (viewport) coordinate space.
 *
 * - Unset/empty: the animator emits NO `transform-box`/`transform-origin`,
 *   so the `<g class="anim-…">` wrapper uses the SVG default — Blink's UA
 *   stylesheet (`third_party/blink/renderer/core/css/svg.css`) sets
 *   `transform-origin: 0 0` for SVG elements without a CSS layout box, per
 *   the CSS Transforms spec. The wrapper draws in viewport coordinates, so
 *   the origin is the viewBox top-left: (0, 0).
 * - Set: the animator emits `transform-box: fill-box; transform-origin: <v>`,
 *   so percentages/keywords resolve against the animated element's own box.
 *   We approximate the wrapper's fill-box with the animated element's border
 *   box (`animatedBbox`). Supported: `left|center|right|top|bottom` keywords,
 *   `<n>px`, `<n>%`, one- or two-value forms.
 *
 * Returns null when the origin can't be resolved (unparseable value, or a set
 * origin without a known animated-element box) — callers must go conservative
 * when the affine actually needs an origin (i.e. contains scale).
 */
function resolveTransformOrigin(spec: string | undefined, box: Bbox | undefined): { x: number; y: number } | null {
  if (spec == null || spec.trim() === "") return { x: 0, y: 0 };
  if (box == null) return null;
  const tokens = spec.trim().split(/\s+/);
  if (tokens.length === 0 || tokens.length > 2) return null; // 3-value (z) — not modeled
  type Tok = { axis: "x" | "y" | "any"; frac?: number; px?: number };
  const parseTok = (t: string): Tok | null => {
    const k = t.toLowerCase();
    if (k === "left") return { axis: "x", frac: 0 };
    if (k === "right") return { axis: "x", frac: 1 };
    if (k === "top") return { axis: "y", frac: 0 };
    if (k === "bottom") return { axis: "y", frac: 1 };
    if (k === "center") return { axis: "any", frac: 0.5 };
    const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(k);
    if (pct != null) return { axis: "any", frac: Number(pct[1]) / 100 };
    const px = parsePx(k);
    if (px != null) return { axis: "any", px };
    return null;
  };
  const t0 = parseTok(tokens[0]);
  if (t0 == null) return null;
  let xTok: Tok;
  let yTok: Tok;
  if (tokens.length === 1) {
    // One value: it sets its own axis (keyword) or the x axis (length/%);
    // the other axis defaults to center.
    const center: Tok = { axis: "any", frac: 0.5 };
    if (t0.axis === "y") { xTok = center; yTok = t0; }
    else { xTok = t0; yTok = center; }
  } else {
    const t1 = parseTok(tokens[1]);
    if (t1 == null) return null;
    // Keywords may swap order (`top left`); otherwise first=x, second=y.
    if (t0.axis === "y" || t1.axis === "x") { xTok = t1; yTok = t0; }
    else { xTok = t0; yTok = t1; }
    if (xTok.axis === "y" || yTok.axis === "x") return null; // e.g. `top bottom`
  }
  const resolve = (tok: Tok, start: number, size: number): number =>
    tok.px != null ? start + tok.px : start + (tok.frac ?? 0) * size;
  return { x: resolve(xTok, box.x, box.w), y: resolve(yTok, box.y, box.h) };
}

/**
 * Map a bbox through `affine` applied about `origin` — i.e. the full CSS
 * transform T(origin) · affine · T(-origin). Axis-aligned, so mapping two
 * opposite corners and taking min/max (handles negative scale) is exact.
 */
function mapBbox(b: Bbox, a: Affine, ox: number, oy: number): Bbox {
  const x1 = ox + a.sx * (b.x - ox) + a.tx;
  const x2 = ox + a.sx * (b.x + b.w - ox) + a.tx;
  const y1 = oy + a.sy * (b.y - oy) + a.ty;
  const y2 = oy + a.sy * (b.y + b.h - oy) + a.ty;
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return { x, y, w: Math.max(x1, x2) - x, h: Math.max(y1, y2) - y };
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
  /**
   * Border box (viewport coords) of the element CARRYING the animation —
   * stamped by the tree walk when it reaches the `animId` carrier and
   * inherited by every descendant's context. A set `transformOrigin` resolves
   * its percentages/keywords against this box (the animator emits
   * `transform-box: fill-box`, and the carrier's border box approximates the
   * anim wrapper's fill-box). Absent for contexts built outside the tree walk;
   * scale-bearing animations with a set origin then go conservative.
   */
  animatedBbox?: Bbox;
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
 * - With a translate/scale animation: map the bbox through the composed
 *   affine (about the resolved transform-origin) at `from`, at `to`, and
 *   N=50 samples in between. Per the DM-599 feedback rule, the element is
 *   visible during the animation if ANY sample intersects; pre-animation hide
 *   iff `from` is off-viewBox; post-animation hide iff `to` is off-viewBox.
 * - With an unmodelable transform (rotate / skew / matrix / percent values,
 *   fused transform tracks on separate timelines): always visible, no window.
 *   Over-hide is the catastrophic direction; a missed cull is only a missed
 *   optimization.
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
  const affines = affinesFromAnim(ctx.anim);
  if (affines === "static") {
    // No transform-family track (`width`, `opacity`, `clipPath`, …): the bbox
    // doesn't move. Treat as static.
    return {
      alwaysHidden: !bboxIntersectsViewport(staticBbox, vw, vh),
    };
  }
  if (affines === "unsupported") {
    // The element MOVES but we can't model where it goes. Never hide.
    return { alwaysHidden: false };
  }
  const { from, to } = affines;
  // The transform-origin only matters when a scale is present (a pure
  // translate is origin-invariant: T(o)·translate·T(-o) = translate).
  let ox = 0, oy = 0;
  if (from.sx !== 1 || from.sy !== 1 || to.sx !== 1 || to.sy !== 1) {
    const origin = resolveTransformOrigin(ctx.anim.transformOrigin, ctx.animatedBbox);
    if (origin == null) {
      // Scale about an origin we can't resolve — can't tell where the bbox
      // converges. Never hide.
      return { alwaysHidden: false };
    }
    ox = origin.x;
    oy = origin.y;
  }
  const fromVisible = bboxIntersectsViewport(mapBbox(staticBbox, from, ox, oy), vw, vh);
  const toVisible   = bboxIntersectsViewport(mapBbox(staticBbox, to,   ox, oy), vw, vh);

  // Sample the animation interpolation: lerp the affine components (exact for
  // matched translate+scale lists — CSS interpolates each function's args
  // linearly, and the composed sx/sy/tx/ty are linear in those args). If any
  // sample intersects, the element is visible during the animation (per
  // user's rule we don't hide during animation that crosses the boundary).
  let anyDuringVisible = false;
  for (let i = 1; i < SAMPLE_COUNT; i++) {
    const t = i / SAMPLE_COUNT;
    const p = evalEasing(ctx.anim.easing, t);
    const at: Affine = {
      sx: from.sx + p * (to.sx - from.sx),
      sy: from.sy + p * (to.sy - from.sy),
      tx: from.tx + p * (to.tx - from.tx),
      ty: from.ty + p * (to.ty - from.ty),
    };
    if (bboxIntersectsViewport(mapBbox(staticBbox, at, ox, oy), vw, vh)) {
      anyDuringVisible = true;
      break;
    }
  }
  const everVisible = fromVisible || toVisible || anyDuringVisible;
  if (!everVisible) {
    return { alwaysHidden: true };
  }
  // A repeating animation (`repeat` / `alternate`) loops for the whole time
  // its frame is on screen — it does NOT rest at `from` before `animStartPct`
  // or at `to` after `animEndPct`, so the from-before / to-after window
  // semantics below don't apply. Ever-visible → keep visible the whole cycle.
  if (ctx.anim.repeat != null) {
    return { alwaysHidden: false };
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
    // Clone (don't mutate the shared per-animation context): the same animId
    // can be carried by multiple elements (selector-matched), each with its
    // own box, and descendants inherit THIS carrier's box for transform-origin
    // resolution.
    ctx = { ...animsById.get(el.animId)!, animatedBbox: { x: el.x, y: el.y, w: el.width, h: el.height } };
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
        anim: a,
      });
    }
  }

  // Coalesce: elements that resolve to the same (visStartPct, visEndPct)
  // share a class so we emit one keyframes block per unique interval.
  const windowToClass = new Map<string, string>();
  const cssBlocks: string[] = [];

  // Walk bottom-up: recurse FIRST, then decide the element's own cull. A
  // parent can only safely inherit `displayNone` if every descendant is
  // also fully hidden — children of an `overflow: visible` parent paint
  // outside the parent's bbox and stay in-viewport even when the parent's
  // bbox is entirely above/below the viewBox (DM-650: NYT body is
  // height: 100vh, so at scrollY > 0 the body bbox sits exactly above
  // the viewport but its descendants are in-viewport). Returns true if
  // any element in the subtree (including `el` itself) is visible.
  const walk = (el: CapturedElement, inheritedCtx: AnimationFrameContext | null): boolean => {
    const { ctx, decision } = decideForElement(el, viewportW, viewportH, inheritedCtx, animsById);
    let anyDescendantVisible = false;
    if (el.children != null) {
      for (const child of el.children) {
        if (walk(child, ctx)) anyDescendantVisible = true;
      }
    }
    if (decision.alwaysHidden && !anyDescendantVisible) {
      el.displayNone = true;
      return false;
    }
    if (decision.visStartPct != null && decision.visEndPct != null) {
      const key = `${r3(decision.visStartPct)},${r3(decision.visEndPct)}`;
      let className = windowToClass.get(key);
      if (className == null) {
        className = cullClassName(decision.visStartPct, decision.visEndPct);
        windowToClass.set(key, className);
        cssBlocks.push(buildCullKeyframes(className, decision.visStartPct, decision.visEndPct));
      }
      el.cullClass = el.cullClass == null || el.cullClass === "" ? className : `${el.cullClass} ${className}`;
    }
    return true;
  };
  for (const root of roots) walk(root, null);

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
