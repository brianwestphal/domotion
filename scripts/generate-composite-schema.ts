#!/usr/bin/env tsx
/**
 * Generate `schemas/composite-config.schema.json` — the published JSON Schema for
 * the `domotion composite` config — from the zod schema in `src/cli/composite.ts`
 * (the single source of truth). Run via `npm run build:composite-schema`.
 *
 * Pass `--check` to verify the committed file is up to date without rewriting it
 * (exit 1 on drift). The `composite-config-json-schema.test.ts` unit test asserts
 * the same thing inside `npm test`, so a stale schema fails the quality gates.
 * Mirrors `generate-animate-schema.ts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compositeConfigJsonSchemaText } from "../src/cli/composite-config-json-schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "schemas/composite-config.schema.json");

const text = compositeConfigJsonSchemaText();
const check = process.argv.includes("--check");

if (check) {
  let current: string | null = null;
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = null;
  }
  if (current !== text) {
    console.error(
      `[generate-composite-schema] ${OUT} is out of date.\n` +
        `Run \`npm run build:composite-schema\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`[generate-composite-schema] ${OUT} is up to date.`);
} else {
  writeFileSync(OUT, text);
  console.log(`[generate-composite-schema] wrote ${OUT} (${text.length} bytes)`);
}
