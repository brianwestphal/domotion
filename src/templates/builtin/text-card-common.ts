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
import { safeAreaPadding, type SafeInset } from "../formats.js";
import { resolveMotionPreset } from "../../animation/motion-presets.js";

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
