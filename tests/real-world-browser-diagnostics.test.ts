import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureOwnedBrowserDiagnostics } from "./real-world-browser-diagnostics.js";

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
