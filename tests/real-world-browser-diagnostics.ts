import { type ChildProcess, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createBoundedCapture, createNativeLogFilter } from "../scripts/e2e-native-logs.mjs";

export const OWNED_BROWSER_LOG_MAX_BYTES = 256 * 1024;

/** Actual owned Chrome, distinct from Playwright's short-lived launch scout.
 * Opt-in uses the same pre-retention privacy filter as the E2E runner. Never
 * record spawn arguments/environment or forward unfiltered process output. */
export function captureOwnedBrowserDiagnostics(
  child: ChildProcess,
  directory: string,
  sourceCommit: string | undefined,
  maxBytes = OWNED_BROWSER_LOG_MAX_BYTES,
): { logPath: string; metadataPath: string; finalize(): Promise<void> } {
  if (child.stderr == null) throw new Error("Owned browser diagnostic stderr is not piped");
  const stderr = child.stderr;
  const capture = createBoundedCapture(maxBytes);
  const startedAt = new Date().toISOString();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const logPath = join(resolve(directory), `owned-${process.pid}-${child.pid ?? "unspawned"}-${randomUUID()}.log`);
  const metadataPath = `${logPath}.json`;
  let endpointLines = 0;
  const filter = createNativeLogFilter((chunk) => {
    // The loopback discovery token is a browser credential, not useful error
    // evidence. The public launcher already discovers it through its profile.
    if (/DevTools listening on wss?:\/\//.test(chunk.toString("utf8"))) endpointLines++;
    else capture.append(chunk);
  });
  let stderrEnded = false;
  let processCloseObserved = false;
  let streamError = false;
  let launchErrorCode: string | null = null;
  let finalized = false;
  let diagnosticError: unknown;
  let finalizePromise: Promise<void> | undefined;
  let complete: () => void;
  const closed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const data = (chunk: Buffer): void => filter.append(chunk);
  const end = (): void => {
    stderrEnded = true;
  };
  const error = (): void => {
    streamError = true;
  };
  const launchError = (error: Error): void => {
    const code: unknown = Reflect.get(error, "code");
    launchErrorCode = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown";
  };
  const save = (): void => {
    if (finalized) return;
    finalized = true;
    stderr.off("data", data);
    stderr.off("end", end);
    stderr.off("error", error);
    child.off("error", launchError);
    child.off("close", close);
    try {
      const filtered = filter.finish();
      const retained = capture.finish();
      const incomplete = !processCloseObserved || !stderrEnded || streamError;
      writeFileSync(logPath, retained.data, { flag: "wx", mode: 0o600 });
      writeFileSync(
        metadataPath,
        JSON.stringify(
          {
            schema: "domotion-owned-browser-log-v1",
            startedAt,
            finishedAt: new Date().toISOString(),
            sourceCommit: /^[0-9a-f]{40}$/i.test(sourceCommit ?? "") ? sourceCommit : null,
            platform: process.platform,
            arch: process.arch,
            hostProcessId: process.pid,
            processId: child.pid ?? null,
            status: child.exitCode,
            signal: child.signalCode,
            launchErrorCode,
            processCloseObserved,
            stderrEnded,
            streamError,
            diagnosticFailure: incomplete,
            ...filtered,
            endpointLines,
            byteBasis: "filtered-owned-chromium-stderr",
            maxLineBytes: 64 * 1024,
            maxBytes,
            totalBytes: retained.totalBytes,
            retainedBytes: retained.retainedBytes,
            omittedBytes: retained.omittedBytes,
            truncated: retained.truncated,
            filteredStreamSha256: retained.sha256,
          },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
      if (incomplete) diagnosticError = new Error("Owned browser diagnostic stream did not complete");
    } catch (error) {
      diagnosticError = error;
    }
  };
  const close = (): void => {
    processCloseObserved = true;
    save();
    complete();
  };
  stderr.on("data", data);
  stderr.once("end", end);
  stderr.on("error", error);
  child.on("error", launchError);
  child.once("close", close);
  return {
    logPath,
    metadataPath,
    finalize: () =>
      (finalizePromise ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([closed, new Promise<void>((resolve) => (timer = setTimeout(resolve, 2_000)))]);
        } finally {
          clearTimeout(timer);
        }
        save();
        // Drain a late stream after a bounded incomplete finish. It cannot
        // block the browser, add retained bytes or hold a diagnostic listener.
        stderr.resume();
        if (diagnosticError != null) throw diagnosticError;
      })()),
  };
}

export const SCOUT_CLOSE_LOG_MAX_BYTES = 64 * 1024;
export const SCOUT_SAMPLE_MAX_BYTES = 64 * 1024;
/** Upper bound on how long a stalled-close sample may delay the fallback kill. */
export const SCOUT_SAMPLE_TIMEOUT_MS = 5_000;

/** Returns a native sampler report for `pid`, or `null` when the platform has
 * no sampler. Must give up within `timeoutMs`. */
export type NativeSampler = (pid: number, timeoutMs: number) => Promise<string | null>;

/** macOS `sample <pid> 1 -mayDie`, written to a private temporary file. */
export const nativeSampler: NativeSampler = async (pid, timeoutMs) => {
  if (process.platform !== "darwin") return null;
  const directory = await mkdtemp(join(tmpdir(), "dm-scout-sample-"));
  try {
    const file = join(directory, "sample.txt");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "/usr/bin/sample",
        [String(pid), "1", "-mayDie", "-file", file],
        { timeout: timeoutMs, killSignal: "SIGKILL" },
        (error) => (error == null ? resolve() : reject(error)),
      );
    });
    return await readFile(file, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** The call-graph sections of a `sample` report: everything from `Call graph:`
 * up to `Binary Images:`. The header (executable path, parent process, dates)
 * and the binary-image table are dropped, and any remaining absolute path is
 * replaced with `<path>`. */
export function sampleCallGraph(report: string): string {
  const start = report.indexOf("Call graph:");
  if (start === -1) return "";
  const end = report.indexOf("\nBinary Images:", start);
  const section = report.slice(start, end === -1 ? undefined : end + 1);
  return section.replace(
    /(?:~|\/(?:Users|home|private|var|tmp|Volumes|opt|Applications|System|Library))\/[^\s)\]>]*/g,
    "<path>",
  );
}

type ScoutSample = {
  status: "captured" | "unsupported" | "failed" | "timeout";
  durationMs: number;
  text: string;
};

/** Failure-only evidence for Playwright's short-lived launch scout. Observers
 * attach to the public BrowserServer.process() before the unchanged close
 * request; a healthy close disposes them without touching disk. Retained
 * output passes the same pre-retention filter as owned-browser logs, and
 * arguments, environment, profile and discovery tokens are never recorded.
 * Output emitted before attachment is not observed, so absence is not proof. */
export function observeScoutClose(
  child: ChildProcess,
  directory: string | undefined,
  sourceCommit: string | undefined,
  diagnosticCase?: string,
  maxBytes = SCOUT_CLOSE_LOG_MAX_BYTES,
  sampler: NativeSampler = nativeSampler,
  sampleTimeoutMs = SCOUT_SAMPLE_TIMEOUT_MS,
): {
  requested(): void;
  expired(): void;
  sample(): Promise<void>;
  dispose(): void;
  fail(killOutcome: "resolved" | "rejected"): Promise<void>;
} {
  const observedAt = Date.now();
  const at = (): number => Date.now() - observedAt;
  const capture = createBoundedCapture(maxBytes);
  let endpointLines = 0;
  const filter = createNativeLogFilter((chunk) => {
    if (/DevTools listening on wss?:\/\//.test(chunk.toString("utf8"))) endpointLines++;
    else capture.append(chunk);
  });
  const streams = [
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ] as const;
  const ended: Record<string, number | null> = { stdout: null, stderr: null };
  let closeRequestedAtMs: number | null = null;
  let deadlineAtMs: number | null = null;
  let exitAtMs: number | null = null;
  let closeAtMs: number | null = null;
  let disposed = false;
  let failure: Promise<void> | undefined;
  let sampling: Promise<void> | undefined;
  let sampled: ScoutSample | undefined;
  let notifyClose: (() => void) | undefined;
  const data = (chunk: Buffer): void => filter.append(chunk);
  const endHandlers = streams.map(([name]) => () => {
    ended[name] = at();
  });
  const exit = (): void => {
    exitAtMs = at();
  };
  const close = (): void => {
    closeAtMs = at();
    notifyClose?.();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    streams.forEach(([, stream], index) => {
      stream?.off("data", data);
      stream?.off("end", endHandlers[index]!);
    });
    child.off("exit", exit);
    child.off("close", close);
  };
  if (directory == null)
    return {
      requested() {},
      expired() {},
      sample: () => Promise.resolve(),
      dispose() {},
      fail: () => Promise.resolve(),
    };
  streams.forEach(([, stream], index) => {
    stream?.on("data", data);
    stream?.once("end", endHandlers[index]!);
  });
  child.once("exit", exit);
  child.once("close", close);
  return {
    requested() {
      closeRequestedAtMs ??= at();
    },
    // Called when the close deadline fires, before the fallback kill, so the
    // kill's own latency never masquerades as part of the close window.
    expired() {
      deadlineAtMs ??= at();
    },
    // Called after `expired()` and before the fallback kill. Resolves within
    // `sampleTimeoutMs` (plus bookkeeping) and never rejects: a sampler
    // failure or timeout is recorded, so it can neither replace the original
    // close error nor hold the kill past that bound.
    sample: () =>
      disposed || child.pid == null
        ? Promise.resolve()
        : (sampling ??= (async () => {
            const startedAt = Date.now();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const outcome = await Promise.race([
              sampler(child.pid!, sampleTimeoutMs).then(
                (report) =>
                  report == null
                    ? ({ status: "unsupported", text: "" } as const)
                    : ({ status: "captured", text: sampleCallGraph(report) } as const),
                () => ({ status: "failed", text: "" }) as const,
              ),
              new Promise<{ status: "timeout"; text: string }>((resolve) => {
                timer = setTimeout(() => resolve({ status: "timeout", text: "" }), sampleTimeoutMs);
              }),
            ]).finally(() => clearTimeout(timer));
            sampled = { ...outcome, durationMs: Date.now() - startedAt };
          })()),
    dispose,
    // A healthy close disposes first; only an undisposed observer may write.
    fail: (killOutcome) =>
      disposed && failure == null
        ? Promise.resolve()
        : (failure ??= (async () => {
            const killSettledAtMs = at();
            await sampling;
            if (closeAtMs == null) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await new Promise<void>((resolve) => {
                  notifyClose = resolve;
                  timer = setTimeout(resolve, 2_000);
                });
              } finally {
                clearTimeout(timer);
              }
            }
            dispose();
            const filtered = filter.finish();
            const retained = capture.finish();
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const logPath = join(
              resolve(directory),
              `scout-${process.pid}-${child.pid ?? "unspawned"}-${randomUUID()}.log`,
            );
            writeFileSync(logPath, retained.data, { flag: "wx", mode: 0o600 });
            // The sample's call graph passes the same line filter and byte
            // bound as the scout's own output.
            let sample: Record<string, unknown> = { status: "not-requested" };
            if (sampled != null) {
              const sampleCapture = createBoundedCapture(SCOUT_SAMPLE_MAX_BYTES);
              const sampleFilter = createNativeLogFilter((chunk) => sampleCapture.append(chunk));
              sampleFilter.append(Buffer.from(sampled.text, "utf8"));
              const sampleCounts = sampleFilter.finish();
              const sampleRetained = sampleCapture.finish();
              const samplePath = sampleRetained.retainedBytes > 0 ? `${logPath}.sample.txt` : null;
              if (samplePath != null) writeFileSync(samplePath, sampleRetained.data, { flag: "wx", mode: 0o600 });
              sample = {
                status: sampled.status,
                tool: process.platform === "darwin" ? "sample <pid> 1 -mayDie" : null,
                durationMs: sampled.durationMs,
                timeoutMs: sampleTimeoutMs,
                file: samplePath == null ? null : basename(samplePath),
                sensitiveLines: sampleCounts.sensitiveLines,
                maxBytes: SCOUT_SAMPLE_MAX_BYTES,
                retainedBytes: sampleRetained.retainedBytes,
                omittedBytes: sampleRetained.omittedBytes,
                truncated: sampleRetained.truncated,
              };
            }
            writeFileSync(
              `${logPath}.json`,
              JSON.stringify(
                {
                  schema: "domotion-scout-close-v3",
                  writtenAt: new Date().toISOString(),
                  sourceCommit: /^[0-9a-f]{40}$/i.test(sourceCommit ?? "") ? sourceCommit : null,
                  diagnosticCase: diagnosticCase?.slice(0, 512) ?? null,
                  platform: process.platform,
                  arch: process.arch,
                  hostProcessId: process.pid,
                  processId: child.pid ?? null,
                  timeBasis: "ms after observer attachment",
                  closeRequestedAtMs,
                  deadlineAtMs,
                  killSettledAtMs,
                  exitAtMs,
                  closeAtMs,
                  stdoutEndAtMs: ended.stdout,
                  stderrEndAtMs: ended.stderr,
                  stdoutPiped: child.stdout != null,
                  stderrPiped: child.stderr != null,
                  status: child.exitCode,
                  signal: child.signalCode,
                  postKill: killOutcome,
                  exitObserved: exitAtMs != null,
                  outputBeforeAttachmentObserved: false,
                  ...filtered,
                  endpointLines,
                  byteBasis: "filtered-scout-stdout-stderr-after-attachment",
                  maxBytes,
                  totalBytes: retained.totalBytes,
                  retainedBytes: retained.retainedBytes,
                  omittedBytes: retained.omittedBytes,
                  truncated: retained.truncated,
                  filteredStreamSha256: retained.sha256,
                  sample,
                },
                null,
                2,
              ),
              { flag: "wx", mode: 0o600 },
            );
          })()),
  };
}
