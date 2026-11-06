import { z } from "zod";
import { isCssEasingFunction } from "./easing.js";
import { easingPresetNames, resolveEasingPreset } from "./motion-presets.js";

/**
 * Validation and emission guard for user-authored animation easing.
 *
 * Every config easing (transitions, overlay enter/exit and animations, composite
 * layers, templates) ends up interpolated into a `<style>` block of the
 * "self-contained" output SVG. Free text there is a style-block injection: a
 * value such as `ease}</style><script>…` closes the element. So an easing is
 * accepted only as a built-in preset name (resolved by `resolveEasingPreset`) or
 * a CSS `<easing-function>` (`isCssEasingFunction`, transcribed from Blink's
 * `ConsumeAnimationTimingFunction`), neither of which can carry `<`, `}` or `;`.
 */
export function isEasingInput(value: string): boolean {
  const resolved = resolveEasingPreset(value.trim());
  return resolved != null && isCssEasingFunction(resolved);
}

const EASING_INPUT_MESSAGE =
  "must be an easing preset name or a CSS easing function (a keyword, cubic-bezier(), steps() or linear())";

/** Zod schema for an author-supplied easing: a preset name or a CSS `<easing-function>`. */
export const easingInputSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isEasingInput, { message: EASING_INPUT_MESSAGE })
  .describe(`Easing preset (${easingPresetNames().join(", ")}) or a CSS <easing-function>.`);

/**
 * The CSS text to emit for an easing, for direct API callers that bypass the
 * config schemas: resolves a preset name, then requires the CSS easing grammar.
 * Throws rather than writing an unvalidated string into a `<style>` block.
 */
export function cssEasingForStyle(value: string | undefined, fallback: string): string {
  if (value == null) return fallback;
  const resolved = resolveEasingPreset(value.trim());
  if (resolved != null && isCssEasingFunction(resolved)) return resolved;
  throw new Error(`Invalid easing ${JSON.stringify(value)}: ${EASING_INPUT_MESSAGE}.`);
}
