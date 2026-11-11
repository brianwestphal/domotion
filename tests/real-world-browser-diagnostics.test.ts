import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { captureOwnedBrowserDiagnostics, observeScoutClose } from "./real-world-browser-diagnostics.js";

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
    schema: "domotion-scout-close-v2",
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
