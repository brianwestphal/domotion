#!/usr/bin/env node

// Git dependencies are packed from a source checkout, where dist/ is absent.
// A local install after a build can reuse its artifacts; prepack still forces
// a clean build when producing a release tarball.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTypeScriptCompiler } from "./run-typescript.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function hasPackageEntryPoints(packageRoot, manifest, fileExists = existsSync) {
  return [manifest.main, ...Object.values(manifest.bin)].every((path) => fileExists(join(packageRoot, path)));
}

export function isNpmGitCheckout(packageRoot) {
  return packageRoot.split(/[\\/]/).some((part) => /^git-clone[^/\\]*$/.test(part));
}

export function prepareBuildEnvironment(
  packageRoot,
  nodeDirectory,
  sourceEnv = process.env,
  pathDelimiter = delimiter,
) {
  // npm's temporary Windows Git install can run the root prepare after the
  // workspace prepare with a PATH that no longer finds node or .bin/tsc.cmd.
  // Restore the active Node toolchain and both possible compiler shim homes.
  const priorPath = Object.entries(sourceEnv)
    .filter(([key]) => key.toLowerCase() === "path")
    .map(([, value]) => value)
    .filter(Boolean)
    .join(pathDelimiter);
  const env = Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => key.toLowerCase() !== "path"));
  env.PATH = [
    nodeDirectory,
    join(packageRoot, "node_modules", ".bin"),
    join(packageRoot, "packages", "text-engine", "node_modules", ".bin"),
    priorPath,
  ]
    .filter(Boolean)
    .join(pathDelimiter);
  return env;
}

export function gitSourceBuildSteps(packageRoot, compiler) {
  const workspace = join(packageRoot, "packages", "text-engine");
  const script = (path, cwd = packageRoot) => ({ cwd, args: [join(packageRoot, path)] });
  const typescript = (cwd, ...args) => ({ cwd, args: [compiler, ...args] });
  const schema = (name) => ({
    cwd: packageRoot,
    args: ["--import", "tsx", join(packageRoot, "scripts", `generate-${name}-schema.ts`)],
  });
  return [
    script("scripts/clean-dist.mjs"),
    typescript(workspace, "-b", "tsconfig.build.json", "--clean"),
    typescript(workspace, "-p", "tsconfig.build.json"),
    script("packages/text-engine/tools/check-runtime-import.mjs", workspace),
    script("scripts/build-capture-script.mjs"),
    script("scripts/build-compare-pngs-browser.mjs"),
    script("scripts/build-review-client.mjs"),
    script("scripts/build-scrubber-client.mjs"),
    script("scripts/build-studio-client.mjs"),
    schema("animate"),
    schema("composite"),
    schema("storyboard"),
    schema("studio-project"),
    typescript(packageRoot, "-p", "tsconfig.build.json"),
    script("scripts/check-package-dist.mjs"),
  ];
}

function buildGitSourceCheckout() {
  const env = prepareBuildEnvironment(root, dirname(process.execPath));
  for (const step of gitSourceBuildSteps(root, resolveTypeScriptCompiler())) {
    const result = spawnSync(process.execPath, step.args, {
      cwd: step.cwd,
      env,
      stdio: "inherit",
    });
    if (result.error != null) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
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
    buildGitSourceCheckout();
  }
  if (isNpmGitCheckout(root)) materializeBundledWorkspace();
}
