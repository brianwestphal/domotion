import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

test("verified cleanup passes platform-supported and portable refusal contracts", () => {
  // Node cannot implement POSIX owner/group/other chmod distinctions on Windows:
  // https://nodejs.org/api/fs.html#file-modes. Its native job checks portable
  // grammar and the explicit pre-I/O refusal; POSIX hosts run every Git fixture.
  const selection =
    process.platform === "win32"
      ? [
          "--test-name-pattern",
          "GitHub CI authority|CLI never accepts|generated exception refuses|Windows cleanup refuses",
        ]
      : [];
  const result = spawnSync(process.execPath, ["--test", ...selection, "scripts/verified-worktree-cleanup.test.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, DOMOTION_CLEANUP_TEST_PROGRESS: "1" },
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('[cleanup-test] {"phase":"complete",');
  if (process.platform !== "win32") {
    expect(result.stdout).toContain('"operation":"init","phase":"start"');
    expect(result.stdout).toContain('"phase":"fixture"');
  }
}, 95_000);
