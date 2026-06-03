/**
 * DM-1040 / DM-1045 / DM-1041: trim an animated SVG to a time window `[t0, t1]`.
 *
 * Two layered strategies, chosen per animation:
 *
 *   1. PERIOD-SPANNING animations (a looping animation whose duration ≈ the
 *      whole loop period — the master cursor / content cycle) are WINDOW-SLICED:
 *      their `@keyframes` (CSS) or `values`/`keyTimes` (SMIL) are sliced to
 *      `[f0, f1] = [t0/period, t1/period]` — interior stops kept + remapped to
 *      `[0%, 100%]`, boundary stops synthesised at the window edges — and their
 *      duration set to the window length. So the output LOOPS exactly the
 *      selected window (DM-1041).
 *   2. SCHEDULED animations (a short `<animate begin="1.85s" dur="0.5s">` ripple,
 *      or any non-period CSS animation) are RE-BASED by a negative time shift —
 *      CSS `animation-delay: -t0` + `fill: both`; SMIL `begin -= t0` — so they
 *      fire at the right offset within the window (DM-1045) without being
 *      sliced.
 *
 * Re-basing alone (DM-1045) already reproduced the window CONTENT correctly; the
 * slicing here is what makes the export LOOP the window instead of playing the
 * full period forward. Verified with the A/B harness (`tools/probe-1041-ab.mjs`):
 * trimmed @ k matches original @ t0+k AND trimmed @ (win+k) matches original @
 * t0+k (the loop), across the window.
 *
 * Boundary interpolation handles the cart-htmx / `domotion animate` shapes:
 * opacity / transform / multi-component SMIL values (linear), and discrete
 * properties (`step-end` `visibility`, SMIL `calcMode="discrete"`) which SNAP to
 * the stop at-or-before the boundary. Documented edge cases that fall back to
 * pure re-basing (no slice): a CSS rule mixing period-spanning + scheduled
 * animations in one shorthand, SMIL `calcMode="paced"`/`"spline"`, and ranges
 * spanning multiple periods. Pure + DOM-free so it unit-tests without a browser.
 */

export interface TrimResult {
  svg: string;
  /** CSS animation rules / SMIL elements window-SLICED to the loop window. */
  slicedCss: number;
  slicedSmil: number;
  /** CSS rules / SMIL elements RE-BASED (negative shift) instead of sliced. */
  shiftedCss: number;
  shiftedSmil: number;
}

const SMIL_TAGS = "animate|animateTransform|animateMotion|animateColor|set";

// ── small formatters ────────────────────────────────────────────────────────

function num(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
function secs(ms: number): string {
  const s = num(ms / 1000);
  return `${s === "" || s === "-0" ? "0" : s}s`;
}

/** Parse a SMIL/CSS clock-value ("1.85s", "500ms", "2") to ms, or null. */
function parseClockMs(v: string): number | null {
  const t = v.trim();
  let m = /^(-?\d*\.?\d+)ms$/.exec(t);
  if (m) return parseFloat(m[1]);
  m = /^(-?\d*\.?\d+)s$/.exec(t);
  if (m) return parseFloat(m[1]) * 1000;
  m = /^(-?\d*\.?\d+)$/.exec(t);
  if (m) return parseFloat(m[1]) * 1000;
  return null;
}

// ── value interpolation (shared by CSS decls + SMIL values) ─────────────────

const NUM_RE = /-?\d*\.?\d+(?:[eE][+-]?\d+)?/g;

/** Linear-interpolate two values that share an identical non-numeric skeleton
 *  (`translateX(10px)`↔`translateX(20px)`, `0`↔`1`, `0,0`↔`40,10`). Returns null
 *  when skeletons differ (discrete value like `visible`↔`hidden`) so the caller
 *  SNAPS. */
function lerpValue(a: string, b: string, t: number): string | null {
  const an = a.match(NUM_RE);
  const bn = b.match(NUM_RE);
  if (a.replace(NUM_RE, "\0") !== b.replace(NUM_RE, "\0") || an == null || bn == null || an.length !== bn.length) return null;
  const parts = a.replace(NUM_RE, "\0").split("\0");
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < an.length) out += num(parseFloat(an[i]) + (parseFloat(bn[i]) - parseFloat(an[i])) * t);
  }
  return out;
}

interface Stop { at: number; value: string }

/** State of a single value channel at fraction `f`, given sorted stops. */
function valueAt(stops: Stop[], f: number, discrete: boolean): string {
  if (stops.length === 0) return "";
  if (f <= stops[0].at) return stops[0].value;
  if (f >= stops[stops.length - 1].at) return stops[stops.length - 1].value;
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (stops[i].at <= f && f <= stops[i + 1].at) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  if (discrete) return lo.value; // hold the value of the stop at-or-before f
  const span = hi.at - lo.at;
  return span > 0 ? (lerpValue(lo.value, hi.value, (f - lo.at) / span) ?? lo.value) : lo.value;
}

/** Slice a sorted stop list to `[f0, f1]`, remapping to `[0, 1]`. */
function windowStops(stops: Stop[], f0: number, f1: number, discrete: boolean): Stop[] {
  const span = f1 - f0;
  if (!(span > 0)) return stops;
  const out: Stop[] = [{ at: 0, value: valueAt(stops, f0, discrete) }];
  for (const s of stops) if (s.at > f0 && s.at < f1) out.push({ at: (s.at - f0) / span, value: s.value });
  out.push({ at: 1, value: valueAt(stops, f1, discrete) });
  // De-dup identical fractions (keep last).
  const byAt = new Map<number, string>();
  for (const s of out) byAt.set(Math.round(s.at * 1e6) / 1e6, s.value);
  return [...byAt.entries()].sort((a, b) => a[0] - b[0]).map(([at, value]) => ({ at, value }));
}

// ── CSS @keyframes parse / slice ────────────────────────────────────────────

interface CssFrame { at: number; decls: Map<string, string> }

function parseKeyframes(body: string): CssFrame[] {
  const frames: CssFrame[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) != null) {
    const decls = new Map<string, string>();
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      const k = d.slice(0, i).trim();
      if (k) decls.set(k, d.slice(i + 1).trim());
    }
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      let at: number | null = null;
      if (s === "from") at = 0;
      else if (s === "to") at = 1;
      else if (s.endsWith("%")) { const v = parseFloat(s); if (Number.isFinite(v)) at = v / 100; }
      if (at != null) frames.push({ at, decls: new Map(decls) });
    }
  }
  frames.sort((a, b) => a.at - b.at);
  return frames;
}

/** Decls are discrete (snap) when the property is non-interpolatable; we detect
 *  this lazily per-property in `cssStateAt` via the lerp-skeleton check. */
function cssStateAt(frames: CssFrame[], f: number): Map<string, string> {
  if (frames.length === 0) return new Map();
  if (f <= frames[0].at) return new Map(frames[0].decls);
  if (f >= frames[frames.length - 1].at) return new Map(frames[frames.length - 1].decls);
  let lo = frames[0], hi = frames[frames.length - 1];
  for (let i = 0; i < frames.length - 1; i++) {
    if (frames[i].at <= f && f <= frames[i + 1].at) { lo = frames[i]; hi = frames[i + 1]; break; }
  }
  const t = hi.at > lo.at ? (f - lo.at) / (hi.at - lo.at) : 0;
  const out = new Map<string, string>();
  for (const p of new Set([...lo.decls.keys(), ...hi.decls.keys()])) {
    const a = lo.decls.get(p), b = hi.decls.get(p);
    if (a != null && b != null) out.set(p, lerpValue(a, b, t) ?? a); // lerp, else snap to lo
    else out.set(p, (a ?? b)!);
  }
  return out;
}

function sliceKeyframesBody(body: string, f0: number, f1: number): string {
  const frames = parseKeyframes(body);
  if (frames.length === 0) return body;
  const span = f1 - f0;
  if (!(span > 0)) return body;
  const stops: { at: number; decls: Map<string, string> }[] = [{ at: 0, decls: cssStateAt(frames, f0) }];
  for (const fr of frames) if (fr.at > f0 && fr.at < f1) stops.push({ at: (fr.at - f0) / span, decls: fr.decls });
  stops.push({ at: 1, decls: cssStateAt(frames, f1) });
  const byPct = new Map<number, Map<string, string>>();
  for (const s of stops) byPct.set(Math.round(s.at * 1e5) / 1e3, s.decls);
  return [...byPct.entries()].sort((a, b) => a[0] - b[0])
    .map(([pct, decls]) => `${pct}% { ${[...decls.entries()].map(([k, v]) => `${k}: ${v}`).join("; ")} }`)
    .join(" ");
}

// ── CSS animation shorthand parsing ─────────────────────────────────────────

/** Split a comma list ignoring commas inside parens (cubic-bezier(...)). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim() !== "" || out.length > 0) out.push(cur);
  return out;
}

const TIME_RE = /(-?\d*\.?\d+)(ms|s)\b/;

interface CssAnim { seg: string; name: string | null; durMs: number | null; infinite: boolean }

function parseCssAnims(value: string, keyframeNames: Set<string>): CssAnim[] {
  return splitTopLevel(value).map((seg) => {
    const name = [...keyframeNames].find((n) => new RegExp(`(^|\\s)${n}(\\s|$)`).test(seg.trim())) ?? null;
    const tm = TIME_RE.exec(seg);
    const durMs = tm ? (tm[2] === "ms" ? parseFloat(tm[1]) : parseFloat(tm[1]) * 1000) : null;
    return { seg, name, durMs, infinite: /\binfinite\b/.test(seg) };
  });
}

// ── main ────────────────────────────────────────────────────────────────────

export function trimAnimatedSvg(svgMarkup: string, startMs: number, endMs: number, periodMs?: number): TrimResult {
  const t0 = Math.max(0, Math.min(startMs, endMs));
  const t1 = Math.max(startMs, endMs);
  const win = Math.max(1, t1 - t0);
  const result: TrimResult = { svg: svgMarkup, slicedCss: 0, slicedSmil: 0, shiftedCss: 0, shiftedSmil: 0 };
  if (!(t0 > 0) && (periodMs == null || t1 >= periodMs)) return result; // full range / nothing to do

  const period = periodMs && periodMs > 0 ? periodMs : t1; // fall back: treat the window's end as the period
  const f0 = t0 / period;
  const f1 = Math.min(1, t1 / period);
  const isPeriod = (durMs: number | null): boolean => durMs != null && Math.abs(durMs - period) <= Math.max(4, period * 0.02);
  const negT0 = secs(-t0);
  const winSec = secs(win);

  // Collect @keyframes names.
  const keyframeNames = new Set<string>();
  for (const m of svgMarkup.matchAll(/@keyframes\s+([A-Za-z_][\w-]*)/g)) keyframeNames.add(m[1]);

  // Decide, per @keyframes name, whether it should be sliced — true only when
  // EVERY CSS animation referencing it is period-spanning (so the rule is a
  // clean all-period-spanning rule). Mixed rules fall back to re-basing.
  const sliceNames = new Set<string>();
  const rebaseRuleNames = new Set<string>(); // names whose rule is re-based (don't slice)
  for (const m of svgMarkup.matchAll(/animation\s*:\s*([^;}]+)/g)) {
    const anims = parseCssAnims(m[1], keyframeNames);
    const allPeriod = anims.length > 0 && anims.every((a) => isPeriod(a.durMs) && a.infinite);
    for (const a of anims) {
      if (a.name == null) continue;
      if (allPeriod) sliceNames.add(a.name); else rebaseRuleNames.add(a.name);
    }
  }
  for (const n of rebaseRuleNames) sliceNames.delete(n); // a name used by any re-based rule is never sliced

  let out = svgMarkup;

  // 1. Slice the @keyframes bodies that belong to period-spanning rules.
  out = out.replace(/@keyframes\s+([A-Za-z_][\w-]*)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, (full, name: string, body: string) => {
    if (!sliceNames.has(name)) return full;
    return `@keyframes ${name} {${sliceKeyframesBody(body, f0, f1)}}`;
  });

  // 2. Rewrite each `animation` shorthand.
  out = out.replace(/animation\s*:\s*([^;}]+)/g, (full, value: string) => {
    const anims = parseCssAnims(value, keyframeNames);
    const allPeriod = anims.length > 0 && anims.every((a) => isPeriod(a.durMs) && a.infinite);
    if (allPeriod) {
      // Sliced: set each segment's duration to the window length; no delay.
      result.slicedCss++;
      const newVal = splitTopLevel(value).map((seg) => seg.replace(TIME_RE, winSec)).join(",");
      return `animation:${newVal}`;
    }
    // Re-based: shift the whole rule back by t0 (single delay applies to all
    // animations in the list) and hold pre/post states.
    result.shiftedCss++;
    return `${full};animation-delay:${negT0};animation-fill-mode:both`;
  });

  // 3. SMIL: slice period-spanning elements; window-loop / drop the rest.
  const idCounter = { n: 0 };
  out = out.replace(new RegExp(`<(?:${SMIL_TAGS})\\b[^>]*?/?>`, "g"),
    (tag) => rewriteSmil(tag, t0, win, f0, f1, winSec, isPeriod, idCounter, result));

  return { ...result, svg: out };
}

/** Get an attribute value from a start-tag. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
function setAttr(tag: string, name: string, value: string): string {
  if (new RegExp(`\\b${name}\\s*=\\s*"[^"]*"`).test(tag)) {
    return tag.replace(new RegExp(`\\b${name}\\s*=\\s*"[^"]*"`), `${name}="${value}"`);
  }
  return tag.replace(/\s*\/?>$/, (end) => ` ${name}="${value}"${end.trim().startsWith("/") ? "/>" : ">"}`);
}

function rewriteSmil(
  tag: string, t0: number, win: number, f0: number, f1: number, winSec: string,
  isPeriod: (d: number | null) => boolean, idCounter: { n: number }, result: TrimResult,
): string {
  const durMs = parseClockMs(attr(tag, "dur") ?? "");
  const repeat = attr(tag, "repeatCount");
  const looping = repeat === "indefinite" || (repeat != null && parseFloat(repeat) > 1);
  const values = attr(tag, "values");
  const calcMode = attr(tag, "calcMode") ?? "linear";

  // PERIOD-SPANNING (looping, dur ≈ period): window-slice the values/keyTimes so
  // it loops EXACTLY the window. (paced/spline carry extra timing data we don't
  // slice — they fall through to the scheduled path.)
  if (isPeriod(durMs) && looping && values != null && calcMode !== "paced" && calcMode !== "spline") {
    const vals = values.split(";").map((s) => s.trim());
    const ktAttr = attr(tag, "keyTimes");
    const kt = ktAttr != null
      ? ktAttr.split(";").map((s) => parseFloat(s))
      : vals.map((_, i) => (vals.length === 1 ? 0 : i / (vals.length - 1)));
    const sliced = windowStops(vals.map((value, i) => ({ at: kt[i] ?? 0, value })), f0, f1, calcMode === "discrete");
    let t = setAttr(tag, "values", sliced.map((s) => s.value).join(";"));
    t = setAttr(t, "keyTimes", sliced.map((s) => num(s.at)).join(";"));
    t = setAttr(t, "dur", winSec);
    t = setAttr(t, "begin", "0s");
    result.slicedSmil++;
    return t;
  }

  // SCHEDULED (e.g. a `begin="1.85s" dur="0.5s"` ripple). Re-time it relative to
  // the window and make it RE-FIRE every loop so the windowed export loops.
  const beginAttr = attr(tag, "begin");
  const beginMs = beginAttr == null ? 0 : parseClockMs(beginAttr);
  if (beginMs == null) return tag; // event/syncbase begin — leave alone
  const delta = beginMs - t0; // begin time relative to the window start
  const dur = durMs ?? 0;
  result.shiftedSmil++;
  if (delta >= win) return setAttr(tag, "begin", "indefinite"); // fires only after the window → never in the loop
  if (delta + dur <= 0) return setAttr(tag, "begin", secs(delta)); // finished before the window → static (fill=freeze holds end state)
  // Overlaps the window → fire at `delta`, then re-fire every `win`, each
  // instance CLIPPED at the next loop boundary (so it doesn't bleed past the
  // window). Self-referencing syncbase = a 2-entry begin/end, no long list.
  let id = attr(tag, "id");
  let t = tag;
  if (id == null) { id = `tw${idCounter.n++}`; t = setAttr(t, "id", id); }
  t = setAttr(t, "begin", `${secs(delta)}; ${id}.begin+${winSec}`);
  t = setAttr(t, "end", `${winSec}; ${id}.end+${winSec}`);
  // `fill="remove"` so a clipped instance VANISHES at the loop boundary instead
  // of freezing its mid-animation value into the next loop's pre-fire gap.
  t = setAttr(t, "fill", "remove");
  return t;
}
