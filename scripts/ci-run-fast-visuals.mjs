#!/usr/bin/env node

// Run the non-sharded visual/integration suites without letting an early
// failure erase evidence from the later suites. GitHub Actions uploads the
// output directory unconditionally, while this driver exits non-zero after
// writing a machine-readable completeness manifest.

import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const outputDir = resolve(process.env.DOMOTION_OUTPUT_DIR ?? "tests/output");
mkdirSync(outputDir, { recursive: true });

const suites = [
  ["features", "demos:test"],
  ["showcase", "demos:test:showcase"],
  ["snapshot-isolation", "demos:test:snapshot-isolation"],
  ["animate", "demos:test:animate"],
  ["real-world", "demos:test:real-world"],
];

const results = [];
for (const [suite, script] of suites) {
  const startedAt = new Date().toISOString();
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = spawnSync(command, ["run", script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const exitCode = run.status ?? 1;
  const error = run.error?.message;
  if (error != null) console.error(`FASTVISUAL ${suite} launch failed: ${error}`);
  results.push({ suite, script, startedAt, completedAt: new Date().toISOString(), exitCode, ...(error != null ? { error } : {}) });
}

const manifest = {
  version: 1,
  platform: process.platform,
  arch: process.arch,
  complete: results.every((result) => result.exitCode === 0),
  suites: results,
};
writeFileSync(
  resolve(outputDir, "fast-visual-completeness.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

for (const result of results) {
  console.log(`FASTVISUAL ${result.suite} exit=${result.exitCode}`);
}
if (!manifest.complete) process.exitCode = 1;
