import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { hasPackageEntryPoints, isNpmGitCheckout } from "./prepare-git-install.mjs";

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
