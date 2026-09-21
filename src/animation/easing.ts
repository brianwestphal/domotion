/**
 * Easing evaluation + CSS-value interpolation for BAKED keyframe sampling
 * (DM-1517). Used by the animator when a fused animation's tracks have different
 * windows/easings and so can't share one `animation-timing-function`: instead of
 * a from→to pair, the animator samples each track's eased value at many stops
 * and emits them with `linear` timing (the easing is baked into the values), so
 * several property tracks with independent timing still animate as ONE CSS
 * animation — one timeline, immune to Firefox's off-main-thread desync
 * (docs/84). Pure functions, no I/O.
 */

/** A normalized easing: progress `t` in [0,1] → eased output in [0,1]. */
export type EasingFn = (t: number) => number;

/** Solve a CSS `cubic-bezier(x1,y1,x2,y2)` for y at x=t (endpoints (0,0),(1,1)). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number): number => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number): number => ((ay * u + by) * u + cy) * u;
  const dX = (u: number): number => (3 * ax * u + 2 * bx) * u + cx;
  const solveU = (x: number): number => {
    // Newton-Raphson, then bisection fallback.
    let u = x;
    for (let i = 0; i < 8; i++) {
      const xErr = sampleX(u) - x;
      if (Math.abs(xErr) < 1e-6) return u;
      const d = dX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= xErr / d;
    }
    let lo = 0;
    let hi = 1;
    u = x;
    for (let i = 0; i < 24; i++) {
      const xErr = sampleX(u) - x;
      if (Math.abs(xErr) < 1e-6) break;
      if (xErr > 0) hi = u;
      else lo = u;
      u = (lo + hi) / 2;
    }
    return u;
  };
  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveU(t));
  };
}

const NAMED: Record<string, EasingFn> = {
  linear: (t) => t,
  ease: cubicBezier(0.25, 0.1, 0.25, 1),
  "ease-in": cubicBezier(0.42, 0, 1, 1),
  "ease-out": cubicBezier(0, 0, 0.58, 1),
  "ease-in-out": cubicBezier(0.42, 0, 0.58, 1),
};

/**
 * Parse a CSS easing string into an `EasingFn`. Handles the named keywords and
 * `cubic-bezier(a,b,c,d)`. `step`/`steps()` and anything unrecognized fall back
 * to `linear` — the sampled path is for smooth curves; discrete steps don't need
 * baking (they'd be authored as explicit stops).
 */
export function resolveEasing(css: string | undefined): EasingFn {
  if (css == null || css === "") return NAMED.linear;
  const s = css.trim();
  if (s in NAMED) return NAMED[s];
  const m = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(s);
  if (m != null) return cubicBezier(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4]));
  return NAMED.linear;
}

/** Round to at most 4 decimals and drop trailing zeros. */
function fmt(n: number): string {
  return Number(n.toFixed(4)).toString();
}

/**
 * DM-1542: a normalized under-damped spring step-response, from rest at 0 to a
 * target of 1 over normalized time `t` in [0,1]. This is the analytic solution of
 * a damped harmonic oscillator (mass-spring-damper) starting at position 0 with
 * zero velocity:
 *
 *   p(t) = 1 - e^(-ζ ωₙ t) · [cos(ω_d t) + (ζ ωₙ / ω_d) · sin(ω_d t)]
 *
 * where `ζ` (`damping`, in (0,1)) is the damping ratio — lower is bouncier — and
 * `ωₙ` (`omega`, the natural angular frequency) sets how many oscillations happen
 * before the envelope `e^(-ζ ωₙ t)` decays. `ω_d = ωₙ · √(1-ζ²)` is the damped
 * frequency. The output OVERSHOOTS 1 during the bounce (values > 1) then rings
 * down to 1 — exactly the springy motion a single `cubic-bezier` can't express
 * (a bezier is monotonic-in-time and can overshoot only once). We bake it to
 * `linear(...)` samples (`springLinearEasing`) because CSS `linear()` is the
 * cross-engine way to carry an arbitrary sampled curve (Chrome 113+, Safari
 * 17.2+, Firefox 112+ — see docs/84), with no runtime and no JS.
 */
export function springEasingFn(damping: number, omega: number): EasingFn {
  const z = Math.min(0.999, Math.max(0.001, damping));
  const wn = omega;
  const wd = wn * Math.sqrt(1 - z * z);
  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const envelope = Math.exp(-z * wn * t);
    return 1 - envelope * (Math.cos(wd * t) + ((z * wn) / wd) * Math.sin(wd * t));
  };
}

/**
 * DM-1542: bake a spring step-response to a CSS `linear(...)` easing string by
 * sampling `springEasingFn` at `samples + 1` evenly spaced points across
 * normalized time. `linear()` distributes evenly-spaced output values across the
 * input range and interpolates linearly between them, so evenly-spaced samples
 * reproduce the spring curve (including its > 1 overshoots) to within the sample
 * spacing. The endpoints are pinned to exactly `0` and `1` so the motion starts
 * at `from` and RESTS at `to` (identity) — the tiny residual ring at the final
 * sample is snapped out, which keeps Domotion's own re-capture of a rested frame
 * un-doubled (see the "rest at identity" invariant in docs/08).
 */
export function springLinearEasing(damping: number, omega: number, samples = 40): string {
  const fn = springEasingFn(damping, omega);
  const vals: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const v = i === 0 ? 0 : i === samples ? 1 : fn(i / samples);
    vals.push(fmt(v));
  }
  return `linear(${vals.join(", ")})`;
}

const NUM_RE = /-?\d*\.?\d+(?:e-?\d+)?/g;

/**
 * Interpolate between two CSS value strings at `t` in [0,1] by matching their
 * numeric tokens pairwise and lerping each, keeping the surrounding literal
 * skeleton. Handles the value shapes the intra-frame animator produces —
 * `"0.3"`→`"1"` (scale), `"-0.6em"`→`"0em"` (translate), `"240px"`→`"0px"`,
 * `"inset(-10% 100% -10% 0)"`→`"inset(-10% 0% -10% 0)"` (clip-path). If the two
 * strings don't share the same non-numeric skeleton (e.g. different units), it
 * can't be smoothly interpolated, so it steps at the midpoint.
 */
export function interpolateCssValue(from: string, to: string, t: number): string {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const fParts: string[] = [];
  const fNums: number[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(from)) != null) {
    fParts.push(from.slice(last, m.index));
    fNums.push(parseFloat(m[0]));
    last = m.index + m[0].length;
  }
  fParts.push(from.slice(last));

  const gParts: string[] = [];
  const gNums: number[] = [];
  last = 0;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(to)) != null) {
    gParts.push(to.slice(last, m.index));
    gNums.push(parseFloat(m[0]));
    last = m.index + m[0].length;
  }
  gParts.push(to.slice(last));

  // Skeletons (the literal parts) must match to interpolate meaningfully.
  if (fParts.length !== gParts.length || fParts.join("\0") !== gParts.join("\0")) {
    return t < 0.5 ? from : to;
  }
  let out = fParts[0];
  for (let i = 0; i < fNums.length; i++) {
    out += fmt(fNums[i] + (gNums[i] - fNums[i]) * t) + fParts[i + 1];
  }
  return out;
}
