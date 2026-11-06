import { z } from "zod";

/**
 * Validation and emission guards for author-supplied CSS values that land in the
 * output SVG's `<style>` block, a `style="…"` attribute, or a presentation
 * attribute such as `fill="…"`.
 *
 * Animation `from` / `to` / `transformOrigin`, overlay and caret colors, and
 * canvas backgrounds used to be interpolated as free text, so a value such as
 * `0}</style><script>…` closed the `<style>` element of a "self-contained" SVG
 * and `red" onload="…` broke out of an attribute. Each value is now checked
 * twice. The config schemas reject it with the property's own grammar where
 * that grammar is small (`opacity` and `scale` are numbers, `translate*` /
 * `width` / `height` are lengths) and otherwise with `isSafeCssValue`. The
 * emitters re-check it (`cssValueForStyle`, `cssAnimationValueForStyle`,
 * `cssIdentForStyle`) for direct API callers that bypass the schemas, and throw
 * rather than write it. This is the sibling of `easing-input.ts`.
 */

/**
 * Characters no plain CSS value needs, and that end or escape its context:
 * `<` / `>` (markup, `</style>`), `{` / `}` (a new rule), `;` (a new
 * declaration), `\` (a CSS escape that can spell any of these), `&` (an XML
 * entity reference), and control characters (including line breaks).
 */
const UNSAFE_CSS_CHARS = /[<>{};\\&\u0000-\u001f\u007f]/;
/** Quotes: needed only by `clip-path` `path()` / `url()` and font-family names. */
const QUOTE_CHARS = /["'`]/;

export interface SafeCssValueOptions {
  /** Permit `"`, `'` and `` ` `` (for `clip-path: path('…')` and the like). Default false. */
  allowQuotes?: boolean;
}

/** True when `value` can sit inside a CSS declaration or an attribute without leaving it. */
export function isSafeCssValue(value: string, opts: SafeCssValueOptions = {}): boolean {
  if (UNSAFE_CSS_CHARS.test(value)) return false;
  if (opts.allowQuotes !== true && QUOTE_CHARS.test(value)) return false;
  return true;
}

const SAFE_MESSAGE = "must be a plain CSS value (no < > { } ; \\ & quotes or line breaks)";
const SAFE_QUOTED_MESSAGE = "must be a plain CSS value (no < > { } ; \\ & or line breaks)";

/** A free-form CSS value with no quotes: a color, `transform`, or `transform-origin`. */
export const cssValueInputSchema = z.string().refine((v) => isSafeCssValue(v), { message: SAFE_MESSAGE });

/** A CSS color (or paint) written into the output: free-form, no quotes. */
export const cssColorInputSchema = cssValueInputSchema;

/** `transform-origin`: keywords, lengths and percentages; no quotes. */
export const transformOriginInputSchema = cssValueInputSchema;

/**
 * An animation `from` / `to` value before its property is known: free-form with
 * quotes allowed (a `clipPath` value may be `path('…')`). The per-property grammar
 * is applied by `isAnimationValueInput`, at the object level and in the emitter.
 */
export const animationValueInputSchema = z
  .string()
  .refine((v) => isSafeCssValue(v, { allowQuotes: true }), { message: SAFE_QUOTED_MESSAGE });

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER_RE = new RegExp(`^${NUM}%?$`);
const SCALE_RE = new RegExp(`^${NUM}%?(?:\\s*,?\\s*${NUM}%?){0,2}$`);
const LENGTH_RE = new RegExp(`^${NUM}(?:[a-zA-Z]+|%)?$`);
/** A math or variable function (`calc(100% - 20px)`, `var(--x)`), already checked for safe characters. */
const FUNCTION_RE = /^(?:calc|min|max|clamp|var)\([^"'`]*\)$/i;

/** The animatable properties, across intra-frame animations and composite layers. */
export type AnimationValueProperty =
  | "width"
  | "height"
  | "opacity"
  | "transform"
  | "translateX"
  | "translateY"
  | "scale"
  | "clipPath"
  | "clipScaleX"
  | "clipScaleY";

/**
 * The per-property grammar for an animation `from` / `to` value. `opacity` is a
 * number or percentage; `scale` is one to three numbers; `translate*` / `width` /
 * `height` are a length or percentage; each of those also accepts a math or
 * `var()` function. `transform` and `clipPath` are free-form but must pass
 * `isSafeCssValue` (`clipPath` may contain quotes); `clipScaleX/Y` are numbers.
 */
export function isAnimationValueInput(property: AnimationValueProperty, value: string | number): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  const v = value.trim();
  if (v === "") return false;
  switch (property) {
    case "opacity":
    case "clipScaleX":
    case "clipScaleY":
      return NUMBER_RE.test(v) || (property === "opacity" && isSafeCssValue(v) && FUNCTION_RE.test(v));
    case "scale":
      return SCALE_RE.test(v) || (isSafeCssValue(v) && FUNCTION_RE.test(v));
    case "translateX":
    case "translateY":
    case "width":
    case "height":
      return LENGTH_RE.test(v) || (isSafeCssValue(v) && FUNCTION_RE.test(v));
    case "transform":
      return isSafeCssValue(v);
    case "clipPath":
      return isSafeCssValue(v, { allowQuotes: true });
  }
}

function animationValueMessage(property: AnimationValueProperty): string {
  switch (property) {
    case "opacity":
    case "clipScaleX":
    case "clipScaleY":
      return `must be a number for "${property}"`;
    case "scale":
      return 'must be one to three numbers for "scale"';
    case "translateX":
    case "translateY":
    case "width":
    case "height":
      return `must be a CSS length or percentage for "${property}"`;
    case "transform":
      return `${SAFE_MESSAGE} for "transform"`;
    case "clipPath":
      return `${SAFE_QUOTED_MESSAGE} for "clipPath"`;
  }
}

/**
 * Object-level refinement for an animation entry: checks `from`, `to` and each
 * fused track's values against their property's grammar. Applied with
 * `.superRefine` on the final authoring schemas (not on `intraFrameAnimationSchema`
 * itself, which is `.omit()`ted to build them).
 */
export function refineAnimationValues(
  a: {
    property?: AnimationValueProperty;
    from?: string | number;
    to?: string | number;
    fuse?: ReadonlyArray<{ property: AnimationValueProperty; from: string; to: string }>;
  },
  ctx: z.RefinementCtx,
): void {
  const check = (property: AnimationValueProperty, value: string | number | undefined, path: (string | number)[]) => {
    if (value == null || isAnimationValueInput(property, value)) return;
    ctx.addIssue({ code: "custom", path, message: animationValueMessage(property) });
  };
  if (a.property != null) {
    check(a.property, a.from, ["from"]);
    check(a.property, a.to, ["to"]);
  }
  a.fuse?.forEach((t, i) => {
    check(t.property, t.from, ["fuse", i, "from"]);
    check(t.property, t.to, ["fuse", i, "to"]);
  });
}

/**
 * Emission guard for a free-form CSS value (color, `transform-origin`, …) from a
 * direct API caller: returns it unchanged when safe, and throws rather than
 * writing an unvalidated string into a `<style>` block or attribute.
 */
export function cssValueForStyle(value: string, field: string, opts: SafeCssValueOptions = {}): string {
  if (isSafeCssValue(value, opts)) return value;
  throw new Error(
    `Invalid ${field} ${JSON.stringify(value)}: ${opts.allowQuotes === true ? SAFE_QUOTED_MESSAGE : SAFE_MESSAGE}.`,
  );
}

/** Emission guard for an animation `from` / `to` value: the per-property grammar, or throw. */
export function cssAnimationValueForStyle<V extends string | number>(
  property: AnimationValueProperty,
  value: V,
  field: string,
): V {
  if (isAnimationValueInput(property, value)) return value;
  throw new Error(`Invalid ${field} ${JSON.stringify(value)}: ${animationValueMessage(property)}.`);
}

const IDENT_RE = /^[A-Za-z0-9_-]+$/;

/** Emission guard for an identifier used in a class selector or `@keyframes` name. */
export function cssIdentForStyle(value: string, field: string): string {
  if (IDENT_RE.test(value)) return value;
  throw new Error(`Invalid ${field} ${JSON.stringify(value)}: must contain only letters, digits, "_" and "-".`);
}
