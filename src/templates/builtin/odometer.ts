/**
 * Odometer digit-reel module (creative pack, docs/86 §4–5, DM-1532).
 *
 * The shared technique behind `counter` and `stat`: animate a number `from → to`
 * as rolling digit reels instead of per-frame text. Each digit column is a
 * clipped window (one digit tall) over a vertical strip of digits; the strip is
 * `translateY`-animated so the digits roll past the window and settle on the
 * target. Pure transform → cross-engine-safe (docs/84).
 *
 * **Rests at identity (critical for Domotion).** The strip's natural, untransformed
 * layout shows the FINAL number at the top of the window; the animation rolls
 * FROM a negative offset (showing the start) UP TO `translateY(0)`. Domotion bakes
 * an element's resting transform into the captured glyph positions and then
 * re-applies the keyframe transform, so a NON-identity rest (e.g.
 * `translateY(-final)`) double-transforms and the overflow clip lands wrong —
 * exactly how every working Domotion animation (lower-third, kinetic-text) rests
 * at `to: 0`/`scale(1)`. Offsets are in **px** (a fixed cell height), not `em`
 * (which is ambiguous once the group is captured into SVG).
 *
 * **Real odometer spin.** A digit that changes value many times over the count
 * (the low-order digits) rolls through several full turns; high-order digits roll
 * less. Each column's travel = `min(⌊trueIncrements/10⌋, MAX_SPINS)` full turns +
 * the modular distance to the final digit. So counting 0 → 128,500 spins the
 * units/tens fast and barely nudges the hundred-thousands — reading as counting,
 * not a single-step twitch.
 */

import type { Anims } from "../../cli/animate.js";
import { escapeHtml } from "../../utils/escapeHtml.js";

/** Grouping / decimal formatting options shared by the number templates. */
export interface OdometerFormat {
  /** Fixed decimal places (default 0). */
  decimals?: number;
  /** Insert a thousands separator (default false). */
  grouping?: boolean;
  /** Thousands separator (default ","). */
  groupSep?: string;
  /** Decimal separator (default "."). */
  decimalSep?: string;
}

/** One rendered column: a rolling digit reel or a fixed character (sep/decimal/sign). */
export type OdometerColumn =
  | { type: "static"; char: string }
  | {
      type: "digit";
      /** Digit shown at animation start. */
      startDigit: number;
      /** Digit shown at rest / animation end (the final value). */
      endDigit: number;
      /** Roll direction (true = count-up / forward). */
      up: boolean;
      /** Cells to travel: `spins*10 + modular distance`. 0 = unchanged (no roll). */
      steps: number;
    };

export interface OdometerPlan {
  /** The final displayed text (what a static/reduced-motion render shows). */
  toText: string;
  /** The starting displayed text (aligned to the same columns as `toText`). */
  fromText: string;
  /** Left-to-right columns. */
  columns: OdometerColumn[];
}

/** Max full 0..9 turns any single digit column rolls (caps the strip length). */
export const MAX_SPINS = 4;

/** Digit count of the integer part of |n| at the given decimal precision. */
function intDigitCount(n: number, decimals: number): number {
  const s = Math.abs(n).toFixed(decimals);
  const dot = s.indexOf(".");
  return (dot === -1 ? s : s.slice(0, dot)).length;
}

/**
 * Format a number for display: fixed `decimals`, optional thousands grouping, and
 * left-pad the integer part to `minIntDigits` with zeros so a `from`/`to` pair can
 * be aligned column-for-column (odometer style — leading positions roll from 0).
 */
export function formatNumber(n: number, opts: OdometerFormat = {}, minIntDigits = 1): string {
  const decimals = opts.decimals ?? 0;
  const groupSep = opts.groupSep ?? ",";
  const decimalSep = opts.decimalSep ?? ".";
  const neg = n < 0;
  const fixed = Math.abs(n).toFixed(decimals);
  const dot = fixed.indexOf(".");
  let intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  const fracPart = dot === -1 ? "" : fixed.slice(dot + 1);
  if (intPart.length < minIntDigits) intPart = "0".repeat(minIntDigits - intPart.length) + intPart;
  if (opts.grouping === true) intPart = groupInt(intPart, groupSep);
  return (neg ? "-" : "") + intPart + (decimals > 0 ? decimalSep + fracPart : "");
}

/** Insert `sep` every three digits from the right of a bare integer string. */
function groupInt(intStr: string, sep: string): string {
  let out = "";
  for (let i = 0; i < intStr.length; i++) {
    if (i > 0 && (intStr.length - i) % 3 === 0) out += sep;
    out += intStr[i];
  }
  return out;
}

/** Travel (cells) for a digit rolling `startDigit → endDigit` with `trueInc` total
 *  value-changes over the count: capped full turns + the modular final distance. */
function stepsFor(startDigit: number, endDigit: number, up: boolean, trueInc: number): number {
  const modular = up ? (endDigit - startDigit + 10) % 10 : (startDigit - endDigit + 10) % 10;
  const spins = Math.min(Math.floor(trueInc / 10), MAX_SPINS);
  return spins * 10 + modular;
}

/**
 * Plan the odometer for `from → to`: align both to the same column template, and
 * for each digit column compute the roll (direction + travel). Travel includes
 * real odometer spin: a column's `trueIncrements` = how many times that decimal
 * place ticks over the count (computed from the scaled integers). Non-digit
 * characters (separators, decimal point, sign) become static columns.
 */
export function planOdometer(from: number, to: number, opts: OdometerFormat = {}): OdometerPlan {
  const decimals = opts.decimals ?? 0;
  const width = Math.max(intDigitCount(from, decimals), intDigitCount(to, decimals));
  const fromText = formatNumber(from, opts, width);
  const toText = formatNumber(to, opts, width);
  const up = to >= from;
  // Scaled integers to count how often each decimal place ticks (spin amount).
  const scale = 10 ** decimals;
  const scaledFrom = Math.round(Math.abs(from) * scale);
  const scaledTo = Math.round(Math.abs(to) * scale);
  // Assign a place index (from the right, over DIGIT columns only) to each column.
  const digitPlaces = placeIndices(toText);
  const columns: OdometerColumn[] = [];
  for (let i = 0; i < toText.length; i++) {
    const fc = fromText[i] ?? toText[i];
    const tc = toText[i];
    if (tc >= "0" && tc <= "9" && fc >= "0" && fc <= "9") {
      const startDigit = fc.charCodeAt(0) - 48;
      const endDigit = tc.charCodeAt(0) - 48;
      const place = digitPlaces[i];
      const trueInc = Math.abs(Math.floor(scaledTo / 10 ** place) - Math.floor(scaledFrom / 10 ** place));
      columns.push({ type: "digit", startDigit, endDigit, up, steps: stepsFor(startDigit, endDigit, up, trueInc) });
    } else {
      columns.push({ type: "static", char: tc });
    }
  }
  return { toText, fromText, columns };
}

/** For each character index, the digit place from the right over digit chars only
 *  (non-digits get -1). E.g. "1,250" → [4,-1,2,1,0]. */
function placeIndices(text: string): number[] {
  const out: number[] = new Array(text.length).fill(-1);
  let place = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c >= "0" && c <= "9") { out[i] = place; place++; }
  }
  return out;
}

/** Seconds → clock text: `M:SS`, or `H:MM:SS` when an hour or more. */
export function formatTimer(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const two = (n: number): string => (n < 10 ? "0" + n : String(n));
  return hrs > 0 ? `${hrs}:${two(mins)}:${two(secs)}` : `${mins}:${two(secs)}`;
}

/** The tick period (in seconds) of each timer digit column, from the right,
 *  skipping the `:` separators: secUnits=1, secTens=10, minUnits=60, minTens=600, … */
const TIMER_PERIODS = [1, 10, 60, 600, 3600, 36000];

/**
 * Plan an odometer between two clock strings (timer mode). Aligned right, colons
 * static; each digit rolls with spin scaled to how fast that place ticks over the
 * elapsed time (seconds-units fastest).
 */
export function planTimer(fromSeconds: number, toSeconds: number): OdometerPlan {
  const rawFrom = formatTimer(fromSeconds);
  const rawTo = formatTimer(toSeconds);
  const len = Math.max(rawFrom.length, rawTo.length);
  const fromText = rawFrom.padStart(len, "0");
  const toText = rawTo.padStart(len, "0");
  const up = toSeconds >= fromSeconds;
  const totalDelta = Math.abs(Math.floor(toSeconds) - Math.floor(fromSeconds));
  const columns: OdometerColumn[] = [];
  let place = 0;
  for (let i = len - 1; i >= 0; i--) {
    const fc = fromText[i];
    const tc = toText[i];
    if (tc >= "0" && tc <= "9" && fc >= "0" && fc <= "9") {
      const startDigit = fc.charCodeAt(0) - 48;
      const endDigit = tc.charCodeAt(0) - 48;
      const period = TIMER_PERIODS[Math.min(place, TIMER_PERIODS.length - 1)];
      const trueInc = Math.floor(totalDelta / period);
      columns[i] = { type: "digit", startDigit, endDigit, up, steps: stepsFor(startDigit, endDigit, up, trueInc) };
      place++;
    } else {
      columns[i] = { type: "static", char: tc };
    }
  }
  return { toText, fromText, columns };
}

/** Options for {@link buildOdometerMarkup}. */
export interface OdometerMarkupOptions {
  /** Unique-per-document class prefix (default "od"). */
  prefix?: string;
  /** Digit cell height in px (= the number's font size at line-height 1). */
  cellPx: number;
  /** Roll duration (ms). */
  durationMs: number;
  /** CSS easing for the roll. Default a decelerating ease-out. */
  easing?: string;
  /** Per-digit-column stagger (ms), cascading left→right. Default 0. */
  staggerMs?: number;
}

/** The markup + animations + css for an odometer plan. */
export interface OdometerMarkup {
  html: string;
  animations: Anims;
  css: string;
}

/**
 * Turn a plan into HTML + intra-frame animations. Each digit reel is built so its
 * NATURAL (untransformed) layout shows the final digit at the top of the window;
 * the animation rolls it in from `-steps*cellPx` up to `0` (rest = identity, the
 * Domotion-safe shape). Reduced-motion / static render therefore shows the final
 * number. Unchanged digits render as a single static glyph (no animation).
 */
export function buildOdometerMarkup(plan: OdometerPlan, opts: OdometerMarkupOptions): OdometerMarkup {
  const prefix = opts.prefix ?? "od";
  const easing = opts.easing ?? "cubic-bezier(0.22,1,0.36,1)";
  const stagger = opts.staggerMs ?? 0;
  const cell = opts.cellPx;

  const animations: Anims = [];
  let digitOrder = 0;
  const cols = plan.columns.map((col, i) => {
    if (col.type === "static") {
      return `<span class="${prefix}-static">${escapeHtml(col.char)}</span>`;
    }
    if (col.steps === 0) {
      // Unchanged digit — no reel needed.
      return `<span class="${prefix}-cell"><span class="${prefix}-d">${col.endDigit}</span></span>`;
    }
    // Build the digit sequence the reel passes through, laid out so index 0 (the
    // resting position, translateY 0) is the FINAL digit and index `steps` is the
    // start. Rolling from -steps*cell up to 0 sweeps start → … → end.
    const seq: number[] = [];
    for (let j = 0; j <= col.steps; j++) {
      seq.push(col.up ? (col.startDigit + j) % 10 : ((col.startDigit - j) % 10 + 10) % 10);
    }
    seq.reverse(); // index 0 = end (rest), index steps = start
    const cls = `${prefix}-s${i}`;
    const stripInner = seq.map((d) => `<span class="${prefix}-d">${d}</span>`).join("");
    animations.push({
      selector: `.${cls}`, property: "translateY",
      from: `-${col.steps * cell}px`, to: "0px",
      duration: opts.durationMs, delay: digitOrder * stagger, easing,
    });
    digitOrder++;
    return `<span class="${prefix}-cell"><span class="${prefix}-strip ${cls}">${stripInner}</span></span>`;
  }).join("");

  const css = `.${prefix}-row { display: inline-flex; align-items: flex-start; line-height: 1; font-variant-numeric: tabular-nums; }
  .${prefix}-cell { display: inline-block; height: ${cell}px; overflow: hidden; }
  .${prefix}-strip { display: block; }
  .${prefix}-d { display: block; height: ${cell}px; line-height: ${cell}px; text-align: center; }
  .${prefix}-static { display: inline-block; height: ${cell}px; line-height: ${cell}px; }`;

  return { html: `<span class="${prefix}-row">${cols}</span>`, animations, css };
}
