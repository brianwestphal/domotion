import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Insert a release entry after Unreleased and before the first prior release. */
export function insertChangelogEntry(changelog, entry) {
  const cleanEntry = entry
    .trim()
    .replaceAll("\r\n", "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (cleanEntry.length === 0) throw new Error("release entry must not be empty");

  const previousRelease = changelog.indexOf("\n## [");
  if (previousRelease === -1) {
    return `${changelog.trimEnd()}\n\n${cleanEntry}\n`;
  }

  const prefix = changelog.slice(0, previousRelease).trimEnd();
  const history = changelog.slice(previousRelease).trim();
  return `${prefix}\n\n${cleanEntry}\n\n${history}\n`;
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
