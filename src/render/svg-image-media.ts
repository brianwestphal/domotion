/**
 * `@media` evaluation inside an `<img>` SVG document. Blink gives the image
 * its own document whose frame view is sized to the container size, which is
 * the `<img>`'s concrete object rect (`SVGImage::PaintRecordForCurrentFrame`,
 * `core/svg/graphics/svg_image.cc:463-473`, chromium 7d859f27), so width /
 * height features see that rect in the image's CSS px rather than the page
 * viewport.
 */
/**
 * Evaluate an `@media` query list against the SVG image's viewport (CSS px):
 * Blink sizes the image document's frame view to the container size
 * (`SVGImage::PaintRecordForCurrentFrame`, `core/svg/graphics/svg_image.cc:472`,
 * chromium 7d859f27), so width / height features see the concrete object
 * rect. Supports the `all` / `screen` media types, `not` / `only`, `and`, and
 * the width / height / orientation / aspect-ratio features in both the
 * `min-` / `max-` and the range forms. Null when any part is outside that set.
 */
export function evaluateMediaQueryList(list: string, vp: { w: number; h: number }): boolean | null {
  const queries = list.split(",").map((q) => q.trim());
  let any = false;
  for (const q of queries) {
    const r = evaluateMediaQuery(q, vp);
    if (r == null) return null;
    any ||= r;
  }
  return any;
}

function evaluateMediaQuery(query: string, vp: { w: number; h: number }): boolean | null {
  let q = query.trim();
  if (q === "") return true;
  let negate = false;
  const lead = /^(not|only)\s+/i.exec(q);
  if (lead != null) {
    negate = lead[1].toLowerCase() === "not";
    q = q.slice(lead[0].length);
  }
  const parts = q.split(/\s+and\s+/i).map((p) => p.trim());
  let result = true;
  for (const [index, part] of parts.entries()) {
    if (!part.startsWith("(")) {
      if (index !== 0) return null;
      const type = part.toLowerCase();
      if (type === "print" || type === "speech") result = false;
      else if (type !== "all" && type !== "screen") return null;
      continue;
    }
    const r = evaluateMediaFeature(part, vp);
    if (r == null) return null;
    result &&= r;
  }
  return negate ? !result : result;
}

/**
 * A media-query length in px. Font-relative units resolve against the initial
 * font-size (`MediaValues` computes them from the default font size, not from
 * any element, `core/css/media_values.cc`), which is 16px.
 */
function mediaLength(token: string): number | null {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))(px|in|cm|mm|q|pt|pc|em|rem)?$/i.exec(token.trim());
  if (m == null) return null;
  const n = Number(m[1]);
  if (m[2] == null) return n === 0 ? 0 : null;
  const factor: Record<string, number> = {
    px: 1,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    q: 96 / 101.6,
    pt: 4 / 3,
    pc: 16,
    em: 16,
    rem: 16,
  };
  return n * factor[m[2].toLowerCase()];
}

function mediaRatio(token: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(token);
  if (m == null) return null;
  const den = m[2] == null ? 1 : Number(m[2]);
  return den === 0 ? null : Number(m[1]) / den;
}

function evaluateMediaFeature(part: string, vp: { w: number; h: number }): boolean | null {
  const inner = /^\(([\s\S]*)\)$/.exec(part.trim())?.[1].trim();
  if (inner == null) return null;
  const valueOf = (feature: string): number | null =>
    feature === "width" ? vp.w : feature === "height" ? vp.h : feature === "aspect-ratio" ? vp.w / vp.h : null;
  const parse = (feature: string, token: string): number | null =>
    feature === "aspect-ratio" ? mediaRatio(token) : mediaLength(token);
  const colon = /^([-a-z]+)\s*:\s*([\s\S]+)$/i.exec(inner);
  if (colon != null) {
    const name = colon[1].toLowerCase();
    if (name === "orientation") {
      const v = colon[2].trim().toLowerCase();
      if (v !== "portrait" && v !== "landscape") return null;
      return vp.h >= vp.w === (v === "portrait");
    }
    const m = /^(min-|max-)?(width|height|aspect-ratio)$/.exec(name);
    if (m == null) return null;
    const actual = valueOf(m[2]);
    const target = parse(m[2], colon[2]);
    if (actual == null || target == null) return null;
    return m[1] === "min-" ? actual >= target : m[1] === "max-" ? actual <= target : actual === target;
  }
  // Range syntax: `(width >= 100px)`, `(100px < width <= 300px)`.
  const tokens = inner.split(/\s*(<=|>=|<|>|=)\s*/);
  if (tokens.length !== 3 && tokens.length !== 5) return null;
  const cmp = (a: number, op: string, b: number): boolean =>
    op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : a === b;
  const feature = (tokens.length === 3 ? [tokens[0], tokens[2]] : [tokens[2]]).find((t) =>
    /^(width|height|aspect-ratio)$/i.test(t),
  );
  if (feature == null) return null;
  const name = feature.toLowerCase();
  const actual = valueOf(name);
  if (actual == null) return null;
  const operand = (t: string): number | null => (t.toLowerCase() === name ? actual : parse(name, t));
  for (let k = 0; k + 2 < tokens.length; k += 2) {
    const a = operand(tokens[k]);
    const b = operand(tokens[k + 2]);
    if (a == null || b == null) return null;
    if (!cmp(a, tokens[k + 1], b)) return false;
  }
  return true;
}
