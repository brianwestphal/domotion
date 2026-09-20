#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function normalized(path) {
  return path.split(sep).join("/");
}

function walk(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(normalized(relative(root, path)));
    }
  };
  visit(root);
  return files.sort();
}

export function packageDistProblems(sourceFiles, distFiles) {
  const sources = sourceFiles
    .filter((path) => /\.tsx?$/.test(path))
    .filter((path) => !/\.d\.ts$/.test(path))
    .filter((path) => !/\.(?:test|e2e\.test)\.tsx?$/.test(path))
    .filter((path) => !path.startsWith("test-support/"));
  const expected = new Set(sources.flatMap((path) => {
    const stem = path.replace(/\.tsx?$/, "");
    return [`${stem}.js`, `${stem}.d.ts`];
  }));
  const actual = new Set(distFiles);
  const problems = [];
  for (const path of [...actual].sort()) {
    if (!expected.has(path)) problems.push(`unexpected dist artifact: ${path}`);
  }
  for (const path of [...expected].sort()) {
    if (!actual.has(path)) problems.push(`missing dist artifact: ${path}`);
  }
  return problems;
}

export function checkPackageDist(root) {
  return packageDistProblems(walk(resolve(root, "src")), walk(resolve(root, "dist")));
}

const invokedPath = process.argv[1];
if (invokedPath != null && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkPackageDist(root);
  if (problems.length > 0) {
    process.stderr.write(`[check-package-dist] ${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("[check-package-dist] dist/ exactly matches publishable src/ modules\n");
  }
}
