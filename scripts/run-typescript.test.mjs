import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveTypeScriptCompiler } from "./run-typescript.mjs";

const script = fileURLToPath(new URL("./run-typescript.mjs", import.meta.url));

test("TypeScript resolves from a workspace when the root has no compiler", () => {
  const temporary = mkdtempSync(join(tmpdir(), "domotion-typescript-test-"));
  try {
    const root = join(temporary, "root");
    const workspace = join(root, "packages", "text-engine");
    const compiler = join(workspace, "node_modules", "typescript", "bin", "tsc");
    mkdirSync(dirname(compiler), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(workspace, "package.json"), "{}");
    writeFileSync(
      join(workspace, "node_modules", "typescript", "package.json"),
      '{"name":"typescript","version":"0.0.0"}',
    );
    writeFileSync(compiler, "// fixture");
    assert.equal(resolveTypeScriptCompiler([root, workspace]), realpathSync(compiler));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("a missing compiler fails with an install instruction", () => {
  const temporary = mkdtempSync(join(tmpdir(), "domotion-typescript-test-"));
  try {
    assert.throws(() => resolveTypeScriptCompiler([temporary]), /install this source checkout's devDependencies/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

let compilerInstalled = true;
try {
  resolveTypeScriptCompiler();
} catch {
  compilerInstalled = false;
}

test("the real compiler runs without npm's .bin shims on PATH", { skip: !compilerInstalled }, () => {
  const result = spawnSync(process.execPath, [script, "--version"], {
    cwd: resolve(dirname(script), ".."),
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Version \d+/);
});
