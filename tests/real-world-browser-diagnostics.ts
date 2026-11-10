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
