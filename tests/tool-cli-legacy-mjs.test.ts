import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const cwd = resolve(import.meta.dirname, "..");
const run = (file: string, args: string[] = []) =>
  spawnSync(process.execPath, [resolve(cwd, "tools", file), ...args], { cwd, encoding: "utf8" });

it("keeps report tools inert when imported", () => {
  for (const file of [
    "ab-compare-results.mjs",
    "coverage-all.mjs",
    "run-ci-visual-tests.mjs",
    "probe-983-genroutes-darwin.mjs",
    "generate-use-left-matra-ranges.mjs",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(new URL(`../tools/${file}`, import.meta.url).href)})`,
      ],
      { cwd, encoding: "utf8" },
    );
    expect(result.status, `${file}: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("");
  }
});

it("rejects unknown flags before running a report", () => {
  const result = run("ab-compare-results.mjs", ["--bogus"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("--bogus");
});

it("preserves the missing-input usage exit for the A/B report", () => {
  const result = run("ab-compare-results.mjs");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("usage: ab-compare-results.mjs");
});

it("runs a report with two positional inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "domotion-legacy-cli-"));
  const off = join(dir, "off.json");
  const on = join(dir, "on.json");
  writeFileSync(off, "[]");
  writeFileSync(on, "[]");
  const result = run("ab-compare-results.mjs", [off, on]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("OFF 0  →  ON 0");
});

it("rejects unknown generator flags before reading source inputs", () => {
  const invalid = run("generate-cjk-ideograph-or-symbol-ranges.mjs", ["--bogus"]);
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).toContain("--bogus");
});

it("runs an inventory's digest mode through the guarded entry point", () => {
  const result = run("font-inventory.mjs", ["--digest"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toMatch(/^[0-9a-f]{16}$/);
});
