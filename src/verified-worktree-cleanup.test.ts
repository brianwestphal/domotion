import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/** DM-BEMV41: the child makes about 2,720 native Git calls whose wall time
 * scales with host load (19 s idle; 94 s under 30 busy processes on 15 cores,
 * with every call slower and none over 107 ms). A fixed wall-clock deadline
 * therefore measured load, not a hang. A hang is a child that stops emitting
 * its progress trace; the overall cap only bounds pathological slowness. */
const STALL_MS = 60_000;
const OVERALL_MS = 300_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

interface ChildResult {
  pid: number | undefined;
  status: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  stdout: string;
  stderr: string;
  longestSilenceMs: number;
}

function runChild(
  args: string[],
  cwd: string,
  { stallMs = STALL_MS, overallMs = OVERALL_MS } = {},
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, DOMOTION_CLEANUP_TEST_PROGRESS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = performance.now();
    let lastProgress = started;
    let longestSilenceMs = 0;
    let error: string | null = null;
    let bytes = 0;
    const output = { stdout: "", stderr: "" };
    const stop = (code: string) => {
      error ??= code;
      // SIGTERM, as spawnSync's timeout sent: the `--test` supervisor then
      // cleans up its own test-file child.
      child.kill("SIGTERM");
    };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) return stop("ENOBUFS");
        output[stream] += chunk;
        if (chunk.includes("[cleanup-test]")) {
          const now = performance.now();
          longestSilenceMs = Math.max(longestSilenceMs, now - lastProgress);
          lastProgress = now;
        }
      });
    }
    const watchdog = setInterval(
      () => {
        const now = performance.now();
        if (now - started > overallMs) stop("ETIMEDOUT");
        // After a reported truncation the trace goes quiet by design.
        else if (
          now - lastProgress > stallMs &&
          !`${output.stdout}${output.stderr}`.includes('"phase":"trace-truncated"')
        )
          stop("ESTALLED");
      },
      Math.min(1_000, stallMs / 4),
    );
    child.on("error", (spawnError) => {
      const code: unknown = Reflect.get(spawnError, "code");
      error ??= typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "unknown";
    });
    child.on("close", (status, signal) => {
      clearInterval(watchdog);
      resolve({ pid: child.pid, status, signal, error, ...output, longestSilenceMs: Math.round(longestSilenceMs) });
    });
  });
}

test(
  "verified cleanup passes platform-supported and portable refusal contracts",
  async () => {
    // Node cannot implement POSIX owner/group/other chmod distinctions on Windows:
    // https://nodejs.org/api/fs.html#file-modes. Its native job checks portable
    // grammar and the explicit pre-I/O refusal; POSIX hosts run every Git fixture.
    const selection =
      process.platform === "win32"
        ? [
            "--test-name-pattern",
            "GitHub CI authority|CLI never accepts|CLI refuses the review-less|generated exception refuses|Windows cleanup refuses",
          ]
        : [];
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const result = await runChild(
      ["--test", ...selection, "scripts/verified-worktree-cleanup.test.mjs"],
      fileURLToPath(new URL("..", import.meta.url)),
    );
    const outcome = {
      schema: "domotion-cleanup-wrapper-result-v2",
      startedAt,
      finishedAt: new Date().toISOString(),
      ownerPid: process.pid,
      supervisorPid: result.pid,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      stallMs: STALL_MS,
      overallMs: OVERALL_MS,
      longestSilenceMs: result.longestSilenceMs,
      status: result.status,
      signal: result.signal,
      error: result.error,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr),
    };
    const diagnostic = `${JSON.stringify(outcome)}\n${result.stdout}${result.stderr}`;
    expect(result.error, diagnostic).toBeNull();
    expect(result.status, diagnostic).toBe(0);
    expect(result.stdout).toContain('[cleanup-test] {"phase":"complete",');
    if (process.platform !== "win32") {
      expect(result.stdout).toContain('"operation":"init","phase":"start"');
      expect(result.stdout).toContain('"phase":"fixture"');
    }
  },
  OVERALL_MS + 10_000,
);

const progressThenSilence = (truncated: boolean) => [
  "-e",
  `console.log('[cleanup-test] {"phase":"process-start"}');${
    truncated ? `console.log('[cleanup-test] {"phase":"trace-truncated"}');` : ""
  }setTimeout(() => console.log('[cleanup-test] {"phase":"complete"}'), 1500);`,
];

test("cleanup wrapper stops a child whose progress trace goes silent", async () => {
  const started = performance.now();
  const result = await runChild(progressThenSilence(false), process.cwd(), { stallMs: 400, overallMs: 10_000 });
  expect(result.error).toBe("ESTALLED");
  expect(result.signal).toBe("SIGTERM");
  expect(performance.now() - started).toBeLessThan(1_400);
});

test("cleanup wrapper keeps waiting once the trace reports its own truncation", async () => {
  const result = await runChild(progressThenSilence(true), process.cwd(), { stallMs: 400, overallMs: 10_000 });
  expect(result).toMatchObject({ error: null, status: 0, signal: null });
  expect(result.stdout).toContain('"phase":"complete"');
});
