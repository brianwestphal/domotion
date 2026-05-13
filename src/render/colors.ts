/**
 * CSS color parsing, comparison, and serialization.
 *
 * `parseColor` handles every shape Chromium's computed-style serializer can
 * emit (rgb/rgba, 3/4/6/8-digit hex, named colors, and the `color()` form for
 * srgb / srgb-linear that wide-gamut inputs collapse to), plus the named-color
 * subset that survives non-computed paths. `colorStr` is the inverse used by
 * SVG emission. `shadeColor` is the HSL-domain lighten/darken used for border
 * groove / ridge / inset / outset bevels.
 */

import { r } from "./format.js";

export interface RGBA { r: number; g: number; b: number; a: number }

export function parseColor(css: string): RGBA | null {
  if (css === "" || css === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  // rgb()/rgba() — Chromium uses this form for srgb colors.
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(css);
  if (m != null) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? +m[4] : 1 };
  // #rrggbb / #rrggbbaa — hex.
  const h = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(css);
  if (h != null) {
    const a = h[2] != null ? parseInt(h[2], 16) / 255 : 1;
    return { r: parseInt(h[1].slice(0, 2), 16), g: parseInt(h[1].slice(2, 4), 16), b: parseInt(h[1].slice(4, 6), 16), a };
  }
  // #rgb / #rgba — short hex (each digit doubles per CSS spec: #abc → #aabbcc).
  const hs = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i.exec(css);
  if (hs != null) {
    const a = hs[4] != null ? parseInt(hs[4] + hs[4], 16) / 255 : 1;
    return {
      r: parseInt(hs[1] + hs[1], 16),
      g: parseInt(hs[2] + hs[2], 16),
      b: parseInt(hs[3] + hs[3], 16),
      a,
    };
  }
  // CSS named colors (subset). Chromium's computed-style serializer normalises
  // these to rgb()/rgba(), so this branch only fires for raw author input
  // reaching `parseColor` (e.g. test fixtures using `parseConicGradient`
  // directly, or any non-computed-style code path). Full CSS named-color
  // table is large; cover the common ones here.
  const named = NAMED_COLORS[css.toLowerCase()];
  if (named != null) return { ...named };
  // color(srgb r g b [/ a]) — produced by the capture-side normalizer for
  // wide-gamut inputs (oklch/lab/color(display-p3)/color-mix). Values are 0..1
  // floats, sometimes negative or >1 when the source was out-of-srgb-gamut;
  // clamp before scaling to 0..255.
  // DM-519: float pattern allows scientific notation (e.g. `-6.85e-9`).
  // Chromium emits these for color-mix interpolations whose intermediate
  // value is near zero in some channel; without `[eE][+-]?\d+`, parseColor
  // returns null and the renderer drops the fill (visible on
  // `19-deep-color-mix` srgb-linear swatch — bg silently empty).
  const cs = /^color\(srgb\s+(-?[\d.]+(?:[eE][+-]?\d+)?)\s+(-?[\d.]+(?:[eE][+-]?\d+)?)\s+(-?[\d.]+(?:[eE][+-]?\d+)?)(?:\s*\/\s*([\d.]+(?:[eE][+-]?\d+)?))?\)$/i.exec(css);
  if (cs != null) {
    const clamp = (v: number): number => Math.max(0, Math.min(1, v));
    return {
      r: Math.round(clamp(+cs[1]) * 255),
      g: Math.round(clamp(+cs[2]) * 255),
      b: Math.round(clamp(+cs[3]) * 255),
      a: cs[4] != null ? +cs[4] : 1,
    };
  }
  // DM-519: color(srgb-linear r g b [/ a]) — Chromium returns this form for
  // `color-mix(in srgb-linear, ...)` even after our srgb-wrapped normalize
  // probe (the probe converts to srgb, but Chromium's serialization can keep
  // the original space when it was in the source). Apply the inverse-EOTF
  // transform (linear → sRGB) so 0.215 in linear becomes 0.5 in srgb (i.e.
  // ~128/255), matching Chromium's painted output for `color-mix(in
  // srgb-linear, red, blue)`.
  const csl = /^color\(srgb-linear\s+(-?[\d.]+(?:[eE][+-]?\d+)?)\s+(-?[\d.]+(?:[eE][+-]?\d+)?)\s+(-?[\d.]+(?:[eE][+-]?\d+)?)(?:\s*\/\s*([\d.]+(?:[eE][+-]?\d+)?))?\)$/i.exec(css);
  if (csl != null) {
    const clamp = (v: number): number => Math.max(0, Math.min(1, v));
    const linToSrgb = (lin: number): number => {
      const l = clamp(lin);
      return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    };
    return {
      r: Math.round(linToSrgb(+csl[1]) * 255),
      g: Math.round(linToSrgb(+csl[2]) * 255),
      b: Math.round(linToSrgb(+csl[3]) * 255),
      a: csl[4] != null ? +csl[4] : 1,
    };
  }
  return null;
}

export function colorStr(c: RGBA): string {
  return c.a < 1 ? `rgba(${c.r},${c.g},${c.b},${r(c.a)})` : `rgb(${c.r},${c.g},${c.b})`;
}

export function sameColor(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && Math.abs(a.a - b.a) < 0.01;
}

/**
 * Lighten (positive delta) or darken (negative delta) a color in HSL space.
 * Used for border-style groove/ridge/inset/outset where the border color is
 * lightened or darkened per side to produce the 3D bevel look Chromium paints.
 */
export function shadeColor(c: RGBA, delta: number): RGBA {
  const r255 = c.r / 255, g255 = c.g / 255, b255 = c.b / 255;
  const max = Math.max(r255, g255, b255);
  const min = Math.min(r255, g255, b255);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r255: h = ((g255 - b255) / d + (g255 < b255 ? 6 : 0)) / 6; break;
      case g255: h = ((b255 - r255) / d + 2) / 6; break;
      default:   h = ((r255 - g255) / d + 4) / 6;
    }
  }
  const newL = Math.max(0, Math.min(1, l + delta / 100));
  // HSL -> RGB.
  if (s === 0) {
    const v = Math.round(newL * 255);
    return { r: v, g: v, b: v, a: c.a };
  }
  const q = newL < 0.5 ? newL * (1 + s) : newL + s - newL * s;
  const p = 2 * newL - q;
  const hueToRgb = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hueToRgb(h + 1 / 3) * 255),
    g: Math.round(hueToRgb(h) * 255),
    b: Math.round(hueToRgb(h - 1 / 3) * 255),
    a: c.a,
  };
}

const NAMED_COLORS: Record<string, RGBA> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  cyan: { r: 0, g: 255, b: 255, a: 1 },
  aqua: { r: 0, g: 255, b: 255, a: 1 },
  magenta: { r: 255, g: 0, b: 255, a: 1 },
  fuchsia: { r: 255, g: 0, b: 255, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  maroon: { r: 128, g: 0, b: 0, a: 1 },
  olive: { r: 128, g: 128, b: 0, a: 1 },
  lime: { r: 0, g: 255, b: 0, a: 1 },
  teal: { r: 0, g: 128, b: 128, a: 1 },
  navy: { r: 0, g: 0, b: 128, a: 1 },
  purple: { r: 128, g: 0, b: 128, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  pink: { r: 255, g: 192, b: 203, a: 1 },
};
