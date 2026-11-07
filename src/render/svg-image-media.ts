/**
 * `@media` evaluation inside an `<img>` SVG document. Blink gives the image
 * its own document whose frame view is sized to the container size, which is
 * the `<img>`'s concrete object rect (`SVGImage::PaintRecordForCurrentFrame`,
 * `core/svg/graphics/svg_image.cc:463-473`, chromium 7d859f27), so width /
 * height features see that rect in the image's CSS px rather than the page
 * viewport.
 */
/**
 * The parts of the image document's media environment that come from its
 * embedder rather than from source. Null / absent when the capture did not
 * record them.
 */
export interface ImageMediaEnv {
  /** Blink's `LayoutImageResource::GetImage` resolves it with
   *  `StyleEngine::ResolveColorSchemeForEmbedding` and hands it to the image
   *  (`SVGImage::SetPreferredColorScheme`, `core/svg/graphics/svg_image.cc:306`). */
  preferredColorScheme?: "light" | "dark" | null;
  /** The image page's `Settings::PrefersReducedMotion`, copied from the first
   *  ordinary page's Settings (`svg_image.cc:901-904`,
   *  `isolated_svg_document_host.cc:192-193`). The image page has no media
   *  overrides, so `MediaValues::CalculatePrefersReducedMotion`
   *  (`core/css/media_values.cc:441-459`) returns it. */
  prefersReducedMotion?: boolean | null;
  /** Whether the image page's `Settings::InForcedColors` (copied at
   *  `isolated_svg_document_host.cc:199`) is set, which is its StyleEngine's
   *  forced colors (`core/css/style_engine.cc:4431`). */
  forcedColors?: boolean | null;
}

/**
 * Evaluate an `@media` query list against the SVG image document.
 *
 * - Width / height / aspect-ratio / orientation see the image viewport (CSS
 *   px): Blink sizes the image document's frame view to the container size
 *   (`SVGImage::PaintRecordForCurrentFrame`, `core/svg/graphics/svg_image.cc:472`).
 * - The image lives in a non-ordinary `Page` (`IsolatedSVGDocumentHost`,
 *   `core/svg/graphics/isolated_svg_document_host.cc:105-125`) that copies only
 *   fonts, animation policy, `prefersReducedMotion`, `preferredColorScheme`,
 *   `inForcedColors` and accept-languages from an ordinary page's Settings
 *   (`CopySettingsFrom`, :178-202), and never sees DevTools media overrides. So:
 *   - `hover` / `pointer` and `any-hover` / `any-pointer` keep the Settings
 *     defaults `kHoverNone` / `kPointerNone` and `HOVER_TYPE_NONE` /
 *     `POINTER_TYPE_NONE` (`core/frame/settings.json5:748-777`);
 *   - `prefers-contrast` and `prefers-reduced-transparency` keep
 *     `no-preference` (settings.json5:1186-1209);
 *   - `resolution` and `-webkit-device-pixel-ratio` are 1dppx:
 *     `LocalFrame::DevicePixelRatio` is the page's inspector override (1,
 *     `core/page/page.cc:276`) times the frame's layout zoom, 1 for a frame
 *     with no parent (`core/frame/local_frame.cc:288-291, 1839-1846`).
 *   - `prefers-color-scheme` is the embedder's resolved scheme (`env`).
 *   - `prefers-reduced-motion` and `forced-colors` follow the copied Settings
 *     (`env`), which capture asks an SVG image itself for; undecided when it
 *     did not record them.
 * Feature semantics per `core/css/media_query_evaluator.cc` (chromium
 * 7d859f27). Supports the `all` / `screen` media types, `not` / `only`,
 * `and`, the `min-` / `max-` and range forms of the numeric features, and the
 * boolean form of the environment features. Null when any part is outside
 * that set.
 */
export function evaluateMediaQueryList(
  list: string,
  vp: { w: number; h: number } | null,
  env: ImageMediaEnv = {},
): boolean | null {
  const queries = list.split(",").map((q) => q.trim());
  let any = false;
  for (const q of queries) {
    const r = evaluateMediaQuery(q, vp, env);
    if (r == null) return null;
    any ||= r;
  }
  return any;
}

function evaluateMediaQuery(query: string, vp: { w: number; h: number } | null, env: ImageMediaEnv): boolean | null {
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
    const r = evaluateMediaFeature(part, vp, env);
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

/** A `<resolution>` in dppx (`dppx` / `x` / `dpi` / `dpcm`), with whether it
 *  was given in dpcm (`EvalResolution` rounds those comparisons). */
function mediaResolution(token: string): { dppx: number; dpcm: boolean } | null {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))(dppx|x|dpi|dpcm)$/i.exec(token.trim());
  if (m == null) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const dppx = unit === "dpi" ? n / 96 : unit === "dpcm" ? (n * 2.54) / 96 : n;
  return { dppx, dpcm: unit === "dpcm" };
}

/** The image document's device pixel ratio (see `evaluateMediaQueryList`). */
const IMAGE_DPPX: number = 1;

/** A discrete or boolean-context feature of the image document, or null when
 *  it is not one decided here. `value` is null in the boolean context. */
function discreteFeature(name: string, value: string | null, env: ImageMediaEnv): boolean | null {
  const v = value?.trim().toLowerCase() ?? null;
  const oneOf = (allowed: string[]): boolean => v != null && allowed.includes(v);
  switch (name) {
    case "prefers-color-scheme": {
      // PrefersColorSchemeMediaFeatureEval: the boolean form is always true.
      if (v == null) return true;
      if (!oneOf(["light", "dark"])) return null;
      const scheme = env.preferredColorScheme;
      return scheme == null ? null : v === scheme;
    }
    case "hover":
    case "any-hover":
      // Primary kHoverNone; available HOVER_TYPE_NONE only.
      if (v == null) return false;
      return oneOf(["none", "hover"]) ? v === "none" : null;
    case "pointer":
    case "any-pointer":
      if (v == null) return false;
      return oneOf(["none", "coarse", "fine"]) ? v === "none" : null;
    case "prefers-contrast":
      if (v == null) return false;
      return oneOf(["no-preference", "more", "less", "custom"]) ? v === "no-preference" : null;
    case "prefers-reduced-transparency":
      if (v == null) return false;
      return oneOf(["no-preference", "reduce"]) ? v === "no-preference" : null;
    case "prefers-reduced-motion": {
      // PrefersReducedMotionMediaFeatureEval (media_query_evaluator.cc:1000-1022):
      // the boolean form is the setting itself.
      const reduce = env.prefersReducedMotion;
      if (v != null && !oneOf(["no-preference", "reduce"])) return null;
      if (reduce == null) return null;
      return v == null ? reduce : (v === "no-preference") !== reduce;
    }
    case "forced-colors": {
      // ForcedColorsMediaFeatureEval (media_query_evaluator.cc:1207-1228).
      const forced = env.forcedColors;
      if (v != null && !oneOf(["none", "active"])) return null;
      if (forced == null) return null;
      return v == null ? forced : (v === "active") === forced;
    }
    case "resolution":
    case "-webkit-device-pixel-ratio":
      // EvalResolution: the boolean form is `!!actual_resolution`, and the
      // image document's ratio is 1.
      return v == null ? true : null;
    default:
      return null;
  }
}

type NumericFeature = "width" | "height" | "aspect-ratio" | "resolution";

function evaluateMediaFeature(part: string, vp: { w: number; h: number } | null, env: ImageMediaEnv): boolean | null {
  const inner = /^\(([\s\S]*)\)$/.exec(part.trim())?.[1].trim();
  if (inner == null) return null;
  if (/^[-a-z]+$/i.test(inner)) return discreteFeature(inner.toLowerCase(), null, env);
  // Viewport features are undecided when the image viewport is unknown.
  const valueOf = (feature: NumericFeature): number | null =>
    feature === "resolution"
      ? IMAGE_DPPX
      : vp == null
        ? null
        : feature === "width"
          ? vp.w
          : feature === "height"
            ? vp.h
            : vp.w / vp.h;
  // A comparison `actual op target`; dpcm values compare at 2 decimals
  // (EvalResolution, media_query_evaluator.cc:577-585).
  const parse = (feature: NumericFeature, token: string): { value: number; round: boolean } | null => {
    if (feature === "aspect-ratio") {
      const r = mediaRatio(token);
      return r == null ? null : { value: r, round: false };
    }
    if (feature === "resolution") {
      const r = mediaResolution(token);
      return r == null ? null : { value: r.dppx, round: r.dpcm };
    }
    const l = mediaLength(token);
    return l == null ? null : { value: l, round: false };
  };
  const round2 = (n: number): number => Math.floor(0.5 + 100 * n) / 100;
  const cmp = (a: number, op: string, b: number): boolean =>
    op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : a === b;
  const colon = /^([-a-z]+)\s*:\s*([\s\S]+)$/i.exec(inner);
  if (colon != null) {
    const name = colon[1].toLowerCase();
    if (name === "orientation") {
      const v = colon[2].trim().toLowerCase();
      if (v !== "portrait" && v !== "landscape") return null;
      return vp == null ? null : vp.h >= vp.w === (v === "portrait");
    }
    const px = /^-webkit-(min-|max-)?device-pixel-ratio$/.exec(name);
    if (px != null) {
      // DevicePixelRatioMediaFeatureEval takes a plain number.
      const n = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*$/.exec(colon[2]);
      if (n == null) return null;
      const op = px[1] === "min-" ? ">=" : px[1] === "max-" ? "<=" : "=";
      return cmp(IMAGE_DPPX, op, Number(n[1]));
    }
    const m = /^(min-|max-)?(width|height|aspect-ratio|resolution)$/.exec(name);
    if (m == null) return discreteFeature(name, colon[2], env);
    const feature = m[2] as NumericFeature;
    const target = parse(feature, colon[2]);
    const value = valueOf(feature);
    if (target == null || value == null) return null;
    const actual = target.round ? round2(value) : value;
    const goal = target.round ? round2(target.value) : target.value;
    return cmp(actual, m[1] === "min-" ? ">=" : m[1] === "max-" ? "<=" : "=", goal);
  }
  // Range syntax: `(width >= 100px)`, `(100px < width <= 300px)`.
  const tokens = inner.split(/\s*(<=|>=|<|>|=)\s*/);
  if (tokens.length !== 3 && tokens.length !== 5) return null;
  const featureToken = (tokens.length === 3 ? [tokens[0], tokens[2]] : [tokens[2]]).find((t) =>
    /^(width|height|aspect-ratio|resolution)$/i.test(t),
  );
  if (featureToken == null) return null;
  const feature = featureToken.toLowerCase() as NumericFeature;
  // Each operand: its value (the actual one for the feature) and whether it was
  // given in dpcm, which rounds that one comparison.
  const operands: Array<{ value: number; round: boolean }> = [];
  for (let k = 0; k < tokens.length; k += 2) {
    if (tokens[k].toLowerCase() === feature) {
      const actual = valueOf(feature);
      if (actual == null) return null;
      operands.push({ value: actual, round: false });
      continue;
    }
    const v = parse(feature, tokens[k]);
    if (v == null) return null;
    operands.push(v);
  }
  for (let k = 0; k + 1 < operands.length; k++) {
    const round = operands[k].round || operands[k + 1].round;
    const [a, b] = [operands[k].value, operands[k + 1].value].map((n) => (round ? round2(n) : n));
    if (!cmp(a, tokens[2 * k + 1], b)) return false;
  }
  return true;
}
