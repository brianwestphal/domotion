#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const os = arg("--os");
const outputDir = resolve(arg("--output", "tests/output"));
const update = process.argv.includes("--update-baseline");
if (os == null) {
  console.error("ci-fast-baselines: --os <macos|linux|windows> required");
  process.exit(2);
}

const suites = [
  ["features", resolve(outputDir, "features-results.json")],
  ["showcase", resolve(outputDir, "showcase-results.json")],
  ["real-world", resolve(outputDir, "real-world", "results.json")],
];
const envPath = resolve(outputDir, "run-env.json");
const imagePath = resolve(outputDir, "runner-image.txt");
const image = existsSync(imagePath) ? readFileSync(imagePath, "utf8").trim() : null;

for (const [suite, results] of suites) {
  if (!existsSync(results)) {
    console.warn(`ci-fast-baselines: ${suite} produced no results file`);
    continue;
  }
  const baseline = resolve(`tests/baselines/${suite}-${os}.json`);
  if (existsSync(baseline)) {
    execFileSync("node", [
      "scripts/diff-against-baseline.mjs",
      "--results", results,
      "--baseline", baseline,
      "--env", envPath,
      "--label", `${os} / ${suite}`,
    ], { stdio: "inherit" });
  } else {
    console.warn(`ci-fast-baselines: no committed ${suite}/${os} baseline yet`);
  }

  if (update) {
    const out = resolve(outputDir, `baseline-${suite}-${os}.json`);
    const writeArgs = [
      "scripts/write-baseline.mjs",
      "--results", results,
      "--out", out,
      "--suite", suite,
      "--os", os,
      "--env", envPath,
      "--captured-at", new Date().toISOString(),
    ];
    if (image) writeArgs.push("--image", image);
    execFileSync("node", writeArgs, { stdio: "inherit" });
  }
}
