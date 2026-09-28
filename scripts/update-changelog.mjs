import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Insert a release entry after Unreleased and before the first prior release.
 *
 * A release consumes the `## Unreleased` section: release.sh pre-fills the
 * release-notes editor with its body (see `unreleasedBody`), so inserting a
 * new version resets Unreleased to an empty heading rather than leaving
 * already-released entries stranded above the version that shipped them.
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

  const normalized = changelog.replaceAll("\r\n", "\n");
  const previousRelease = normalized.indexOf("\n## [");
  const head = previousRelease === -1 ? normalized : normalized.slice(0, previousRelease);
  const history = previousRelease === -1 ? "" : normalized.slice(previousRelease).trim();

  const unreleased = findUnreleased(head);
  const prefix = (unreleased == null ? head : `${head.slice(0, unreleased.start)}${UNRELEASED_HEADING}`).trimEnd();
  return history.length === 0 ? `${prefix}\n\n${cleanEntry}\n` : `${prefix}\n\n${cleanEntry}\n\n${history}\n`;
}

const UNRELEASED_HEADING = "## Unreleased";

/** Locate the `## Unreleased` section (heading through the next `## ` heading or end). */
function findUnreleased(changelog) {
  const match = /^## Unreleased[ \t]*$/m.exec(changelog);
  if (match == null) return null;
  const bodyStart = match.index + match[0].length;
  const next = changelog.slice(bodyStart).search(/^## /m);
  const end = next === -1 ? changelog.length : bodyStart + next;
  return { start: match.index, bodyStart, end };
}

/** The trimmed body of the `## Unreleased` section, or "" when absent or empty. */
export function unreleasedBody(changelog) {
  const normalized = changelog.replaceAll("\r\n", "\n");
  const section = findUnreleased(normalized);
  return section == null ? "" : normalized.slice(section.bodyStart, section.end).trim();
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
  const [, , first, second] = process.argv;
  if (first === "--unreleased" && second != null) {
    const body = unreleasedBody(readFileSync(second, "utf8"));
    if (body.length > 0) process.stdout.write(`${body}\n`);
  } else {
    if (first == null || second == null) {
      throw new Error(
        "usage: node scripts/update-changelog.mjs <changelog-path> <release-entry>\n" +
          "       node scripts/update-changelog.mjs --unreleased <changelog-path>",
      );
    }
    const changelog = readFileSync(first, "utf8");
    writeFileSync(first, insertChangelogEntry(changelog, second));
  }
}
