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
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--test", ...selection, "scripts/verified-worktree-cleanup.test.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, DOMOTION_CLEANUP_TEST_PROGRESS: "1" },
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const rawErrorCode: unknown = result.error == null ? null : Reflect.get(result.error, "code");
  const outcome = {
    schema: "domotion-cleanup-wrapper-result-v1",
    startedAt,
    finishedAt: new Date().toISOString(),
    ownerPid: process.pid,
    supervisorPid: result.pid,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    status: result.status,
    signal: result.signal,
    error:
      typeof rawErrorCode === "string" && /^[A-Z0-9_]{1,64}$/.test(rawErrorCode)
        ? rawErrorCode
        : result.error == null
          ? null
          : "unknown",
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
  };
  const diagnostic = `${JSON.stringify(outcome)}\n${result.stdout}${result.stderr}`;
  expect(result.error, diagnostic).toBeUndefined();
  expect(result.status, diagnostic).toBe(0);
  expect(result.stdout).toContain('[cleanup-test] {"phase":"complete",');
  if (process.platform !== "win32") {
    expect(result.stdout).toContain('"operation":"init","phase":"start"');
    expect(result.stdout).toContain('"phase":"fixture"');
  }
}, 95_000);
