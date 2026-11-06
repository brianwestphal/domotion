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
 * Values: px, absolute units, percentages, `em` / `rem` (against the root's
 * font-size, which is also the document root's), the four angle units, and
 * `calc()` over them. Every transform function is resolved, the 3D ones
 * included. The image root paints into a flat picture with no perspective,
 * so a 3D matrix without perspective terms flattens exactly to its 2D affine
 * part: the rasterizer maps (x, y, 0, 1) through the 4x4 matrix, and the z
 * row and column never reach the screen. The functions are composed with
 * the matrices of the CSS Transforms 2 spec, which Blink's `TransformOperations`
 * build. A composed matrix whose w row varies across the plane (a
 * `perspective(<length>)` followed by a rotation out of the plane, or a
 * `matrix3d` with m14 / m24 terms) is projective and cannot be expressed as an
 * SVG transform: the result is `"projective"`, and the caller routes the image
 * to the `<image>` fallback, whose SVG document applies the transform itself.
 * Viewport units resolve against the image viewport (the object rect) when the
 * caller knows it. `ex` / `ch` and the other font-metric units return
 * `"unsupported"`, so the caller keeps its previous output instead of painting
 * a guess.
 */
import { formatNumberLoose } from "./format.js";

export interface ImageRootTransformInputs {
  /** The root's `transform` attribute (SVG transform-list syntax). */
  transformAttr: string | null;
  /** The root's `transform-origin` attribute. */
  transformOriginAttr: string | null;
  /** The root's `style` declarations, property names lowercased, last wins. */
  style: ReadonlyMap<string, string>;
  /** The root's computed font-size in px for `em` / `rem`; null when it cannot
   *  be known exactly. Defaults to 16 (the initial `medium`). */
  fontSize?: number | null;
  /** The image viewport (the concrete object rect in the image's CSS px) for
   *  `vw` / `vh` / `vmin` / `vmax`; null when unknown. */
  viewport?: { w: number; h: number } | null;
}

/** What font- and viewport-relative lengths resolve against. */
export interface LengthEnv {
  fontSize: number | null;
  viewport: { w: number; h: number } | null;
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

const f = (n: number): string => formatNumberLoose(n, 6);

/** Resolution context: the percentage basis and the root's font-size (null
 *  when it cannot be known exactly, which makes `em` / `rem` unresolvable). */
interface ValueContext extends LengthEnv {
  basis: number;
}

type ValueKind = "length" | "angle" | "number";

const LENGTH_UNITS: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 4 / 3,
  pc: 16,
};
const ANGLE_UNITS: Record<string, number> = { deg: 1, grad: 0.9, turn: 360, rad: 180 / Math.PI };

/** A resolved operand: `dim` is false for a plain number, true for a value of
 *  the requested kind (already converted to px / degrees / a factor). */
interface Operand {
  value: number;
  dim: boolean;
}

/**
 * Evaluate one value of `kind`: a dimension, a percentage, a bare number, or a
 * `calc()` (with nested parentheses / `calc()`) over them. Lengths resolve to
 * px (a percentage against `ctx.basis`), angles to degrees, and numbers (a
 * scale factor, where a percentage is a fraction) to plain numbers. Returns
 * null for anything else.
 */
function evaluate(token: string, kind: ValueKind, ctx: ValueContext): number | null {
  const src = token.trim();
  let pos = 0;
  const peek = (): string => {
    while (pos < src.length && /\s/.test(src[pos])) pos++;
    return src[pos] ?? "";
  };
  const atom = (): Operand | null => {
    const c = peek();
    if (c === "(") {
      pos++;
      const v = sum();
      if (v == null || peek() !== ")") return null;
      pos++;
      return v;
    }
    if (/^calc\(/i.test(src.slice(pos))) {
      pos += 4;
      return atom();
    }
    const m = new RegExp(`^(${NUMBER})(%|[a-zA-Z]+)?`).exec(src.slice(pos));
    if (m == null) return null;
    pos += m[0].length;
    const n = Number(m[1]);
    const unit = m[2]?.toLowerCase();
    if (unit == null) return { value: n, dim: false };
    if (unit === "%") {
      if (kind === "length") return { value: (n / 100) * ctx.basis, dim: true };
      if (kind === "number") return { value: n / 100, dim: false };
      return null;
    }
    if (kind === "length") {
      if (unit in LENGTH_UNITS) return { value: n * LENGTH_UNITS[unit], dim: true };
      if ((unit === "em" || unit === "rem") && ctx.fontSize != null) return { value: n * ctx.fontSize, dim: true };
      // Viewport units resolve against the image document's viewport, the
      // container (object rect) size (svg_image.cc:463-473).
      const vp = ctx.viewport;
      if (vp != null) {
        const per = { vw: vp.w, vh: vp.h, vmin: Math.min(vp.w, vp.h), vmax: Math.max(vp.w, vp.h) }[unit];
        if (per != null) return { value: (n * per) / 100, dim: true };
      }
      return null;
    }
    if (kind === "angle" && unit in ANGLE_UNITS) return { value: n * ANGLE_UNITS[unit], dim: true };
    return null;
  };
  const unary = (): Operand | null => {
    const c = peek();
    if ((c === "-" || c === "+") && !/[\d.]/.test(src[pos + 1] ?? "")) {
      pos++;
      const v = unary();
      return v == null ? null : { value: c === "-" ? -v.value : v.value, dim: v.dim };
    }
    return atom();
  };
  const product = (): Operand | null => {
    let left = unary();
    while (left != null) {
      const c = peek();
      if (c !== "*" && c !== "/") break;
      pos++;
      const right = unary();
      if (right == null) return null;
      if (c === "*") {
        if (left.dim && right.dim) return null;
        left = { value: left.value * right.value, dim: left.dim || right.dim };
      } else {
        if (right.dim || right.value === 0) return null;
        left = { value: left.value / right.value, dim: left.dim };
      }
    }
    return left;
  };
  // In calc(), `+` / `-` must be surrounded by whitespace; a sign glued to a
  // number belongs to that number.
  const sum = (): Operand | null => {
    let left = product();
    while (left != null) {
      const c = peek();
      if ((c !== "+" && c !== "-") || !/\s/.test(src[pos - 1] ?? "") || !/\s/.test(src[pos + 1] ?? "")) break;
      pos++;
      const right = product();
      if (right == null || right.dim !== left.dim) return null;
      left = { value: left.value + (c === "+" ? right.value : -right.value), dim: left.dim };
    }
    return left;
  };
  const isCalc = /^calc\(/i.test(src);
  const result = isCalc ? atom() : unary();
  if (result == null || peek() !== "" || !Number.isFinite(result.value)) return null;
  if (kind === "number") return result.dim ? null : result.value;
  // A bare number is only valid as a zero length / angle (outside calc()).
  if (!result.dim) return !isCalc && result.value === 0 ? 0 : null;
  return result.value;
}

/** A `<length-percentage>` in px; a bare 0 is a valid length. */
function lengthOf(token: string, basis: number, env: LengthEnv): number | null {
  return evaluate(token, "length", { basis, ...env });
}

/** An `<angle>` in degrees; a bare 0 is a valid angle. */
function angleDeg(token: string): number | null {
  return evaluate(token, "angle", { basis: 0, fontSize: null, viewport: null });
}

/** A scale factor: a `<number>` or a `<percentage>`. */
function scaleFactor(token: string): number | null {
  return evaluate(token, "number", { basis: 0, fontSize: null, viewport: null });
}

function plainNumber(token: string): number | null {
  return evaluate(token, "number", { basis: 0, fontSize: null, viewport: null });
}

/** Split on top-level commas (or whitespace), respecting parentheses. */
function splitTopLevel(raw: string, comma: boolean): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth < 0) return null;
    const sep = i === raw.length || (depth === 0 && (comma ? ch === "," : /\s/.test(ch)));
    if (!sep) continue;
    const part = raw.slice(start, i).trim();
    start = i + 1;
    if (comma && part === "") return null;
    if (part !== "") parts.push(part);
  }
  return depth === 0 ? parts : null;
}

/** Split function arguments on commas; CSS transform functions are comma-separated. */
function commaArgs(raw: string): string[] | null {
  return splitTopLevel(raw, true);
}

/** A 4x4 matrix in CSS `matrix3d()` (column-major) order. */
type M4 = number[];

/** The 2D mapping of a 4x4 matrix as an SVG `matrix()`, or `"projective"`.
 *  The image root paints its z = 0 plane: a point (x, y, 0, 1) maps to
 *  (m0 x + m4 y + m12, m1 x + m5 y + m13) / (m3 x + m7 y + m15), so the
 *  z row and column (m2, m6, m8..m11, m14) never reach the screen. The
 *  mapping is affine exactly when m3 = m7 = 0; a positive m15 then divides
 *  out. Anything else (w varying across the plane, or w <= 0, which Blink
 *  clips as behind the viewer) is projective. */
function flatten(m: M4): string | "projective" {
  const eps = 1e-12;
  if (Math.abs(m[3]) > eps || Math.abs(m[7]) > eps || !(m[15] > eps)) return "projective";
  const w = m[15];
  return `matrix(${[m[0], m[1], m[4], m[5], m[12], m[13]].map((v) => f(v / w)).join(" ")})`;
}

/** `rotate3d(x, y, z, a)` per CSS Transforms 2 §12; a zero axis is identity. */
function rotate3d(x: number, y: number, z: number, deg: number): M4 | null {
  const len = Math.hypot(x, y, z);
  if (len === 0) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  [x, y, z] = [x / len, y / len, z / len];
  const half = (deg * Math.PI) / 360;
  const sc = Math.sin(half) * Math.cos(half);
  const sq = Math.sin(half) ** 2;
  return [
    1 - 2 * (y * y + z * z) * sq,
    2 * (x * y * sq + z * sc),
    2 * (x * z * sq - y * sc),
    0,
    2 * (x * y * sq - z * sc),
    1 - 2 * (x * x + z * z) * sq,
    2 * (y * z * sq + x * sc),
    0,
    2 * (x * z * sq + y * sc),
    2 * (y * z * sq - x * sc),
    1 - 2 * (x * x + y * y) * sq,
    0,
    0,
    0,
    0,
    1,
  ];
}

/** A 3D factor kept as a 4x4 matrix until the whole list is composed: its
 *  2D part alone is not enough once another 3D factor couples through z. */
function m4Token(m: M4): string {
  return `m4(${m.join(",")})`;
}

/** Column-major 4x4 product `a · b`. */
function multiply(a: M4, b: M4): M4 {
  const out: number[] = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return out;
}

/** One function of a resolved list (this module's own output) as a 4x4 matrix. */
function tokenToM4(name: string, args: number[]): M4 | null {
  const affine = (a: number, b: number, c: number, d: number, e: number, f2: number): M4 => [
    a,
    b,
    0,
    0,
    c,
    d,
    0,
    0,
    0,
    0,
    1,
    0,
    e,
    f2,
    0,
    1,
  ];
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  switch (name) {
    case "m4":
      return args.length === 16 ? args : null;
    case "matrix":
      return args.length === 6 ? affine(args[0], args[1], args[2], args[3], args[4], args[5]) : null;
    case "translate":
      return affine(1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0);
    case "scale":
      return affine(args[0], 0, 0, args[1] ?? args[0], 0, 0);
    case "rotate": {
      const r = rad(args[0]);
      return affine(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0);
    }
    case "skewX":
      return affine(1, 0, Math.tan(rad(args[0])), 1, 0, 0);
    case "skewY":
      return affine(1, Math.tan(rad(args[0])), 0, 1, 0, 0);
    default:
      return null;
  }
}

/** Compose a resolved list that holds 3D factors into one flattened
 *  `matrix()`; `"projective"` when the product is, null on a malformed list. */
function composeFlattened(list: string): string | "projective" | null {
  let m: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const fn of list.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)) {
    const factor = tokenToM4(
      fn[1],
      fn[2]
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number),
    );
    if (factor == null) return null;
    m = multiply(m, factor);
  }
  return flatten(m);
}

function translate3d(x: number, y: number, z: number): M4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function scale3d(x: number, y: number, z: number): M4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

/** A 3D transform function as a flattened SVG `matrix()`, or null. */
function css3dFunctionToSvg(name: string, args: string[], box: Box, env: LengthEnv): string | null {
  const len = (token: string, basis: number): number | null => lengthOf(token, basis, env);
  const nums = (tokens: string[]): number[] | null => {
    const out = tokens.map(plainNumber);
    return out.some((v) => v == null) ? null : (out as number[]);
  };
  let m: M4 | null = null;
  switch (name) {
    case "translate3d": {
      if (args.length !== 3) return null;
      const [x, y, z] = [len(args[0], box.w), len(args[1], box.h), len(args[2], 0)];
      if (x == null || y == null || z == null || /%/.test(args[2])) return null;
      m = translate3d(x, y, z);
      break;
    }
    case "translatez": {
      const z = args.length === 1 && !/%/.test(args[0]) ? len(args[0], 0) : null;
      if (z == null) return null;
      m = translate3d(0, 0, z);
      break;
    }
    case "scale3d": {
      const v = args.length === 3 ? args.map(scaleFactor) : null;
      if (v == null || v.some((n) => n == null)) return null;
      m = scale3d(v[0]!, v[1]!, v[2]!);
      break;
    }
    case "scalez": {
      const z = args.length === 1 ? scaleFactor(args[0]) : null;
      if (z == null) return null;
      m = scale3d(1, 1, z);
      break;
    }
    case "rotatex":
    case "rotatey": {
      const a = args.length === 1 ? angleDeg(args[0]) : null;
      if (a == null) return null;
      m = name === "rotatex" ? rotate3d(1, 0, 0, a) : rotate3d(0, 1, 0, a);
      break;
    }
    case "rotate3d": {
      if (args.length !== 4) return null;
      const axis = nums(args.slice(0, 3));
      const a = angleDeg(args[3]);
      if (axis == null || a == null) return null;
      m = rotate3d(axis[0], axis[1], axis[2], a);
      break;
    }
    case "matrix3d": {
      m = args.length === 16 ? nums(args) : null;
      break;
    }
    case "perspective": {
      // `perspective(none)` is the identity. `perspective(<length [0,inf]>)`
      // sets m34 = -1 / d, with d below 1px treated as 1px (CSS Transforms 2
      // §13.1; Blink's `PerspectiveTransformOperation`). It only reaches the
      // screen through a later factor that moves the plane along z.
      if (args.length !== 1) return null;
      if (args[0].toLowerCase() === "none") return "";
      const d = /%/.test(args[0]) ? null : len(args[0], 0);
      if (d == null || d < 0) return null;
      m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / Math.max(d, 1), 0, 0, 0, 1];
      break;
    }
    default:
      return null;
  }
  return m == null ? null : m4Token(m);
}

/** One CSS `<transform-function>` as an SVG transform, or null when unsupported. */
function cssFunctionToSvg(name: string, raw: string, box: Box, env: LengthEnv): string | null {
  const args = commaArgs(raw);
  if (args == null) return null;
  const lengthPx = (token: string, basis: number): number | null => lengthOf(token, basis, env);
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
      return css3dFunctionToSvg(name, args, box, env);
  }
}

/** A CSS `transform` value (`none` or a function list) as an SVG list. */
function cssTransformList(value: string, box: Box, env: LengthEnv): string | null | "unsupported" {
  const source = value.trim();
  if (source === "" || source.toLowerCase() === "none") return null;
  const fns = splitTopLevel(source, false);
  if (fns == null) return "unsupported";
  const out: string[] = [];
  for (const fn of fns) {
    const m = /^([a-zA-Z0-9]+)\(([\s\S]*)\)$/.exec(fn);
    if (m == null) return "unsupported";
    const svg = cssFunctionToSvg(m[1].toLowerCase(), m[2], box, env);
    if (svg == null) return "unsupported";
    if (svg !== "") out.push(svg);
  }
  return out.length === 0 ? null : out.join(" ");
}

function spaceArgs(value: string): string[] {
  return splitTopLevel(value.trim(), false) ?? [value.trim()];
}

/** The individual `translate` property (`none` | `<lp> [<lp> [<length>]]`). */
function translateProperty(value: string, box: Box, env: LengthEnv): string | null | "unsupported" {
  const parts = spaceArgs(value);
  if (parts.length === 1 && parts[0].toLowerCase() === "none") return null;
  if (parts.length < 1 || parts.length > 3) return "unsupported";
  const x = lengthOf(parts[0], box.w, env);
  const y = parts.length >= 2 ? lengthOf(parts[1], box.h, env) : 0;
  if (x == null || y == null) return "unsupported";
  if (parts.length === 3) {
    // `translate` is the outermost factor (ComputedStyle::ApplyTransform), so
    // its z offset never reaches x / y without perspective.
    if (/%/.test(parts[2]) || lengthOf(parts[2], 0, env) == null) return "unsupported";
  }
  return `translate(${f(x)} ${f(y)})`;
}

/** The individual `rotate` property (`none` | `<angle>` | `[x | y | z | <n>{3}] <angle>`). */
function rotateProperty(value: string): string | null | "unsupported" {
  const parts = spaceArgs(value);
  if (parts.length === 1 && parts[0].toLowerCase() === "none") return null;
  if (parts.length === 1) {
    const angle = angleDeg(parts[0]);
    return angle == null ? "unsupported" : `rotate(${f(angle)})`;
  }
  // The axis may come before or after the angle.
  const angleFirst = angleDeg(parts[0]) != null && parts.length > 1 && angleDeg(parts[parts.length - 1]) == null;
  const angleToken = angleFirst ? parts[0] : parts[parts.length - 1];
  const axisTokens = angleFirst ? parts.slice(1) : parts.slice(0, -1);
  const angle = angleDeg(angleToken);
  if (angle == null) return "unsupported";
  let axis: number[] | null = null;
  if (axisTokens.length === 1) {
    const k = axisTokens[0].toLowerCase();
    axis = k === "x" ? [1, 0, 0] : k === "y" ? [0, 1, 0] : k === "z" ? [0, 0, 1] : null;
  } else if (axisTokens.length === 3) {
    const v = axisTokens.map(plainNumber);
    axis = v.some((n) => n == null) ? null : (v as number[]);
  }
  if (axis == null) return "unsupported";
  if (axis[0] === 0 && axis[1] === 0 && axis[2] !== 0) return `rotate(${f(axis[2] > 0 ? angle : -angle)})`;
  const m = rotate3d(axis[0], axis[1], axis[2], angle);
  return m == null ? "unsupported" : m4Token(m);
}

/** The individual `scale` property (`none` | `<n-p> [<n-p> [<n-p>]]`). */
function scaleProperty(value: string): string | null | "unsupported" {
  const parts = spaceArgs(value);
  if (parts.length === 1 && parts[0].toLowerCase() === "none") return null;
  if (parts.length < 1 || parts.length > 3) return "unsupported";
  const x = scaleFactor(parts[0]);
  const y = parts.length >= 2 ? scaleFactor(parts[1]) : x;
  if (x == null || y == null) return "unsupported";
  if (parts.length === 3) {
    // A z factor matters once a later 3D factor (in `transform`) moves along z.
    const z = scaleFactor(parts[2]);
    if (z == null) return "unsupported";
    if (z !== 1) return m4Token(scale3d(x, y, z));
  }
  return `scale(${f(x)} ${f(y)})`;
}

/**
 * A `transform-origin` value resolved against `box` (2D; a z offset is
 * ignored). One value sets x (or y, for `top`/`bottom`) with the other axis at
 * `center`; two values may come in either order when they are keywords.
 */
export function resolveTransformOrigin(
  value: string,
  box: Box,
  env: LengthEnv = { fontSize: 16, viewport: null },
): { x: number; y: number } | null {
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
  const x = first in xKeyword ? xKeyword[first] * box.w : lengthOf(first, box.w, env);
  const y = second in yKeyword ? yKeyword[second] * box.h : lengthOf(second, box.h, env);
  if (x == null || y == null) return null;
  if (parts.length === 3 && (/%/.test(parts[2]) || lengthOf(parts[2], 0, env) == null)) return null;
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
): ResolvedImageRootTransform | null | "unsupported" | "projective" {
  const parts: string[] = [];
  const env: LengthEnv = {
    fontSize: inputs.fontSize === undefined ? 16 : inputs.fontSize,
    viewport: inputs.viewport ?? null,
  };
  const individual: Array<[string, (value: string) => string | null | "unsupported"]> = [
    ["translate", (value) => translateProperty(value, box, env)],
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
    const svg = cssTransformList(styleTransform, box, env);
    if (svg === "unsupported") return "unsupported";
    if (svg != null) parts.push(svg);
  }
  // A 3D factor couples with any other 3D factor through z, so the CSS parts
  // are composed as 4x4 matrices and flattened once. (The SVG attribute is
  // 2D and comes last, and a 2D factor never reads the z column.)
  if (parts.some((part) => part.includes("m4("))) {
    const flat = composeFlattened(parts.join(" "));
    if (flat == null || flat === "projective") return flat ?? "unsupported";
    parts.splice(0, parts.length, flat);
  }
  if (styleTransform == null && inputs.transformAttr != null && inputs.transformAttr.trim() !== "") {
    // SVG transform-list syntax is already a valid SVG `transform` value.
    parts.push(inputs.transformAttr.trim());
  }
  if (parts.length === 0) return null;
  const originValue = inputs.style.get("transform-origin") ?? inputs.transformOriginAttr;
  const origin =
    originValue == null || originValue.trim() === ""
      ? { x: box.x + box.w / 2, y: box.y + box.h / 2 }
      : resolveTransformOrigin(originValue, box, env);
  if (origin == null) return "unsupported";
  return { transform: parts.join(" "), origin };
}
