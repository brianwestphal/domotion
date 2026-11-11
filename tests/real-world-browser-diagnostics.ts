import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
): {
  requested(): void;
  expired(): void;
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
  if (directory == null) return { requested() {}, expired() {}, dispose() {}, fail: () => Promise.resolve() };
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
    dispose,
    // A healthy close disposes first; only an undisposed observer may write.
    fail: (killOutcome) =>
      disposed && failure == null
        ? Promise.resolve()
        : (failure ??= (async () => {
            const killSettledAtMs = at();
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
            writeFileSync(
              `${logPath}.json`,
              JSON.stringify(
                {
                  schema: "domotion-scout-close-v2",
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
                },
                null,
                2,
              ),
              { flag: "wx", mode: 0o600 },
            );
          })()),
  };
}
