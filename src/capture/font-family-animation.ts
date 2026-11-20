/**
 * Which ORIGINAL keyframe value an animated `font-family` currently applies.
 *
 * Chromium 7d859f27 has no interpolation type for `font-family`
 * (`core/animation/interpolation_types_map.cc:497-504` falls through to
 * `CSSDefaultInterpolationType`), and that type applies the keyframe's own
 * authored CSSValue (`css_default_interpolation_type.cc:64-83`). The family
 * TYPE therefore survives the animation; only the inspector/WAAPI
 * serializations lose it. This module transcribes how Blink picks the
 * keyframe, so the caller can classify the authored value instead of the
 * lossy computed string:
 *
 * - Interval records: `KeyframeEffectModelBase::EnsureInterpolationEffectPopulated`
 *   (`core/animation/keyframe_effect_model.cc:567-627`), including the
 *   coincident-offset adjustments at both ends and the open first/last ranges.
 * - Synthetic neutral boundary keyframes: `AddSyntheticKeyframeIfRequired`
 *   (`keyframe_effect_model.cc:846-864`) and the zero-offset easing chosen in
 *   `EnsureKeyframeGroups` (`:509-553`); interior keyframes sharing an offset
 *   with both neighbours are dropped by `RemoveRedundantKeyframes` (`:694-711`).
 * - Local fraction and per-keyframe easing: `InterpolationEffect::GetActiveInterpolations`
 *   (`core/animation/interpolation_effect.cc:27-41`), evaluated with
 *   `gfx::CubicBezier` / `StepsTimingFunction::GetValue` / `LinearTimingFunction`
 *   (`ui/gfx/animation/keyframe/timing_function.cc:61-151,187-215`).
 * - The discrete flip: a non-interpolable pair becomes a
 *   `FlipPrimitiveInterpolation` (`invalidatable_interpolation.cc:168-206`),
 *   which takes `fraction < 0.5 ? start : end` (`primitive_interpolation.h:127-143`).
 * - A neutral side converts to nothing when no underlying interpolation of the
 *   same type exists, so the lower layer / static cascade value stays
 *   (`invalidatable_interpolation.cc:69-91,330-399`). A non-neutral value
 *   replaces whatever is below it, because `CSSDefaultInterpolationType::Composite`
 *   is a plain set (`css_default_interpolation_type.cc:56-63`) — add and
 *   accumulate composite behave as replace for this property.
 *
 * Anything the transcription cannot decide exactly — an unsupported easing,
 * a result within solver precision of the flip point, a step boundary whose
 * limit direction depends on the animation phase — is reported as unknown.
 */

export interface FamilyKeyframe {
  /** Computed keyframe offset in [0, 1]. */
  offset: number;
  /** Chromium's serialized easing for the keyframe (`effect.getKeyframes()`). */
  easing: string;
  /** Authored value; `null` for a synthetic neutral keyframe. */
  value: string | null;
}

export type FamilyKeyframeChoice =
  { kind: "value"; value: string; index: number } | { kind: "neutral" } | { kind: "unknown"; reason: string };

/** Synthesize Blink's neutral boundary keyframes for a property group. */
export function withSyntheticFamilyKeyframes(keyframes: FamilyKeyframe[], zeroOffsetEasing: string): FamilyKeyframe[] {
  if (keyframes.length === 0) return [];
  const out = [...keyframes];
  if (out[0].offset > 0) out.unshift({ offset: 0, easing: zeroOffsetEasing, value: null });
  // The trailing neutral keyframe's easing is never evaluated: it can only be
  // the END of a record (or a coincident-offset start equal to its end).
  if (out[out.length - 1].offset < 1) out.push({ offset: 1, easing: "linear", value: null });
  for (let i = out.length - 2; i > 0; --i) {
    if (out[i - 1].offset === out[i].offset && out[i + 1].offset === out[i].offset) out.splice(i, 1);
  }
  return out;
}

const KEYWORD_BEZIERS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

type Easing =
  | { kind: "linear" }
  | { kind: "bezier"; p: [number, number, number, number] }
  | { kind: "steps"; steps: number; position: "start" | "end" | "jump-both" | "jump-none" }
  | { kind: "points"; points: Array<{ input: number; output: number }> };

function parseEasing(text: string): Easing | null {
  const t = text.trim().toLowerCase();
  if (t === "linear") return { kind: "linear" };
  if (t in KEYWORD_BEZIERS) return { kind: "bezier", p: KEYWORD_BEZIERS[t] };
  if (t === "step-start") return { kind: "steps", steps: 1, position: "start" };
  if (t === "step-end") return { kind: "steps", steps: 1, position: "end" };
  let m = /^cubic-bezier\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,)]+)\)$/.exec(t);
  if (m) {
    const p = m.slice(1, 5).map(Number) as [number, number, number, number];
    if (p.some((n) => !Number.isFinite(n)) || p[0] < 0 || p[0] > 1 || p[2] < 0 || p[2] > 1) return null;
    return { kind: "bezier", p };
  }
  m = /^steps\(\s*(\d+)\s*(?:,\s*(start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)$/.exec(t);
  if (m) {
    const steps = Number(m[1]);
    const raw = m[2] ?? "end";
    // step-start/jump-start and step-end/jump-end share GetStepsStartOffset
    // and NumberOfJumps (timing_function.cc:116-151).
    const position =
      raw === "start" || raw === "jump-start"
        ? "start"
        : raw === "end" || raw === "jump-end"
          ? "end"
          : (raw as "jump-none" | "jump-both");
    if (steps < 1 || (position === "jump-none" && steps < 2)) return null;
    return { kind: "steps", steps, position };
  }
  m = /^linear\((.*)\)$/.exec(t);
  if (m) return parseLinearPoints(m[1]);
  return null;
}

/** `linear()` points as Chromium serializes them: `output input%?`, comma separated,
 * every input already resolved (the serialization lists explicit inputs). */
function parseLinearPoints(body: string): Easing | null {
  const points: Array<{ input: number; output: number }> = [];
  for (const part of body.split(",")) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length !== 2 || !tokens[1].endsWith("%")) return null;
    const output = Number(tokens[0]),
      input = Number(tokens[1].slice(0, -1));
    if (!Number.isFinite(output) || !Number.isFinite(input)) return null;
    points.push({ input, output });
  }
  if (points.length < 2) return null;
  for (let i = 1; i < points.length; i++) if (points[i].input < points[i - 1].input) return null;
  return { kind: "points", points };
}

/** gfx::CubicBezier::Solve for x in [0, 1]; outside, its linear extrapolation
 * by the end-point gradients (ui/gfx/geometry/cubic_bezier.cc). */
function solveBezier([x1, y1, x2, y2]: [number, number, number, number], x: number): number | null {
  const curve = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  if (x < 0 || x > 1) {
    // Out-of-range input only arises from an overshooting effect easing; the
    // extrapolation gradients are not transcribed, so decline.
    return null;
  }
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (curve(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return curve(y1, y2, (lo + hi) / 2);
}

type EasedFraction = { value: number } | { reason: string };

function evaluateEasing(text: string, x: number): EasedFraction {
  const easing = parseEasing(text);
  if (easing == null) return { reason: `unsupported keyframe easing ${text}` };
  switch (easing.kind) {
    case "linear":
      return { value: x };
    case "bezier": {
      const y = solveBezier(easing.p, x);
      return y == null ? { reason: "cubic-bezier input outside [0, 1]" } : { value: y };
    }
    case "steps": {
      // StepsTimingFunction::GetValue. At an exact boundary the result depends
      // on the before-phase limit direction, which the caller cannot observe.
      if (easing.steps * x - Math.floor(easing.steps * x) === 0)
        return { reason: "step boundary depends on the animation phase" };
      const offset = easing.position === "start" || easing.position === "jump-both" ? 1 : 0;
      const jumps =
        easing.position === "jump-both"
          ? easing.steps + 1
          : easing.position === "jump-none"
            ? easing.steps - 1
            : easing.steps;
      let step = Math.floor(easing.steps * x + offset);
      if (x >= 0 && step < 0) step = 0;
      if (x <= 1 && step > jumps) step = jumps;
      return { value: step / jumps };
    }
    case "points": {
      const pts = easing.points;
      let b = pts.findIndex((p) => 100 * x < p.input);
      if (b < 0) b = pts.length - 1;
      let a = b === 0 ? 0 : b - 1;
      if (a + 1 === pts.length) a -= 1;
      const A = pts[a],
        B = pts[a + 1];
      if (A.input === B.input) return { value: B.output };
      return { value: A.output + ((100 * x - A.input) / (B.input - A.input)) * (B.output - A.output) };
    }
  }
}

/** gfx::CubicBezier's solver tolerance is 1e-7; stay clear of it at the flip. */
const FLIP_MARGIN = 1e-6;

/**
 * Choose the keyframe whose value Blink applies at `progress` (the effect's
 * transformed iteration progress, `getComputedTiming().progress`).
 * `keyframes` must already include the synthetic neutral boundaries.
 */
export function chooseFamilyKeyframe(keyframes: FamilyKeyframe[], progress: number): FamilyKeyframeChoice {
  if (keyframes.length < 2) return { kind: "unknown", reason: "family keyframe group is incomplete" };
  if (!Number.isFinite(progress)) return { kind: "unknown", reason: "animation progress is unavailable" };
  for (let i = 1; i < keyframes.length; i++)
    if (!(keyframes[i].offset >= keyframes[i - 1].offset)) return { kind: "unknown", reason: "unsorted keyframes" };
  const values = keyframes.map((k) => k.value);
  const pick = (index: number): FamilyKeyframeChoice => {
    const value = values[index];
    return value == null ? { kind: "neutral" } : { kind: "value", value, index };
  };
  // IsStrictlyStatic: one value, no neutral keyframe — sampled at its first keyframe.
  if (values.every((v) => v != null && v === values[0])) return pick(0);
  for (let i = 0; i < keyframes.length - 1; i++) {
    let start = i,
      end = i + 1;
    const startOffset = keyframes[start].offset,
      endOffset = keyframes[end].offset;
    let applyFrom = startOffset,
      applyTo = endOffset;
    if (i === 0) {
      applyFrom = -Infinity;
      if (endOffset === 0) end = start;
    }
    if (i === keyframes.length - 2) {
      applyTo = Infinity;
      if (startOffset === 1) start = end;
    }
    if (applyFrom === applyTo || !(progress >= applyFrom && progress < applyTo)) continue;
    if (values[start] === values[end]) return pick(start);
    const length = keyframes[end].offset - keyframes[start].offset;
    const local = length ? (progress - keyframes[start].offset) / length : 0;
    const eased = evaluateEasing(keyframes[start].easing, local);
    if ("reason" in eased) return { kind: "unknown", reason: eased.reason };
    if (Math.abs(eased.value - 0.5) < FLIP_MARGIN)
      return { kind: "unknown", reason: "keyframe flip point is unresolved" };
    return pick(eased.value < 0.5 ? start : end);
  }
  return { kind: "unknown", reason: "no keyframe interval contains the progress" };
}

/** CSS `@keyframes` selector text to Blink offsets; null for timeline ranges. */
export function keyframeSelectorOffsets(text: string): number[] | null {
  const out: number[] = [];
  for (const raw of text.split(",")) {
    const part = raw.trim().toLowerCase();
    if (part === "from") out.push(0);
    else if (part === "to") out.push(1);
    else {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)%$/.exec(part);
      if (m == null) return null;
      const value = Number(m[1]) / 100;
      if (!(value >= 0 && value <= 1)) return null;
      out.push(value);
    }
  }
  return out.length ? out : null;
}
