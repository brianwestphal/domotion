/** Generate the published JSON Schema for the paged-capture bundle manifest. */

import { z } from "zod";

import { pagedCaptureBundleManifestSchema } from "./paged-capture-bundle.js";

export const PAGED_CAPTURE_BUNDLE_SCHEMA_ID =
  "https://raw.githubusercontent.com/brianwestphal/domotion/main/schemas/paged-capture-bundle.schema.json";

export function buildPagedCaptureBundleJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(pagedCaptureBundleManifestSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: PAGED_CAPTURE_BUNDLE_SCHEMA_ID,
    title: "Domotion paged-capture bundle manifest",
    description:
      "Versioned authenticated/unavailable manifest for an opt-in paged-media capture bundle. " +
      "Runtime validation additionally enforces consecutive pages, deterministic relative SVG paths, and content digests.",
    ...schema,
  };
}

export function pagedCaptureBundleJsonSchemaText(): string {
  return `${JSON.stringify(buildPagedCaptureBundleJsonSchema(), null, 2)}\n`;
}
