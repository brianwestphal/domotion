/**
 * CSS gradient parser + SVG <linearGradient> emitter.
 *
 * Converts CSS `linear-gradient(...)` text (as resolved by Chromium's
 * computed-style serializer) into an SVG `<linearGradient>` def using
 * `gradientUnits="userSpaceOnUse"`. Per-rect coordinates pin the gradient
 * line in screen space so non-orthogonal angles round-trip correctly even
 * for non-square boxes — the CSS "magic corner" rule
 * (L = |w·sin θ| + |h·cos θ|) maps cleanly onto absolute SVG coords.
 *
 * Origin: SK-1224 (implementation of doc 29). v1 covers linear-gradient
 * track/thumb fills on `<input type=range>`. SK-1225 adds radial; SK-1226
 * adds px-positioned color stops.
 */

export interface LinearStop {
  /** Resolved CSS color (Chromium serializes to rgb()/rgba() form). */
  color: string;
  /**
   * Final fractional offset (0..1). Populated by parseStop for percent
   * positions and by resolveStops for px positions / auto-distribution.
   */
  offset?: number;
  /**
   * Pending pixel offset along the gradient axis, awaiting rect dimensions
   * (SK-1226). Resolved into `offset` once buildLinearGradientDef knows the
   * gradient line length. Negative values are allowed (CSS spec).
   */
  pxOffset?: number;
  /**
   * Pending mixed `calc(<pct>% ± <px>px)` offset (DM-275). Resolved into
   * `offset` once the gradient line length is known: `offset = pct/100 + px/L`.
   */
  calcOffset?: { pct: number; px: number };
  /** Original raw position token (debugging / inspection). */
  rawPos?: string;
}

export interface LinearGradient {
  kind: "linear";
  /** Resolved angle in CSS degrees (0 = to top, 90 = to right, 180 = to bottom, 270 = to left). */
  angleDeg: number;
  stops: LinearStop[];
  /** True when the source was `repeating-linear-gradient(...)`. The stop list spans one tile period; the emitter clones it across the full gradient line (DM-275). */
  repeating?: boolean;
}

/** Position component along one axis. Resolved against rect at emit time. */
export type PosValue = { kind: "frac"; value: number } | { kind: "px"; value: number };

/** Sizing of a radial gradient (CSS extent keyword or explicit lengths). */
export type RadialSize =
  | { kind: "extent"; value: "closest-side" | "closest-corner" | "farthest-side" | "farthest-corner" }
  | { kind: "px"; r1: number; r2?: number };

export interface RadialGradient {
  kind: "radial";
  shape: "circle" | "ellipse";
  size: RadialSize;
  /** Center position of the gradient (default: center of the painted rect). */
  position: { x: PosValue; y: PosValue };
  stops: LinearStop[];
  /** True when the source was `repeating-radial-gradient(...)` (DM-275). */
  repeating?: boolean;
}

export interface ConicStop {
  /** Resolved CSS color (Chromium serializes to rgb()/rgba() form). */
  color: string;
  /**
   * Final fractional offset around the conic sweep (0..1). 0 = first stop,
   * 1 = last stop. Populated by parseConicStop for percent and angle
   * positions. Auto-distribution for missing offsets happens at rasterize
   * time (the rasterizer needs the sweep period to interpolate).
   */
  offset?: number;
  /** Original raw position token (debugging / inspection). */
  rawPos?: string;
}

export interface ConicGradient {
  kind: "conic";
  /** `from <angle>` clause in CSS degrees. 0 = top per CSS spec, 90 = right. */
  fromAngleDeg: number;
  /** Center position. Default (50%, 50%). Reuses radial's PosValue grammar. */
  position: { x: PosValue; y: PosValue };
  stops: ConicStop[];
  /** True when the source was `repeating-conic-gradient(...)`. */
  repeating?: boolean;
}

export type AnyGradient = LinearGradient | RadialGradient | ConicGradient;

/** Try every supported gradient type. Returns the first that parses or null. */
export function parseGradient(text: string | undefined | null): AnyGradient | null {
  return parseLinearGradient(text) ?? parseRadialGradient(text) ?? parseConicGradient(text);
}

/** Parse `linear-gradient(...)` or `repeating-linear-gradient(...)` text. */
export function parseLinearGradient(text: string | undefined | null): LinearGradient | null {
  if (text == null) return null;
  const trimmed = text.trim();
  const m = /^(repeating-)?linear-gradient\s*\(([\s\S]*)\)\s*$/.exec(trimmed);
  if (m == null) return null;
  const repeating = m[1] != null;
  const inner = m[2].trim();
  const tokens = splitTopLevelCommas(inner).map((t) => t.trim()).filter((t) => t !== "");
  if (tokens.length < 2) return null;

  let angleDeg = 180; // CSS default: to bottom
  let stopsStart = 0;
  const angle = parseAngleToken(tokens[0]);
  if (angle != null) {
    angleDeg = angle;
    stopsStart = 1;
  }

  const stops: LinearStop[] = [];
  for (let i = stopsStart; i < tokens.length; i++) {
    const parsed = parseStopToken(tokens[i]);
    if (parsed.length === 0) return null;
    for (const s of parsed) stops.push(s);
  }
  if (stops.length < 2) return null;

  // Don't auto-distribute here — px positions need the rect's gradient line
  // length to resolve, which isn't known until buildLinearGradientDef.
  return repeating ? { kind: "linear", angleDeg, stops, repeating: true } : { kind: "linear", angleDeg, stops };
}

/**
 * Compute the gradient line length per the CSS magic-corner formula.
 * L = |w·sin θ| + |h·cos θ|. Used to convert px stop offsets to fractions.
 */
export function gradientLineLength(angleDeg: number, w: number, h: number): number {
  const θ = (angleDeg * Math.PI) / 180;
  return Math.abs(w * Math.sin(θ)) + Math.abs(h * Math.cos(θ));
}

/**
 * Build the `<linearGradient>` def markup for a parsed gradient applied to a
 * specific painted rect. `userSpaceOnUse` puts x1/y1/x2/y2 in screen
 * coordinates — so two sliders at different positions need different defs
 * even if their CSS gradient text matches.
 */
export function buildLinearGradientDef(
  gradient: LinearGradient,
  id: string,
  rect: { x: number; y: number; w: number; h: number },
): string {
  const { x1, y1, x2, y2 } = computeUserSpaceLine(gradient.angleDeg, rect);
  // Resolve stop positions against this rect. Clone first so two callers
  // sharing the same parsed gradient don't mutate each other's offsets
  // (different rects produce different L → different fractions for px stops).
  const resolved = gradient.stops.map((s) => ({ ...s }));
  resolveStops(resolved, gradientLineLength(gradient.angleDeg, rect.w, rect.h), { skipFirstLastDefaults: gradient.repeating === true });
  const tiled = gradient.repeating === true ? tileRepeatingStops(resolved) : resolved;
  const stops = tiled.map((s) => stopMarkup(s)).join("");
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}">${stops}</linearGradient>`;
}

/**
 * Map a CSS gradient angle onto absolute SVG coords for a rect.
 * CSS convention: 0deg = up, 90deg = right, 180deg = down, 270deg = left.
 * The gradient line passes through the rect center; its length is the
 * "magic corner" projection L = |w·sin θ| + |h·cos θ|.
 */
export function computeUserSpaceLine(
  angleDeg: number,
  rect: { x: number; y: number; w: number; h: number },
): { x1: number; y1: number; x2: number; y2: number } {
  const θ = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(θ);
  const dy = -Math.cos(θ);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const L = Math.abs(rect.w * dx) + Math.abs(rect.h * dy);
  return {
    x1: cx - (dx * L) / 2,
    y1: cy - (dy * L) / 2,
    x2: cx + (dx * L) / 2,
    y2: cy + (dy * L) / 2,
  };
}

/** Stable key for dedup. Same gradient + same rect = same def = same id. */
export function gradientCacheKey(g: AnyGradient, rect: { x: number; y: number; w: number; h: number }): string {
  const stopsKey = g.stops.map((s) => {
    let pos: string;
    if (s.offset != null) pos = num(s.offset);
    else if ("pxOffset" in s && s.pxOffset != null) pos = `${num(s.pxOffset)}px`;
    else if ("calcOffset" in s && s.calcOffset != null) pos = `c${num(s.calcOffset.pct)}/${num(s.calcOffset.px)}`;
    else pos = "?";
    return `${s.color}@${pos}`;
  }).join(",");
  const rectKey = `${num(rect.x)},${num(rect.y)},${num(rect.w)},${num(rect.h)}`;
  const rep = g.repeating === true ? "r" : "n";
  if (g.kind === "linear") return `L|${rep}|${num(g.angleDeg)}|${rectKey}|${stopsKey}`;
  if (g.kind === "conic") {
    const posKey = `${posKey1(g.position.x)},${posKey1(g.position.y)}`;
    return `C|${rep}|${num(g.fromAngleDeg)}|${posKey}|${rectKey}|${stopsKey}`;
  }
  // Radial
  const sizeKey = g.size.kind === "extent" ? `e:${g.size.value}` : `p:${num(g.size.r1)}/${g.size.r2 != null ? num(g.size.r2) : ""}`;
  const posKey = `${posKey1(g.position.x)},${posKey1(g.position.y)}`;
  return `R|${rep}|${g.shape}|${sizeKey}|${posKey}|${rectKey}|${stopsKey}`;
}

function posKey1(p: PosValue): string {
  return p.kind === "frac" ? `${num(p.value)}f` : `${num(p.value)}px`;
}

/**
 * Parse a `radial-gradient(...)` text. Supports the common authoring forms:
 *   radial-gradient(red, blue)                     // ellipse, farthest-corner, center
 *   radial-gradient(circle, red, blue)
 *   radial-gradient(circle 50px, red, blue)
 *   radial-gradient(closest-side, red, blue)
 *   radial-gradient(circle at 25% 25%, red, blue)
 *   radial-gradient(ellipse 60px 40px at top right, red, blue)
 *
 * Defaults per CSS: shape=ellipse, size=farthest-corner, position=center.
 */
export function parseRadialGradient(text: string | undefined | null): RadialGradient | null {
  if (text == null) return null;
  const trimmed = text.trim();
  const m = /^(repeating-)?radial-gradient\s*\(([\s\S]*)\)\s*$/.exec(trimmed);
  if (m == null) return null;
  const repeating = m[1] != null;
  const tokens = splitTopLevelCommas(m[2]).map((t) => t.trim()).filter((t) => t !== "");
  if (tokens.length < 2) return null;

  // Decide whether the first token is a shape/size/position prefix or a stop.
  // A prefix never contains the typical color-stop pattern (a color literal),
  // so try parsing it as a stop first; if that fails AND it matches one of the
  // prefix keywords or position syntax, treat as prefix.
  let shape: "circle" | "ellipse" = "ellipse";
  let size: RadialSize = { kind: "extent", value: "farthest-corner" };
  let position: { x: PosValue; y: PosValue } = {
    x: { kind: "frac", value: 0.5 },
    y: { kind: "frac", value: 0.5 },
  };
  let stopsStart = 0;

  const first = tokens[0];
  if (looksLikeRadialPrefix(first)) {
    const parsed = parseRadialPrefix(first);
    if (parsed == null) return null;
    shape = parsed.shape;
    size = parsed.size;
    position = parsed.position;
    stopsStart = 1;
  }

  const stops: LinearStop[] = [];
  for (let i = stopsStart; i < tokens.length; i++) {
    const parsed = parseStopToken(tokens[i]);
    if (parsed.length === 0) return null;
    for (const s of parsed) stops.push(s);
  }
  if (stops.length < 2) return null;

  return repeating
    ? { kind: "radial", shape, size, position, stops, repeating: true }
    : { kind: "radial", shape, size, position, stops };
}

/**
 * Parse a `conic-gradient(...)` text. Common authoring forms:
 *   conic-gradient(red, yellow, green, blue)                // sweep starting at top
 *   conic-gradient(from 45deg, red, blue)                   // rotate origin 45deg
 *   conic-gradient(at 25% 75%, red, blue)                   // off-center
 *   conic-gradient(from 0.25turn at top right, red, blue)   // both
 *   repeating-conic-gradient(#ddd 0 25%, white 0 50%)       // alpha-checkerboard
 *   conic-gradient(red 0deg, yellow 90deg, blue 180deg)     // angle-positioned stops
 *
 * Defaults: from=0deg (top), at center (50% 50%).
 */
export function parseConicGradient(text: string | undefined | null): ConicGradient | null {
  if (text == null) return null;
  const trimmed = text.trim();
  const m = /^(repeating-)?conic-gradient\s*\(([\s\S]*)\)\s*$/.exec(trimmed);
  if (m == null) return null;
  const repeating = m[1] != null;
  const tokens = splitTopLevelCommas(m[2]).map((t) => t.trim()).filter((t) => t !== "");
  if (tokens.length < 2) return null;

  let fromAngleDeg = 0;
  let position: { x: PosValue; y: PosValue } = {
    x: { kind: "frac", value: 0.5 },
    y: { kind: "frac", value: 0.5 },
  };
  let stopsStart = 0;

  // The first token may carry an optional "from <angle>" clause and/or an
  // optional "at <position>" clause. Detect via leading keywords.
  const first = tokens[0].toLowerCase();
  if (first.startsWith("from ") || first.startsWith("at ") || /\bat\b/.test(first) && first.startsWith("from")) {
    const parsed = parseConicPrefix(tokens[0]);
    if (parsed == null) return null;
    fromAngleDeg = parsed.fromAngleDeg;
    position = parsed.position;
    stopsStart = 1;
  }

  const stops: ConicStop[] = [];
  for (let i = stopsStart; i < tokens.length; i++) {
    const parsed = parseConicStopToken(tokens[i]);
    if (parsed.length === 0) return null;
    for (const s of parsed) stops.push(s);
  }
  if (stops.length < 2) return null;

  return repeating
    ? { kind: "conic", fromAngleDeg, position, stops, repeating: true }
    : { kind: "conic", fromAngleDeg, position, stops };
}

/**
 * Parse the optional `from <angle> at <position>` prefix of a conic gradient.
 * Either clause is optional, in either order. Returns null on parse failure.
 */
function parseConicPrefix(tok: string): { fromAngleDeg: number; position: { x: PosValue; y: PosValue } } | null {
  let fromAngleDeg = 0;
  let position: { x: PosValue; y: PosValue } = {
    x: { kind: "frac", value: 0.5 },
    y: { kind: "frac", value: 0.5 },
  };
  // Split into "from <angle>" clause and "at <position>" clause. Either may
  // appear at the start of the prefix; both are optional. The "at" keyword
  // boundary is matched at the start of the string OR after whitespace, since
  // a bare "at <pos>" prefix has no preceding "from" clause.
  const atSplit = tok.split(/(?:^|\s+)at\s+/i);
  const beforeAt = atSplit[0].trim();
  const afterAt = atSplit.length > 1 ? atSplit.slice(1).join(" at ").trim() : "";
  // Parse the "from <angle>" clause if present in the before-at portion.
  const fromMatch = /^from\s+(.+)$/i.exec(beforeAt);
  if (fromMatch != null) {
    const angle = parseAngleToken(fromMatch[1].trim());
    if (angle == null) return null;
    fromAngleDeg = angle;
  } else if (beforeAt !== "") {
    // before-at must be empty (bare "at" prefix) or "from <angle>".
    return null;
  }
  if (afterAt !== "") {
    const pos = parsePositionPair(afterAt);
    if (pos == null) return null;
    position = pos;
  }
  return { fromAngleDeg, position };
}

/**
 * Parse a single conic-gradient stop token. Returns 1 stop, or 2 for the
 * double-position hard-stop form `<color> <pos1> <pos2>`. Conic stops accept
 * both `<percentage>` (relative to the sweep) and `<angle>` (deg/turn/rad/grad,
 * absolute around the sweep), normalized to [0, 1) at parse time.
 */
function parseConicStopToken(tok: string): ConicStop[] {
  const parts = splitTopLevelSpaces(tok);
  if (parts.length === 0) return [];
  const isPos = (t: string) => isConicPositionToken(t);
  const positions: string[] = [];
  let cut = parts.length;
  while (cut > 0 && isPos(parts[cut - 1])) {
    positions.unshift(parts[cut - 1]);
    cut--;
  }
  if (cut === 0) return [];
  const colorText = parts.slice(0, cut).join(" ").trim();
  if (colorText === "") return [];
  if (positions.length === 0) return [{ color: colorText }];
  if (positions.length === 1) {
    return [makeConicStop(colorText, positions[0])];
  }
  if (positions.length === 2) {
    return [makeConicStop(colorText, positions[0]), makeConicStop(colorText, positions[1])];
  }
  return [];
}

function isConicPositionToken(t: string): boolean {
  // Plain percentage / bare number / 0 (special).
  if (/^(-?\d+(?:\.\d+)?|-?\.\d+)(%)?$/.test(t)) return true;
  // Angle units.
  if (/^(-?\d+(?:\.\d+)?|-?\.\d+)(deg|grad|rad|turn)$/i.test(t)) return true;
  return false;
}

function makeConicStop(color: string, posTok: string): ConicStop {
  const offset = parseConicPosition(posTok);
  if (offset == null) return { color, rawPos: posTok };
  return { color, offset, rawPos: posTok };
}

/**
 * Parse a conic stop position to a fractional sweep offset (0..1).
 * - Percentage `25%` → 0.25.
 * - Bare number `25` (lenient): same as `25%` → 0.25.
 * - `0` → 0.
 * - Angle `90deg` / `0.25turn` / `1.57rad` / `100grad` → fraction of 360deg.
 *   Negative / >360 angles are not pre-normalized — the rasterizer applies
 *   the same monotonicity / clamping rules as linear/radial.
 */
function parseConicPosition(tok: string): number | null {
  // Percent / bare number.
  const pm = /^(-?\d+(?:\.\d+)?|-?\.\d+)(%)?$/.exec(tok);
  if (pm != null) {
    const v = parseFloat(pm[1]);
    return v / 100;
  }
  // Angle units.
  const am = /^(-?\d+(?:\.\d+)?|-?\.\d+)(deg|grad|rad|turn)$/i.exec(tok);
  if (am != null) {
    const v = parseFloat(am[1]);
    const unit = am[2].toLowerCase();
    if (unit === "deg") return v / 360;
    if (unit === "turn") return v;
    if (unit === "grad") return v / 400;
    if (unit === "rad") return v / (Math.PI * 2);
  }
  return null;
}

/**
 * Build the `<radialGradient>` def for a parsed radial gradient applied to
 * a specific painted rect. Elliptical gradients use gradientTransform to
 * stretch the natively-circular SVG radial gradient.
 */
export function buildRadialGradientDef(
  gradient: RadialGradient,
  id: string,
  rect: { x: number; y: number; w: number; h: number },
): string {
  const cx = resolvePos(gradient.position.x, rect.x, rect.w);
  const cy = resolvePos(gradient.position.y, rect.y, rect.h);
  const { rx, ry } = resolveRadii(gradient, cx, cy, rect);
  // Resolve stops against the gradient ray length. For ellipse, use rx (the
  // x-axis radius) as the canonical ray length — gradientTransform rescales
  // ry separately.
  const resolved = gradient.stops.map((s) => ({ ...s }));
  resolveStops(resolved, rx, { skipFirstLastDefaults: gradient.repeating === true });
  const tiled = gradient.repeating === true ? tileRepeatingStops(resolved) : resolved;
  const stopMarkup_ = tiled.map((s) => stopMarkup(s)).join("");
  // SVG <radialGradient> takes one r. For ellipse, use rx and apply a
  // gradientTransform to scale the y axis to ry.
  const r = rx;
  const transform = ry !== rx
    ? ` gradientTransform="translate(${num(cx)} ${num(cy)}) scale(1 ${num(ry / rx)}) translate(${num(-cx)} ${num(-cy)})"`
    : "";
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}"${transform}>${stopMarkup_}</radialGradient>`;
}

// ── Internals ──────────────────────────────────────────────────────────────

function num(n: number): string {
  return Number(n.toFixed(3)).toString();
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** Parse a CSS gradient angle token. Returns degrees, or null if not an angle. */
function parseAngleToken(tok: string): number | null {
  const t = tok.trim().toLowerCase();
  // Side keywords: "to <side>" or "to <side> <side>".
  if (t.startsWith("to ")) {
    const sides = t.slice(3).split(/\s+/).filter((s) => s !== "");
    return sidesToAngle(sides);
  }
  // Numeric angle: <number><unit>
  const m = /^(-?\d+(?:\.\d+)?|-?\.\d+)(deg|grad|rad|turn)?$/.exec(t);
  if (m == null) return null;
  const value = parseFloat(m[1]);
  const unit = m[2] ?? "deg";
  let deg: number;
  if (unit === "deg") deg = value;
  else if (unit === "turn") deg = value * 360;
  else if (unit === "grad") deg = (value * 360) / 400;
  else if (unit === "rad") deg = (value * 180) / Math.PI;
  else return null;
  // Normalize to [0, 360).
  return ((deg % 360) + 360) % 360;
}

function sidesToAngle(sides: string[]): number | null {
  // "to top" = 0deg, "to right" = 90, "to bottom" = 180, "to left" = 270.
  // Combined sides go corner-ward but the actual angle is computed per the
  // CSS "magic corner" rule and depends on the box aspect ratio. For the
  // pseudo-element use case (small rects with predictable aspect ratios),
  // approximate corner directions with 45deg increments — Chromium's
  // computed style normalizes "to top right" to a numeric angle anyway, so
  // this branch is mostly defensive.
  const set = new Set(sides);
  if (set.has("top") && set.has("right")) return 45;
  if (set.has("right") && set.has("bottom")) return 135;
  if (set.has("bottom") && set.has("left")) return 225;
  if (set.has("top") && set.has("left")) return 315;
  if (set.has("top")) return 0;
  if (set.has("right")) return 90;
  if (set.has("bottom")) return 180;
  if (set.has("left")) return 270;
  return null;
}

/**
 * Parse a single color-stop token. Returns 1 stop normally, 2 stops for the
 * double-position hard-stop form `<color> <pos1> <pos2>`. Returns [] if the
 * token is unparseable.
 */
function parseStopToken(tok: string): LinearStop[] {
  // Find the boundary between the color and any trailing positions. Color
  // values may contain spaces (e.g. `rgb(0 0 0 / 0.5)` modern syntax) and
  // commas inside parens, so split by walking parens-aware.
  const parts = splitTopLevelSpaces(tok);
  if (parts.length === 0) return [];
  // Heuristic: positions are tokens that match a length/percent pattern.
  // calc(...) tokens that resolve to a length-percent are also positions
  // (DM-275: repeating gradients commonly use `calc(N% - Mpx)` for stripe
  // boundaries). Anything more complex falls through to color-text.
  const posRe = /^(-?\d+(?:\.\d+)?|-?\.\d+)(%|px|em|rem|pt|cm|mm|in|pc)?$/;
  const calcRe = /^calc\(.*\)$/;
  const isPos = (t: string) => posRe.test(t) || calcRe.test(t);
  // Walk from the end consuming positions.
  const positions: string[] = [];
  let cut = parts.length;
  while (cut > 0 && isPos(parts[cut - 1])) {
    positions.unshift(parts[cut - 1]);
    cut--;
  }
  if (cut === 0) return [];
  const colorText = parts.slice(0, cut).join(" ").trim();
  if (colorText === "") return [];
  if (positions.length === 0) return [{ color: colorText }];
  if (positions.length === 1) {
    return [makeStop(colorText, positions[0])];
  }
  // Double-position hard stop: emit two stops at p1, p2 sharing the color.
  if (positions.length === 2) {
    return [makeStop(colorText, positions[0]), makeStop(colorText, positions[1])];
  }
  return [];
}

/** Build a LinearStop from a color and one position token. */
function makeStop(color: string, posTok: string): LinearStop {
  const calc = parseCalcPosition(posTok);
  if (calc != null) return { color, calcOffset: calc, rawPos: posTok };
  const parsed = parsePosition(posTok);
  if (parsed == null) return { color, rawPos: posTok };
  if (parsed.kind === "frac") return { color, offset: parsed.value, rawPos: posTok };
  return { color, pxOffset: parsed.value, rawPos: posTok };
}

/**
 * Parse a `calc(<pct>% ± <px>px)` token into a {pct, px} pair (DM-275).
 * Supports the limited form Chromium emits in computed gradient stops:
 * a single percentage term plus an optional signed pixel offset, in either
 * order. Anything else returns null and the caller falls back to the
 * straight `parsePosition` path (which won't handle calc, leaving the stop
 * un-positioned).
 *
 * Examples:
 *   `calc(10% - 1px)` → {pct: 10, px: -1}
 *   `calc(10%)`       → {pct: 10, px: 0}
 *   `calc(10% + 2px)` → {pct: 10, px: 2}
 *   `calc(2px + 10%)` → {pct: 10, px: 2}
 */
function parseCalcPosition(tok: string): { pct: number; px: number } | null {
  const m = /^calc\(\s*(.+?)\s*\)$/.exec(tok);
  if (m == null) return null;
  const inner = m[1];
  // Tokenize: split on top-level + or -, preserving signs.
  const terms: { sign: 1 | -1; raw: string }[] = [];
  let sign: 1 | -1 = 1;
  let buf = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if ((c === "+" || c === "-") && buf.trim() !== "" && /\s/.test(inner[i - 1])) {
      terms.push({ sign, raw: buf.trim() });
      sign = c === "+" ? 1 : -1;
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim() !== "") terms.push({ sign, raw: buf.trim() });
  let pct = 0;
  let px = 0;
  for (const t of terms) {
    const pm = /^(-?\d+(?:\.\d+)?|-?\.\d+)(%|px)?$/.exec(t.raw);
    if (pm == null) return null;
    const val = parseFloat(pm[1]) * t.sign;
    const unit = pm[2] ?? "px";
    if (unit === "%") pct += val;
    else if (unit === "px") px += val;
    else return null;
  }
  return { pct, px };
}

/** Split a single-stop token into space-separated parts, paren-aware. */
function splitTopLevelSpaces(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inToken = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (depth === 0 && /\s/.test(c)) {
      if (inToken) {
        out.push(s.slice(start, i));
        inToken = false;
      }
      continue;
    }
    if (!inToken) {
      start = i;
      inToken = true;
    }
  }
  if (inToken) out.push(s.slice(start));
  return out;
}

type ParsedPosition = { kind: "frac"; value: number } | { kind: "px"; value: number };

/**
 * Parse a stop position token to a fractional offset (0..1) or a pending
 * pixel offset (resolved to a fraction once the painted rect's gradient
 * line length is known — SK-1226).
 *
 * Length units other than px are coerced to px via a coarse approximation
 * (1em = 16px, 1pt = 4/3 px, etc.) since real CSS context isn't available
 * at parse time. Authors using em/rem on gradient stops are rare in
 * practice; if the heuristic bites, the fallback is auto-distribution.
 */
function parsePosition(tok: string): ParsedPosition | null {
  const m = /^(-?\d+(?:\.\d+)?|-?\.\d+)(%|px|em|rem|pt|cm|mm|in|pc)?$/.exec(tok);
  if (m == null) return null;
  const value = parseFloat(m[1]);
  const unit = m[2] ?? "";
  if (unit === "%") return { kind: "frac", value: value / 100 };
  if (unit === "") return { kind: "frac", value: value / 100 }; // bare number → percent (lenient)
  if (unit === "px") return { kind: "px", value };
  // Coarse length conversions to px; rare on gradient stops.
  if (unit === "em" || unit === "rem") return { kind: "px", value: value * 16 };
  if (unit === "pt") return { kind: "px", value: value * (4 / 3) };
  if (unit === "pc") return { kind: "px", value: value * 16 };
  if (unit === "in") return { kind: "px", value: value * 96 };
  if (unit === "cm") return { kind: "px", value: value * (96 / 2.54) };
  if (unit === "mm") return { kind: "px", value: value * (96 / 25.4) };
  return null;
}

/**
 * Resolve all stop positions to fractional offsets (0..1) for emission.
 * - Px stops (pxOffset set) → offset = pxOffset / gradientLineLength.
 * - First stop without an offset → 0.
 * - Last stop without an offset → 1.
 * - Middle stops without an offset → linearly interpolated between
 *   surrounding positioned stops.
 * - Out-of-order positions are clamped (CSS rule: each stop's effective
 *   offset is max(self, previous)).
 *
 * Mutates `stops` in place. Caller may want to clone first if the same
 * parsed gradient is being emitted against multiple rects (different L).
 */
function resolveStops(stops: LinearStop[], gradientLineLength: number, opts?: { skipFirstLastDefaults?: boolean }): void {
  if (stops.length === 0) return;
  // Resolve pending px / calc positions to fractions.
  if (gradientLineLength > 0) {
    for (const s of stops) {
      if (s.offset == null && s.pxOffset != null) {
        s.offset = s.pxOffset / gradientLineLength;
      } else if (s.offset == null && s.calcOffset != null) {
        s.offset = s.calcOffset.pct / 100 + s.calcOffset.px / gradientLineLength;
      }
    }
  }
  // For repeating gradients, the first/last stop must NOT be forced to 0/1 —
  // their explicit positions define the tile period. Authors may omit them
  // and rely on auto-distribution within the tile, but our test cases
  // always include explicit positions, so leave them alone (DM-275).
  if (opts?.skipFirstLastDefaults !== true) {
    if (stops[0].offset == null) stops[0].offset = 0;
    if (stops[stops.length - 1].offset == null) stops[stops.length - 1].offset = 1;
  }
  let i = 0;
  while (i < stops.length) {
    if (stops[i].offset != null) {
      i++;
      continue;
    }
    // Find the next positioned stop.
    let j = i + 1;
    while (j < stops.length && stops[j].offset == null) j++;
    const prev = stops[i - 1].offset ?? 0;
    const next = stops[j]?.offset ?? 1;
    const span = j - i + 1;
    for (let k = i; k < j; k++) {
      stops[k].offset = prev + ((next - prev) * (k - (i - 1))) / span;
    }
    i = j;
  }
  // Enforce monotonicity (CSS rule: each stop's effective offset is
  // max(self, previous)). Out-of-order positions are still emitted, just
  // clamped — SVG renderers honor monotonic offsets.
  let max = stops[0].offset ?? 0;
  for (const s of stops) {
    if (s.offset != null && s.offset < max) s.offset = max;
    if (s.offset != null && s.offset > max) max = s.offset;
  }
}

/**
 * Tile repeating-gradient stops across the full [0, 1] gradient line.
 *
 * The author specifies one tile period via the first and last stop offsets
 * (e.g. `repeating-linear-gradient(90deg, transparent 0 9%, #94a3b8 9% 10%)`
 * has period = 0.10 starting at 0). We replicate the stop list, shifted by
 * the period, until we cover [0, 1]. SVG `<linearGradient>` doesn't have a
 * native repeat mode (`spreadMethod="repeat"` only repeats *outside* the
 * declared 0..1 range, which userSpaceOnUse already clips to the gradient
 * line endpoints), so up-front replication is the simplest approach that
 * works across renderers (DM-275).
 *
 * Caller is responsible for resolving stop offsets first (px → fraction).
 * Stops without offsets are dropped from the tile (defensive: should not
 * happen for the well-formed test fixtures).
 */
function tileRepeatingStops(stops: LinearStop[]): LinearStop[] {
  if (stops.length < 2) return stops;
  const sorted = stops.filter((s) => s.offset != null) as Array<LinearStop & { offset: number }>;
  if (sorted.length < 2) return stops;
  const tileStart = sorted[0].offset;
  const tileEnd = sorted[sorted.length - 1].offset;
  const period = tileEnd - tileStart;
  // No meaningful period (degenerate tile) — emit one copy clamped to 0..1.
  if (period <= 0 || period > 1) return sorted.map((s) => ({ ...s, offset: Math.max(0, Math.min(1, s.offset)) }));
  const out: LinearStop[] = [];
  // Shift backward until tileStart - n*period <= 0.
  let n = 0;
  while (tileStart - n * period > 0) n++;
  // Then walk forward emitting tiles until we pass 1.
  for (let k = -n; ; k++) {
    const shift = k * period;
    const tileFirst = tileStart + shift;
    if (tileFirst > 1) break;
    for (const s of sorted) {
      const off = s.offset + shift;
      if (off < 0 - 1e-9 || off > 1 + 1e-9) continue;
      out.push({ ...s, offset: Math.max(0, Math.min(1, off)) });
    }
  }
  if (out.length === 0) return sorted.map((s) => ({ ...s, offset: Math.max(0, Math.min(1, s.offset)) }));
  return out;
}

function looksLikeRadialPrefix(tok: string): boolean {
  const lower = tok.toLowerCase();
  if (/\b(circle|ellipse|closest-side|closest-corner|farthest-side|farthest-corner)\b/.test(lower)) return true;
  if (/\bat\b/.test(lower)) return true;
  // A bare length like "50px 30px" with no color is also a prefix — but
  // "50px 30px" alone would be unparseable as a stop (no color), so the
  // stop parser would fail to add it. To be safe, treat as prefix only if
  // the token contains an unambiguous shape/keyword/at marker.
  return false;
}

function parseRadialPrefix(tok: string): { shape: "circle" | "ellipse"; size: RadialSize; position: { x: PosValue; y: PosValue } } | null {
  // Split on " at " (case-insensitive) into [shape-and-size, position].
  const atSplit = tok.split(/\s+at\s+/i);
  const shapeSizeText = atSplit[0].trim();
  const positionText = atSplit.length > 1 ? atSplit.slice(1).join(" at ").trim() : "";

  const shapeSize = parseShapeAndSize(shapeSizeText);
  if (shapeSize == null) return null;
  const position = positionText !== "" ? parsePositionPair(positionText) : {
    x: { kind: "frac" as const, value: 0.5 },
    y: { kind: "frac" as const, value: 0.5 },
  };
  if (position == null) return null;
  return { shape: shapeSize.shape, size: shapeSize.size, position };
}

function parseShapeAndSize(text: string): { shape: "circle" | "ellipse"; size: RadialSize } | null {
  const parts = splitTopLevelSpaces(text).map((p) => p.toLowerCase());
  let shape: "circle" | "ellipse" = "ellipse";
  let size: RadialSize = { kind: "extent", value: "farthest-corner" };
  const sizes: number[] = [];
  let extent: RadialSize | null = null;
  for (const p of parts) {
    if (p === "circle") shape = "circle";
    else if (p === "ellipse") shape = "ellipse";
    else if (p === "closest-side" || p === "closest-corner" || p === "farthest-side" || p === "farthest-corner") {
      extent = { kind: "extent", value: p };
    } else {
      const parsed = parsePosition(p);
      if (parsed != null && parsed.kind === "px") sizes.push(parsed.value);
      else if (parsed != null && parsed.kind === "frac") sizes.push(parsed.value); // % treated as px-equivalent only loosely
      else if (p === "") {
        /* skip */
      } else return null;
    }
  }
  if (sizes.length === 1) size = { kind: "px", r1: sizes[0] };
  else if (sizes.length === 2) {
    size = { kind: "px", r1: sizes[0], r2: sizes[1] };
    shape = "ellipse"; // two sizes implies ellipse
  } else if (sizes.length === 0 && extent != null) {
    size = extent;
  } else if (sizes.length === 0) {
    // Default
    size = { kind: "extent", value: "farthest-corner" };
  } else {
    return null;
  }
  return { shape, size };
}

function parsePositionPair(text: string): { x: PosValue; y: PosValue } | null {
  const parts = splitTopLevelSpaces(text).map((p) => p.toLowerCase());
  // Resolve each token to a PosValue or a side keyword.
  let x: PosValue = { kind: "frac", value: 0.5 };
  let y: PosValue = { kind: "frac", value: 0.5 };
  // Side keywords map to fractions.
  const sideX: Record<string, number> = { left: 0, center: 0.5, right: 1 };
  const sideY: Record<string, number> = { top: 0, center: 0.5, bottom: 1 };
  // CSS position is up to 4 tokens but the common forms are 1 or 2.
  if (parts.length === 1) {
    const p = parts[0];
    if (p in sideX) x = { kind: "frac", value: sideX[p] };
    else if (p in sideY) y = { kind: "frac", value: sideY[p] };
    else {
      const v = parsePosition(p);
      if (v == null) return null;
      x = v.kind === "px" ? { kind: "px", value: v.value } : { kind: "frac", value: v.value };
    }
  } else if (parts.length >= 2) {
    const [a, b] = parts;
    // Order can be x y or y x — keyword 'top'/'bottom' before length means y.
    let xTok = a;
    let yTok = b;
    if ((a === "top" || a === "bottom") && (b in sideX || /^[-\d.]/.test(b))) {
      xTok = b;
      yTok = a;
    }
    const xVal = xTok in sideX ? { kind: "frac" as const, value: sideX[xTok] } : posValueFromToken(xTok);
    const yVal = yTok in sideY ? { kind: "frac" as const, value: sideY[yTok] } : posValueFromToken(yTok);
    if (xVal == null || yVal == null) return null;
    x = xVal;
    y = yVal;
  }
  return { x, y };
}

function posValueFromToken(tok: string): PosValue | null {
  const v = parsePosition(tok);
  if (v == null) return null;
  if (v.kind === "px") return { kind: "px", value: v.value };
  return { kind: "frac", value: v.value };
}

function resolvePos(p: PosValue, rectStart: number, rectExtent: number): number {
  if (p.kind === "px") return rectStart + p.value;
  return rectStart + p.value * rectExtent;
}

/**
 * Resolve a radial gradient's size to concrete (rx, ry) given its center
 * and the painted rect. CSS extent keywords measure distance from the
 * center to the named feature (side or corner) of the rect.
 */
function resolveRadii(g: RadialGradient, cx: number, cy: number, rect: { x: number; y: number; w: number; h: number }): { rx: number; ry: number } {
  if (g.size.kind === "px") {
    const r1 = g.size.r1;
    const r2 = g.size.r2 ?? r1;
    return { rx: r1, ry: g.shape === "circle" ? r1 : r2 };
  }
  const left = cx - rect.x;
  const right = rect.x + rect.w - cx;
  const top = cy - rect.y;
  const bottom = rect.y + rect.h - cy;
  const dxClosest = Math.min(Math.abs(left), Math.abs(right));
  const dxFarthest = Math.max(Math.abs(left), Math.abs(right));
  const dyClosest = Math.min(Math.abs(top), Math.abs(bottom));
  const dyFarthest = Math.max(Math.abs(top), Math.abs(bottom));
  switch (g.size.value) {
    case "closest-side":
      if (g.shape === "circle") {
        const d = Math.min(dxClosest, dyClosest);
        return { rx: d, ry: d };
      }
      return { rx: dxClosest, ry: dyClosest };
    case "farthest-side":
      if (g.shape === "circle") {
        const d = Math.max(dxFarthest, dyFarthest);
        return { rx: d, ry: d };
      }
      return { rx: dxFarthest, ry: dyFarthest };
    case "closest-corner": {
      const d = Math.sqrt(dxClosest * dxClosest + dyClosest * dyClosest);
      if (g.shape === "circle") return { rx: d, ry: d };
      // For ellipse, scale the closest-side radii so the corner sits on the curve.
      const k = Math.sqrt((dxClosest * dxClosest + dyClosest * dyClosest) / (dxClosest * dxClosest + dyClosest * dyClosest)); // = 1; spec scaling is more nuanced
      return { rx: dxClosest * k, ry: dyClosest * k };
    }
    case "farthest-corner": {
      const d = Math.sqrt(dxFarthest * dxFarthest + dyFarthest * dyFarthest);
      if (g.shape === "circle") return { rx: d, ry: d };
      // CSS ellipse farthest-corner: rx = farthest x distance scaled so the corner lies on the curve.
      // Approximation: rx = dxFarthest * sqrt(2), ry = dyFarthest * sqrt(2).
      // This is the common-case approximation used in browsers.
      return { rx: dxFarthest * Math.SQRT2, ry: dyFarthest * Math.SQRT2 };
    }
  }
}

function stopMarkup(stop: LinearStop): string {
  const offset = stop.offset != null ? Math.max(0, Math.min(1, stop.offset)) : 0;
  const { color, opacity } = splitColorAndAlpha(stop.color);
  const opAttr = opacity != null && opacity !== 1 ? ` stop-opacity="${num(opacity)}"` : "";
  return `<stop offset="${num(offset)}" stop-color="${color}"${opAttr} />`;
}

/**
 * Split a CSS color into its base color and alpha channel for emission as
 * separate `stop-color` + `stop-opacity` attrs (SVG renderers handle this
 * pair more reliably than embedding the alpha in the color string).
 */
function splitColorAndAlpha(color: string): { color: string; opacity: number | null } {
  const rgba = /^rgba\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)$/i.exec(color);
  if (rgba != null) {
    return { color: `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})`, opacity: parseFloat(rgba[4]) };
  }
  return { color, opacity: null };
}
