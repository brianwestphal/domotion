/**
 * Generate the published JSON Schema for the `domotion composite` config from the
 * zod schema that already validates it at runtime (`compositeConfigSchema` in
 * `./composite.ts`). The zod schema is the single source of truth; this module
 * projects it to a standard JSON Schema (draft 2020-12) so consumers can get
 * editor autocompletion / validation without running Domotion.
 *
 * The generated file is committed at `schemas/composite-config.schema.json` and
 * shipped in the npm package; `scripts/generate-composite-schema.ts` writes it and
 * `composite-config-json-schema.test.ts` asserts the committed copy is in sync.
 * See `docs/77-nested-animated-compositing.md`. Mirrors
 * `animate-config-json-schema.ts`.
 */

import { z } from "zod";
import { compositeConfigSchema } from "./composite.js";

/**
 * Stable, fetchable URL for the schema (the npm package also ships a local copy
 * at `schemas/composite-config.schema.json`). Authors can point a config's
 * `"$schema"` key here for editor support.
 */
export const COMPOSITE_CONFIG_SCHEMA_ID =
  "https://raw.githubusercontent.com/brianwestphal/domotion/main/schemas/composite-config.schema.json";

/**
 * Build the JSON Schema object for the composite config. `io: "input"` so fields
 * with a zod `.default()` are reported optional, matching what
 * `validateCompositeConfig` accepts.
 *
 * Note: the layer schema's zod `.superRefine()` rule ("each layer must have
 * exactly one source: svg / cast / template") has no JSON Schema equivalent and
 * is intentionally not represented — it stays enforced at runtime. The JSON
 * Schema covers structure and types; the zod schema remains the authoritative
 * validator.
 */
export function buildCompositeConfigJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(compositeConfigSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;

  // Allow a config to carry a `"$schema"` pointer (so editors can resolve this
  // file) without tripping the top-level `additionalProperties: false`. zod
  // strips the unknown key at runtime, so it's inert for the actual compose.
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const decorated: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: COMPOSITE_CONFIG_SCHEMA_ID,
    title: "Domotion composite config",
    description:
      "Config for the `domotion composite` CLI: a list of layers (each an svg / " +
      "cast / template source, optionally wrapped in device chrome), placed and " +
      "on its own timeline, composited into one animated SVG with every layer's " +
      "animation preserved. See docs/77-nested-animated-compositing.md. " +
      "Authoritative validation is the zod schema in src/cli/composite.ts; the " +
      "exactly-one-source-per-layer rule is enforced at runtime and not expressed " +
      "here.",
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
export function compositeConfigJsonSchemaText(): string {
  return JSON.stringify(buildCompositeConfigJsonSchema(), null, 2) + "\n";
}
