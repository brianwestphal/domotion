#!/usr/bin/env node

// npm's Git install path drops the bundled private workspace. The Git prepare
// step places a copy in assets/git-install/; registry tarballs have no copy.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "assets", "git-install", "text-engine");
if (existsSync(join(source, "dist", "index.js"))) {
  const target = join(root, "node_modules", "@domotion", "text-engine");
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
