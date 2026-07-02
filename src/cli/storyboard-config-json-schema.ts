/**
 * Generate the published JSON Schema for the `domotion storyboard` config from the
 * zod schema that already validates it at runtime (`storyboardConfigSchema` in
 * `./storyboard.ts`). The zod schema is the single source of truth; this module
 * projects it to a standard JSON Schema (draft 2020-12) so consumers can get
 * editor autocompletion / validation without running Domotion.
 *
 * The generated file is committed at `schemas/storyboard-config.schema.json` and
 * shipped in the npm package; `scripts/generate-storyboard-schema.ts` writes it and
 * `storyboard-config-json-schema.test.ts` asserts the committed copy is in sync.
 * See `docs/89-storyboard-sequencing.md`. Mirrors `composite-config-json-schema.ts`.
 */

import { z } from "zod";
import { storyboardConfigSchema } from "./storyboard.js";

/**
 * Stable, fetchable URL for the schema (the npm package also ships a local copy
 * at `schemas/storyboard-config.schema.json`). Authors can point a config's
 * `"$schema"` key here for editor support.
 */
export const STORYBOARD_CONFIG_SCHEMA_ID =
  "https://raw.githubusercontent.com/brianwestphal/domotion/main/schemas/storyboard-config.schema.json";

/**
 * Build the JSON Schema object for the storyboard config. `io: "input"` so fields
 * with a zod `.default()` are reported optional, matching what
 * `validateStoryboardConfig` accepts.
 *
 * Note: the scene schema's zod `.superRefine()` rules (exactly-one-source, and the
 * `params`/`term`/`period` companion-field requirements) have no JSON Schema
 * equivalent and are intentionally not represented — they stay enforced at
 * runtime. The JSON Schema covers structure and types; the zod schema remains the
 * authoritative validator.
 */
export function buildStoryboardConfigJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(storyboardConfigSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;

  // Allow a config to carry a `"$schema"` pointer (so editors can resolve this
  // file) without tripping the top-level `additionalProperties: false`. zod strips
  // the unknown key at runtime, so it's inert for the actual compose.
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const decorated: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: STORYBOARD_CONFIG_SCHEMA_ID,
    title: "Domotion storyboard config",
    description:
      "Config for the `domotion storyboard` CLI: an ordered list of scenes (each a " +
      "template / capture / cast / svg source), each with a duration and an " +
      "inter-scene transition, sequenced into one animated SVG. See " +
      "docs/89-storyboard-sequencing.md. Authoritative validation is the zod schema " +
      "in src/cli/storyboard.ts; the exactly-one-source-per-scene rule is enforced " +
      "at runtime and not expressed here.",
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
export function storyboardConfigJsonSchemaText(): string {
  return JSON.stringify(buildStoryboardConfigJsonSchema(), null, 2) + "\n";
}
