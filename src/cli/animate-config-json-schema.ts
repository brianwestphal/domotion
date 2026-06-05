/**
 * Generate the published JSON Schema for the `domotion animate` config from the
 * zod schema that already validates it at runtime (`animateConfigSchema` in
 * `./animate.ts`). The zod schema is the single source of truth; this module
 * projects it to a standard JSON Schema (draft 2020-12) so consumers can get
 * editor autocompletion / validation without running Domotion.
 *
 * The generated file is committed at `schemas/animate-config.schema.json` and
 * shipped in the npm package; `scripts/generate-animate-schema.ts` writes it and
 * `animate-config-json-schema.test.ts` asserts the committed copy is in sync.
 * See `docs/43-declarative-animate-config.md`.
 */

import { z } from "zod";
import { animateConfigSchema } from "./animate.js";

/**
 * Stable, fetchable URL for the schema (the npm package also ships a local copy
 * at `schemas/animate-config.schema.json`). Authors can point a config's
 * `"$schema"` key here for editor support.
 */
export const ANIMATE_CONFIG_SCHEMA_ID =
  "https://raw.githubusercontent.com/brianwestphal/domotion/main/schemas/animate-config.schema.json";

/**
 * Build the JSON Schema object for the animate config. `io: "input"` so fields
 * with a zod `.default()` are reported optional (a config author may omit them),
 * matching what `validateAnimateConfig` accepts.
 *
 * Note: zod `.refine()` / `.superRefine()` rules (e.g. "frame 0 must load an
 * input", "scroll `pattern` must parse", regex validity of `replaceText`) have
 * no JSON Schema equivalent and are intentionally not represented here — they
 * stay enforced at runtime by `validateAnimateConfig`. The JSON Schema covers
 * structure and types; the zod schema remains the authoritative validator.
 */
export function buildAnimateConfigJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(animateConfigSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;

  // Allow a config to carry a `"$schema"` pointer (so editors can resolve this
  // file) without tripping the top-level `additionalProperties: false`. zod
  // strips the unknown key at runtime, so it's inert for the actual capture.
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const decorated: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: ANIMATE_CONFIG_SCHEMA_ID,
    title: "Domotion animate config",
    description:
      "Config for the `domotion animate` CLI: a list of frames captured from a " +
      "URL / HTML file, with per-frame actions, overlays, intra-frame animations, " +
      "and transitions, composed into one animated SVG. See " +
      "docs/43-declarative-animate-config.md. Authoritative validation is the zod " +
      "schema in src/cli/animate.ts; cross-field rules (frame-0 input, scroll-" +
      "pattern / regex validity) are enforced at runtime and not expressed here.",
    ...schema,
    properties: {
      $schema: {
        type: "string",
        description:
          "Optional pointer to this JSON Schema for editor support; ignored by the CLI.",
      },
      ...props,
    },
  };
  return decorated;
}

/** Pretty-printed JSON text (trailing newline) for writing / comparing the committed file. */
export function animateConfigJsonSchemaText(): string {
  return JSON.stringify(buildAnimateConfigJsonSchema(), null, 2) + "\n";
}
