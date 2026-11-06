/**
 * Small read-only helpers for inspecting an already-rendered SVG document's
 * metadata — its intrinsic size and (for an animated SVG) its play length.
 *
 * DM-1339: these were copy-pasted across `composite.ts` (`svgIntrinsicSize`),
 * `cli/composite.ts` (`svgSize` + `detectPeriodMs`), and
 * `templates/builtin/device-mockup.ts` (`svgSize` + `sceneDurationMs`). Extracted
 * here so a future regex fix lands in one place; callers apply their own
 * not-found fallback.
 */

import { formatNumber } from "../render/format.js";

// CSS absolute-length units in CSS px (css-values-4 §6.2), the conversions
// `SVGLengthContext` applies to a root `width`/`height`.
const ABSOLUTE_UNIT_PX: Readonly<Record<string, number>> = {
  "": 1,
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 96 / 6,
};
const SVG_NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const LENGTH_RE = new RegExp(`^(${SVG_NUMBER})([a-z]*|%)$`, "i");
const VIEWBOX_RE = new RegExp(
  `^(${SVG_NUMBER})(?:\\s*,\\s*|\\s+)(${SVG_NUMBER})(?:\\s*,\\s*|\\s+)(${SVG_NUMBER})(?:\\s*,\\s*|\\s+)(${SVG_NUMBER})$`,
);

/** One attribute value from an opening tag, either quote style; `undefined` when absent. */
function readAttribute(tag: string, name: string): string | undefined {
  // `(?<=\s)` keeps `width` from matching inside `stroke-width` / `data-width`.
  const m = new RegExp(`(?<=\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m == null ? undefined : (m[1] ?? m[2]).trim();
}

/**
 * A root `width`/`height` as Blink's `SVGSVGElement::IntrinsicWidth` reads it:
 * an absolute length in px, clamped at 0. A percentage, `auto`, a missing value
 * and (here, without computed style) a font-relative unit yield no natural
 * dimension.
 */
function naturalDimension(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const m = LENGTH_RE.exec(value);
  if (m == null) return undefined;
  const scale = ABSOLUTE_UNIT_PX[m[2].toLowerCase()];
  if (scale == null) return undefined;
  return Math.max(0, Number(m[1]) * scale);
}

/**
 * The single intrinsic-size reader for an SVG document's root `<svg>`, shared by
 * every tool that sizes an SVG (composite, storyboard, templates, Studio,
 * svg-to-image / svg-to-video, the scrubber and svg-review).
 *
 * Precedence follows Blink's `LayoutSVGRoot::UnscaledNaturalSizingInfo`
 * (chromium 7d859f27, `core/layout/svg/layout_svg_root.cc:74-103`, with
 * `SVGSVGElement::IntrinsicWidth/Height` in `core/svg/svg_svg_element.cc:629-649`):
 * non-percentage `width`/`height` lengths ARE the natural size, and the
 * `viewBox` only supplies a natural aspect ratio when that size is empty. So
 * `width="640" height="360" viewBox="0 0 1280 720"` is 640×360 — what Chromium
 * paints for the document — and a single declared dimension takes the other from
 * the viewBox ratio.
 *
 * One deliberate departure: with no natural size at all (both dimensions
 * percentage, `auto`, missing or 0) Blink has only a ratio and a consumer falls
 * back to its default object size; these tools need a canvas, so the viewBox
 * extent is returned. `null` when there is neither a usable size nor a viewBox.
 */
export function parseSvgIntrinsicSize(svg: string): { w: number; h: number } | null {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const w = naturalDimension(readAttribute(open, "width"));
  const h = naturalDimension(readAttribute(open, "height"));
  if (w != null && h != null && w > 0 && h > 0) return { w, h };
  const vb = VIEWBOX_RE.exec(readAttribute(open, "viewBox") ?? "");
  const vbW = vb == null ? NaN : Number(vb[3]);
  const vbH = vb == null ? NaN : Number(vb[4]);
  if (!(vbW > 0 && vbH > 0)) return null;
  if (w != null && w > 0 && h == null) return { w, h: (w * vbH) / vbW };
  if (h != null && h > 0 && w == null) return { w: (h * vbW) / vbH, h };
  return { w: vbW, h: vbH };
}

/**
 * An animated SVG's own play length (ms): from its `--scene-dur` custom property
 * when present (full-mode casts / `animate` output), else the longest `animation:`
 * shorthand duration (incremental-mode casts carry no `--scene-dur` but every
 * line/cursor track runs at the scene period). `undefined` when neither is found
 * (a static SVG). The first `<time>` in an `animation:` shorthand is its duration.
 */
export function detectAnimationPeriodMs(svg: string): number | undefined {
  const scene = /--scene-dur:\s*([\d.]+)s/i.exec(svg);
  if (scene != null) return Math.round(parseFloat(scene[1]) * 1000);
  let maxSec = 0;
  for (const m of svg.matchAll(/animation:\s*[^;}]*?\b([\d.]+)s\b/gi)) {
    const s = parseFloat(m[1]);
    if (s > maxSec) maxSec = s;
  }
  return maxSec > 0 ? Math.round(maxSec * 1000) : undefined;
}

/** Format a number for CSS/SVG output: up to 4 decimals, trailing zeros trimmed. */
export const fmt = (n: number): string => formatNumber(n, 4);

/** Clamp a percentage to the [0, 100] range. */
export const clampPct = (p: number): number => (p < 0 ? 0 : p > 100 ? 100 : p);
