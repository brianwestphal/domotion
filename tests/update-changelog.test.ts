import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { insertChangelogEntry } from "../scripts/update-changelog.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("insertChangelogEntry", () => {
  it("normalizes entry edges and inserts before the first prior release", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "- Pending change.",
      "",
      "## [0.29.0] - 2026-09-17",
      "",
      "- Previous change.",
      "",
    ].join("\n");

    expect(insertChangelogEntry(changelog, "\n## [0.30.0] - 2026-09-21\n\n\n**Features**\n\n- New.\n")).toBe(
      [
        "# Changelog",
        "",
        "## Unreleased",
        "",
        "- Pending change.",
        "",
        "## [0.30.0] - 2026-09-21",
        "",
        "**Features**",
        "",
        "- New.",
        "",
        "## [0.29.0] - 2026-09-17",
        "",
        "- Previous change.",
        "",
      ].join("\n"),
    );
  });

  it("appends the first release without discarding the changelog introduction", () => {
    const changelog = "# Changelog\n\nAll notable changes are documented here.\n";
    const entry = "## [1.0.0] - 2026-09-21\n\n- Initial release.";

    expect(insertChangelogEntry(changelog, entry)).toBe(`${changelog.trimEnd()}\n\n${entry}\n`);
  });

  it("rejects an empty release entry", () => {
    expect(() => insertChangelogEntry("# Changelog\n", " \n ")).toThrow("release entry must not be empty");
  });
});

describe("update-changelog CLI", () => {
  it("updates the requested file through the release script boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "domotion-changelog-"));
    temporaryDirectories.push(directory);
    const changelogPath = join(directory, "CHANGELOG.md");
    writeFileSync(changelogPath, "# Changelog\n\n## Unreleased\n\n## [0.9.0] - 2026-09-01\n");

    const entry = "## [1.0.0] - 2026-09-21\n\n**Features**\n\n- Stable output.";
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/update-changelog.mjs"), changelogPath, `\n${entry}\n\n`],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(changelogPath, "utf8")).toBe(
      `# Changelog\n\n## Unreleased\n\n${entry}\n\n## [0.9.0] - 2026-09-01\n`,
    );
  });
});
