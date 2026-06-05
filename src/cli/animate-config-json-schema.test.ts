import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANIMATE_CONFIG_SCHEMA_ID,
  animateConfigJsonSchemaText,
  buildAnimateConfigJsonSchema,
} from "./animate-config-json-schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA_PATH = resolve(ROOT, "schemas/animate-config.schema.json");

describe("animate-config JSON Schema", () => {
  it("the committed schema file is in sync with the zod source of truth", () => {
    // If this fails, the zod schema in `animate.ts` changed without
    // regenerating the published file. Run `npm run build:animate-schema`.
    const committed = readFileSync(SCHEMA_PATH, "utf8");
    expect(committed).toBe(animateConfigJsonSchemaText());
  });

  it("carries the stable $id and draft-2020-12 dialect", () => {
    const schema = buildAnimateConfigJsonSchema();
    expect(schema.$id).toBe(ANIMATE_CONFIG_SCHEMA_ID);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
  });

  it("documents the core config surface", () => {
    const schema = buildAnimateConfigJsonSchema();
    const props = schema.properties as Record<string, unknown>;
    // Spot-check the load-bearing top-level fields so an accidental schema
    // breakage (empty object, wrong io mode) is caught loudly.
    for (const key of ["width", "height", "frames", "vars", "cursor"]) {
      expect(props, `missing top-level property: ${key}`).toHaveProperty(key);
    }
    // `$schema` pointer is allowed so editors can resolve the file.
    expect(props).toHaveProperty("$schema");
    // `frames` is required (no `.default`/`.optional` on it), width/height too.
    expect(schema.required).toEqual(expect.arrayContaining(["width", "height", "frames"]));
  });
});
