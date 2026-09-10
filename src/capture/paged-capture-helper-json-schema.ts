/** Generate the published JSON Schema for paged-capture helper bundles. */

import { z } from "zod";

import { pagedCaptureHelperBundleManifestSchema } from "./paged-capture-helper.js";

export const PAGED_CAPTURE_HELPER_BUNDLE_SCHEMA_ID =
  "https://raw.githubusercontent.com/brianwestphal/domotion/main/schemas/paged-capture-helper-bundle.schema.json";

export function buildPagedCaptureHelperBundleJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(pagedCaptureHelperBundleManifestSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: PAGED_CAPTURE_HELPER_BUNDLE_SCHEMA_ID,
    title: "Domotion paged-capture helper bundle manifest",
    description:
      "Strict, externally pinned inventory for the separately distributed opt-in Chromium helper. " +
      "Runtime validation additionally enforces exact closure, license, capability, and executable invariants.",
    ...schema,
  };
}

export function pagedCaptureHelperBundleJsonSchemaText(): string {
  return `${JSON.stringify(buildPagedCaptureHelperBundleJsonSchema(), null, 2)}\n`;
}
