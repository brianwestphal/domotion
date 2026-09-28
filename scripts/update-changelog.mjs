import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Insert a release entry after Unreleased and before the first prior release.
 *
 * Idempotent per version: if the changelog already holds one or more sections
 * headed `## [<version>]` for the entry's version (a resumed or re-run
 * release), they are replaced in place by the new entry instead of gaining a
 * second copy.
 */
export function insertChangelogEntry(changelog, entry) {
  const cleanEntry = entry
    .trim()
    .replaceAll("\r\n", "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (cleanEntry.length === 0) throw new Error("release entry must not be empty");

  const version = /^## \[([^\]]+)\]/.exec(cleanEntry)?.[1];
  if (version != null) {
    const replaced = replaceVersionSections(changelog, version, cleanEntry);
    if (replaced != null) return replaced;
  }

  const previousRelease = changelog.indexOf("\n## [");
  if (previousRelease === -1) {
    return `${changelog.trimEnd()}\n\n${cleanEntry}\n`;
  }

  const prefix = changelog.slice(0, previousRelease).trimEnd();
  const history = changelog.slice(previousRelease).trim();
  return `${prefix}\n\n${cleanEntry}\n\n${history}\n`;
}

/** Replace every `## [version]` section with one copy of `entry`, or return null if none exists. */
function replaceVersionSections(changelog, version, entry) {
  const lines = changelog.replaceAll("\r\n", "\n").split("\n");
  const heading = `## [${version}]`;
  const kept = [];
  let inserted = false;
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      skipping = line.startsWith(heading);
      if (skipping && !inserted) {
        kept.push(entry, "");
        inserted = true;
      }
    }
    if (!skipping) kept.push(line);
  }
  if (!inserted) return null;
  return `${kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

const invokedPath = process.argv[1] == null ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const [, , changelogPath, entry] = process.argv;
  if (changelogPath == null || entry == null) {
    throw new Error("usage: node scripts/update-changelog.mjs <changelog-path> <release-entry>");
  }

  const changelog = readFileSync(changelogPath, "utf8");
  writeFileSync(changelogPath, insertChangelogEntry(changelog, entry));
}
