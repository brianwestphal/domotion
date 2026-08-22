/**
 * Conservative continuous-time bounds for the transform wrappers emitted by
 * the intra-frame animator (DM-2461).
 *
 * This is deliberately a small, fail-closed transcription of Chromium's
 * `TransformOperations::BlendedBoundsForBox` contract. Matching translate,
 * scale, and 2D rotation functions interpolate their parameters before
 * composition; rotation includes every per-corner arc extremum; bounds are
 * propagated in reverse operation order. Anything requiring matrix
 * decomposition, projective mapping, or an unrecognised timing function
 * returns `null`. Callers must interpret `null` as "retain paint".
 *
 * Source (Chromium revision pinned by the repository):
 * - ui/gfx/geometry/transform_operations.cc:58-95,339-372
 * - ui/gfx/geometry/transform_operation.cc:177-510
 */

import type { IntraFrameAnimation } from "../animation/animator.js";

export interface SweptBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SweptAnimationContext {
  /** Primary animation's first active instant on the scene clock. */
  animStartPct: number;
  /** End of its first iteration (or of the one-shot active interval). */
  animEndPct: number;
  anim: IntraFrameAnimation;
  /** Renderer-owned used SVG reference box for the generated animation `<g>`. */
  transformReferenceBox?: SweptBox;
  /** Exact frame origin when the tree walk has the global scene timeline. */
  frameStartPct?: number;
}

export interface SweptBoxInterval {
  startPct: number;
  endPct: number;
  bounds: SweptBox;
}

type Point = { x: number; y: number };
type EndpointOperation =
  | { kind: "translate"; x: number; y: number }
  | { kind: "scale"; x: number; y: number }
  | { kind: "rotate"; x: number; y: 0 };

interface EasingModel {
  range(lo: number, hi: number): [number, number];
  discontinuities: number[];
}

interface TimingModel {
  startPct: number;
  durationPct: number;
  iterations: number | "infinite";
  alternate: boolean;
  easing: EasingModel;
  /**
   * The animator bakes independently timed fused tracks to linear keyframe
   * stops. Until that emitted piecewise curve is represented directly, use
   * the track's whole active progress range in each overlapping partition.
   * This loses correlation but contains every baked chord.
   */
  wholeActiveRange: boolean;
}

interface AnimatedOperation {
  kind: EndpointOperation["kind"];
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  timing: TimingModel;
}

interface WrapperModel {
  operations: AnimatedOperation[];
  origin: Point;
}

const TRANSFORM_FAMILY = new Set<string>(["transform", "translateX", "translateY", "scale"]);
const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const NUMBER_RE = new RegExp(`^(${NUMBER})$`);
const PX_RE = new RegExp(`^(${NUMBER})(?:px)?$`, "i");
const MAX_TIMING_BOUNDARIES = 20_000;
const RANGE_PAD = 1e-10;

function finite(...values: number[]): boolean {
  return values.every(Number.isFinite);
}

function parseNumber(value: string): number | null {
  const match = NUMBER_RE.exec(value.trim());
  if (match == null) return null;
  const result = Number(match[1]);
  return Number.isFinite(result) ? result : null;
}

function parsePx(value: string): number | null {
  const match = PX_RE.exec(value.trim());
  if (match == null) return null;
  const result = Number(match[1]);
  return Number.isFinite(result) ? result : null;
}

function parseAngle(value: string): number | null {
  const match = new RegExp(`^(${NUMBER})(deg|grad|rad|turn)$`, "i").exec(value.trim());
  if (match == null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  if (unit === "deg") return amount;
  if (unit === "grad") return amount * 0.9;
  if (unit === "turn") return amount * 360;
  return amount * (180 / Math.PI);
}

/** Legacy transform functions require a comma between two arguments. */
function splitTransformFunctionArgs(value: string): string[] | null {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  if (!trimmed.includes(",")) return [trimmed];
  const result = trimmed.split(",").map((part) => part.trim());
  return result.some((part) => part === "") ? null : result;
}

/** Parse one endpoint while preserving the function list's operation order. */
function parseTransformEndpoint(property: string, value: string): EndpointOperation[] | null {
  if (property === "translateX") {
    const x = parsePx(value);
    return x == null ? null : [{ kind: "translate", x, y: 0 }];
  }
  if (property === "translateY") {
    const y = parsePx(value);
    return y == null ? null : [{ kind: "translate", x: 0, y }];
  }
  if (property === "scale") {
    // `composeAnimStop` emits this as the legacy `scale(<value>)` function,
    // not the independent CSS `scale` property. Match that grammar so an
    // invalid two-value whitespace form cannot be mistaken for live motion.
    const args = splitTransformFunctionArgs(value);
    if (args == null) return null;
    if (args.length < 1 || args.length > 2) return null;
    const x = parseNumber(args[0]);
    const y = args.length === 2 ? parseNumber(args[1]) : x;
    return x == null || y == null ? null : [{ kind: "scale", x, y }];
  }
  if (property !== "transform") return [];

  const source = value.trim();
  if (source === "" || source.toLowerCase() === "none") return [];
  const fnRe = /([a-zA-Z0-9]+)\(([^()]*)\)/g;
  if (/\S/.test(source.replace(fnRe, " "))) return null;
  fnRe.lastIndex = 0;
  const result: EndpointOperation[] = [];
  let match: RegExpExecArray | null;
  while ((match = fnRe.exec(source)) != null) {
    const name = match[1].toLowerCase();
    const args = splitTransformFunctionArgs(match[2]);
    if (args == null) return null;
    if (name === "translate" || name === "translatex" || name === "translatey") {
      if (name === "translatex") {
        if (args.length !== 1) return null;
        const x = parsePx(args[0]);
        if (x == null) return null;
        result.push({ kind: "translate", x, y: 0 });
      } else if (name === "translatey") {
        if (args.length !== 1) return null;
        const y = parsePx(args[0]);
        if (y == null) return null;
        result.push({ kind: "translate", x: 0, y });
      } else {
        if (args.length < 1 || args.length > 2) return null;
        const x = parsePx(args[0]);
        const y = args.length === 2 ? parsePx(args[1]) : 0;
        if (x == null || y == null) return null;
        result.push({ kind: "translate", x, y });
      }
      continue;
    }
    if (name === "scale" || name === "scalex" || name === "scaley") {
      if (name === "scalex") {
        if (args.length !== 1) return null;
        const x = parseNumber(args[0]);
        if (x == null) return null;
        result.push({ kind: "scale", x, y: 1 });
      } else if (name === "scaley") {
        if (args.length !== 1) return null;
        const y = parseNumber(args[0]);
        if (y == null) return null;
        result.push({ kind: "scale", x: 1, y });
      } else {
        if (args.length < 1 || args.length > 2) return null;
        const x = parseNumber(args[0]);
        const y = args.length === 2 ? parseNumber(args[1]) : x;
        if (x == null || y == null) return null;
        result.push({ kind: "scale", x, y });
      }
      continue;
    }
    if (name === "rotate" || name === "rotatez") {
      if (args.length !== 1) return null;
      const angle = parseAngle(args[0]);
      if (angle == null) return null;
      result.push({ kind: "rotate", x: angle, y: 0 });
      continue;
    }
    // Chromium can bound more individual operations, but mismatched suffixes,
    // matrices, 3D/projective operations, and paths need contracts this module
    // does not own. Its API-level equivalent of `false` is `null`.
    return null;
  }
  return result.length > 0 ? result : null;
}

function identityFor(operation: EndpointOperation): EndpointOperation {
  return operation.kind === "translate"
    ? { kind: "translate", x: 0, y: 0 }
    : operation.kind === "scale"
      ? { kind: "scale", x: 1, y: 1 }
      : { kind: "rotate", x: 0, y: 0 };
}

/**
 * Match endpoints by operation primitive. `none` is the identity list, as in
 * Chromium's from/to-identity path. A non-empty length/type mismatch would use
 * decomposed matrix interpolation in Blink, so it fails closed here.
 */
function matchOperations(
  from: EndpointOperation[],
  to: EndpointOperation[],
): Array<{ from: EndpointOperation; to: EndpointOperation }> | null {
  if (from.length === 0 && to.length === 0) return [];
  if (from.length === 0) return to.map((operation) => ({ from: identityFor(operation), to: operation }));
  if (to.length === 0) return from.map((operation) => ({ from: operation, to: identityFor(operation) }));
  if (from.length !== to.length) return null;
  const result: Array<{ from: EndpointOperation; to: EndpointOperation }> = [];
  for (let i = 0; i < from.length; i++) {
    if (from[i].kind !== to[i].kind) return null;
    result.push({ from: from[i], to: to[i] });
  }
  return result;
}

function cubicCoefficients(a: number, b: number): [number, number, number] {
  const c = 3 * a;
  const q = 3 * (b - a) - c;
  return [1 - c - q, q, c];
}

function evalCubic(coeff: [number, number, number], u: number): number {
  return ((coeff[0] * u + coeff[1]) * u + coeff[2]) * u;
}

function invertMonotonicCubic(coeff: [number, number, number], x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (evalCubic(coeff, mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function derivativeRoots(coeff: [number, number, number]): number[] {
  const a = 3 * coeff[0];
  const b = 2 * coeff[1];
  const c = coeff[2];
  if (Math.abs(a) < 1e-15) return Math.abs(b) < 1e-15 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

function cubicEasing(x1: number, y1: number, x2: number, y2: number): EasingModel | null {
  // CSS rejects bezier x control points outside [0,1]. Treat invalid CSS as
  // unknown instead of guessing what survives shorthand parsing.
  if (!finite(x1, y1, x2, y2) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
  const xCoeff = cubicCoefficients(x1, x2);
  const yCoeff = cubicCoefficients(y1, y2);
  return {
    discontinuities: [],
    range(lo, hi) {
      const uLo = invertMonotonicCubic(xCoeff, Math.max(0, Math.min(1, lo)));
      const uHi = invertMonotonicCubic(xCoeff, Math.max(0, Math.min(1, hi)));
      const values = [evalCubic(yCoeff, uLo), evalCubic(yCoeff, uHi)];
      for (const root of derivativeRoots(yCoeff)) {
        if (root > uLo && root < uHi) values.push(evalCubic(yCoeff, root));
      }
      const min = Math.min(...values);
      const max = Math.max(...values);
      return [min - RANGE_PAD, max + RANGE_PAD];
    },
  };
}

function stepEasing(count: number, position: string): EasingModel | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  const pos = position === "start" ? "jump-start" : position === "end" ? "jump-end" : position;
  if (!new Set(["jump-start", "jump-end", "jump-none", "jump-both"]).has(pos)) return null;
  if (pos === "jump-none" && count < 2) return null;
  const discontinuities = Array.from({ length: count + 1 }, (_, i) => i / count)
    .filter((value) => value > 0 && value < 1);
  const evalStep = (t: number, right: boolean): number => {
    const x = Math.max(0, Math.min(1, t));
    // A tiny directed offset includes both sides of a discontinuity in a
    // closed swept interval. Steps are monotone, so endpoint sides are enough.
    const q = Math.max(0, Math.min(1, x + (right ? 1 : -1) * 1e-12));
    if (pos === "jump-start") return Math.min(1, Math.ceil(q * count) / count);
    if (pos === "jump-none") return Math.max(0, Math.min(1, Math.floor(q * count) / (count - 1)));
    if (pos === "jump-both") return Math.max(0, Math.min(1, (Math.floor(q * count) + 1) / (count + 1)));
    return Math.max(0, Math.min(1, Math.floor(q * count) / count));
  };
  return {
    discontinuities,
    range(lo, hi) {
      const values = [evalStep(lo, false), evalStep(lo, true), evalStep(hi, false), evalStep(hi, true)];
      return [Math.min(...values), Math.max(...values)];
    },
  };
}

function parseEasing(value: string | undefined): EasingModel | null {
  const source = (value ?? "linear").trim().toLowerCase();
  if (source === "linear") return { discontinuities: [], range: (lo, hi) => [lo, hi] };
  if (source === "ease") return cubicEasing(0.25, 0.1, 0.25, 1);
  if (source === "ease-in") return cubicEasing(0.42, 0, 1, 1);
  if (source === "ease-out") return cubicEasing(0, 0, 0.58, 1);
  if (source === "ease-in-out") return cubicEasing(0.42, 0, 0.58, 1);
  if (source === "step-start") return stepEasing(1, "jump-start");
  if (source === "step-end") return stepEasing(1, "jump-end");
  const bezier = new RegExp(`^cubic-bezier\\(\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*\\)$`, "i").exec(source);
  if (bezier != null) return cubicEasing(Number(bezier[1]), Number(bezier[2]), Number(bezier[3]), Number(bezier[4]));
  const steps = /^steps\(\s*(\d+)\s*(?:,\s*(jump-start|jump-end|jump-none|jump-both|start|end)\s*)?\)$/i.exec(source);
  if (steps != null) return stepEasing(Number(steps[1]), (steps[2] ?? "jump-end").toLowerCase());
  // `linear(...)`, spring samples, and future timing syntaxes need a dedicated
  // extrema parser before they can prove exclusion continuously.
  return null;
}

function inferredFrameStartPct(ctx: SweptAnimationContext): number | null {
  if (ctx.frameStartPct != null) return Number.isFinite(ctx.frameStartPct) ? ctx.frameStartPct : null;
  const durationPct = ctx.animEndPct - ctx.animStartPct;
  if (!finite(durationPct, ctx.anim.duration) || ctx.anim.duration <= 0) return null;
  return ctx.animStartPct - ((ctx.anim.delay ?? 0) / ctx.anim.duration) * durationPct;
}

function timingForTrack(
  ctx: SweptAnimationContext,
  track: { duration?: number; delay?: number; easing?: string },
  sampledFusion: boolean,
): TimingModel | null {
  const primaryDurationPct = ctx.animEndPct - ctx.animStartPct;
  if (!Number.isFinite(primaryDurationPct) || primaryDurationPct <= 0 || ctx.anim.duration <= 0) return null;
  const pctPerMs = primaryDurationPct / ctx.anim.duration;
  const frameStartPct = inferredFrameStartPct(ctx);
  if (frameStartPct == null) return null;

  const repeating = ctx.anim.repeat != null;
  const durationMs = repeating ? ctx.anim.duration : (track.duration ?? ctx.anim.duration);
  const delayMs = repeating ? (ctx.anim.delay ?? 0) : (track.delay ?? ctx.anim.delay ?? 0);
  const easing = parseEasing(repeating ? ctx.anim.easing : (track.easing ?? ctx.anim.easing));
  if (easing == null || !finite(durationMs, delayMs) || durationMs <= 0) return null;
  let iterations: number | "infinite" = 1;
  if (repeating) {
    if (ctx.anim.repeat === "infinite") iterations = "infinite";
    else if (Number.isInteger(ctx.anim.repeat) && ctx.anim.repeat! > 0) iterations = ctx.anim.repeat!;
    else return null;
  }
  const result: TimingModel = {
    startPct: frameStartPct + delayMs * pctPerMs,
    durationPct: durationMs * pctPerMs,
    iterations,
    alternate: repeating && ctx.anim.alternate === true,
    easing,
    wholeActiveRange: sampledFusion,
  };
  return finite(result.startPct, result.durationPct) ? result : null;
}

function resolveTransformOrigin(spec: string | undefined, box: SweptBox | undefined): Point | null {
  if (spec == null || spec.trim() === "") return { x: 0, y: 0 };
  if (box == null || !finite(box.x, box.y, box.w, box.h)) return null;
  const tokens = spec.trim().split(/\s+/);
  if (tokens.length < 1 || tokens.length > 2) return null;
  type Token = { axis: "x" | "y" | "any"; fraction?: number; px?: number };
  const parse = (value: string): Token | null => {
    const keyword = value.toLowerCase();
    if (keyword === "left") return { axis: "x", fraction: 0 };
    if (keyword === "right") return { axis: "x", fraction: 1 };
    if (keyword === "top") return { axis: "y", fraction: 0 };
    if (keyword === "bottom") return { axis: "y", fraction: 1 };
    if (keyword === "center") return { axis: "any", fraction: 0.5 };
    const percentage = new RegExp(`^(${NUMBER})%$`).exec(keyword);
    if (percentage != null) return { axis: "any", fraction: Number(percentage[1]) / 100 };
    const px = parsePx(keyword);
    return px == null ? null : { axis: "any", px };
  };
  const first = parse(tokens[0]);
  if (first == null) return null;
  let xToken: Token;
  let yToken: Token;
  if (tokens.length === 1) {
    const center: Token = { axis: "any", fraction: 0.5 };
    if (first.axis === "y") { xToken = center; yToken = first; }
    else { xToken = first; yToken = center; }
  } else {
    const second = parse(tokens[1]);
    if (second == null) return null;
    if (first.axis === "y" || second.axis === "x") { xToken = second; yToken = first; }
    else { xToken = first; yToken = second; }
    if (xToken.axis === "y" || yToken.axis === "x") return null;
  }
  const resolve = (token: Token, start: number, size: number): number =>
    token.px != null ? start + token.px : start + (token.fraction ?? 0) * size;
  const result = { x: resolve(xToken, box.x, box.w), y: resolve(yToken, box.y, box.h) };
  return finite(result.x, result.y) ? result : null;
}

function buildWrapper(ctx: SweptAnimationContext): WrapperModel | "identity" | null {
  type Track = { property: string; from: string; to: string; duration?: number; delay?: number; easing?: string };
  const tracks: Track[] = [{ property: ctx.anim.property, from: ctx.anim.from, to: ctx.anim.to }];
  tracks.push(...(ctx.anim.fuse ?? []));
  const transformTracks = tracks.filter((track) => TRANSFORM_FAMILY.has(track.property));
  const sampledFusion = ctx.anim.repeat == null &&
    (ctx.anim.fuse ?? []).some((track) =>
      track.duration != null || track.delay != null || track.easing != null);
  // `composeAnimStop` concatenates all transform-family strings. `none` is
  // valid only as the complete transform value, so `none translate(...)`
  // would be dropped by CSS parsing. Retain instead of modelling motion that
  // the generated SVG does not actually apply.
  if (transformTracks.length > 1 && transformTracks.some((track) =>
    (track.property === "transform" &&
      (track.from.trim() === "" || track.from.trim().toLowerCase() === "none" ||
       track.to.trim() === "" || track.to.trim().toLowerCase() === "none")))) {
    return null;
  }
  const operations: AnimatedOperation[] = [];
  let hasTransformTrack = false;
  let needsOrigin = false;
  for (const track of tracks) {
    if (!TRANSFORM_FAMILY.has(track.property)) continue;
    hasTransformTrack = true;
    const from = parseTransformEndpoint(track.property, track.from);
    const to = parseTransformEndpoint(track.property, track.to);
    if (from == null || to == null) return null;
    const matched = matchOperations(from, to);
    const timing = timingForTrack(ctx, track, sampledFusion);
    if (matched == null || timing == null) return null;
    for (const pair of matched) {
      if (pair.from.kind !== pair.to.kind) return null;
      if (pair.from.kind === "scale" || pair.from.kind === "rotate") needsOrigin = true;
      operations.push({
        kind: pair.from.kind,
        fromX: pair.from.x,
        fromY: pair.from.y,
        toX: pair.to.x,
        toY: pair.to.y,
        timing,
      });
    }
  }
  if (!hasTransformTrack || operations.length === 0) return "identity";
  const origin = needsOrigin ? resolveTransformOrigin(ctx.anim.transformOrigin, ctx.transformReferenceBox) : { x: 0, y: 0 };
  return origin == null ? null : { operations, origin };
}

function addBoundary(boundaries: Set<number>, value: number): boolean {
  if (Number.isFinite(value) && value > 0 && value < 100) boundaries.add(value);
  return boundaries.size <= MAX_TIMING_BOUNDARIES;
}

function timingIterationRange(timing: TimingModel): [number, number] | null {
  const first = Math.max(0, Math.floor((0 - timing.startPct) / timing.durationPct) - 1);
  const sceneLast = Math.ceil((100 - timing.startPct) / timing.durationPct) + 1;
  const last = timing.iterations === "infinite" ? sceneLast : Math.min(timing.iterations, sceneLast);
  if (!finite(first, last) || last - first > MAX_TIMING_BOUNDARIES) return null;
  return [first, Math.max(first, last)];
}

function addTimingBoundaries(boundaries: Set<number>, timing: TimingModel): boolean {
  if (!addBoundary(boundaries, timing.startPct)) return false;
  const range = timingIterationRange(timing);
  if (range == null) return false;
  const [first, last] = range;
  for (let iteration = first; iteration <= last; iteration++) {
    const iterationStart = timing.startPct + iteration * timing.durationPct;
    if (!addBoundary(boundaries, iterationStart)) return false;
    const activeIteration = timing.iterations === "infinite" || iteration < timing.iterations;
    if (activeIteration) {
      for (const local of timing.easing.discontinuities) {
        if (!addBoundary(boundaries, iterationStart + local * timing.durationPct)) return false;
      }
    }
  }
  if (timing.iterations !== "infinite") {
    if (!addBoundary(boundaries, timing.startPct + timing.iterations * timing.durationPct)) return false;
  }
  return true;
}

function terminalProgress(timing: TimingModel): number {
  if (timing.iterations === "infinite") return 0;
  return timing.alternate && timing.iterations % 2 === 0 ? 0 : 1;
}

function progressRange(timing: TimingModel, startPct: number, endPct: number): [number, number] | null {
  const midpoint = (startPct + endPct) / 2;
  const activeEnd = timing.iterations === "infinite"
    ? Number.POSITIVE_INFINITY
    : timing.startPct + timing.durationPct * timing.iterations;
  if (midpoint < timing.startPct) return [0, 0];
  if (midpoint >= activeEnd) {
    const value = terminalProgress(timing);
    return [value, value];
  }
  const iteration = Math.max(0, Math.floor((midpoint - timing.startPct) / timing.durationPct));
  const iterationStart = timing.startPct + iteration * timing.durationPct;
  const lo = Math.max(0, Math.min(1, (startPct - iterationStart) / timing.durationPct));
  const hi = Math.max(0, Math.min(1, (endPct - iterationStart) / timing.durationPct));
  if (!finite(lo, hi)) return null;
  const reversed = timing.alternate && iteration % 2 === 1;
  if (timing.wholeActiveRange) return timing.easing.range(0, 1);
  if (!reversed) return timing.easing.range(lo, hi);
  // Reversing the keyframe traversal evaluates the same timing curve with
  // reversed input: E(1-u). At u=0 this is the `to` value (progress 1), and
  // at u=1 it is the `from` value (progress 0).
  return timing.easing.range(1 - hi, 1 - lo);
}

function lerpRange(from: number, to: number, progress: [number, number]): [number, number] {
  const first = from + (to - from) * progress[0];
  const second = from + (to - from) * progress[1];
  return first <= second ? [first, second] : [second, first];
}

function outwardBox(minX: number, minY: number, maxX: number, maxY: number): SweptBox | null {
  const magnitude = Math.max(1, Math.abs(minX), Math.abs(minY), Math.abs(maxX), Math.abs(maxY));
  const pad = magnitude * RANGE_PAD;
  const result = {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + 2 * pad,
    h: maxY - minY + 2 * pad,
  };
  return finite(result.x, result.y, result.w, result.h) ? result : null;
}

function mapTranslateRange(box: SweptBox, x: [number, number], y: [number, number]): SweptBox | null {
  return outwardBox(
    box.x + x[0],
    box.y + y[0],
    box.x + box.w + x[1],
    box.y + box.h + y[1],
  );
}

function mapScaleRange(box: SweptBox, x: [number, number], y: [number, number]): SweptBox | null {
  const xs = [box.x * x[0], box.x * x[1], (box.x + box.w) * x[0], (box.x + box.w) * x[1]];
  const ys = [box.y * y[0], box.y * y[1], (box.y + box.h) * y[0], (box.y + box.h) * y[1]];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return outwardBox(minX, minY, maxX, maxY);
}

/** Exact 2D counterpart of Chromium's per-corner rotation-arc bounds. */
function mapRotateRange(box: SweptBox, degrees: [number, number]): SweptBox | null {
  const lo = degrees[0] * (Math.PI / 180);
  const hi = degrees[1] * (Math.PI / 180);
  if (!finite(lo, hi)) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const include = (x: number, y: number, angle: number): void => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const mappedX = x * cos - y * sin;
    const mappedY = x * sin + y * cos;
    minX = Math.min(minX, mappedX);
    minY = Math.min(minY, mappedY);
    maxX = Math.max(maxX, mappedX);
    maxY = Math.max(maxY, mappedY);
  };
  const corners: Array<[number, number]> = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ];
  for (const [x, y] of corners) {
    include(x, y, lo);
    include(x, y, hi);
    const radius = Math.hypot(x, y);
    if (hi - lo >= Math.PI * 2) {
      minX = Math.min(minX, -radius);
      minY = Math.min(minY, -radius);
      maxX = Math.max(maxX, radius);
      maxY = Math.max(maxY, radius);
      continue;
    }
    // x extrema: theta = atan2(-y,x) + k*pi.
    // y extrema: theta = atan2(x,y) + k*pi.
    for (const base of [Math.atan2(-y, x), Math.atan2(x, y)]) {
      const first = Math.ceil((lo - base) / Math.PI);
      const last = Math.floor((hi - base) / Math.PI);
      for (let k = first; k <= last; k++) include(x, y, base + k * Math.PI);
    }
  }
  return outwardBox(minX, minY, maxX, maxY);
}

function translateBox(box: SweptBox, x: number, y: number): SweptBox | null {
  const result = { x: box.x + x, y: box.y + y, w: box.w, h: box.h };
  return finite(result.x, result.y, result.w, result.h) ? result : null;
}

function sweepWrapper(box: SweptBox, wrapper: WrapperModel, startPct: number, endPct: number): SweptBox | null {
  let result = translateBox(box, -wrapper.origin.x, -wrapper.origin.y);
  if (result == null) return null;
  // Chromium applies unsquashed transform operations in reverse order.
  for (let i = wrapper.operations.length - 1; i >= 0; i--) {
    const operation = wrapper.operations[i];
    const progress = progressRange(operation.timing, startPct, endPct);
    if (progress == null || !finite(progress[0], progress[1])) return null;
    const x = lerpRange(operation.fromX, operation.toX, progress);
    const y = lerpRange(operation.fromY, operation.toY, progress);
    result = operation.kind === "translate"
      ? mapTranslateRange(result, x, y)
      : operation.kind === "scale"
        ? mapScaleRange(result, x, y)
        : mapRotateRange(result, x);
    if (result == null) return null;
  }
  return translateBox(result, wrapper.origin.x, wrapper.origin.y);
}

/**
 * Sweep `box` through every root-to-leaf animation wrapper on the global scene
 * clock. Successive AABB expansion deliberately loses cross-wrapper
 * correlation; that can retain extra paint but cannot over-cull it.
 *
 * `null` means at least one interval cannot be proven bounded. It is never a
 * partially useful answer: permanent suppression requires every interval to be
 * known and disjoint.
 */
export function conservativeSweptBoxes(
  box: SweptBox,
  contexts: readonly SweptAnimationContext[],
): SweptBoxInterval[] | null {
  if (!finite(box.x, box.y, box.w, box.h) || box.w < 0 || box.h < 0) return null;
  const wrappers: WrapperModel[] = [];
  const boundaries = new Set<number>([0, 100]);
  for (const context of contexts) {
    const wrapper = buildWrapper(context);
    if (wrapper == null) return null;
    if (wrapper === "identity") continue;
    wrappers.push(wrapper);
    for (const operation of wrapper.operations) {
      if (!addTimingBoundaries(boundaries, operation.timing)) return null;
    }
  }
  if (wrappers.length === 0) return [{ startPct: 0, endPct: 100, bounds: { ...box } }];
  const times = [...boundaries].sort((a, b) => a - b);
  const result: SweptBoxInterval[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const startPct = times[i];
    const endPct = times[i + 1];
    if (!(endPct > startPct)) continue;
    let bounds: SweptBox | null = { ...box };
    // Contexts are root -> leaf; geometry sees the innermost wrapper first.
    for (let j = wrappers.length - 1; j >= 0; j--) {
      bounds = sweepWrapper(bounds, wrappers[j], startPct, endPct);
      if (bounds == null) return null;
    }
    result.push({ startPct, endPct, bounds });
  }
  return result;
}
