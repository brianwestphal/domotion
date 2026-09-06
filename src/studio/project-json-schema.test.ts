import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { STUDIO_PROJECT_SCHEMA_ID } from "./project-schema.js";
import {
  buildStudioProjectJsonSchema,
  studioProjectJsonSchemaText,
} from "./project-json-schema.js";

describe("Studio project JSON Schema", () => {
  it("publishes the v1 identity and recursive composition shape", () => {
    const schema = buildStudioProjectJsonSchema();
    expect(schema.$id).toBe(STUDIO_PROJECT_SCHEMA_ID);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(JSON.stringify(schema)).toContain("domotion-studio-project");
    expect(JSON.stringify(schema)).toContain("semantic-interactions");
    expect(JSON.stringify(schema)).toContain("composition");
  });

  it("keeps the committed schema byte-for-byte synchronized", () => {
    const committed = readFileSync(resolve("schemas/domotion-studio-project.schema.json"), "utf8");
    expect(committed).toBe(studioProjectJsonSchemaText());
  });
});
