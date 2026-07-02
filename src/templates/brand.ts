/**
 * Brand kit — design tokens applied across templates (docs/85, DM-1522 design →
 * DM-1530 impl).
 *
 * A single reusable **brand file** (palette, font, radius, logo, background)
 * supplies every built-in template's *defaults*, so a lower-third, a chart, and
 * a subscribe card all come out on-brand without per-call theming. Explicit
 * params always win; the brand only fills what the caller left unset.
 *
 * Precedence (the core rule, docs/85):
 *
 *   explicit param  >  brand token  >  template's built-in default
 *
 * Enforced by merging brand defaults BENEATH the raw user params *before* zod
 * applies the schema defaults (`{ ...brandDefaults(brand), ...rawUserParams }`),
 * since after parsing a user value is indistinguishable from a default. Each
 * template exposes an optional `brandDefaults(brand)` mapping brand tokens to its
 * own param names; a template with no matching slot ignores the brand entirely.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

/** Palette tokens — all optional; a template uses each only where it has a slot. */
export const brandPaletteSchema = z
  .object({
    primary: z.string().optional().describe("Main brand color (buttons, accents, series 1)."),
    accent: z.string().optional().describe("Secondary accent (highlights, bars, series 2)."),
    background: z.string().optional().describe("Flat surface color behind content."),
    text: z.string().optional().describe("Primary text / foreground color."),
    muted: z.string().optional().describe("Secondary text color."),
  })
  .optional();

/** Font tokens. `weights` is available for templates that pick a title/body weight. */
export const brandFontSchema = z
  .object({
    family: z.string().optional().describe("CSS font-family stack."),
    weights: z.array(z.coerce.number()).optional().describe("Font weights a template may pick from."),
  })
  .optional();

/**
 * The brand-file schema. All fields optional; unknown keys are stripped (so a
 * brand file carrying a future token still loads). `logo` is a path/URL resolved
 * relative to the brand file by `loadBrand`. Top-level `background` is an optional
 * richer fill (e.g. a gradient) for full-bleed templates — it wins over
 * `palette.background` where a template fills the whole canvas.
 */
export const brandSchema = z.object({
  palette: brandPaletteSchema,
  font: brandFontSchema,
  radius: z.coerce.number().optional().describe("Corner radius (px) for panels/cards."),
  logo: z.string().optional().describe("Logo asset (path/URL) for templates with a logo slot."),
  background: z.string().optional().describe("Optional richer scene fill (overrides palette.background full-bleed)."),
});

export type Brand = z.infer<typeof brandSchema>;

/**
 * Parse + validate a brand JSON file. Resolves a relative `logo` against the
 * brand file's directory (like a config's relative paths); an absolute path or
 * `http(s)://` URL is left as-is. Throws a clear error on a missing file, invalid
 * JSON, or a schema violation.
 */
export function loadBrand(path: string): Brand {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    throw new Error(`brand: file not found: ${abs}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`brand: ${path} is not valid JSON — ${(e as Error).message}`);
  }
  const result = brandSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`brand: invalid brand file ${path} — ${issues}`);
  }
  const brand = result.data;
  if (brand.logo != null && brand.logo !== "" && !isAbsolute(brand.logo) && !/^https?:\/\//i.test(brand.logo)) {
    brand.logo = resolve(dirname(abs), brand.logo);
  }
  return brand;
}

/**
 * Build a partial-params object from `param → value` pairs, dropping any whose
 * value is null/undefined. A brand token the file didn't set must NOT appear in
 * the result — an explicit `undefined` would still count as a provided key and
 * could shadow a template's own default (and defeats the merge's intent). Used by
 * each template's `brandDefaults`.
 */
export function brandParams<P>(pairs: Record<string, unknown>): Partial<P> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pairs)) {
    if (v != null) out[k] = v;
  }
  return out as Partial<P>;
}

/**
 * The brand's data-color series for a template's multi-color list (chart series,
 * background blobs) — `[primary, accent]` filtered to those the brand actually
 * set. Returns `undefined` when the brand defines neither, so the template keeps
 * its own default palette.
 */
export function brandSeriesColors(brand: Brand): string[] | undefined {
  const colors = [brand.palette?.primary, brand.palette?.accent].filter((c): c is string => c != null && c !== "");
  return colors.length > 0 ? colors : undefined;
}

/**
 * The brand's canvas fill: the richer top-level `background` if present, else the
 * flat `palette.background`. `undefined` when neither is set.
 */
export function brandBackground(brand: Brand): string | undefined {
  return brand.background ?? brand.palette?.background;
}
