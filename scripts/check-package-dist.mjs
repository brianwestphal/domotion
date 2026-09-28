#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  const expected = new Set(
    sources.flatMap((path) => {
      const stem = path.replace(/\.tsx?$/, "");
      return [`${stem}.js`, `${stem}.d.ts`];
    }),
  );
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

/**
 * Every `exports` target must point at a shipped file. The map is the only
 * import surface consumers get (deep `dist/` paths are refused by Node once an
 * `exports` field exists), so a typo here breaks the package at import time
 * rather than at build time. Wildcard targets are checked at their directory.
 */
export function packageExportsProblems(exportsField, fileExists) {
  const problems = [];
  if (exportsField == null || typeof exportsField !== "object") {
    return ["package.json has no exports map"];
  }
  for (const required of [".", "./dist/index.js", "./package.json"]) {
    if (!(required in exportsField)) problems.push(`exports map is missing the "${required}" entry`);
  }
  const targets = (value) =>
    typeof value === "string" ? [value] : value != null && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
  for (const [subpath, value] of Object.entries(exportsField)) {
    for (const target of targets(value)) {
      if (!target.startsWith("./")) {
        problems.push(`exports["${subpath}"] target ${target} must be a relative "./" path`);
        continue;
      }
      const probe = target.includes("*") ? target.slice(0, target.indexOf("*")).replace(/\/[^/]*$/, "") : target;
      if (!fileExists(probe)) problems.push(`exports["${subpath}"] target ${target} does not exist`);
    }
  }
  return problems;
}

export function checkPackageDist(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return [
    ...packageDistProblems(walk(resolve(root, "src")), walk(resolve(root, "dist"))),
    ...packageExportsProblems(pkg.exports, (target) => existsSync(resolve(root, target))),
  ];
}

const invokedPath = process.argv[1];
if (invokedPath != null && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkPackageDist(root);
  if (problems.length > 0) {
    process.stderr.write(
      `[check-package-dist] ${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write("[check-package-dist] dist/ exactly matches publishable src/ modules and every exports target exists\n");
  }
}
