/**
 * Strict boolean template params.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, so every non-empty string — including
 * `"false"` and `"0"` — coerces to `true`. A default-`true` param declared that way
 * could never be switched off from a string source (`--params '{"pulse":"false"}'`,
 * a brand file, an env-built config). `templateBoolean()` accepts real booleans plus
 * the strings `"true"` / `"1"` and `"false"` / `"0"` (case-insensitive, trimmed) and
 * rejects anything else with a validation error instead of guessing.
 *
 * The default sits INSIDE the preprocess pipe on purpose: zod's JSON-Schema
 * projection only reports a default declared on the inner schema, and the CLI reads
 * that projection for `--help` and for the boolean-flag decision (`kind: "boolean"`).
 */

import { z } from "zod";

/** Map the accepted boolean spellings to a boolean; pass anything else through so
 *  `z.boolean()` reports it as an invalid value. */
export function parseTemplateBoolean(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  return value;
}

/** A strict boolean param with a default (see the module comment). */
export function templateBoolean(defaultValue: boolean) {
  return z.preprocess(parseTemplateBoolean, z.boolean().default(defaultValue));
}
