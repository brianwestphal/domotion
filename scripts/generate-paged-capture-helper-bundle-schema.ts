#!/usr/bin/env tsx
/** Generate or verify schemas/paged-capture-helper-bundle.schema.json. */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pagedCaptureHelperBundleJsonSchemaText } from "../src/capture/paged-capture-helper-json-schema.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "schemas/paged-capture-helper-bundle.schema.json");
const text = pagedCaptureHelperBundleJsonSchemaText();

if (process.argv.includes("--check")) {
  let current: string | null = null;
  try {
    current = readFileSync(output, "utf8");
  } catch {
    current = null;
  }
  if (current !== text) {
    console.error(`[generate-paged-capture-helper-bundle-schema] ${output} is out of date.`);
    process.exit(1);
  }
  console.log(`[generate-paged-capture-helper-bundle-schema] ${output} is up to date.`);
} else {
  writeFileSync(output, text);
  console.log(`[generate-paged-capture-helper-bundle-schema] wrote ${output} (${text.length} bytes)`);
}
