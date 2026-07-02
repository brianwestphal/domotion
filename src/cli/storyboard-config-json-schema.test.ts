import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STORYBOARD_CONFIG_SCHEMA_ID,
  storyboardConfigJsonSchemaText,
  buildStoryboardConfigJsonSchema,
} from "./storyboard-config-json-schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA_PATH = resolve(ROOT, "schemas/storyboard-config.schema.json");

describe("storyboard-config JSON Schema", () => {
  it("the committed schema file is in sync with the zod source of truth", () => {
    // If this fails, the zod schema in `storyboard.ts` changed without
    // regenerating the published file. Run `npm run build:storyboard-schema`.
    const committed = readFileSync(SCHEMA_PATH, "utf8");
    expect(committed).toBe(storyboardConfigJsonSchemaText());
  });

  it("carries the stable $id and draft-2020-12 dialect", () => {
    const schema = buildStoryboardConfigJsonSchema();
    expect(schema.$id).toBe(STORYBOARD_CONFIG_SCHEMA_ID);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
  });

  it("documents the core config surface", () => {
    const schema = buildStoryboardConfigJsonSchema();
    const props = schema.properties as Record<string, unknown>;
    for (const key of ["width", "height", "scenes", "background", "title", "desc"]) {
      expect(props, `missing top-level property: ${key}`).toHaveProperty(key);
    }
    // `$schema` pointer is allowed so editors can resolve the file.
    expect(props).toHaveProperty("$schema");
    // width / height / scenes are required.
    expect(schema.required).toEqual(expect.arrayContaining(["width", "height", "scenes"]));
  });

  it("exposes the scene source + placement + transition surface", () => {
    const schema = buildStoryboardConfigJsonSchema();
    const props = schema.properties as Record<string, { items?: { properties?: Record<string, unknown> } }>;
    const scene = props.scenes.items!.properties as Record<string, unknown>;
    for (const key of ["template", "capture", "cast", "svg", "params", "term", "fit", "duration", "transition"]) {
      expect(scene, `missing scene property: ${key}`).toHaveProperty(key);
    }
    // The inter-scene transition enum is the opaque-scene-safe subset.
    const transition = (scene.transition as { properties: { type: { enum: string[] } } }).properties.type;
    expect(transition.enum).toEqual(expect.arrayContaining(["crossfade", "cut", "push-left", "scroll"]));
    expect(transition.enum).not.toContain("magic-move");
  });
});
