import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCEPTED_DIFFS, FIXTURE_HEIGHT_OVERRIDES, SKIP_TESTS, captureHeightFor } from "./html-test/tables.js";
import { walkHtmlFiles } from "./walk-html-files.js";

const htmlRoot = resolve("external/html-test");
const unicodeRoot = resolve("../html-test/unicode");

function staleFixtureNames(table: Record<string, unknown>, htmlDir: string, unicodeDir: string): string[] {
  // Other tests may create these directories with a few scratch fixtures. A
  // checkout has a .git marker (directory or worktree file); only then can a
  // missing table name mean that the installed corpus changed.
  const htmlInstalled = existsSync(resolve(htmlDir, ".git"));
  const unicodeInstalled = existsSync(unicodeDir) && existsSync(resolve(unicodeDir, "..", ".git"));
  const namesFor = (root: string) =>
    new Set(walkHtmlFiles(root).map((file) => file.replace(/\.html$/, "").replace(/\//g, "-")));
  const htmlNames = htmlInstalled ? namesFor(htmlDir) : new Set<string>();
  const unicodeNames = unicodeInstalled ? namesFor(unicodeDir) : new Set<string>();
  return Object.keys(table).filter((name) => {
    const unicode = /^[0-9A-F]{4,6}-[0-9A-F]{4,6}-/.test(name);
    return unicode ? unicodeInstalled && !unicodeNames.has(name) : htmlInstalled && !htmlNames.has(name);
  });
}

describe("html-test fixture tables", () => {
  it("uses the documented default and height overrides", () => {
    expect(captureHeightFor("absent-fixture")).toBe(768);
    for (const [name, height] of Object.entries(FIXTURE_HEIGHT_OVERRIDES)) {
      expect(captureHeightFor(name)).toBe(height);
      expect(height).toBeGreaterThanOrEqual(768);
    }
  });

  it("contains no stale fixture names in installed checkouts", () => {
    for (const table of [FIXTURE_HEIGHT_OVERRIDES, SKIP_TESTS, ACCEPTED_DIFFS]) {
      expect(staleFixtureNames(table, htmlRoot, unicodeRoot)).toEqual([]);
    }
  });

  it("ignores scratch fixture directories but checks an installed checkout through refill", () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-fixture-table-"));
    const htmlDir = join(root, "html");
    const unicodeDir = join(root, "unicode-checkout", "unicode");
    mkdirSync(htmlDir);
    mkdirSync(unicodeDir, { recursive: true });
    writeFileSync(join(htmlDir, "present.html"), "");
    const table = { present: true, missing: true, "1F00-1FFF-missing": true };

    expect(staleFixtureNames(table, htmlDir, unicodeDir)).toEqual([]);
    mkdirSync(join(htmlDir, ".git"));
    writeFileSync(join(unicodeDir, "..", ".git"), "gitdir: worktree-metadata");
    expect(staleFixtureNames(table, htmlDir, unicodeDir)).toEqual(["missing", "1F00-1FFF-missing"]);
    writeFileSync(join(htmlDir, "missing.html"), "");
    writeFileSync(join(unicodeDir, "1F00-1FFF-missing.html"), "");
    expect(staleFixtureNames(table, htmlDir, unicodeDir)).toEqual([]);
  });
});
