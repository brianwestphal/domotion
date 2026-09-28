import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { insertChangelogEntry, unreleasedBody } from "../scripts/update-changelog.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("insertChangelogEntry", () => {
  it("normalizes entry edges, inserts before the first prior release, and consumes Unreleased", () => {
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

  it("replaces an existing section for the same version instead of appending a second copy", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## [0.30.1] - 2026-09-21",
      "",
      "- Old notes.",
      "",
      "## [0.30.0] - 2026-09-20",
      "",
      "- Previous change.",
      "",
    ].join("\n");
    const entry = "## [0.30.1] - 2026-09-22\n\n- New notes.";

    const once = insertChangelogEntry(changelog, entry);
    expect(once).toBe(
      [
        "# Changelog",
        "",
        "## Unreleased",
        "",
        "## [0.30.1] - 2026-09-22",
        "",
        "- New notes.",
        "",
        "## [0.30.0] - 2026-09-20",
        "",
        "- Previous change.",
        "",
      ].join("\n"),
    );
    expect(insertChangelogEntry(once, entry)).toBe(once);
  });

  it("collapses already-duplicated sections for the entry's version", () => {
    const section = "## [0.30.1] - 2026-09-21\n\n- Notes.";
    const changelog = `# Changelog\n\n${section}\n\n${section}\n\n## [0.30.0] - 2026-09-20\n\n- Previous.\n`;

    expect(insertChangelogEntry(changelog, section)).toBe(
      `# Changelog\n\n${section}\n\n## [0.30.0] - 2026-09-20\n\n- Previous.\n`,
    );
  });

  it("does not treat a version that merely shares a prefix as the same release", () => {
    const changelog = "# Changelog\n\n## [0.30.10] - 2026-10-01\n\n- Later.\n";
    const entry = "## [0.30.1] - 2026-09-21\n\n- Notes.";

    expect(insertChangelogEntry(changelog, entry)).toBe(
      `# Changelog\n\n${entry}\n\n## [0.30.10] - 2026-10-01\n\n- Later.\n`,
    );
  });

  it("consumes Unreleased on a first release with no prior version", () => {
    const changelog = "# Changelog\n\n## Unreleased\n\n**Changed**\n\n- Pending.\n";
    const entry = "## [1.0.0] - 2026-09-21\n\n**Changed**\n\n- Pending.";

    expect(insertChangelogEntry(changelog, entry)).toBe(`# Changelog\n\n## Unreleased\n\n${entry}\n`);
  });

  it("leaves Unreleased untouched when a re-run replaces an existing version section", () => {
    const changelog =
      "# Changelog\n\n## Unreleased\n\n- Added after the release.\n\n## [1.0.0] - 2026-09-21\n\n- Old.\n";

    expect(insertChangelogEntry(changelog, "## [1.0.0] - 2026-09-21\n\n- New.")).toBe(
      "# Changelog\n\n## Unreleased\n\n- Added after the release.\n\n## [1.0.0] - 2026-09-21\n\n- New.\n",
    );
  });

  it("rejects an empty release entry", () => {
    expect(() => insertChangelogEntry("# Changelog\n", " \n ")).toThrow("release entry must not be empty");
  });
});

describe("unreleasedBody", () => {
  it("returns the trimmed Unreleased body up to the first release", () => {
    expect(
      unreleasedBody(
        "# Changelog\n\n## Unreleased\n\n**Changed**\n\n- A.\n\n**Removed**\n\n- B.\n\n## [1.0.0] - 2026-09-21\n\n- C.\n",
      ),
    ).toBe("**Changed**\n\n- A.\n\n**Removed**\n\n- B.");
  });

  it("returns an empty string for an empty or missing Unreleased section", () => {
    expect(unreleasedBody("# Changelog\n\n## Unreleased\n\n## [1.0.0] - 2026-09-21\n")).toBe("");
    expect(unreleasedBody("# Changelog\n\n## [1.0.0] - 2026-09-21\n")).toBe("");
  });
});

describe("update-changelog CLI", () => {
  it("prints the Unreleased body for release.sh's notes draft", () => {
    const directory = mkdtempSync(join(tmpdir(), "domotion-changelog-"));
    temporaryDirectories.push(directory);
    const changelogPath = join(directory, "CHANGELOG.md");
    writeFileSync(changelogPath, "# Changelog\n\n## Unreleased\n\n- Pending.\n\n## [0.9.0] - 2026-09-01\n");

    const result = spawnSync(
      process.execPath,
      [resolve("scripts/update-changelog.mjs"), "--unreleased", changelogPath],
      {
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("- Pending.\n");
  });

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
