#!/usr/bin/env tsx
/**
 * Generate `schemas/storyboard-config.schema.json` — the published JSON Schema for
 * the `domotion storyboard` config — from the zod schema in `src/cli/storyboard.ts`
 * (the single source of truth). Run via `npm run build:storyboard-schema`.
 *
 * Pass `--check` to verify the committed file is up to date without rewriting it
 * (exit 1 on drift). The `storyboard-config-json-schema.test.ts` unit test asserts
 * the same thing inside `npm test`, so a stale schema fails the quality gates.
 * Mirrors `generate-composite-schema.ts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { storyboardConfigJsonSchemaText } from "../src/cli/storyboard-config-json-schema.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "schemas/storyboard-config.schema.json");

const text = storyboardConfigJsonSchemaText();
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
      `[generate-storyboard-schema] ${OUT} is out of date.\n` +
        `Run \`npm run build:storyboard-schema\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`[generate-storyboard-schema] ${OUT} is up to date.`);
} else {
  writeFileSync(OUT, text);
  console.log(`[generate-storyboard-schema] wrote ${OUT} (${text.length} bytes)`);
}
