import { z } from "zod";
import {
  STUDIO_PROJECT_SCHEMA_ID,
  studioProjectSchema,
} from "./project-schema.js";

/** Project the runtime source of truth to the shipped draft-2020-12 schema. */
export function buildStudioProjectJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(studioProjectSchema, {
    target: "draft-2020-12",
    io: "input",
    reused: "ref",
  }) as Record<string, unknown>;
  return {
    ...schema,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: STUDIO_PROJECT_SCHEMA_ID,
    title: "Domotion Studio project",
    description:
      "Version 1 of Domotion Studio's durable authoring model. It preserves narrative, " +
      "stable scene/track/layer identities, review history, and artifact provenance; " +
      "SVG and review video remain generated outputs.",
  };
}

export function studioProjectJsonSchemaText(): string {
  return `${JSON.stringify(buildStudioProjectJsonSchema(), null, 2)}\n`;
}
