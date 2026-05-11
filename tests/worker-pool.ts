/**
 * Bounded-concurrency worker pool shared by every visual-regression suite
 * (`features.ts`, `showcase.tsx`, `html-test-suite.tsx`, `real-world.tsx`).
 *
 * Each suite has slightly different per-job needs — the pool just runs N
 * concurrent async tasks with a per-worker resource bag so the suite can
 * stash a `BrowserContext`, capture page, and compare page on it. Logging
 * is ordered by completion (not by job index) so tests that finish faster
 * print sooner without scrambling the line per-job. DM-456.
 */

import os from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Number of CPU cores the host exposes. Prefers
 * `os.availableParallelism()` (respects cgroup quotas / `taskset` masks
 * since Node 19) and falls back to `os.cpus().length` on older runtimes.
 */
export function detectCoreCount(): number {
  const fn = (os as { availableParallelism?: () => number }).availableParallelism;
  const n = typeof fn === "function" ? fn() : os.cpus().length;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Default worker count for the visual-regression pool. Each worker owns a
 * Playwright `BrowserContext`, which means a separate Chromium *process tree*
 * (browser + GPU + renderer + utility) and 500 MB-2 GB of resident RAM, so
 * the effective system footprint per worker is several cores plus a sizeable
 * memory hit. Earlier defaults (`cores - 1`, then `cores / 2`) still pegged
 * the host. DM-459 v3 drops the default to `cores / 4` (floor 1, ceiling 8),
 * which on a 10-core MBP runs 2 workers, on a 4-core box runs 1, on a 16-core
 * box runs 4 — combined with the macOS BACKGROUND QoS class set by
 * `lowerProcessPriority()`, interactive work stays responsive even mid-suite.
 * Users on idle hosts can override with `--workers N` / `DOMOTION_TEST_WORKERS`.
 */
export function defaultWorkerCount(coreCount: number = detectCoreCount()): number {
  return Math.min(8, Math.max(1, Math.floor(coreCount / 4)));
}

/**
 * Lower this process (and its descendants — Playwright's Chromium tree) to
 * the lowest practical scheduler priority so the host stays responsive while
 * the test suites run.
 *
 * Two orthogonal mechanisms applied together — POSIX nice alone has not been
 * enough on macOS (DM-459 v2 feedback: "still pegging the system"):
 *
 * 1. **POSIX nice** — `os.setPriority(0, 19)` on this process. POSIX nice is
 *    inherited by `fork()`/`spawn()` children, so Chromium subprocesses come
 *    up at the same nice value.
 * 2. **macOS BACKGROUND QoS class** — `taskpolicy -B -p <pid>`. This is much
 *    more aggressive than nice on macOS: the BACKGROUND QoS class limits
 *    scheduler priority *and* I/O priority *and* timer coalescing, and is
 *    inherited by descendants. The kernel only gives BACKGROUND-class work
 *    truly spare cycles. Linux / Windows: nice alone (no equivalent ergonomic
 *    QoS knob). `taskpolicy` failures are logged once and swallowed —
 *    on Linux / inside sandboxes the binary is absent and we fall back to
 *    nice-only.
 *
 * Skipped entirely when `DOMOTION_NO_NICE=1` so power users can benchmark
 * without the throttle. DM-459.
 */
export function lowerProcessPriority(nice: number = 19): void {
  if (process.env["DOMOTION_NO_NICE"] === "1") return;
  try {
    os.setPriority(0, nice);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[worker-pool] could not lower process priority (nice=${nice}): ${msg}\n`);
  }
  if (process.platform === "darwin") {
    // `taskpolicy` ships with macOS at /usr/sbin/taskpolicy. -B sets the
    // BACKGROUND QoS class (the most aggressive throttle short of suspending
    // the process). -p PID applies it to a running process; descendants
    // inherit.
    const r = spawnSync("/usr/sbin/taskpolicy", ["-B", "-p", String(process.pid)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (r.status !== 0) {
      const stderr = r.stderr != null ? r.stderr.toString() : "";
      const reason = r.error != null ? r.error.message : (stderr || `exit ${r.status}`);
      process.stderr.write(`[worker-pool] taskpolicy -B failed: ${reason.trim()}\n`);
    }
  }
}

/**
 * Resolve the worker count from CLI args (`--workers N`) or env var
 * (`DOMOTION_TEST_WORKERS`). Falls back to `defaultWorkerCount()` —
 * `cpus / 4` (clamped 1–8), keeping interactive work responsive (DM-459).
 * Clamps the final value to [1, 32]; values outside the range are silently
 * coerced.
 *
 * Recognized CLI form: `--workers 6` or `--workers=6` anywhere in argv.
 */
export function resolveWorkerCount(defaultWorkers: number = defaultWorkerCount()): number {
  const argv = process.argv.slice(2);
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workers" && i + 1 < argv.length) { raw = argv[i + 1]; break; }
    if (a.startsWith("--workers=")) { raw = a.slice("--workers=".length); break; }
  }
  if (raw == null) raw = process.env["DOMOTION_TEST_WORKERS"];
  if (raw == null) return Math.min(32, Math.max(1, defaultWorkers));
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return Math.min(32, Math.max(1, defaultWorkers));
  return Math.min(32, Math.max(1, n));
}

/**
 * Run `jobs` with `workers` concurrent workers. Each worker is set up once
 * via `setup()` (typically allocating a `BrowserContext` + pages), then
 * pulls jobs from the queue until empty. Per-job results are passed to
 * `onResult` in completion order so suite logging stays line-oriented and
 * readable.
 *
 * Returns results sorted by **input job order** (not completion order) so
 * downstream callers (manifest writers, summary tallies) see deterministic
 * output regardless of worker scheduling.
 *
 * Errors thrown by `runJob` are wrapped: the result for that job is the
 * value `onError(job, err)` returns. If `onError` is omitted, the error
 * propagates and the pool rejects.
 */
export async function runJobsInPool<TJob, TWorker, TResult>(opts: {
  jobs: TJob[];
  workers: number;
  setup: (workerId: number) => Promise<TWorker>;
  runJob: (job: TJob, worker: TWorker, jobIndex: number) => Promise<TResult>;
  teardown?: (worker: TWorker, workerId: number) => Promise<void>;
  onResult?: (result: TResult, job: TJob, jobIndex: number) => void;
  onError?: (job: TJob, err: unknown, jobIndex: number) => TResult;
}): Promise<TResult[]> {
  const { jobs, runJob, setup, teardown, onResult, onError } = opts;
  const workerCount = Math.min(Math.max(1, opts.workers), Math.max(1, jobs.length));
  const out = new Array<TResult>(jobs.length);
  let next = 0;

  async function worker(workerId: number): Promise<void> {
    const ctx = await setup(workerId);
    try {
      while (true) {
        const idx = next++;
        if (idx >= jobs.length) break;
        const job = jobs[idx];
        let result: TResult;
        try {
          result = await runJob(job, ctx, idx);
        } catch (err) {
          if (onError == null) throw err;
          result = onError(job, err, idx);
        }
        out[idx] = result;
        if (onResult != null) onResult(result, job, idx);
      }
    } finally {
      if (teardown != null) await teardown(ctx, workerId);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker(i));
  await Promise.all(workers);
  return out;
}

