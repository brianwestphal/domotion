import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  createBoundedCapture,
  createNativeLogFilter,
  NATIVE_LOG_MAX_BYTES,
  runWithNativeLog,
} from "../scripts/e2e-native-logs.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function temporary() {
  const path = mkdtempSync(join(tmpdir(), "domotion-native-log-"));
  directories.push(path);
  return path;
}
function sink(delay = 0) {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      if (delay) setTimeout(done, delay);
      else done();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString() };
}

it.each([0, 1, 7, 8, 9, 100_000])("bounds a %i-byte stream without losing prefix/suffix order", (size) => {
  const input = Buffer.from(Array.from({ length: size }, (_, i) => i % 256));
  const capture = createBoundedCapture(8);
  for (let offset = 0; offset < input.length; offset += 3) capture.append(input.subarray(offset, offset + 3));
  const result = capture.finish();
  expect(result.totalBytes).toBe(size);
  expect(result.retainedBytes).toBe(Math.min(8, size));
  expect(result.omittedBytes).toBe(Math.max(0, size - 8));
  expect(result.sha256).toBe(createHash("sha256").update(input).digest("hex"));
  if (size <= 8) expect(result.data).toEqual(input);
  else {
    expect(result.data.subarray(0, 4)).toEqual(input.subarray(0, 4));
    expect(result.data.subarray(-4)).toEqual(input.subarray(-4));
    expect(result.data.length).toBeLessThan(8 + 128);
  }
  expect(() => capture.append(Buffer.from("late"))).toThrow("finalized");
  expect(() => capture.finish()).toThrow("finalized");
});

it("retains an odd-sized bound across a single huge chunk and later refill", () => {
  const input = Buffer.from("0123456789".repeat(10_000) + "after");
  const capture = createBoundedCapture(7);
  capture.append(input.subarray(0, input.length - 5));
  capture.append(input.subarray(-5));
  const result = capture.finish();
  expect(result.data.subarray(0, 4).toString()).toBe("0123");
  expect(result.data.subarray(-3).toString()).toBe("ter");
});

it.each([0, 1, -1, Infinity, 2.5, NATIVE_LOG_MAX_BYTES + 1])("rejects invalid byte bound %s", (bound) => {
  expect(() => createBoundedCapture(bound)).toThrow("invalid");
});

it("filters split launch arguments and header/environment dumps before any forwarding", () => {
  const chunks: Buffer[] = [];
  const filter = createNativeLogFilter((chunk) => chunks.push(chunk));
  const text =
    "2026 pw:browser <launching> chromium --private=ARG_SECRET\n" +
    "  - <launching> copied failed launch --secret=SECOND_SECRET\n" +
    'pw:browser [pid=1][err] {"headers":{"Authorization":"HEADER_SECRET"}}\n' +
    "Authorization: HEADER_SECRET\n" +
    "X-Api-Key: HEADER_SECRET\n" +
    'env: {API_KEY:"ENV_SECRET"}\n' +
    "AWS_SECRET_ACCESS_KEY=ENV_SECRET\n" +
    "pw:browser [pid=1][err] Context reset detected after MakeCurrent.\n";
  for (const byte of Buffer.from(text)) filter.append(Buffer.from([byte]));
  const counts = filter.finish();
  expect(Buffer.concat(chunks).toString()).toBe("pw:browser [pid=1][err] Context reset detected after MakeCurrent.\n");
  expect(counts).toMatchObject({
    launchLines: 2,
    sensitiveLines: 5,
    oversizedLines: 0,
    inputBytes: Buffer.byteLength(text),
  });
  expect(() => filter.append(Buffer.from("late"))).toThrow("finalized");
});

it("bounds a partial line, drops it whole, then preserves UTF-8 and an unterminated tail", () => {
  const chunks: Buffer[] = [];
  const filter = createNativeLogFilter((chunk) => chunks.push(chunk));
  filter.append(Buffer.from("x".repeat(70_000)));
  filter.append(Buffer.from("SECRET\n"));
  const native = Buffer.from("pw:browser [pid=3][err] reset → lost\nlast native error");
  for (const byte of native) filter.append(Buffer.from([byte]));
  expect(filter.finish().oversizedLines).toBe(1);
  expect(Buffer.concat(chunks)).toEqual(native);
});

it("retains only filtered bytes and no executable arguments/environment metadata", async () => {
  const path = join(temporary(), "lane.log");
  const output = sink();
  const source = `if(process.env.DEBUG!=='pw:browser')process.exitCode=9;process.stderr.write('pw:browser <launching> --key=ARG_SECRET\\nAuthorization: HEADER_SECRET\\npw:browser [pid=1][err] native context lost\\n')`;
  const result = await runWithNativeLog(process.execPath, ["-e", source, "ARG_SECRET"], {
    lane: "all",
    logPath: path,
    forward: output.stream,
    env: { ...process.env, LOGGER_PRIVATE: "ENV_SECRET", DEBUG: "pw:*" },
  });
  expect(result.status).toBe(0);
  expect(result.error).toBeUndefined();
  expect(result.diagnosticError).toBeUndefined();
  expect(readFileSync(path, "utf8")).toBe("pw:browser [pid=1][err] native context lost\n");
  expect(output.text()).toBe(readFileSync(path, "utf8"));
  const metadata = readFileSync(`${path}.json`, "utf8");
  expect(metadata).not.toMatch(/ARG_SECRET|ENV_SECRET|HEADER_SECRET|executable|argv|environment/);
  expect(JSON.parse(metadata)).toMatchObject({
    status: 0,
    signal: null,
    launchLines: 1,
    sensitiveLines: 1,
    truncated: false,
  });
});

it("preserves real child nonzero status and records it", async () => {
  const path = join(temporary(), "failed.log");
  const result = await runWithNativeLog(
    process.execPath,
    ["-e", "process.stderr.write('native failed\\n');process.exitCode=17"],
    { lane: "regular", logPath: path, forward: sink().stream },
  );
  expect(result.status).toBe(17);
  expect(result.error).toBeUndefined();
  expect(JSON.parse(readFileSync(`${path}.json`, "utf8"))).toMatchObject({ status: 17, signal: null });
});

it("preserves a launch failure and records its code without spawn arguments", async () => {
  const directory = temporary();
  const path = join(directory, "absent.log");
  const result = await runWithNativeLog(join(directory, "missing-program"), ["ARG_SECRET"], {
    lane: "all",
    logPath: path,
    forward: sink().stream,
  });
  expect((result.error as NodeJS.ErrnoException).code).toBe("ENOENT");
  const metadata = readFileSync(`${path}.json`, "utf8");
  expect(JSON.parse(metadata).launchErrorCode).toBe("ENOENT");
  expect(metadata).not.toContain("ARG_SECRET");
});

it("does not treat child signal termination as success", async () => {
  const path = join(temporary(), "signal.log");
  const result = await runWithNativeLog(process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"], {
    lane: "all",
    logPath: path,
    forward: sink().stream,
  });
  expect(result.signal !== null || result.status !== 0).toBe(true);
  if (process.platform !== "win32") {
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  }
});

it("forwards under backpressure while keeping retention bounded", async () => {
  const path = join(temporary(), "bounded.log");
  const output = sink(1);
  const text = "native error line\n".repeat(100);
  const result = await runWithNativeLog(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(text)})`], {
    lane: "all",
    logPath: path,
    forward: output.stream,
    maxBytes: 64,
  });
  expect(result.status).toBe(0);
  expect(result.diagnosticError).toBeUndefined();
  expect(output.text()).toBe(text);
  expect(readFileSync(path).length).toBeLessThan(64 + 128);
  expect(JSON.parse(readFileSync(`${path}.json`, "utf8"))).toMatchObject({
    truncated: true,
    totalBytes: Buffer.byteLength(text),
    retainedBytes: 64,
  });
  expect(output.stream.listenerCount("drain")).toBe(0);
});

it("fails and closes the child when the forwarding destination fails", async () => {
  const path = join(temporary(), "sink-error.log");
  const forward = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error("controlled sink failure"));
    },
  });
  const result = await runWithNativeLog(
    process.execPath,
    ["-e", "process.stderr.write('native error\\n');setInterval(()=>{},1000)"],
    { lane: "all", logPath: path, forward },
  );
  expect(result.diagnosticError?.message).toBe("controlled sink failure");
  expect(result.status !== 0 || result.signal !== null).toBe(true);
});

it.each([0, 17])("keeps actual child status %i when artifact persistence fails", async (status) => {
  const path = temporary();
  const result = await runWithNativeLog(process.execPath, ["-e", `process.exitCode=${status}`], {
    lane: "all",
    logPath: path,
    forward: sink().stream,
  });
  expect(result.status).toBe(status);
  expect(result.diagnosticError).toBeInstanceOf(Error);
});

const runner = fileURLToPath(new URL("../scripts/run-e2e-tests.mjs", import.meta.url));
function fakeVitest(directory: string) {
  const modules = join(directory, "node_modules", "vitest");
  mkdirSync(modules, { recursive: true });
  writeFileSync(
    join(modules, "vitest.mjs"),
    `import {appendFileSync} from 'node:fs';appendFileSync(process.env.CALLS,process.env.DOMOTION_E2E_LANE+'\\n');if(process.env.DEBUG==='pw:browser')process.stderr.write('pw:browser <launching> --key=ARG_SECRET\\npw:browser [pid=1][err] native marker\\n');process.exitCode=process.env.DOMOTION_E2E_LANE==='heavy'?17:0;`,
  );
}

it.each([false, true])("preserves lane sequencing and failure status (logs %s)", (enabled) => {
  const directory = temporary();
  fakeVitest(directory);
  const calls = join(directory, "calls.txt");
  const env: NodeJS.ProcessEnv = { ...process.env, CALLS: calls };
  delete env.DEBUG;
  if (enabled) env.DOMOTION_E2E_NATIVE_LOG_DIR = join(directory, "logs");
  else delete env.DOMOTION_E2E_NATIVE_LOG_DIR;
  const result = spawnSync(process.execPath, [runner], { cwd: directory, env, encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(17);
  expect(readFileSync(calls, "utf8")).toBe("regular\nheavy\n");
  if (enabled) {
    expect(result.stderr).not.toContain("ARG_SECRET");
    expect(readFileSync(join(directory, "logs", "heavy-native.log.json"), "utf8")).toContain('"status": 17');
  }
});

it("uses one serial filtered lane with diagnostics", () => {
  const directory = temporary();
  fakeVitest(directory);
  const calls = join(directory, "calls.txt");
  const result = spawnSync(process.execPath, [runner, "tests/only.e2e.test.ts"], {
    cwd: directory,
    env: { ...process.env, CALLS: calls, DOMOTION_E2E_NATIVE_LOG_DIR: join(directory, "logs") },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(calls, "utf8")).toBe("all\n");
});

// Node emulates kill(SIGTERM) on Windows as unconditional termination, so no
// parent callback can finalize there (nodejs.org/api/process.html#signal-events).
it.skipIf(process.platform === "win32")(
  "restores catchable parent signal semantics after finalizing diagnostics",
  async () => {
    const directory = temporary();
    const modules = join(directory, "node_modules", "vitest");
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, "vitest.mjs"), "process.stderr.write('NATIVE_READY\\n');setInterval(()=>{},1000)");
    const child = spawn(process.execPath, [runner, "one"], {
      cwd: directory,
      env: { ...process.env, DOMOTION_E2E_NATIVE_LOG_DIR: join(directory, "logs") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("signal fixture exceeded 8s"));
      }, 8_000);
      child.stderr.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("NATIVE_READY")) child.kill("SIGTERM");
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    expect(outcome.signal !== null || outcome.code !== 0).toBe(true);
    expect(JSON.parse(readFileSync(join(directory, "logs", "all-native.log.json"), "utf8"))).toMatchObject({
      interruptedBy: "SIGTERM",
    });
  },
);
