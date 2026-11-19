import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * Child-process bounds for unit tests whose children do a small, fixed amount
 * of CPU work (a Node or tsx startup, argument parsing, a short write).
 *
 * Such a child's CPU time is constant, but its wall time is that CPU time
 * divided by the share of a core it gets. Measured on a 15-core macOS host
 * (docs/tool-child-process-test-bounds.md): inside a loaded full `vitest run`,
 * every child kept its idle CPU time (tsx tool startups 0.9-1.26 s), while its
 * wall time reached 35 times that for tsx startups and 55 times for bare Node
 * startups, and every child still exited normally. A fixed wall deadline sized
 * from idle runs therefore measured host load, not a hang. Each bound is
 * instead derived from the child's measured CPU work: `LOAD_ALLOWANCE` times
 * it, but never below `MIN_BUDGET_MS`, so a child that stops making progress
 * is still killed and reported.
 */
export const LOAD_ALLOWANCE = 100;
/** Floor for the smallest children, whose fixed startup costs scale worst. */
export const MIN_BUDGET_MS = 30_000;

/**
 * Allowance for each further process a child starts in sequence (a CLI that
 * runs a dozen version-control commands, or a script whose own children do
 * almost no work). Under load each process start waited to be scheduled
 * regardless of its CPU time: inside a loaded full `vitest run`, a changelog
 * CLI that started 13 processes for 0.28 s of CPU took 52.9 s, about 4 s per
 * process, and no single small process took more than 9 s
 * (docs/tool-child-process-test-bounds.md).
 */
export const PROCESS_START_ALLOWANCE_MS = 10_000;

/**
 * Wall-clock budget for a child whose measured CPU work, its own children
 * included, is `cpuMs`, and which starts `processes` processes in sequence
 * (itself included). A single process keeps the plain CPU-derived budget.
 */
export function budgetForCpuWork(cpuMs: number, processes = 1): number {
  const starts = Math.max(0, processes - 1) * PROCESS_START_ALLOWANCE_MS;
  return Math.max(MIN_BUDGET_MS, Math.ceil(cpuMs * LOAD_ALLOWANCE) + starts);
}

/** Vitest timeout for a test that runs children with these budgets in sequence. */
export function testTimeoutFor(...budgetsMs: number[]): number {
  return budgetsMs.reduce((total, budget) => total + budget + KILL_GRACE_MS, 0) + 5_000;
}

export interface BoundedChildResult {
  pid: number | undefined;
  status: number | null;
  signal: NodeJS.Signals | null;
  /** `ETIMEDOUT` past the budget, `ENOBUFS` past the output limit, a spawn error code, or null. */
  error: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  budgetMs: number;
}

/**
 * Runs a child asynchronously, so the test worker's event loop stays live, and
 * sends SIGTERM (SIGKILL after a grace period) once `budgetMs` elapses. Unlike
 * a `spawnSync` without a timeout, a hung child is stopped and reported rather
 * than blocking the worker until Vitest can only report its own timeout.
 */
export function runBoundedChild(
  command: string,
  args: readonly string[],
  options: { budgetMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<BoundedChildResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let error: string | null = null;
    let bytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const output = { stdout: "", stderr: "" };
    const stop = (code: string) => {
      error ??= code;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const budget = setTimeout(() => stop("ETIMEDOUT"), options.budgetMs);
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) stop("ENOBUFS");
        else output[stream] += chunk;
      });
    }
    child.on("error", (spawnError) => {
      const code: unknown = Reflect.get(spawnError, "code");
      error ??= typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "unknown";
    });
    child.on("close", (status, signal) => {
      clearTimeout(budget);
      clearTimeout(killTimer);
      resolve({
        pid: child.pid,
        status,
        signal,
        error,
        ...output,
        durationMs: Math.round(performance.now() - started),
        budgetMs: options.budgetMs,
      });
    });
  });
}

/** Assertion message: the outcome summary followed by the captured output. */
export function describeChild(result: BoundedChildResult): string {
  const { stdout, stderr, ...outcome } = result;
  return `${JSON.stringify(outcome)}\n${stdout}${stderr}`;
}
