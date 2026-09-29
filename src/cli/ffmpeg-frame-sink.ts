/**
 * Pipe rendered frames into an `ffmpeg` child (image2pipe) without the failure
 * modes a bare `spawn` + `stdin.write` loop has:
 *
 * - the exit promise is observed from the moment ffmpeg starts, so an early
 *   non-zero exit (unwritable output, missing codec, bad `--captions`) is never an
 *   unhandled rejection that kills the process before the caller's `finally` runs;
 * - a frame write races the exit, and a write error (EPIPE once ffmpeg is gone) is
 *   replaced by ffmpeg's own exit error, so the reported failure does not depend on
 *   which event the OS delivers first;
 * - stderr is either inherited or drained into a bounded tail (never left as an
 *   undrained pipe, which blocks ffmpeg after ~64 KB of progress output and hangs
 *   the render); the tail is appended to the exit error;
 * - `dispose()` kills a still-running ffmpeg so a mid-render failure (page crash)
 *   cannot orphan it.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface FfmpegFrameSinkOptions {
  /** `inherit` shows ffmpeg's progress on the terminal; `capture` drains it into the error tail. */
  stderr: "inherit" | "capture";
  /** ffmpeg writes nothing useful to stdout in pipe mode; `inherit` keeps the historical behavior. */
  stdout?: "inherit" | "ignore";
}

export interface FfmpegFrameSink {
  /** Write one frame; rejects with ffmpeg's exit error when ffmpeg has already failed. */
  writeFrame(frame: Buffer): Promise<void>;
  /** End stdin and wait for ffmpeg to exit cleanly; rejects with its exit error. */
  finish(): Promise<void>;
  /** Kill ffmpeg if it is still running. Safe to call after `finish()` and more than once. */
  dispose(): void;
}

/** How much of ffmpeg's stderr is retained, and how much of it goes into an error message. */
const STDERR_RETAIN_CHARS = 8192;
const STDERR_MESSAGE_CHARS = 400;

export function startFfmpegFrameSink(
  binary: string,
  args: string[],
  options: FfmpegFrameSinkOptions,
  spawnFn: typeof spawn = spawn,
): FfmpegFrameSink {
  const capture = options.stderr === "capture";
  const child: ChildProcess = spawnFn(binary, args, {
    stdio: ["pipe", options.stdout ?? "inherit", capture ? "pipe" : "inherit"],
  });
  const stdin = child.stdin;
  if (!stdin) {
    child.kill();
    throw new Error("ffmpeg stdin pipe unavailable");
  }
  // EPIPE surfaces through the write callback and the exit status; an 'error' event with
  // no listener would otherwise be an uncaught exception.
  stdin.on("error", () => {});

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail += chunk.toString();
    if (stderrTail.length > STDERR_RETAIN_CHARS) stderrTail = stderrTail.slice(-STDERR_RETAIN_CHARS);
  });

  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = capture && stderrTail.trim() !== "" ? `: ${stderrTail.trim().slice(-STDERR_MESSAGE_CHARS)}` : "";
      reject(new Error(`ffmpeg exited ${code ?? signal}${tail}`));
    });
  });
  // Observed from the start; `finish()` / `writeFrame()` re-await it to surface the error.
  done.catch(() => {});

  const stillRunning = (): boolean => child.exitCode == null && child.signalCode == null;

  return {
    async writeFrame(frame) {
      const written = new Promise<void>((resolve, reject) => {
        stdin.write(frame, (err) => (err ? reject(err) : resolve()));
      });
      const exitedEarly = done.then(() => {
        throw new Error("ffmpeg exited before every frame was written");
      });
      try {
        await Promise.race([written, exitedEarly]);
      } catch (err) {
        // Whatever failed first, ffmpeg is unusable now. Prefer its own exit error over the
        // incidental EPIPE, which one of the two events always wins by timing alone.
        if (stillRunning()) child.kill();
        await done;
        throw err;
      }
    },
    async finish() {
      stdin.end();
      await done;
    },
    dispose() {
      if (stillRunning()) child.kill();
    },
  };
}
