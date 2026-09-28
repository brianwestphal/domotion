#!/usr/bin/env node

// Fail when the npm tarball would ship a gitignored file outside an intended
// build-output directory. `dist/` trees are gitignored but are the package; any
// other ignored file (a host-built glyph helper, an acquired ICU companion and
// its 10 MB data image, a scratch probe) is host-local state that a local
// publish, or a CI job that acquires helpers before packing, would otherwise
// ship to every consumer.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BUNDLED_WORKSPACES = { "@domotion/text-engine": "packages/text-engine" };

/** Directories whose gitignored contents are the intended build output. */
export const ALLOWED_IGNORED_PREFIXES = ["dist/", "packages/text-engine/dist/"];

/**
 * Map a tarball path to its repository path. Bundled workspace files appear
 * under `node_modules/<name>/`; other bundled node_modules are third-party and
 * return null (they are not governed by this repository's .gitignore).
 */
export function repoPathForPackedPath(packedPath) {
  if (!packedPath.startsWith("node_modules/")) return packedPath;
  for (const [name, directory] of Object.entries(BUNDLED_WORKSPACES)) {
    const prefix = `node_modules/${name}/`;
    if (packedPath.startsWith(prefix)) return `${directory}/${packedPath.slice(prefix.length)}`;
  }
  return null;
}

export function packIgnoredArtifactProblems(packedPaths, isIgnored) {
  const problems = [];
  for (const packedPath of packedPaths) {
    const repoPath = repoPathForPackedPath(packedPath);
    if (repoPath == null) continue;
    if (ALLOWED_IGNORED_PREFIXES.some((prefix) => repoPath.startsWith(prefix))) continue;
    if (isIgnored(repoPath)) problems.push(`tarball ships gitignored host-local file: ${packedPath}`);
  }
  return problems;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error != null) throw result.error;
  return result;
}

export function checkPackContents(root) {
  const pack = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    shell: process.platform === "win32",
  });
  if (pack.status !== 0) throw new Error(`npm pack --dry-run failed:\n${pack.stderr}`);
  const packedPaths = JSON.parse(pack.stdout)[0].files.map((file) => file.path);
  const candidates = packedPaths.map(repoPathForPackedPath).filter((path) => path != null);
  // `git check-ignore` reports only untracked ignored paths, which is exactly
  // the host-local set; exit 1 means "none ignored".
  const ignore = run("git", ["check-ignore", "--stdin"], { cwd: root, input: `${candidates.join("\n")}\n` });
  if (ignore.status !== 0 && ignore.status !== 1) throw new Error(`git check-ignore failed:\n${ignore.stderr}`);
  const ignored = new Set(ignore.stdout.split("\n").filter((line) => line.length > 0));
  return packIgnoredArtifactProblems(packedPaths, (path) => ignored.has(path));
}

const invokedPath = process.argv[1];
if (invokedPath != null && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkPackContents(root);
  if (problems.length > 0) {
    process.stderr.write(
      `[check-pack-contents] ${problems.length} problem(s):\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write("[check-pack-contents] tarball ships no gitignored host-local files outside dist/\n");
  }
}
