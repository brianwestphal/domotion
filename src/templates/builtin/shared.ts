/**
 * Pieces every built-in template used to define for itself: the theme list, the
 * blank-string normalizer, and the validator for params that are interpolated into
 * a generated `<style>` block.
 */
import { z } from "zod";

export { CARD_FONT_STACK } from "./text-card-common.js";

/** Base themes the text-card templates offer. */
export const THEMES = ["dark", "light"] as const;

/** `undefined` for an absent or empty string, so a blank flag doesn't override a theme default. */
export function blank(value: string | undefined): string | undefined {
  return value != null && value !== "" ? value : undefined;
}

/**
 * A value that can sit inside a generated stylesheet declaration without breaking out of it:
 * no braces (a new rule), no angle brackets (`</style>` closing the block), no line breaks or
 * control characters. Colors, gradients, `url(...)` and font stacks all pass; the point is not to
 * validate CSS but to keep an author- or agent-supplied param from becoming markup.
 */
export function isPlainCssValue(value: string): boolean {
  return !/[{}<>\u0000-\u001f\u007f]/.test(value);
}

/**
 * Schema for a string param that lands verbatim in a template's `<style>` (a color, background,
 * gradient, or font-family stack). Refined rather than transformed, so it never alters an
 * accepted value and still describes itself as a plain string in the generated JSON Schema.
 */
export function cssValue(): z.ZodString {
  return z.string().refine(isPlainCssValue, {
    message: "must be a plain CSS value (no braces, angle brackets or line breaks)",
  }) as unknown as z.ZodString;
}
