import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPOSITE_CONFIG_SCHEMA_ID,
  compositeConfigJsonSchemaText,
  buildCompositeConfigJsonSchema,
} from "./composite-config-json-schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA_PATH = resolve(ROOT, "schemas/composite-config.schema.json");

describe("composite-config JSON Schema", () => {
  it("the committed schema file is in sync with the zod source of truth", () => {
    // If this fails, the zod schema in `composite.ts` changed without
    // regenerating the published file. Run `npm run build:composite-schema`.
    const committed = readFileSync(SCHEMA_PATH, "utf8");
    expect(committed).toBe(compositeConfigJsonSchemaText());
  });

  it("carries the stable $id and draft-2020-12 dialect", () => {
    const schema = buildCompositeConfigJsonSchema();
    expect(schema.$id).toBe(COMPOSITE_CONFIG_SCHEMA_ID);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
  });

  it("documents the core config surface", () => {
    const schema = buildCompositeConfigJsonSchema();
    const props = schema.properties as Record<string, unknown>;
    for (const key of ["width", "height", "layers", "background", "duration"]) {
      expect(props, `missing top-level property: ${key}`).toHaveProperty(key);
    }
    // `$schema` pointer is allowed so editors can resolve the file.
    expect(props).toHaveProperty("$schema");
    // width / height / layers are required.
    expect(schema.required).toEqual(expect.arrayContaining(["width", "height", "layers"]));
  });

  it("exposes the layer source + timeline + animation surface", () => {
    const schema = buildCompositeConfigJsonSchema();
    const props = schema.properties as Record<string, { items?: { properties?: Record<string, unknown> } }>;
    const layer = props.layers.items!.properties as Record<string, unknown>;
    for (const key of ["svg", "cast", "template", "chrome", "x", "y", "start", "mode", "animations"]) {
      expect(layer, `missing layer property: ${key}`).toHaveProperty(key);
    }
    // The layer-animation `property` enum carries the resize-by-clip ops.
    const anim = (layer.animations as { items: { properties: { property: { enum: string[] } } } }).items.properties.property;
    expect(anim.enum).toEqual(expect.arrayContaining(["scale", "translateX", "opacity", "clipScaleX", "clipScaleY"]));
  });
});
