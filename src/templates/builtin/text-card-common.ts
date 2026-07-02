/**
 * Shared scaffolding for the creative-pack text cards (docs/86, DM-1531):
 * `title-card`, `quote`, `caption`, `cta`. Each is an ordinary generator template
 * (HTML/CSS + intra-frame `animations` run through `runSingleFrameGenerator`), so
 * they share three things: a light/dark theme resolver, a staggered enter-reveal
 * builder (the fade-up / pop motion the kinetic-text + lower-third templates use),
 * and the safe-area body padding (so content honors a format's `safeInset`,
 * DM-1537). No new rendering code — they inherit every fidelity fix, reduced-
 * motion degradation, and cross-engine safety from the pipeline.
 */

import type { Anims } from "../../cli/animate.js";
import { safeAreaPadding, formatScaleFactor, type SafeInset } from "../formats.js";
import { resolveMotionPreset } from "../../animation/motion-presets.js";

/**
 * The adaptive per-ratio scale factor (docs/91, DM-1541) a text card applies to
 * its authored font sizes / spacing. A thin re-export of {@link formatScaleFactor}
 * so the cards import their two format helpers (`cardHeadCss` + this) from one
 * module. Returns exactly `1` when no format is chosen (`safeInset == null`), so
 * default output is byte-identical.
 */
export function cardScaleFactor(width: number, height: number, safeInset?: SafeInset): number {
  return formatScaleFactor(width, height, safeInset);
}

/**
 * Scale an authored px length by a card's adaptive scale factor and return a `px`
 * string (docs/91, DM-1541). Rounded to 0.01 px so the emitted CSS is stable;
 * with `sf === 1` it returns the integer unchanged (e.g. `fs(84, 1)` → `"84px"`),
 * keeping the no-format default byte-identical.
 */
export function fs(px: number, sf: number): string {
  return `${Math.round(px * sf * 100) / 100}px`;
}

/** Scale an authored px length by `sf`, returned as a rounded number (for markup
 *  that needs a bare number, e.g. an SVG `font-size` attribute). */
export function fsNum(px: number, sf: number): number {
  return Math.round(px * sf * 100) / 100;
}

/** Tabular-digit advance as a fraction of the cell (em). The number templates lay
 *  their value out with `font-variant-numeric: tabular-nums`; a digit's advance is
 *  ~0.6 em in the default sans. A hair over that (0.64) buys a small safety margin
 *  for the width-fit clamp below. */
const DIGIT_ADVANCE = 0.64;

/**
 * Cap an odometer's scaled cell size so the WHOLE number fits `availableW` px
 * (docs/91, DM-1541). A fixed-width number can't wrap, so the adaptive scale-up
 * would otherwise overflow a narrow 9:16 canvas and clip the value. `cols` is the
 * total column count (digits + separators + any prefix/suffix chars). Returns
 * `scaledCell` unchanged when the number already fits, and — since callers only
 * apply it under a chosen format — the no-format path stays byte-identical.
 */
export function fitOdometerCell(scaledCell: number, cols: number, availableW: number): number {
  if (cols <= 0 || availableW <= 0) return scaledCell;
  const maxCell = availableW / (cols * DIGIT_ADVANCE);
  return Math.round(Math.min(scaledCell, maxCell) * 100) / 100;
}

/** Resolved card colors for a theme, after any explicit overrides. */
export interface CardTheme {
  /** Surface behind the card content (a CSS color or gradient). */
  background: string;
  /** Primary text/foreground. */
  text: string;
  /** Secondary/muted text. */
  muted: string;
}

/**
 * Resolve a card's theme colors. `dark` (default) is a deep surface with light
 * text; `light` inverts. Any of `background`/`text` overrides wins (e.g. a brand
 * background or an explicit `textColor`), and `muted` is derived from `text` at
 * reduced opacity so it tracks the foreground.
 */
export function resolveCardTheme(
  theme: "dark" | "light",
  overrides: { background?: string; text?: string } = {},
): CardTheme {
  const dark = theme === "dark";
  const text = overrides.text ?? (dark ? "#f5f7fa" : "#0d1117");
  const background = overrides.background ?? (dark ? "#0b1020" : "#f6f8fa");
  // Muted = the foreground at ~62% — reads as secondary against either surface.
  const muted = dark ? "rgba(245,247,250,0.62)" : "rgba(13,17,23,0.60)";
  return { background, text, muted };
}

/** Options for {@link staggeredReveal}. */
export interface RevealOpts {
  /** `fade-up` (rise + fade) or `pop` (scale-overshoot + fade). Default `fade-up`. */
  style?: "fade-up" | "pop";
  /** Ms between successive items' starts. Default 120. */
  stagger?: number;
  /** Ms before the first item starts. Default 0. */
  startDelay?: number;
  /** Per-item animation duration (ms). Default 600. */
  duration?: number;
  /** Rise distance (px) for `fade-up`. Default 24. */
  rise?: number;
}

/**
 * Build a staggered enter animation (one entry per selector), fading each element
 * in as it rises (`fade-up`) or pops (`pop`). The per-element motion comes from
 * the shared **motion preset** vocabulary (DM-1526) — `fade-up`/`pop` — so opacity
 * is FUSED into the transform track (DM-1512/1513, can't desync under Firefox
 * OMTA) and the curves match the rest of the library. Elements sit at the `from`
 * state until their turn; reduced-motion degrades to the final state. Returns `[]`
 * for an empty selector list.
 */
export function staggeredReveal(selectors: string[], opts: RevealOpts = {}): Anims {
  const style = opts.style ?? "fade-up";
  const stagger = opts.stagger ?? 120;
  const duration = opts.duration ?? 600;
  const startDelay = opts.startDelay ?? 0;
  const rise = opts.rise ?? 24;
  const m = resolveMotionPreset(style === "pop" ? "pop" : "fade-up", { distance: rise });
  return selectors.map((selector, i) => ({
    selector,
    property: m.property,
    from: m.from,
    to: m.to,
    duration,
    delay: startDelay + i * stagger,
    easing: m.easing,
    ...(m.transformOrigin != null ? { transformOrigin: m.transformOrigin } : {}),
    ...(m.fuse != null ? { fuse: m.fuse } : {}),
  }));
}

/** The end time (ms) of a staggered reveal over `count` items — used to size the
 *  card's total on-screen `holdMs` so the reveal finishes before the hold ends. */
export function revealEndMs(count: number, opts: RevealOpts = {}): number {
  if (count <= 0) return 0;
  const stagger = opts.stagger ?? 120;
  const duration = opts.duration ?? 600;
  const startDelay = opts.startDelay ?? 0;
  return startDelay + (count - 1) * stagger + duration;
}

/**
 * The shared reset + body CSS every text card opens with: a box-sizing reset, the
 * canvas size, the font, and the safe-area padding (per-side max of the card's own
 * margin and a format's `safeInset`, DM-1537). Callers append their own rules and
 * close the `<style>`.
 */
export function cardHeadCss(p: {
  width: number; height: number; fontFamily: string;
}, defaultPadding: number, safeInset: SafeInset | undefined): string {
  const d = defaultPadding;
  const padding = safeAreaPadding({ top: d, right: d, bottom: d, left: d }, safeInset);
  return `* { margin: 0; box-sizing: border-box; }
  html, body { width: ${p.width}px; height: ${p.height}px; }
  body { font-family: ${p.fontFamily}; padding: ${padding}; }`;
}

/** Default system font stack shared by the text cards (matches lower-third). */
export const CARD_FONT_STACK = "-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif";
