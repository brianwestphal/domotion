import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFfmpegFrameSink, type FfmpegFrameSink } from "./ffmpeg-frame-sink.js";

// Each "ffmpeg" here is a `node -e` script, so the tests exercise real child-process
// behavior (exit codes, EPIPE, full stderr pipes) without needing ffmpeg installed.
const node = process.execPath;
const frame = Buffer.alloc(64 * 1024, 7);

const script = (body: string): string[] => ["-e", body];

describe("startFfmpegFrameSink", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  const sinks: FfmpegFrameSink[] = [];
  const start = (
    args: string[],
    stderr: "inherit" | "capture" = "capture",
    stdout: "inherit" | "ignore" = "ignore",
  ): FfmpegFrameSink => {
    const sink = startFfmpegFrameSink(node, args, { stderr, stdout });
    sinks.push(sink);
    return sink;
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(async () => {
    for (const sink of sinks.splice(0)) sink.dispose();
    // Let any stray rejection surface before the assertion below.
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("writes every frame and finishes when ffmpeg drains stdin and exits 0", async () => {
    const sink = start(script("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"));
    for (let i = 0; i < 4; i++) await sink.writeFrame(frame);
    await expect(sink.finish()).resolves.toBeUndefined();
  });

  it("reports ffmpeg's own exit error (with its stderr tail) when it dies before the frames are written", async () => {
    const sink = start(script("process.stderr.write('Unknown encoder libx999\\n'); process.exit(1);"));
    let error: Error | undefined;
    try {
      // ffmpeg is already gone (or going): a later write must fail with ITS error, not an
      // incidental EPIPE, and never as an unhandled rejection.
      for (let i = 0; i < 200; i++) await sink.writeFrame(frame);
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toMatch(/^ffmpeg exited 1: .*Unknown encoder libx999/s);
  });

  it("reports a non-zero exit from finish() when ffmpeg fails after reading every frame", async () => {
    const sink = start(script("process.stdin.resume(); process.stdin.on('end', () => process.exit(3));"));
    await sink.writeFrame(frame);
    await expect(sink.finish()).rejects.toThrow(/ffmpeg exited 3/);
  });

  it("never observes an unhandled rejection when ffmpeg fails and the caller never awaits it", async () => {
    // The caller's render loop is the only consumer of the exit promise. If it throws for an
    // unrelated reason (a page crash) and only calls dispose(), the exit rejection must
    // already be handled.
    const sink = start(script("process.exit(1);"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    sink.dispose();
  });

  it("drains a flood of stderr in capture mode instead of hanging", async () => {
    // ffmpeg prints progress continuously; an undrained pipe fills at ~64 KB and blocks it.
    const sink = start(
      script(
        // fs.writeSync blocks on a full pipe (process.stderr.write can buffer in memory instead),
        // so an undrained stderr pipe stalls this stub exactly as it stalls ffmpeg.
        "const fs = require('fs');" +
          "const chunk = 'frame= 1 fps=1 q=-1.0 size=0kB time=00:00:00.04\\n'.repeat(2000);" +
          "for (let i = 0; i < 40; i++) fs.writeSync(2, chunk);" +
          "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));",
      ),
    );
    await sink.writeFrame(frame);
    await expect(sink.finish()).resolves.toBeUndefined();
  }, 8_000);

  it("dispose() kills a still-running ffmpeg so a mid-render failure cannot orphan it", async () => {
    const sink = start(script("setInterval(() => {}, 1000);"));
    await sink.writeFrame(frame);
    sink.dispose();
    await expect(sink.finish()).rejects.toThrow(/ffmpeg exited (null|SIG)/i);
  });

  it("dispose() after a clean finish is a harmless no-op", async () => {
    const sink = start(script("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"));
    await sink.finish();
    sink.dispose();
    sink.dispose();
  });
});
