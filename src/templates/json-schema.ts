/**
 * Project a template's `paramsSchema` (zod) to a JSON Schema (draft 2020-12),
 * the same way `src/cli/animate-config-json-schema.ts` projects the animate
 * config. The CLI reads this for `domotion template <name> --help` (per-param
 * descriptions / defaults) and to decide which params take a boolean flag vs a
 * string value. The zod schema stays the authoritative validator.
 */

import { z } from "zod";
import type { Template } from "./types.js";

/** The JSON Schema object for a template's params. */
export function templateParamsJsonSchema(template: Template): Record<string, unknown> {
  return z.toJSONSchema(template.paramsSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
}

/** One param's projected entry (a JSON-Schema property). */
export interface ParamInfo {
  name: string;
  /** Whether the schema marks the param required (no default, not optional). */
  required: boolean;
  /** Coarse kind used by the CLI flag layer: booleans get a presence flag. */
  kind: "boolean" | "string" | "number";
  description?: string;
  /** The param's `enum` values, if it's an enum. */
  enumValues?: string[];
  /** The default, if the schema declares one. */
  default?: unknown;
}

/** True when a JSON-Schema property node (incl. `anyOf` unions from optionals)
 *  admits the given primitive type. */
function admitsType(node: Record<string, unknown>, type: string): boolean {
  const t = node.type;
  if (t === type) return true;
  if (Array.isArray(t) && t.includes(type)) return true;
  const anyOf = node.anyOf;
  if (Array.isArray(anyOf)) {
    return anyOf.some((m) => admitsType(m as Record<string, unknown>, type));
  }
  return false;
}

function enumOf(node: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(node.enum)) return node.enum.map(String);
  const anyOf = node.anyOf;
  if (Array.isArray(anyOf)) {
    for (const m of anyOf) {
      const e = enumOf(m as Record<string, unknown>);
      if (e != null) return e;
    }
  }
  return undefined;
}

/**
 * Flatten a template's top-level params into a list the CLI can turn into flags.
 * Only scalar params (string / number / boolean / enum) become individual flags;
 * arrays / objects are reachable only via `--params` / `--params-file`.
 */
export function describeTemplateParams(template: Template): ParamInfo[] {
  const schema = templateParamsJsonSchema(template);
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const out: ParamInfo[] = [];
  for (const [name, node] of Object.entries(props)) {
    const isBool = admitsType(node, "boolean");
    const isNum = admitsType(node, "number") || admitsType(node, "integer");
    const isStr = admitsType(node, "string");
    const enumValues = enumOf(node);
    if (!isBool && !isNum && !isStr && enumValues == null) continue; // array/object → JSON-only
    out.push({
      name,
      required: required.has(name),
      kind: isBool ? "boolean" : isNum ? "number" : "string",
      description: typeof node.description === "string" ? node.description : undefined,
      enumValues,
      default: "default" in node ? node.default : undefined,
    });
  }
  return out;
}
