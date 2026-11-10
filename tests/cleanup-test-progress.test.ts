import { expect, it, vi } from "vitest";
import { createCleanupTestProgress } from "../scripts/cleanup-test-progress.mjs";

function decode(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line.slice("[cleanup-test] ".length)) as Record<string, unknown>);
}

it("pairs command return timing while preserving old markers and excluding private payloads", () => {
  const lines: string[] = [];
  let time = 100;
  const trace = createCleanupTestProgress({ enabled: true, write: (line) => lines.push(line), now: () => time });
  time = 110;
  trace.emit({
    nativeCommand: 1,
    operation: "init",
    phase: "start",
    args: ["ARGV_SECRET"],
    cwd: "PATH_SECRET",
    env: { SECRET: "ENV_SECRET" },
  });
  time = 125.5;
  trace.emit({ nativeCommand: 1, operation: "init", phase: "returned", durationMs: 15.5, childPid: 42, status: 0 });
  trace.emit({ phase: "complete", nativeCommands: 1 });
  const rows = decode(lines);
  expect(rows[0]).toMatchObject({ phase: "process-start", pid: process.pid, parentPid: process.ppid });
  expect(rows[1]).toMatchObject({ nativeCommand: 1, operation: "init", phase: "start", elapsedMs: 10 });
  expect(rows[2]).toMatchObject({
    nativeCommand: 1,
    phase: "returned",
    elapsedMs: 25.5,
    durationMs: 15.5,
    childPid: 42,
  });
  expect(lines[1]).toContain('"operation":"init","phase":"start"');
  expect(lines[3]).toContain('[cleanup-test] {"phase":"complete",');
  expect(lines.join("")).not.toMatch(/ARGV_SECRET|PATH_SECRET|ENV_SECRET|"args"|"cwd"|"env"/);
});

it("stops normal writes at its byte budget and reserves completion/exit with omission counts", () => {
  const lines: string[] = [];
  const now = vi.fn(() => 0);
  const trace = createCleanupTestProgress({ enabled: true, write: (line) => lines.push(line), maxBytes: 4096, now });
  for (let i = 0; i < 100; i++)
    trace.emit({ phase: "fixture", case: "controlled case ".repeat(20), step: "copy-start" });
  expect(trace.snapshot().byteBudgetExhausted).toBe(true);
  const written = lines.length;
  const clockReads = now.mock.calls.length;
  expect(() =>
    trace.emit({
      phase: "start",
      get privatePayload() {
        throw Error("must not encode after cap");
      },
    }),
  ).not.toThrow();
  for (let i = 0; i < 10_000; i++) trace.emit({ phase: "start", nativeCommand: 1, operation: "status" });
  expect(lines).toHaveLength(written);
  expect(now).toHaveBeenCalledTimes(clockReads);
  trace.emit({ phase: "complete", nativeCommands: 75 });
  trace.emit({ phase: "process-exit", status: 0 });
  const finalCount = lines.length;
  trace.emit({ phase: "complete", nativeCommands: 75 });
  trace.emit({ phase: "process-exit", status: 0 });
  expect(lines).toHaveLength(finalCount);
  const rows = decode(lines);
  expect(rows.filter((row) => row["phase"] === "trace-truncated")).toHaveLength(1);
  expect(rows.at(-2)).toMatchObject({
    phase: "complete",
    trace: { truncated: true, omittedRecords: expect.any(Number) },
  });
  expect(rows.at(-1)).toMatchObject({ phase: "process-exit", status: 0 });
  expect(trace.snapshot().omittedRecords).toBeGreaterThanOrEqual(10_000);
  expect(Buffer.byteLength(lines.join(""))).toBe(trace.snapshot().bytes);
  expect(trace.snapshot().bytes).toBeLessThanOrEqual(4096);
});

it("retains later case markers after the native command cap and sanitizes operation fields", () => {
  const lines: string[] = [];
  const trace = createCleanupTestProgress({ enabled: true, write: (line) => lines.push(line) });
  expect(trace.emit({ nativeCommand: 4097, phase: "start", operation: "status" })).toBe(false);
  expect(
    trace.emit({
      phase: "fixture",
      case: "next case",
      step: "cleanup-returned",
      operation: "SECRET_OPERATION",
      command: "SECRET_COMMAND",
    }),
  ).toBe(true);
  trace.emit({ phase: "complete", nativeCommands: 5000 });
  expect(lines.join("")).not.toMatch(/SECRET_OPERATION|SECRET_COMMAND/);
  expect(decode(lines).at(-1)).toMatchObject({
    phase: "complete",
    nativeCommands: 5000,
    trace: { nativeCommandLimitReached: true, omittedRecords: 1 },
  });
});

it("does not write when disabled and contains writer failure without repeated I/O", () => {
  const write = vi.fn(() => {
    throw Error("diagnostic writer failed");
  });
  const disabled = createCleanupTestProgress({ enabled: false, write });
  expect(disabled.emit({ phase: "fixture" })).toBe(false);
  expect(write).not.toHaveBeenCalled();
  const failed = createCleanupTestProgress({ enabled: true, write });
  expect(failed.emit({ phase: "start", operation: "status", nativeCommand: 1 })).toBe(false);
  expect(failed.emit({ phase: "complete", nativeCommands: 1 })).toBe(false);
  expect(write).toHaveBeenCalledTimes(1);
  expect(failed.snapshot().writeFailed).toBe(true);
});
