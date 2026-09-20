#!/usr/bin/env node

import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
if (dirname(dist) !== root || basename(dist) !== "dist") {
  throw new Error(`Refusing to clean unexpected build path: ${dist}`);
}
rmSync(dist, { recursive: true, force: true });
process.stdout.write("[clean-dist] removed dist/\n");
