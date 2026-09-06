#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { studioProjectJsonSchemaText } from "../src/studio/project-json-schema.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "schemas/domotion-studio-project.schema.json");
const text = studioProjectJsonSchemaText();

if (process.argv.includes("--check")) {
  let current: string | null = null;
  try {
    current = readFileSync(output, "utf8");
  } catch {
    current = null;
  }
  if (current !== text) {
    console.error(`[generate-studio-project-schema] ${output} is out of date.\nRun \`npm run build:studio-project-schema\` and commit the result.`);
    process.exit(1);
  }
  console.log(`[generate-studio-project-schema] ${output} is up to date.`);
} else {
  writeFileSync(output, text);
  console.log(`[generate-studio-project-schema] wrote ${output} (${text.length} bytes)`);
}
