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
  // CSS named colors. Chromium's computed-style serializer normalises these to
  // rgb()/rgba(), so this branch only fires for raw author input reaching
  // `parseColor` (e.g. gradient color stops parsed before computed-style
  // resolution, conic-gradient parsing, or any non-computed-style code path) —
  // where an unknown name silently dropped the fill. NAMED_COLORS is the
  // complete CSS Color 4 `<named-color>` set (148 keywords), generated from
  // Chromium's own `getComputedStyle` output so every value matches Chrome's
  // paint (see `tools/scratch/probe-named-colors.mjs`).
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

// The complete CSS Color 4 `<named-color>` set (148 keywords, including the
// `gray`/`grey` spelling pairs and the `aqua`/`cyan` + `fuchsia`/`magenta`
// synonyms). Values were generated from Chromium's own `getComputedStyle`
// serialization so they match Chrome's painted output exactly; regenerate with
// `node tools/scratch/probe-named-colors.mjs` if the CSS color list ever grows.
// `transparent` and the CSS system colors (Canvas, ButtonText, …) are
// intentionally excluded: `transparent` is handled at the top of parseColor,
// and system colors aren't `<named-color>`s.
const NAMED_COLORS: Record<string, RGBA> = {
  aliceblue: { r: 240, g: 248, b: 255, a: 1 },
  antiquewhite: { r: 250, g: 235, b: 215, a: 1 },
  aqua: { r: 0, g: 255, b: 255, a: 1 },
  aquamarine: { r: 127, g: 255, b: 212, a: 1 },
  azure: { r: 240, g: 255, b: 255, a: 1 },
  beige: { r: 245, g: 245, b: 220, a: 1 },
  bisque: { r: 255, g: 228, b: 196, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  blanchedalmond: { r: 255, g: 235, b: 205, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  blueviolet: { r: 138, g: 43, b: 226, a: 1 },
  brown: { r: 165, g: 42, b: 42, a: 1 },
  burlywood: { r: 222, g: 184, b: 135, a: 1 },
  cadetblue: { r: 95, g: 158, b: 160, a: 1 },
  chartreuse: { r: 127, g: 255, b: 0, a: 1 },
  chocolate: { r: 210, g: 105, b: 30, a: 1 },
  coral: { r: 255, g: 127, b: 80, a: 1 },
  cornflowerblue: { r: 100, g: 149, b: 237, a: 1 },
  cornsilk: { r: 255, g: 248, b: 220, a: 1 },
  crimson: { r: 220, g: 20, b: 60, a: 1 },
  cyan: { r: 0, g: 255, b: 255, a: 1 },
  darkblue: { r: 0, g: 0, b: 139, a: 1 },
  darkcyan: { r: 0, g: 139, b: 139, a: 1 },
  darkgoldenrod: { r: 184, g: 134, b: 11, a: 1 },
  darkgray: { r: 169, g: 169, b: 169, a: 1 },
  darkgreen: { r: 0, g: 100, b: 0, a: 1 },
  darkgrey: { r: 169, g: 169, b: 169, a: 1 },
  darkkhaki: { r: 189, g: 183, b: 107, a: 1 },
  darkmagenta: { r: 139, g: 0, b: 139, a: 1 },
  darkolivegreen: { r: 85, g: 107, b: 47, a: 1 },
  darkorange: { r: 255, g: 140, b: 0, a: 1 },
  darkorchid: { r: 153, g: 50, b: 204, a: 1 },
  darkred: { r: 139, g: 0, b: 0, a: 1 },
  darksalmon: { r: 233, g: 150, b: 122, a: 1 },
  darkseagreen: { r: 143, g: 188, b: 143, a: 1 },
  darkslateblue: { r: 72, g: 61, b: 139, a: 1 },
  darkslategray: { r: 47, g: 79, b: 79, a: 1 },
  darkslategrey: { r: 47, g: 79, b: 79, a: 1 },
  darkturquoise: { r: 0, g: 206, b: 209, a: 1 },
  darkviolet: { r: 148, g: 0, b: 211, a: 1 },
  deeppink: { r: 255, g: 20, b: 147, a: 1 },
  deepskyblue: { r: 0, g: 191, b: 255, a: 1 },
  dimgray: { r: 105, g: 105, b: 105, a: 1 },
  dimgrey: { r: 105, g: 105, b: 105, a: 1 },
  dodgerblue: { r: 30, g: 144, b: 255, a: 1 },
  firebrick: { r: 178, g: 34, b: 34, a: 1 },
  floralwhite: { r: 255, g: 250, b: 240, a: 1 },
  forestgreen: { r: 34, g: 139, b: 34, a: 1 },
  fuchsia: { r: 255, g: 0, b: 255, a: 1 },
  gainsboro: { r: 220, g: 220, b: 220, a: 1 },
  ghostwhite: { r: 248, g: 248, b: 255, a: 1 },
  gold: { r: 255, g: 215, b: 0, a: 1 },
  goldenrod: { r: 218, g: 165, b: 32, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  greenyellow: { r: 173, g: 255, b: 47, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  honeydew: { r: 240, g: 255, b: 240, a: 1 },
  hotpink: { r: 255, g: 105, b: 180, a: 1 },
  indianred: { r: 205, g: 92, b: 92, a: 1 },
  indigo: { r: 75, g: 0, b: 130, a: 1 },
  ivory: { r: 255, g: 255, b: 240, a: 1 },
  khaki: { r: 240, g: 230, b: 140, a: 1 },
  lavender: { r: 230, g: 230, b: 250, a: 1 },
  lavenderblush: { r: 255, g: 240, b: 245, a: 1 },
  lawngreen: { r: 124, g: 252, b: 0, a: 1 },
  lemonchiffon: { r: 255, g: 250, b: 205, a: 1 },
  lightblue: { r: 173, g: 216, b: 230, a: 1 },
  lightcoral: { r: 240, g: 128, b: 128, a: 1 },
  lightcyan: { r: 224, g: 255, b: 255, a: 1 },
  lightgoldenrodyellow: { r: 250, g: 250, b: 210, a: 1 },
  lightgray: { r: 211, g: 211, b: 211, a: 1 },
  lightgreen: { r: 144, g: 238, b: 144, a: 1 },
  lightgrey: { r: 211, g: 211, b: 211, a: 1 },
  lightpink: { r: 255, g: 182, b: 193, a: 1 },
  lightsalmon: { r: 255, g: 160, b: 122, a: 1 },
  lightseagreen: { r: 32, g: 178, b: 170, a: 1 },
  lightskyblue: { r: 135, g: 206, b: 250, a: 1 },
  lightslategray: { r: 119, g: 136, b: 153, a: 1 },
  lightslategrey: { r: 119, g: 136, b: 153, a: 1 },
  lightsteelblue: { r: 176, g: 196, b: 222, a: 1 },
  lightyellow: { r: 255, g: 255, b: 224, a: 1 },
  lime: { r: 0, g: 255, b: 0, a: 1 },
  limegreen: { r: 50, g: 205, b: 50, a: 1 },
  linen: { r: 250, g: 240, b: 230, a: 1 },
  magenta: { r: 255, g: 0, b: 255, a: 1 },
  maroon: { r: 128, g: 0, b: 0, a: 1 },
  mediumaquamarine: { r: 102, g: 205, b: 170, a: 1 },
  mediumblue: { r: 0, g: 0, b: 205, a: 1 },
  mediumorchid: { r: 186, g: 85, b: 211, a: 1 },
  mediumpurple: { r: 147, g: 112, b: 219, a: 1 },
  mediumseagreen: { r: 60, g: 179, b: 113, a: 1 },
  mediumslateblue: { r: 123, g: 104, b: 238, a: 1 },
  mediumspringgreen: { r: 0, g: 250, b: 154, a: 1 },
  mediumturquoise: { r: 72, g: 209, b: 204, a: 1 },
  mediumvioletred: { r: 199, g: 21, b: 133, a: 1 },
  midnightblue: { r: 25, g: 25, b: 112, a: 1 },
  mintcream: { r: 245, g: 255, b: 250, a: 1 },
  mistyrose: { r: 255, g: 228, b: 225, a: 1 },
  moccasin: { r: 255, g: 228, b: 181, a: 1 },
  navajowhite: { r: 255, g: 222, b: 173, a: 1 },
  navy: { r: 0, g: 0, b: 128, a: 1 },
  oldlace: { r: 253, g: 245, b: 230, a: 1 },
  olive: { r: 128, g: 128, b: 0, a: 1 },
  olivedrab: { r: 107, g: 142, b: 35, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  orangered: { r: 255, g: 69, b: 0, a: 1 },
  orchid: { r: 218, g: 112, b: 214, a: 1 },
  palegoldenrod: { r: 238, g: 232, b: 170, a: 1 },
  palegreen: { r: 152, g: 251, b: 152, a: 1 },
  paleturquoise: { r: 175, g: 238, b: 238, a: 1 },
  palevioletred: { r: 219, g: 112, b: 147, a: 1 },
  papayawhip: { r: 255, g: 239, b: 213, a: 1 },
  peachpuff: { r: 255, g: 218, b: 185, a: 1 },
  peru: { r: 205, g: 133, b: 63, a: 1 },
  pink: { r: 255, g: 192, b: 203, a: 1 },
  plum: { r: 221, g: 160, b: 221, a: 1 },
  powderblue: { r: 176, g: 224, b: 230, a: 1 },
  purple: { r: 128, g: 0, b: 128, a: 1 },
  rebeccapurple: { r: 102, g: 51, b: 153, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  rosybrown: { r: 188, g: 143, b: 143, a: 1 },
  royalblue: { r: 65, g: 105, b: 225, a: 1 },
  saddlebrown: { r: 139, g: 69, b: 19, a: 1 },
  salmon: { r: 250, g: 128, b: 114, a: 1 },
  sandybrown: { r: 244, g: 164, b: 96, a: 1 },
  seagreen: { r: 46, g: 139, b: 87, a: 1 },
  seashell: { r: 255, g: 245, b: 238, a: 1 },
  sienna: { r: 160, g: 82, b: 45, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  skyblue: { r: 135, g: 206, b: 235, a: 1 },
  slateblue: { r: 106, g: 90, b: 205, a: 1 },
  slategray: { r: 112, g: 128, b: 144, a: 1 },
  slategrey: { r: 112, g: 128, b: 144, a: 1 },
  snow: { r: 255, g: 250, b: 250, a: 1 },
  springgreen: { r: 0, g: 255, b: 127, a: 1 },
  steelblue: { r: 70, g: 130, b: 180, a: 1 },
  tan: { r: 210, g: 180, b: 140, a: 1 },
  teal: { r: 0, g: 128, b: 128, a: 1 },
  thistle: { r: 216, g: 191, b: 216, a: 1 },
  tomato: { r: 255, g: 99, b: 71, a: 1 },
  turquoise: { r: 64, g: 224, b: 208, a: 1 },
  violet: { r: 238, g: 130, b: 238, a: 1 },
  wheat: { r: 245, g: 222, b: 179, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  whitesmoke: { r: 245, g: 245, b: 245, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  yellowgreen: { r: 154, g: 205, b: 50, a: 1 },
};
