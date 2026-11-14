import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  captureOwnedBrowserDiagnostics,
  type NativeSampler,
  nativeSampler,
  observeScoutClose,
  sampleCallGraph,
} from "./real-world-browser-diagnostics.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporary = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "dm-owned-diagnostics-"));
  directories.push(directory);
  return directory;
};
const source = "a".repeat(40);

it("captures only the actual child's filtered stderr with complete exit and source provenance", async () => {
  const directory = temporary();
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.stdout.write('STDOUT_PRIVATE');process.stderr.write('native startup\\n<launching> --private=ARG_SECRET\\nAuthorization: HEADER_SECRET\\nSECRET_TOKEN=ENV_SECRET\\nDevTools listening on ws://127.0.0.1:1/devtools/browser/ENDPOINT_SECRET\\n');process.stderr.write('z'.repeat(65537)+'\\n');process.stderr.write('native end\\n');process.exitCode=7`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const diagnostics = captureOwnedBrowserDiagnostics(child, directory, source);
  await diagnostics.finalize();
  const log = readFileSync(diagnostics.logPath, "utf8");
  expect(log).toBe("native startup\nnative end\n");
  const metadata = JSON.parse(readFileSync(diagnostics.metadataPath, "utf8"));
  expect(metadata).toMatchObject({
    schema: "domotion-owned-browser-log-v1",
    sourceCommit: source,
    processId: child.pid,
    hostProcessId: process.pid,
    status: 7,
    signal: null,
    launchLines: 1,
    sensitiveLines: 2,
    oversizedLines: 1,
    endpointLines: 1,
    processCloseObserved: true,
    stderrEnded: true,
    diagnosticFailure: false,
    truncated: false,
    filteredStreamSha256: createHash("sha256").update(log).digest("hex"),
  });
  expect(JSON.stringify(metadata)).not.toMatch(/SECRET|STDOUT_PRIVATE|127\.0\.0\.1|--private/);
  await diagnostics.finalize(); // Idempotent close does not rewrite immutable files.
});

it("bounds the actual stream while retaining prefix, suffix and whole filtered-stream hash", async () => {
  const directory = temporary();
  const text = "0123456789\n".repeat(10_000);
  const child = spawn(process.execPath, ["-e", "process.stderr.write('0123456789\\n'.repeat(10000))"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const diagnostics = captureOwnedBrowserDiagnostics(child, directory, "untrusted value", 32);
  await diagnostics.finalize();
  const log = readFileSync(diagnostics.logPath);
  expect(log.subarray(0, 16)).toEqual(Buffer.from(text).subarray(0, 16));
  expect(log.subarray(-16)).toEqual(Buffer.from(text).subarray(-16));
  expect(log.length).toBeLessThan(128);
  expect(JSON.parse(readFileSync(diagnostics.metadataPath, "utf8"))).toMatchObject({
    sourceCommit: null,
    totalBytes: Buffer.byteLength(text),
    retainedBytes: 32,
    omittedBytes: Buffer.byteLength(text) - 32,
    truncated: true,
    filteredStreamSha256: createHash("sha256").update(text).digest("hex"),
  });
});

it("records a real signal instead of fabricating a successful status", async () => {
  const child = spawn(process.execPath, ["-e", "process.stderr.write('ready\\n');setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const diagnostics = captureOwnedBrowserDiagnostics(child, temporary(), source);
  try {
    await new Promise<void>((resolve) => child.stderr.once("data", () => resolve()));
    child.kill("SIGKILL");
    await diagnostics.finalize();
    expect(JSON.parse(readFileSync(diagnostics.metadataPath, "utf8"))).toMatchObject({
      status: null,
      signal: "SIGKILL",
      processCloseObserved: true,
      diagnosticFailure: false,
    });
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
});

it("records spawn failure without persisting its executable or error message", async () => {
  const child = spawn(join(temporary(), "PRIVATE_EXECUTABLE"), [], { stdio: ["ignore", "ignore", "pipe"] });
  const diagnostics = captureOwnedBrowserDiagnostics(child, temporary(), source);
  await diagnostics.finalize();
  const text = readFileSync(diagnostics.metadataPath, "utf8");
  expect(JSON.parse(text)).toMatchObject({ launchErrorCode: "ENOENT", processCloseObserved: true });
  expect(text).not.toContain("PRIVATE_EXECUTABLE");
});

it("refuses to overwrite an existing diagnostic file and surfaces failed output", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.stderr.write('native\\n'),50)"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const diagnostics = captureOwnedBrowserDiagnostics(child, temporary(), source);
  writeFileSync(diagnostics.logPath, "original evidence");
  await expect(diagnostics.finalize()).rejects.toMatchObject({ code: "EEXIST" });
  expect(readFileSync(diagnostics.logPath, "utf8")).toBe("original evidence");
});

it("retains an explicitly incomplete artifact when a child keeps its stream open beyond the drain bound", async () => {
  const child = spawn(process.execPath, ["-e", "process.stderr.write('still alive\\n');setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const diagnostics = captureOwnedBrowserDiagnostics(child, temporary(), source);
  try {
    await expect(diagnostics.finalize()).rejects.toThrow("did not complete");
    expect(JSON.parse(readFileSync(diagnostics.metadataPath, "utf8"))).toMatchObject({
      status: null,
      signal: null,
      processCloseObserved: false,
      stderrEnded: false,
      diagnosticFailure: true,
    });
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
});

// DM-3NDNF2: failure-only Playwright launch-scout close evidence.
const scoutChild = (script: string) => spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
const exited = (child: ReturnType<typeof scoutChild>) =>
  new Promise<void>((done) =>
    child.exitCode != null || child.signalCode != null ? done() : child.once("close", () => done()),
  );
const scoutMetadata = (directory: string) => {
  const files = readdirSync(directory).sort();
  expect(files).toHaveLength(2);
  return {
    log: readFileSync(join(directory, files[0]!), "utf8"),
    metadata: JSON.parse(readFileSync(join(directory, files[1]!), "utf8")),
  };
};
const untilEndsWith = (stream: Readable, last: string) =>
  new Promise<void>((done) => {
    let text = "";
    const seen = (chunk: Buffer): void => {
      text += chunk.toString("utf8");
      if (!text.endsWith(last)) return;
      stream.off("data", seen);
      done();
    };
    stream.on("data", seen);
  });
const STALLED =
  "process.stdout.write('scout ready\\n');process.stderr.write('Authorization: HEADER_SECRET\\nSECRET_TOKEN=ENV_SECRET\\nDevTools listening on ws://127.0.0.1:1/devtools/browser/ENDPOINT_SECRET\\nstill closing\\n');setInterval(()=>{},1000)";

it("writes nothing and keeps the child untouched when the scout closes in time", async () => {
  const directory = temporary();
  const child = scoutChild("process.stderr.write('bye\\n')");
  const evidence = observeScoutClose(child, directory, source, "case");
  evidence.requested();
  await exited(child);
  evidence.dispose();
  await evidence.fail("resolved"); // Disposed observers stay inert even if a caller later fails.
  expect(child.listenerCount("close")).toBe(0);
  expect(readdirSync(directory)).toEqual([]);
});

it("is a no-op without an opt-in directory", async () => {
  const child = scoutChild("");
  const before = child.listenerCount("close");
  const evidence = observeScoutClose(child, undefined, source);
  expect(child.listenerCount("close")).toBe(before);
  evidence.requested();
  await evidence.fail("resolved");
  await exited(child);
});

it("retains filtered output, close request, deadline, exit and post-kill outcome after a stalled close", async () => {
  const directory = temporary();
  const child = scoutChild(STALLED);
  const evidence = observeScoutClose(child, directory, source, "suite > stalled case");
  evidence.requested();
  evidence.expired();
  // Kill only after both streams emitted their last line; a fixed delay raced a loaded host.
  await Promise.all([untilEndsWith(child.stdout, "scout ready\n"), untilEndsWith(child.stderr, "still closing\n")]);
  child.kill("SIGKILL");
  await exited(child);
  await evidence.fail("resolved");
  await evidence.fail("rejected"); // Idempotent: the first outcome is immutable.
  const { log, metadata } = scoutMetadata(directory);
  expect(log).toBe("scout ready\nstill closing\n");
  expect(metadata).toMatchObject({
    schema: "domotion-scout-close-v3",
    sourceCommit: source,
    diagnosticCase: "suite > stalled case",
    processId: child.pid,
    hostProcessId: process.pid,
    status: null,
    signal: "SIGKILL",
    postKill: "resolved",
    exitObserved: true,
    stdoutPiped: true,
    stderrPiped: true,
    sensitiveLines: 2,
    endpointLines: 1,
    outputBeforeAttachmentObserved: false,
    truncated: false,
    filteredStreamSha256: createHash("sha256").update(log).digest("hex"),
  });
  expect(metadata.closeRequestedAtMs).toBeLessThanOrEqual(metadata.deadlineAtMs);
  // The deadline is stamped before the kill; the kill settles after the process exited.
  expect(metadata.deadlineAtMs).toBeLessThanOrEqual(metadata.exitAtMs);
  expect(metadata.killSettledAtMs).toBeGreaterThanOrEqual(metadata.exitAtMs);
  expect(metadata.closeAtMs).not.toBeNull();
  expect(JSON.stringify(metadata) + log).not.toMatch(/SECRET|127\.0\.0\.1/);
});

it("records a close that lands after the deadline was reported", async () => {
  const directory = temporary();
  const child = scoutChild(STALLED);
  const evidence = observeScoutClose(child, directory, source);
  evidence.requested();
  evidence.expired();
  const failed = evidence.fail("rejected");
  setTimeout(() => child.kill("SIGKILL"), 200);
  await failed;
  const { metadata } = scoutMetadata(directory);
  expect(metadata.postKill).toBe("rejected");
  expect(metadata.closeAtMs).toBeGreaterThan(metadata.deadlineAtMs);
  expect(metadata.diagnosticCase).toBeNull();
});

it("bounds the post-kill wait and records absent exit and close as unknown", async () => {
  const directory = temporary();
  const child = scoutChild(STALLED);
  try {
    const evidence = observeScoutClose(child, directory, "not-a-sha");
    const started = Date.now();
    await evidence.fail("resolved");
    expect(Date.now() - started).toBeLessThan(4_000);
    const { metadata } = scoutMetadata(directory);
    expect(metadata).toMatchObject({
      sourceCommit: null,
      closeRequestedAtMs: null,
      deadlineAtMs: null,
      exitAtMs: null,
      closeAtMs: null,
      exitObserved: false,
    });
    expect(child.listenerCount("close")).toBe(0);
  } finally {
    child.kill("SIGKILL");
    await exited(child);
  }
});

it("reports evidence storage failure to the caller without retaining listeners", async () => {
  const parent = temporary();
  const blocked = join(parent, "file");
  writeFileSync(blocked, "");
  const child = scoutChild("");
  const evidence = observeScoutClose(child, join(blocked, "logs"), source);
  await exited(child);
  await expect(evidence.fail("resolved")).rejects.toThrow();
  expect(child.listenerCount("close")).toBe(0);
});

// DM-Q1CW1H: a bounded native sample of a stalled scout, taken before the kill.
const SAMPLE_REPORT = [
  "Analysis of sampling Chromium (pid 42) every 1 millisecond",
  "Process:         Chromium [42]",
  "Path:            /Users/someone/Library/Caches/ms-playwright/chromium/Chromium.app/Contents/MacOS/Chromium",
  "Parent Process:  node [41]",
  "",
  "Call graph:",
  "    883 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)",
  "      883 ChromeMain  (in Chromium Framework) + 12  [0x1]",
  "        883 base::WaitableEvent::Wait  /private/var/folders/xy/T/build/waitable_event.cc:42  [0x2]",
  "      SECRET_TOKEN=ENV_SECRET",
  "",
  "Sort by top of stack, same collapsed (when >= 5):",
  "        __psynch_cvwait  (in libsystem_kernel.dylib)        883",
  "",
  "Binary Images:",
  "       0x1 -        0x2 +Chromium (1) <UUID> /Users/someone/Chromium.app/Contents/MacOS/Chromium",
  "",
].join("\n");

const sampledScout = (directory: string) => {
  const files = readdirSync(directory).sort();
  const metadataFile = files.find((file) => file.endsWith(".log.json"))!;
  const sampleFile = files.find((file) => file.endsWith(".sample.txt"));
  return {
    files,
    metadata: JSON.parse(readFileSync(join(directory, metadataFile), "utf8")),
    sample: sampleFile == null ? undefined : readFileSync(join(directory, sampleFile), "utf8"),
  };
};

async function stalledScoutWith(sampler: NativeSampler, sampleTimeoutMs = 1_000) {
  const directory = temporary();
  const child = scoutChild(STALLED);
  const evidence = observeScoutClose(child, directory, source, "case", undefined, sampler, sampleTimeoutMs);
  evidence.requested();
  evidence.expired();
  const started = Date.now();
  await evidence.sample();
  const sampleMs = Date.now() - started;
  child.kill("SIGKILL");
  await exited(child);
  await evidence.fail("resolved");
  return { directory, child, sampleMs, ...sampledScout(directory) };
}

it("keeps only the scrubbed call graph of a sample report", () => {
  const graph = sampleCallGraph(SAMPLE_REPORT);
  expect(graph.startsWith("Call graph:\n")).toBe(true);
  expect(graph).toContain("base::WaitableEvent::Wait  <path>  [0x2]");
  expect(graph).toContain("__psynch_cvwait");
  expect(graph).not.toMatch(/Binary Images|Parent Process|Path:|someone|\/private/);
  expect(sampleCallGraph("no graph here")).toBe("");
});

it("retains a filtered, bounded call graph from the sampler before the kill", async () => {
  const pids: number[] = [];
  const { child, files, metadata, sample } = await stalledScoutWith(async (pid) => {
    pids.push(pid);
    return SAMPLE_REPORT;
  });
  expect(pids).toEqual([child.pid]);
  expect(files).toHaveLength(3);
  expect(sample).toContain("ChromeMain  (in Chromium Framework)");
  expect(sample).not.toMatch(/SECRET|Binary Images|someone/);
  expect(metadata.schema).toBe("domotion-scout-close-v3");
  expect(metadata.sample).toMatchObject({
    status: "captured",
    sensitiveLines: 1,
    truncated: false,
    file: expect.stringMatching(/^scout-.*\.log\.sample\.txt$/),
  });
  expect(metadata.sample.retainedBytes).toBe(Buffer.byteLength(sample!));
});

it("records a sampler that outlives its bound as a timeout without delaying the kill further", async () => {
  const { sampleMs, metadata, sample } = await stalledScoutWith(() => new Promise<string>(() => undefined), 200);
  expect(sampleMs).toBeLessThan(1_500);
  expect(metadata.sample).toMatchObject({ status: "timeout", timeoutMs: 200, file: null, retainedBytes: 0 });
  expect(sample).toBeUndefined();
});

it("records sampler failure and an unsupported platform without throwing", async () => {
  const failed = await stalledScoutWith(() => Promise.reject(new Error("controlled sampler failure /Users/x")));
  expect(failed.metadata.sample).toMatchObject({ status: "failed", file: null });
  expect(JSON.stringify(failed.metadata)).not.toContain("controlled sampler failure");
  const unsupported = await stalledScoutWith(() => Promise.resolve(null));
  expect(unsupported.metadata.sample).toMatchObject({ status: "unsupported", file: null });
});

it("does not sample a scout that closed in time, nor record one never asked for", async () => {
  const directory = temporary();
  const sampler = vi.fn<NativeSampler>(() => Promise.resolve(SAMPLE_REPORT));
  const child = scoutChild("process.stderr.write('bye\\n')");
  const evidence = observeScoutClose(child, directory, source, "case", undefined, sampler);
  evidence.requested();
  await exited(child);
  evidence.dispose();
  await evidence.sample();
  expect(sampler).not.toHaveBeenCalled();
  expect(readdirSync(directory)).toEqual([]);

  const stalled = scoutChild(STALLED);
  const unsampled = observeScoutClose(stalled, directory, source, "case", undefined, sampler);
  stalled.kill("SIGKILL");
  await exited(stalled);
  await unsampled.fail("resolved");
  expect(sampledScout(directory).metadata.sample).toEqual({ status: "not-requested" });
});

it.runIf(process.platform === "darwin")("samples a real stalled process with macOS sample", async () => {
  const { metadata, sample } = await stalledScoutWith(nativeSampler, 10_000);
  expect(metadata.sample.status).toBe("captured");
  expect(sample).toMatch(/^Call graph:\n/);
  expect(sample).toMatch(/Thread_\d+/);
  expect(sample).not.toMatch(/Binary Images|\/Users\//);
});
