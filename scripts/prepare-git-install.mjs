#!/usr/bin/env node

// Git dependencies are packed from a source checkout, where dist/ is absent.
// A local install after a build can reuse its artifacts; prepack still forces
// a clean build when producing a release tarball.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function hasPackageEntryPoints(packageRoot, manifest, fileExists = existsSync) {
  return [manifest.main, ...Object.values(manifest.bin)].every((path) => fileExists(join(packageRoot, path)));
}

export function isNpmGitCheckout(packageRoot) {
  return packageRoot.split(/[\\/]/).some((part) => /^git-clone[^/\\]*$/.test(part));
}

function materializeBundledWorkspace() {
  const source = join(root, "packages", "text-engine");
  const target = join(root, "assets", "git-install", "text-engine");
  if (!existsSync(join(source, "dist", "index.js"))) throw new Error("text-engine build is missing");
  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(target, { recursive: true });
  for (const name of ["package.json", "README.md", "dist", "assets", "tools", "vendor"]) {
    cpSync(join(source, name), join(target, name), { recursive: true });
  }
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!hasPackageEntryPoints(root, manifest)) {
    process.stdout.write("[prepare] building source checkout for Git installation\n");
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.error != null) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  if (isNpmGitCheckout(root)) materializeBundledWorkspace();
}
