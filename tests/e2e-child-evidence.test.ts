import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserStderrRegistry, writeScreenshotFailureEvidence } from "./e2e-browser-evidence.js";
import { CHILD_EVIDENCE_FLAG, configureChildBrowserEvidence } from "./e2e-child-evidence.js";
import {
  CHILD_EVIDENCE_FLAG as TAP_FLAG,
  SCREENSHOT_CAPTURE_FAILURE as TAP_FAILURE,
  evidenceDirectory as tapEvidenceDirectory,
  installChildBrowserEvidence,
  tapPlaywrightBrowsers,
  writeChildEvidence,
} from "./e2e-child-evidence-tap.mjs";
import { SCREENSHOT_CAPTURE_FAILURE, evidenceDirectory } from "./e2e-browser-evidence.js";

const FAILURE = "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot";
const PRELOAD = "file:///repo/tests/e2e-child-evidence-preload.mjs";

function steppingClock(start = Date.UTC(2026, 10, 20, 12, 0, 0)): () => Date {
  let now = start;
  return () => new Date((now += 1_000));
}

describe("configureChildBrowserEvidence", () => {
  it("opts children in with an absolute preload import", () => {
    const env: NodeJS.ProcessEnv = { DOMOTION_E2E_EVIDENCE_DIR: "relative/dir" };
    configureChildBrowserEvidence(env, PRELOAD);
    expect(env[CHILD_EVIDENCE_FLAG]).toBe("1");
    expect(env["DOMOTION_E2E_EVIDENCE_DIR"]).toBe(resolve("relative/dir"));
    expect(env["NODE_OPTIONS"]).toBe(`--import "${PRELOAD}"`);
  });

  it("appends to existing NODE_OPTIONS and is idempotent", () => {
    const env: NodeJS.ProcessEnv = { NODE_OPTIONS: "--max-old-space-size=4096" };
    configureChildBrowserEvidence(env, PRELOAD);
    configureChildBrowserEvidence(env, PRELOAD);
    expect(env["NODE_OPTIONS"]).toBe(`--max-old-space-size=4096 --import "${PRELOAD}"`);
  });

  it("quotes paths with spaces and escapes quotes and backslashes", () => {
    const env: NodeJS.ProcessEnv = {};
    configureChildBrowserEvidence(env, 'C:\\a b\\"x".mjs');
    expect(env["NODE_OPTIONS"]).toBe('--import "C:\\\\a b\\\\\\"x\\".mjs"');
  });

  it("defaults the evidence directory like the worker does", () => {
    const env: NodeJS.ProcessEnv = { DOMOTION_OUTPUT_DIR: "out-linux" };
    configureChildBrowserEvidence(env, PRELOAD);
    expect(env["DOMOTION_E2E_EVIDENCE_DIR"]).toBe(resolve("out-linux", "e2e-browser-evidence"));
  });

  // A bare Windows absolute path in `--import` parses as a URL whose scheme is
  // the drive letter, so every Node child exited with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME; the owned review and scrubber servers
  // died before reporting ready on the Windows runner.
  it("names the real preload by its file: URL, never a bare path", () => {
    const env: NodeJS.ProcessEnv = {};
    configureChildBrowserEvidence(env);
    const specifier = /^--import "([^"]*)"$/.exec(env["NODE_OPTIONS"] ?? "")?.[1] ?? "";
    expect(specifier).toMatch(/^file:\/\/\/.*\/tests\/e2e-child-evidence-preload\.mjs$/);
    expect(new URL(specifier).protocol).toBe("file:");
  });
});

describe("the plain-JS tap mirrors the worker module", () => {
  it("shares the flag, failure pattern and directory rule", () => {
    expect(TAP_FLAG).toBe(CHILD_EVIDENCE_FLAG);
    expect(TAP_FAILURE.source).toBe(SCREENSHOT_CAPTURE_FAILURE.source);
    for (const env of [{}, { DOMOTION_OUTPUT_DIR: "o" }, { DOMOTION_E2E_EVIDENCE_DIR: "e" }])
      expect(tapEvidenceDirectory(env)).toBe(evidenceDirectory(env));
  });

  it("writes the same dump layout as writeScreenshotFailureEvidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "dm-child-format-"));
    try {
      const worker = readFileSync(
        writeScreenshotFailureEvidence(
          { name: "child: x", file: "f", attempt: 0, message: FAILURE },
          { registry: new BrowserStderrRegistry(), directory, clock: steppingClock(), lane: "regular" },
        ),
        "utf8",
      );
      const child = readFileSync(
        writeChildEvidence({
          name: "child: x",
          file: "f",
          message: FAILURE,
          records: [],
          directory,
          lane: "regular",
          pid: process.pid,
          clock: steppingClock(),
        }),
        "utf8",
      );
      // Only the host sample (live numbers) may differ.
      const strip = (text: string) => text.replace(/^host: .*$/m, "host: <sample>");
      expect(strip(child)).toBe(strip(worker));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

class FakeStream {
  readonly written: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }
}

/** A process whose standard streams are lazy getters, like Node's. */
class FakeProcess extends EventEmitter {
  readonly pid = 4242;
  readonly argv = ["/usr/bin/node", "/repo/dist/cli/svg-to-image.js", "in.svg"];
  readonly created: string[] = [];
  readonly streams = { stdout: new FakeStream(), stderr: new FakeStream() };
  declare readonly stdout: FakeStream;
  declare readonly stderr: FakeStream;
  constructor(readonly env: NodeJS.ProcessEnv) {
    super();
    for (const name of ["stdout", "stderr"] as const)
      Object.defineProperty(this, name, {
        configurable: true,
        enumerable: true,
        get: () => {
          this.created.push(name);
          return this.streams[name];
        },
      });
  }
}

class FakeChild extends EventEmitter {
  stderr: PassThrough | null = new PassThrough();
  constructor(readonly pid: number | undefined) {
    super();
  }
}

const noSpawn = { spawn: (() => new EventEmitter() as ChildProcess) as (...args: never[]) => ChildProcess };

describe("installChildBrowserEvidence", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  function setup() {
    const directory = mkdtempSync(join(tmpdir(), "dm-child-evidence-"));
    directories.push(directory);
    const proc = new FakeProcess({ DOMOTION_E2E_EVIDENCE_DIR: directory, DOMOTION_E2E_LANE: "regular" });
    const handle = installChildBrowserEvidence(proc, noSpawn);
    return { directory, proc, handle };
  }

  it("does not create the standard streams until the child uses them", () => {
    const { proc } = setup();
    expect(proc.created).toEqual([]);
    proc.stdout.write("x");
    expect(proc.created).toEqual(["stdout"]);
    proc.stdout.write("y");
    expect(proc.created).toEqual(["stdout"]);
    expect(proc.streams.stdout.written).toEqual(["x", "y"]);
  });

  it("writes one evidence file at exit after the child printed the failure, and passes output through", () => {
    const { directory, proc, handle } = setup();
    proc.stdout.write("progress\n");
    proc.stderr.write(Buffer.from(`${FAILURE}\nCall log:\n`));
    expect(proc.streams.stderr.written[0]).toContain(FAILURE);
    expect(handle.matched()).toContain(FAILURE);
    proc.emit("exit", 1);
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(directory, files[0]!), "utf8");
    expect(text).toContain("test: child: /repo/dist/cli/svg-to-image.js in.svg");
    expect(text).toContain("lane: regular");
    expect(text).toContain("(no Playwright-launched Chromium recorded in this worker)");
    expect(proc.streams.stderr.written.at(-1)).toMatch(
      /^\[e2e-evidence\] child pid 4242: Unable to capture screenshot/,
    );
    expect(handle.flush()).toBe(join(directory, files[0]!));
    expect(readdirSync(directory)).toHaveLength(1);
  });

  it("matches the failure on stdout too", () => {
    const { directory, proc } = setup();
    proc.stdout.write(FAILURE);
    proc.emit("exit", 1);
    expect(readdirSync(directory)).toHaveLength(1);
  });

  it("writes nothing when the child never printed the failure", () => {
    const { directory, proc, handle } = setup();
    proc.stderr.write("Error: something else\n");
    proc.emit("exit", 1);
    expect(handle.matched()).toBeUndefined();
    expect(handle.flush()).toBeUndefined();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("keeps the exit path quiet when the evidence directory cannot be written", () => {
    const proc = new FakeProcess({ DOMOTION_E2E_EVIDENCE_DIR: "/dev/null/not-a-directory" });
    const handle = installChildBrowserEvidence(proc, noSpawn);
    proc.stderr.write(FAILURE);
    expect(() => proc.emit("exit", 1)).not.toThrow();
    expect(handle.flush()).toBeUndefined();
  });
});

describe("tapPlaywrightBrowsers", () => {
  it("records only Chromium spawned by the launcher, with stamped stderr and exit", () => {
    const children: FakeChild[] = [];
    const host = {
      spawn: ((command: string) => {
        const child = new FakeChild(children.length + 10);
        children.push(child);
        void command;
        return child as unknown as ChildProcess;
      }) as unknown as (...args: never[]) => ChildProcess,
    };
    let launcher = true;
    const records = tapPlaywrightBrowsers(host, steppingClock(), () => launcher);
    host.spawn(...(["/x/chrome-headless-shell"] as never[]));
    host.spawn(...(["/usr/bin/ffmpeg"] as never[]));
    launcher = false;
    host.spawn(...(["/x/chrome"] as never[]));
    expect(records()).toHaveLength(1);
    children[0]!.stderr!.write("line one\npart");
    children[0]!.emit("close", 0, null);
    const [record] = records();
    expect(record!.exit).toBe("code=0");
    const lines = record!.ring.snapshot().lines;
    expect(lines.map((line) => line.replace(/^\S+ /, ""))).toEqual([
      "[evidence] spawned chrome-headless-shell pid=10",
      "line one",
      "part",
      "[evidence] exited code=0",
    ]);
  });
});
