/**
 * The CSS transform of an `<img>` SVG document's root `<svg>`, resolved from
 * its source attributes into an SVG transform list and a transform origin.
 *
 * Blink (chromium 7d859f27): the outermost `<svg>` lays out as `LayoutSVGRoot`,
 * a CSS replaced box, so its transform is an ordinary CSS box transform.
 * - The `transform` attribute is a presentation attribute for the CSS
 *   `transform` property (`core/svg/svg_transformable_element.cc:38-41,
 *   50-52`), and `transform-origin` is a presentation attribute too
 *   (`core/svg/svg_element.cc:381`). A `style` declaration overrides either,
 *   like any author declaration over a presentation attribute.
 * - `ComputedStyle::ApplyTransform` (`core/style/computed_style.cc:1429-1490`)
 *   composes `translate(origin) · translate · rotate · scale · transform ·
 *   translate(-origin)`, with percentages resolved against the reference box.
 * - The initial `transform-origin` is `50% 50%`; the UA rule that sets `0 0`
 *   (`core/css/svg.css:88-90`) only matches an svg whose parent is an SVG
 *   element.
 * - `transform-box` picks the reference box. For a CSS box, `fill-box` is
 *   used as `content-box` and `stroke-box` / `view-box` as `border-box`
 *   (`ComputedStyle::UsedTransformBox`, `core/style/computed_style.cc:1372`).
 *   The root of an SVG image has no border or padding, so every value
 *   resolves to the concrete object rect, which is what callers pass as `box`.
 *
 * Only the 2D subset is resolved: px lengths and percentages, the four angle
 * units, and the 2D transform functions. Anything else (`calc()`, font-relative
 * units, 3D functions, an axis form of `rotate`) returns `"unsupported"`, so
 * the caller can keep its previous output rather than paint a guess.
 */
import { formatNumberLoose } from "./format.js";

export interface ImageRootTransformInputs {
  /** The root's `transform` attribute (SVG transform-list syntax). */
  transformAttr: string | null;
  /** The root's `transform-origin` attribute. */
  transformOriginAttr: string | null;
  /** The root's `style` declarations, property names lowercased, last wins. */
  style: ReadonlyMap<string, string>;
}

export interface ResolvedImageRootTransform {
  /** SVG transform list in output px, applied about `origin`. */
  transform: string;
  origin: { x: number; y: number };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
const LENGTH_RE = new RegExp(`^(${NUMBER})(px|%)?$`, "i");
const ANGLE_RE = new RegExp(`^(${NUMBER})(deg|grad|rad|turn)?$`, "i");
const NUMBER_PCT_RE = new RegExp(`^(${NUMBER})(%)?$`);

const f = (n: number): string => formatNumberLoose(n, 6);

/** A `<length-percentage>` in px; a bare 0 is a valid length. */
function lengthPx(token: string, basis: number): number | null {
  const m = LENGTH_RE.exec(token.trim());
  if (m == null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  if (m[2] == null) return value === 0 ? 0 : null;
  return m[2] === "%" ? (value / 100) * basis : value;
}

/** An `<angle>` in degrees; a bare 0 is a valid angle. */
function angleDeg(token: string): number | null {
  const m = ANGLE_RE.exec(token.trim());
  if (m == null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2]?.toLowerCase();
  if (unit == null) return value === 0 ? 0 : null;
  if (unit === "deg") return value;
  if (unit === "grad") return value * 0.9;
  if (unit === "turn") return value * 360;
  return value * (180 / Math.PI);
}

/** A scale factor: a `<number>` or a `<percentage>`. */
function scaleFactor(token: string): number | null {
  const m = NUMBER_PCT_RE.exec(token.trim());
  if (m == null) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return m[2] === "%" ? value / 100 : value;
}

function plainNumber(token: string): number | null {
  const m = new RegExp(`^(${NUMBER})$`).exec(token.trim());
  return m == null ? null : Number(m[1]);
}

/** Split function arguments on commas; CSS transform functions are comma-separated. */
function commaArgs(raw: string): string[] | null {
  const parts = raw.split(",").map((part) => part.trim());
  return parts.some((part) => part === "") ? null : parts;
}

/** One CSS `<transform-function>` as an SVG transform, or null when unsupported. */
function cssFunctionToSvg(name: string, raw: string, box: Box): string | null {
  const args = commaArgs(raw);
  if (args == null) return null;
  const tan = (deg: number): number => Math.tan((deg * Math.PI) / 180);
  switch (name) {
    case "translate": {
      if (args.length > 2) return null;
      const x = lengthPx(args[0], box.w);
      const y = args.length === 2 ? lengthPx(args[1], box.h) : 0;
      return x == null || y == null ? null : `translate(${f(x)} ${f(y)})`;
    }
    case "translatex": {
      const x = args.length === 1 ? lengthPx(args[0], box.w) : null;
      return x == null ? null : `translate(${f(x)} 0)`;
    }
    case "translatey": {
      const y = args.length === 1 ? lengthPx(args[0], box.h) : null;
      return y == null ? null : `translate(0 ${f(y)})`;
    }
    case "scale": {
      if (args.length > 2) return null;
      const x = scaleFactor(args[0]);
      const y = args.length === 2 ? scaleFactor(args[1]) : x;
      return x == null || y == null ? null : `scale(${f(x)} ${f(y)})`;
    }
    case "scalex": {
      const x = args.length === 1 ? scaleFactor(args[0]) : null;
      return x == null ? null : `scale(${f(x)} 1)`;
    }
    case "scaley": {
      const y = args.length === 1 ? scaleFactor(args[0]) : null;
      return y == null ? null : `scale(1 ${f(y)})`;
    }
    case "rotate":
    case "rotatez": {
      const a = args.length === 1 ? angleDeg(args[0]) : null;
      return a == null ? null : `rotate(${f(a)})`;
    }
    case "skew": {
      if (args.length > 2) return null;
      const ax = angleDeg(args[0]);
      const ay = args.length === 2 ? angleDeg(args[1]) : 0;
      return ax == null || ay == null ? null : `matrix(1 ${f(tan(ay))} ${f(tan(ax))} 1 0 0)`;
    }
    case "skewx": {
      const a = args.length === 1 ? angleDeg(args[0]) : null;
      return a == null ? null : `skewX(${f(a)})`;
    }
    case "skewy": {
      const a = args.length === 1 ? angleDeg(args[0]) : null;
      return a == null ? null : `skewY(${f(a)})`;
    }
    case "matrix": {
      if (args.length !== 6) return null;
      const m = args.map(plainNumber);
      return m.some((v) => v == null || !Number.isFinite(v)) ? null : `matrix(${m.map((v) => f(v!)).join(" ")})`;
    }
    default:
      return null;
  }
}

/** A CSS `transform` value (`none` or a function list) as an SVG list. */
function cssTransformList(value: string, box: Box): string | null | "unsupported" {
  const source = value.trim();
  if (source === "" || source.toLowerCase() === "none") return null;
  const fnRe = /([a-zA-Z0-9]+)\(([^()]*)\)/g;
  if (/\S/.test(source.replace(fnRe, " "))) return "unsupported";
  const out: string[] = [];
  for (const m of source.matchAll(fnRe)) {
    const svg = cssFunctionToSvg(m[1].toLowerCase(), m[2], box);
    if (svg == null) return "unsupported";
    out.push(svg);
  }
  return out.join(" ");
}

function spaceArgs(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/** The individual `translate` property (`none` | `<lp> [<lp>]`; a z length is 3D). */
function translateProperty(value: string, box: Box): string | null | "unsupported" {
  const parts = spaceArgs(value);
  if (parts.length === 1 && parts[0].toLowerCase() === "none") return null;
  if (parts.length < 1 || parts.length > 2) return "unsupported";
  const x = lengthPx(parts[0], box.w);
  const y = parts.length === 2 ? lengthPx(parts[1], box.h) : 0;
  return x == null || y == null ? "unsupported" : `translate(${f(x)} ${f(y)})`;
}

/** The individual `rotate` property (`none` | `<angle>` | `z <angle>`). */
function rotateProperty(value: string): string | null | "unsupported" {
  const parts = spaceArgs(value);
  if (parts.length === 1 && parts[0].toLowerCase() === "none") return null;
  const angle =
    parts.length === 1
      ? angleDeg(parts[0])
      : parts.length === 2 && parts[0].toLowerCase() === "z"
        ? angleDeg(parts[1])
        : null;
  return angle == null ? "unsupported" : `rotate(${f(angle)})`;
}

/** The individual `scale` property (`none` | `<n-p> [<n-p>]`; a z factor is 3D). */
function scaleProperty(value: string): string | null | "unsupported" {
  const parts = spaceArgs(value);
  if (parts.length === 1 && parts[0].toLowerCase() === "none") return null;
  if (parts.length < 1 || parts.length > 2) return "unsupported";
  const x = scaleFactor(parts[0]);
  const y = parts.length === 2 ? scaleFactor(parts[1]) : x;
  return x == null || y == null ? "unsupported" : `scale(${f(x)} ${f(y)})`;
}

/**
 * A `transform-origin` value resolved against `box` (2D; a z offset is
 * ignored). One value sets x (or y, for `top`/`bottom`) with the other axis at
 * `center`; two values may come in either order when they are keywords.
 */
export function resolveTransformOrigin(value: string, box: Box): { x: number; y: number } | null {
  const parts = spaceArgs(value).map((part) => part.toLowerCase());
  if (parts.length < 1 || parts.length > 3) return null;
  const xKeyword: Record<string, number> = { left: 0, center: 0.5, right: 1 };
  const yKeyword: Record<string, number> = { top: 0, center: 0.5, bottom: 1 };
  let [first, second] = parts;
  if (second == null) {
    second = first === "top" || first === "bottom" ? first : "center";
    if (first === "top" || first === "bottom") first = "center";
  } else if (first in yKeyword && !(first in xKeyword) && (second in xKeyword || second === "center")) {
    [first, second] = [second, first];
  }
  const x = first in xKeyword ? xKeyword[first] * box.w : lengthPx(first, box.w);
  const y = second in yKeyword ? yKeyword[second] * box.h : lengthPx(second, box.h);
  if (x == null || y == null) return null;
  if (parts.length === 3 && lengthPx(parts[2], 0) == null) return null;
  return { x: box.x + x, y: box.y + y };
}

/**
 * Resolve the root's transform about its origin, or null when the root has
 * no transform. `"unsupported"` means a declaration this module cannot
 * resolve exactly.
 */
export function resolveImageRootTransform(
  inputs: ImageRootTransformInputs,
  box: Box,
): ResolvedImageRootTransform | null | "unsupported" {
  const parts: string[] = [];
  const individual: Array<[string, (value: string) => string | null | "unsupported"]> = [
    ["translate", (value) => translateProperty(value, box)],
    ["rotate", rotateProperty],
    ["scale", scaleProperty],
  ];
  for (const [name, resolve] of individual) {
    const value = inputs.style.get(name);
    if (value == null) continue;
    const svg = resolve(value);
    if (svg === "unsupported") return "unsupported";
    if (svg != null) parts.push(svg);
  }
  const styleTransform = inputs.style.get("transform");
  if (styleTransform != null) {
    const svg = cssTransformList(styleTransform, box);
    if (svg === "unsupported") return "unsupported";
    if (svg != null) parts.push(svg);
  } else if (inputs.transformAttr != null && inputs.transformAttr.trim() !== "") {
    // SVG transform-list syntax is already a valid SVG `transform` value.
    parts.push(inputs.transformAttr.trim());
  }
  if (parts.length === 0) return null;
  const originValue = inputs.style.get("transform-origin") ?? inputs.transformOriginAttr;
  const origin =
    originValue == null || originValue.trim() === ""
      ? { x: box.x + box.w / 2, y: box.y + box.h / 2 }
      : resolveTransformOrigin(originValue, box);
  if (origin == null) return "unsupported";
  return { transform: parts.join(" "), origin };
}
