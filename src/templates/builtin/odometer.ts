/**
 * Odometer digit-reel module (creative pack, docs/86 §4–5, DM-1532).
 *
 * The shared technique behind `counter` and `stat`: animate a number `from → to`
 * as rolling digit reels instead of per-frame text. Each digit column is a
 * clipped 1em-tall window over a vertical strip of digits (`0..9` repeated); the
 * strip is `translateY`-animated so the target digit lands in the window. That's
 * a pure transform animation — cross-engine-safe (docs/84), resolution-
 * independent (cells are sized in `em`), and reduced-motion friendly (the strip's
 * resting transform is the FINAL digit, so a stripped animation shows the right
 * number).
 *
 * Positions are indices into a strip of `0..9` repeated `CYCLES` times; the digit
 * shown at index `i` is `i % 10`. A CUSHION of whole cycles on either side lets a
 * column roll forward (count-up, strip moves up/negative) OR backward (count-
 * down) from the same strip without running off either end.
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
  | { type: "digit"; startIndex: number; endIndex: number; endDigit: number };

export interface OdometerPlan {
  /** The final displayed text (what a static/reduced-motion render shows). */
  toText: string;
  /** The starting displayed text (aligned to the same columns as `toText`). */
  fromText: string;
  /** Left-to-right columns. Digit columns carry the strip indices to roll between. */
  columns: OdometerColumn[];
  /** The strip is `0..9` repeated this many times (uniform across digit columns). */
  cycles: number;
}

// One whole 0..9 cycle of head-room on each side is provably enough: a column
// starts at index `digit + CUSHION*10` (∈[10,19]) and rolls at most ±9 (a single-
// digit wrap), so every reachable index stays within [0, ODOMETER_CYCLES*10).
// Keeping it tight matters — each cell is a rendered glyph, so fewer cycles =
// smaller SVG (DM-1532).
const CUSHION = 1;
export const ODOMETER_CYCLES = CUSHION * 2 + 2; // total cycles rendered per strip (=4)

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

/**
 * Plan the odometer for `from → to`: align both to the same column template and,
 * for each digit column, compute the strip indices to roll between (forward for a
 * count-up, backward for a count-down; unchanged digits don't move). Non-digit
 * characters (separators, decimal point, sign) become static columns.
 */
export function planOdometer(from: number, to: number, opts: OdometerFormat = {}): OdometerPlan {
  const decimals = opts.decimals ?? 0;
  const width = Math.max(intDigitCount(from, decimals), intDigitCount(to, decimals));
  const fromText = formatNumber(from, opts, width);
  const toText = formatNumber(to, opts, width);
  const up = to >= from;
  const columns: OdometerColumn[] = [];
  // fromText and toText share structure (same width/format) → aligned char-for-char.
  const len = Math.max(fromText.length, toText.length);
  for (let i = 0; i < len; i++) {
    const fc = fromText[i] ?? toText[i];
    const tc = toText[i] ?? fc;
    if (tc >= "0" && tc <= "9" && fc >= "0" && fc <= "9") {
      const startDigit = fc.charCodeAt(0) - 48;
      const endDigit = tc.charCodeAt(0) - 48;
      const startIndex = startDigit + CUSHION * 10;
      const dist = up ? (endDigit - startDigit + 10) % 10 : (startDigit - endDigit + 10) % 10;
      const endIndex = up ? startIndex + dist : startIndex - dist;
      columns.push({ type: "digit", startIndex, endIndex, endDigit });
    } else {
      columns.push({ type: "static", char: tc });
    }
  }
  return { toText, fromText, columns, cycles: ODOMETER_CYCLES };
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

/**
 * Plan an odometer between two clock strings (timer mode). The two are aligned on
 * their right edge and left-padded with the FROM/TO's own leading char so the
 * colons line up; every digit rolls, the `:` separators stay static.
 */
export function planTimer(fromSeconds: number, toSeconds: number): OdometerPlan {
  const rawFrom = formatTimer(fromSeconds);
  const rawTo = formatTimer(toSeconds);
  const len = Math.max(rawFrom.length, rawTo.length);
  const fromText = rawFrom.padStart(len, "0");
  const toText = rawTo.padStart(len, "0");
  const up = toSeconds >= fromSeconds;
  const columns: OdometerColumn[] = [];
  for (let i = 0; i < len; i++) {
    const fc = fromText[i];
    const tc = toText[i];
    if (tc >= "0" && tc <= "9" && fc >= "0" && fc <= "9") {
      const startDigit = fc.charCodeAt(0) - 48;
      const endDigit = tc.charCodeAt(0) - 48;
      const startIndex = startDigit + CUSHION * 10;
      const dist = up ? (endDigit - startDigit + 10) % 10 : (startDigit - endDigit + 10) % 10;
      const endIndex = up ? startIndex + dist : startIndex - dist;
      columns.push({ type: "digit", startIndex, endIndex, endDigit });
    } else {
      columns.push({ type: "static", char: tc });
    }
  }
  return { toText, fromText, columns, cycles: ODOMETER_CYCLES };
}

/** Options for {@link buildOdometerMarkup}. */
export interface OdometerMarkupOptions {
  /** Unique-per-document class prefix for the strips (default "od"). */
  prefix?: string;
  /** Roll duration (ms). */
  durationMs: number;
  /** CSS easing for the roll. Default a decelerating ease-out. */
  easing?: string;
  /** Per-digit-column stagger (ms), cascading left→right. Default 0. */
  staggerMs?: number;
}

/** The markup + animations for an odometer plan. */
export interface OdometerMarkup {
  /** The `<span class="od-row">…</span>` markup (digit reels + static chars). */
  html: string;
  /** The `translateY` animations, one per digit column. */
  animations: Anims;
  /** The `<style>` rules the odometer needs (scoped to `prefix`). */
  css: string;
}

/**
 * Turn a plan into HTML + intra-frame animations. Each digit column is a 1em-tall
 * clipped window over a strip of `0..9` repeated `cycles` times; the strip rests
 * at its FINAL index (so a static / reduced-motion render shows the right number)
 * and the animation rolls it from the start index. Cells are sized in `em`, so
 * the whole odometer scales with `font-size`.
 */
export function buildOdometerMarkup(plan: OdometerPlan, opts: OdometerMarkupOptions): OdometerMarkup {
  const prefix = opts.prefix ?? "od";
  const easing = opts.easing ?? "cubic-bezier(0.22,1,0.36,1)";
  const stagger = opts.staggerMs ?? 0;
  const stripDigits = Array.from({ length: plan.cycles * 10 }, (_, i) => i % 10);
  const stripInner = stripDigits.map((d) => `<span class="${prefix}-d">${d}</span>`).join("");

  const animations: Anims = [];
  let digitOrder = 0;
  const cols = plan.columns.map((col, i) => {
    if (col.type === "static") {
      return `<span class="${prefix}-static">${escapeHtml(col.char)}</span>`;
    }
    const cls = `${prefix}-s${i}`;
    // Rest at the final position; the animation rolls in from the start index.
    const rest = `transform:translateY(-${col.endIndex}em)`;
    if (col.startIndex !== col.endIndex) {
      animations.push({
        selector: `.${cls}`, property: "translateY",
        from: `-${col.startIndex}em`, to: `-${col.endIndex}em`,
        duration: opts.durationMs, delay: digitOrder * stagger, easing,
      });
    }
    digitOrder++;
    return `<span class="${prefix}-cell"><span class="${prefix}-strip ${cls}" style="${rest}">${stripInner}</span></span>`;
  }).join("");

  const css = `.${prefix}-row { display: inline-flex; align-items: baseline; line-height: 1; font-variant-numeric: tabular-nums; }
  .${prefix}-cell { display: inline-block; height: 1em; overflow: hidden; }
  .${prefix}-strip { display: flex; flex-direction: column; }
  .${prefix}-d { height: 1em; line-height: 1; text-align: center; }
  .${prefix}-static { display: inline-block; }`;

  return { html: `<span class="${prefix}-row">${cols}</span>`, animations, css };
}
