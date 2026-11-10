import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const NATIVE_LOG_MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;

/** Fixed buffers retain a prefix and rolling suffix without retaining input chunks. */
export function createBoundedCapture(maxBytes = NATIVE_LOG_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > NATIVE_LOG_MAX_BYTES)
    throw new Error("invalid native log byte bound");
  const head = Buffer.alloc(Math.ceil(maxBytes / 2));
  const tail = Buffer.alloc(Math.floor(maxBytes / 2));
  const hash = createHash("sha256");
  let headBytes = 0;
  let tailBytes = 0;
  let tailOffset = 0;
  let totalBytes = 0;
  let finished = false;
  return {
    /** @param {Buffer} chunk */
    append(chunk) {
      if (finished) throw new Error("native log already finalized");
      hash.update(chunk);
      totalBytes += chunk.length;
      const prefix = Math.min(head.length - headBytes, chunk.length);
      chunk.copy(head, headBytes, 0, prefix);
      headBytes += prefix;
      const rest = chunk.subarray(prefix);
      if (rest.length >= tail.length) {
        rest.copy(tail, 0, rest.length - tail.length);
        tailBytes = tail.length;
        tailOffset = 0;
      } else {
        const first = Math.min(rest.length, tail.length - tailOffset);
        rest.copy(tail, tailOffset, 0, first);
        rest.copy(tail, 0, first);
        tailOffset = (tailOffset + rest.length) % tail.length;
        tailBytes = Math.min(tail.length, tailBytes + rest.length);
      }
    },
    finish() {
      if (finished) throw new Error("native log already finalized");
      finished = true;
      const omittedBytes = totalBytes - headBytes - tailBytes;
      const marker =
        omittedBytes > 0 ? Buffer.from(`\n[${omittedBytes} native diagnostic bytes omitted]\n`) : Buffer.alloc(0);
      const oldest = tailBytes === tail.length ? tailOffset : 0;
      const data = Buffer.concat([
        head.subarray(0, headBytes),
        marker,
        tail.subarray(oldest, oldest + Math.min(tailBytes, tail.length - oldest)),
        tail.subarray(0, Math.max(0, tailBytes - (tail.length - oldest))),
      ]);
      return {
        data,
        totalBytes,
        retainedBytes: headBytes + tailBytes,
        omittedBytes,
        truncated: omittedBytes > 0,
        sha256: hash.digest("hex"),
      };
    },
  };
}

/** Filter complete bounded lines before any new forwarding or retention. */
export function createNativeLogFilter(/** @type {(chunk: Buffer) => void} */ emit) {
  const line = Buffer.alloc(MAX_LINE_BYTES);
  let length = 0;
  let oversized = false;
  let finished = false;
  const counts = { launchLines: 0, sensitiveLines: 0, oversizedLines: 0, inputBytes: 0 };
  const flush = () => {
    if (oversized) counts.oversizedLines++;
    else if (length > 0) {
      const bytes = line.subarray(0, length);
      const text = bytes.toString("utf8");
      if (text.includes("<launching>")) counts.launchLines++;
      else if (
        /\b(?:authorization|proxy-authorization|cookie|set-cookie|headers|extraHTTPHeaders|httpCredentials|x-[\w-]+|api[-_]key|env|environment)\s*["']?\s*[:=]/i.test(
          text,
        ) ||
        /(?:^|[\s"'])[A-Z_][A-Z0-9_]*\s*=/.test(text)
      )
        counts.sensitiveLines++;
      else emit(Buffer.from(bytes));
    }
    length = 0;
    oversized = false;
  };
  return {
    /** @param {Buffer} chunk */
    append(chunk) {
      if (finished) throw new Error("native log filter already finalized");
      counts.inputBytes += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline + 1;
        const bytes = end - offset;
        if (!oversized && length + bytes <= line.length) {
          chunk.copy(line, length, offset, end);
          length += bytes;
        } else oversized = true;
        if (newline !== -1) flush();
        offset = end;
      }
    },
    finish() {
      if (finished) throw new Error("native log filter already finalized");
      finished = true;
      flush();
      return { ...counts };
    },
  };
}

/**
 * Opt-in diagnostics only. Default E2E execution still uses spawnSync/inherit.
 * Metadata deliberately excludes executable arguments, environment and headers.
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{status: number | null; signal: NodeJS.Signals | null; interruptedBy: NodeJS.Signals | undefined; error: Error | undefined; diagnosticError: Error | undefined}>}
 * @param {{ logPath: string; lane: string; cwd?: string; env?: NodeJS.ProcessEnv; maxBytes?: number; forward?: import('node:stream').Writable }} options
 */
export async function runWithNativeLog(command, args, options) {
  mkdirSync(dirname(options.logPath), { recursive: true });
  const capture = createBoundedCapture(options.maxBytes);
  const forward = options.forward ?? process.stderr;
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...(options.env ?? process.env), DEBUG: "pw:browser" },
    stdio: ["inherit", "inherit", "pipe"],
  });
  /** @type {Error | undefined} */
  let launchError;
  /** @type {Error | undefined} */
  let diagnosticError;
  /** @type {NodeJS.Signals | undefined} */
  let interruptedBy;
  let waitingForDrain = false;
  const resume = () => {
    waitingForDrain = false;
    child.stderr.resume();
  };
  const filter = createNativeLogFilter((chunk) => {
    capture.append(chunk);
    if (!forward.write(chunk) && !waitingForDrain) {
      waitingForDrain = true;
      child.stderr.pause();
      forward.once("drain", resume);
    }
  });
  const forwardError = (/** @type {Error} */ error) => {
    diagnosticError = error;
    child.kill("SIGKILL");
    child.stderr.destroy();
  };
  forward.on("error", forwardError);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let killTimer;
  const interrupt = (/** @type {NodeJS.Signals} */ signal) => {
    interruptedBy ??= signal;
    child.kill(signal);
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  child.stderr.on("data", (chunk) => filter.append(chunk));
  child.on("error", (error) => {
    launchError = error;
  });
  return new Promise((resolve) => {
    child.once("close", async (status, signal) => {
      clearTimeout(killTimer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      try {
        const filtered = filter.finish();
        await new Promise((done) => {
          const timer = setTimeout(() => {
            diagnosticError ??= new Error("native diagnostic forwarding exceeded 2000ms");
            done(undefined);
          }, 2_000);
          try {
            forward.write(Buffer.alloc(0), (error) => {
              clearTimeout(timer);
              if (error != null) diagnosticError ??= error;
              done(undefined);
            });
          } catch (error) {
            clearTimeout(timer);
            diagnosticError ??= error instanceof Error ? error : new Error(String(error));
            done(undefined);
          }
        });
        const retained = capture.finish();
        writeFileSync(options.logPath, retained.data);
        writeFileSync(
          `${options.logPath}.json`,
          JSON.stringify(
            {
              schema: "domotion-native-browser-log-v1",
              lane: options.lane,
              startedAt,
              finishedAt: new Date().toISOString(),
              status,
              signal,
              interruptedBy: interruptedBy ?? null,
              diagnosticFailure: diagnosticError != null,
              launchErrorCode: launchError == null ? null : (Reflect.get(launchError, "code") ?? "unknown"),
              ...filtered,
              byteBasis: "filtered-stderr",
              maxLineBytes: MAX_LINE_BYTES,
              maxBytes: options.maxBytes ?? NATIVE_LOG_MAX_BYTES,
              totalBytes: retained.totalBytes,
              retainedBytes: retained.retainedBytes,
              omittedBytes: retained.omittedBytes,
              truncated: retained.truncated,
              filteredStreamSha256: retained.sha256,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        diagnosticError ??= error instanceof Error ? error : new Error(String(error));
      }
      forward.off("drain", resume);
      forward.off("error", forwardError);
      resolve({ status, signal, interruptedBy, error: launchError, diagnosticError });
    });
  });
}
