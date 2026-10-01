import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  gitSourceBuildSteps,
  hasPackageEntryPoints,
  isNpmGitCheckout,
  prepareBuildEnvironment,
} from "./prepare-git-install.mjs";

const root = "/package";
const manifest = { main: "dist/index.js", bin: { domotion: "dist/cli/index.js", review: "dist/cli/review.js" } };
const all = new Set([manifest.main, ...Object.values(manifest.bin)].map((path) => join(root, path)));

test("a complete built package can skip prepare's build", () => {
  assert.equal(
    hasPackageEntryPoints(root, manifest, (path) => all.has(path)),
    true,
  );
});

test("a missing root or bin entry point requires a build", () => {
  for (const missing of all) {
    assert.equal(
      hasPackageEntryPoints(root, manifest, (path) => path !== missing),
      false,
    );
  }
});

test("a clean Git checkout requires a build", () => {
  assert.equal(
    hasPackageEntryPoints(root, manifest, () => false),
    false,
  );
});

test("npm Git staging is distinct from a normal local install", () => {
  assert.equal(isNpmGitCheckout("/tmp/npm-cache/_cacache/tmp/git-clone123"), true);
  assert.equal(isNpmGitCheckout("C:\\cache\\_cacache\\tmp\\git-cloneABC"), true);
  assert.equal(isNpmGitCheckout("/work/domotion"), false);
});

test("nested prepare restores Node and both compiler shim paths with one Windows PATH key", () => {
  const env = prepareBuildEnvironment(
    "C:\\git-clone123",
    "C:\\node",
    { Path: "C:\\Windows\\System32", PATH: "C:\\stale", npm_execpath: "C:\\node\\npm-cli.js" },
    ";",
  );
  assert.equal(env.Path, undefined);
  assert.equal(env.npm_execpath, "C:\\node\\npm-cli.js");
  assert.equal(
    env.PATH,
    [
      "C:\\node",
      join("C:\\git-clone123", "node_modules", ".bin"),
      join("C:\\git-clone123", "packages", "text-engine", "node_modules", ".bin"),
      "C:\\Windows\\System32",
      "C:\\stale",
    ].join(";"),
  );
});

test("Git source build runs ordered stages through Node without nested npm scripts", () => {
  const packageRoot = resolve(root);
  const compiler = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  const steps = gitSourceBuildSteps(packageRoot, compiler);
  assert.deepEqual(
    steps.map((step) => step.args[0]),
    [
      join(packageRoot, "scripts", "clean-dist.mjs"),
      compiler,
      compiler,
      join(packageRoot, "packages", "text-engine", "tools", "check-runtime-import.mjs"),
      join(packageRoot, "scripts", "build-capture-script.mjs"),
      join(packageRoot, "scripts", "build-compare-pngs-browser.mjs"),
      join(packageRoot, "scripts", "build-review-client.mjs"),
      join(packageRoot, "scripts", "build-scrubber-client.mjs"),
      join(packageRoot, "scripts", "build-studio-client.mjs"),
      "--import",
      "--import",
      "--import",
      "--import",
      compiler,
      join(packageRoot, "scripts", "check-package-dist.mjs"),
    ],
  );
  assert.equal(steps[1].cwd, join(packageRoot, "packages", "text-engine"));
  assert.equal(steps[2].cwd, join(packageRoot, "packages", "text-engine"));
  assert.equal(steps[13].cwd, packageRoot);
  assert.deepEqual(
    steps.slice(9, 13).map((step) => step.args.slice(1)),
    ["animate", "composite", "storyboard", "studio-project"].map((name) => [
      "tsx",
      join(packageRoot, "scripts", `generate-${name}-schema.ts`),
    ]),
  );
});
