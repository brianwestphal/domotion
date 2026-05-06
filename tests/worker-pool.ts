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
 * (browser + GPU + renderer + utility), so the effective CPU footprint per
 * worker is several times one core. `cores - 1` was still pegging multi-core
 * hosts and starving interactive work (DM-459 v2 user feedback). Halving the
 * core count plus a hard floor of 1 keeps things responsive on 4-core boxes
 * (2 workers) without giving up too much throughput on 16-core boxes
 * (8 workers). Combine with `lowerProcessPriority()` for additional
 * yield-to-foreground behavior. DM-459.
 */
export function defaultWorkerCount(coreCount: number = detectCoreCount()): number {
  return Math.max(1, Math.floor(coreCount / 2));
}

/**
 * Nudge this Node process (and any future child processes — Playwright's
 * Chromium subprocess inherits) down to a higher nice value so the kernel
 * yields CPU to interactive work (the user's editor, terminal, browser)
 * when there's contention. Idle CPU still goes to the test pool, so
 * absolute throughput on an otherwise-idle machine is unchanged. Skipped
 * when `DOMOTION_NO_NICE=1` is set so power users can benchmark without
 * the priority adjustment. Best-effort: an EPERM (e.g. RLIMIT_NICE limit)
 * is logged once and swallowed. DM-459.
 */
export function lowerProcessPriority(nice: number = 10): void {
  if (process.env["DOMOTION_NO_NICE"] === "1") return;
  try {
    os.setPriority(0, nice);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[worker-pool] could not lower process priority (nice=${nice}): ${msg}\n`);
  }
}

/**
 * Resolve the worker count from CLI args (`--workers N`) or env var
 * (`DOMOTION_TEST_WORKERS`). Falls back to `defaultWorkerCount()` —
 * `cpus - 1`, leaving one core free for other work (DM-459). Clamps the
 * final value to [1, 32]; values outside the range are silently coerced.
 *
 * Recognised CLI form: `--workers 6` or `--workers=6` anywhere in argv.
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

