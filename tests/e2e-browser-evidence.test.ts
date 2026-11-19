import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_HOST_TRANSIENT_RETRY } from "./e2e-lanes.js";
import {
  BrowserStderrRegistry,
  SCREENSHOT_CAPTURE_FAILURE,
  StampedLineRing,
  errorMessages,
  evidenceDirectory,
  formatHostSample,
  hostSampleIntervalMs,
  hostSamplerEnabled,
  installPlaywrightBrowserStderrTap,
  isChromiumExecutable,
  recordScreenshotFailureEvidence,
  sampleHost,
  spawnedByPlaywrightLauncher,
  startHostSampler,
  type HostSample,
} from "./e2e-browser-evidence.js";

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;
const SCREENSHOT_ERROR = "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot";

function steppingClock(start = Date.UTC(2026, 10, 19, 12, 0, 0)): () => Date {
  let now = start;
  return () => new Date((now += 1_000));
}

class FakeChild extends EventEmitter {
  stderr: PassThrough | null = new PassThrough();
  constructor(readonly pid: number | undefined) {
    super();
  }
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

const FIXED_HOST: HostSample = {
  at: "2026-11-19T12:00:00.000Z",
  loadavg: [3.5, 2.25, 1],
  cpus: 3,
  freeMemBytes: 512 * 1024 * 1024,
  totalMemBytes: 7 * 1024 * 1024 * 1024,
  tmpDir: "/tmp",
  tmpFreeBytes: 10 * 1024 * 1024 * 1024,
  tmpTotalBytes: 20 * 1024 * 1024 * 1024,
};

const temporary: string[] = [];
function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "dm-e2e-evidence-"));
  temporary.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("StampedLineRing", () => {
  it("stamps complete lines, carries partial chunks, and keeps only the newest lines", () => {
    const ring = new StampedLineRing(3, steppingClock());
    ring.append("first\nsec");
    expect(ring.snapshot()).toMatchObject({ lines: [expect.stringMatching(/ first$/)], pending: "sec" });
    ring.append("ond\r\nthird\nfourth\n");
    const snap = ring.snapshot();
    expect(snap.lines.map((line) => line.replace(STAMP, ""))).toEqual(["second", "third", "fourth"]);
    expect(snap.dropped).toBe(1);
    for (const line of snap.lines) expect(line).toMatch(STAMP);
  });

  it("stamps an unterminated tail on flush and cuts oversized lines", () => {
    const ring = new StampedLineRing(10, steppingClock(), 8);
    ring.append("tail-without-newline");
    // The unterminated chunk is already longer than a line may be, so it is stamped now.
    expect(ring.snapshot().lines).toHaveLength(1);
    expect(ring.snapshot().lines[0]).toMatch(/ tail-wit \[20 chars, cut\]$/);
    ring.append("x");
    ring.flush();
    ring.flush();
    expect(ring.snapshot().lines.at(-1)).toMatch(/ x$/);
    expect(ring.snapshot()).toMatchObject({ pending: "" });
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new StampedLineRing(0)).toThrow(/positive integer/);
  });
});

describe("BrowserStderrRegistry", () => {
  it("records live browsers, then retains only the newest exited ones", () => {
    const registry = new BrowserStderrRegistry(steppingClock(), 2, 50);
    const children = [101, 102, 103, 104].map((pid) => new FakeChild(pid));
    for (const child of children) registry.track(child.asChild(), "/ms-playwright/chromium/chrome-headless-shell");
    children[0]!.stderr!.write("[0101/1:ERROR:viz] copy output empty\n");
    expect(registry.records().map((record) => record.pid)).toEqual([101, 102, 103, 104]);

    children[0]!.emit("close", 1, null);
    children[1]!.emit("close", null, "SIGKILL");
    children[2]!.emit("close", 0, null);
    const records = registry.records();
    expect(records.map((record) => record.pid)).toEqual([104, 103, 102]);
    expect(records[2]).toMatchObject({ exit: "signal=SIGKILL", executable: "chrome-headless-shell" });
    expect(records[1]!.ring.snapshot().lines.at(-1)).toMatch(/\[evidence\] exited code=0$/);
  });

  it("decodes stderr privately and notes a browser whose stderr is not piped", () => {
    const registry = new BrowserStderrRegistry(steppingClock());
    const piped = new FakeChild(7);
    registry.track(piped.asChild(), "chrome");
    // A multi-byte character split across chunks decodes intact.
    const bytes = Buffer.from("surface \u00e9victed\n");
    piped.stderr!.write(bytes.subarray(0, 10));
    piped.stderr!.write(bytes.subarray(10));
    expect(piped.stderr!.readableEncoding).toBeNull();
    expect(registry.records()[0]!.ring.snapshot().lines.at(-1)).toMatch(/ surface \u00e9victed$/);

    const unpiped = new FakeChild(undefined);
    unpiped.stderr = null;
    registry.track(unpiped.asChild(), "chrome");
    unpiped.emit("error", new Error("spawn ENOENT"));
    const lines = registry.records()[1]!.ring.snapshot().lines.join("\n");
    expect(lines).toContain("pid=none");
    expect(lines).toContain("stderr is not piped");
    expect(lines).toContain("spawn error: spawn ENOENT");
  });
});

describe("installPlaywrightBrowserStderrTap", () => {
  function host() {
    const spawned: FakeChild[] = [];
    const target = {
      spawn: (command: string): ChildProcess => {
        const child = new FakeChild(spawned.length + 1);
        spawned.push(child);
        void command;
        return child.asChild();
      },
    };
    return { target, spawned };
  }

  it("tracks only Chromium spawned by Playwright's launcher, and is idempotent", () => {
    const { target, spawned } = host();
    const original = target.spawn;
    const registry = new BrowserStderrRegistry(steppingClock());
    let launcher = true;
    const uninstall = installPlaywrightBrowserStderrTap(target, registry, () => launcher);
    expect(installPlaywrightBrowserStderrTap(target, registry, () => launcher)).toBe(uninstall);

    const call = target.spawn as unknown as (command: string) => ChildProcess;
    expect(call("/x/chrome-linux/chrome")).toBe(spawned[0]);
    call("/usr/bin/ffmpeg");
    launcher = false;
    call("/x/chrome-linux/chrome");
    expect(registry.records().map((record) => record.pid)).toEqual([1]);

    uninstall();
    expect(target.spawn).toBe(original);
  });

  it("never changes a spawn outcome when tracking throws", () => {
    const { target, spawned } = host();
    const registry = new BrowserStderrRegistry();
    vi.spyOn(registry, "track").mockImplementation(() => {
      throw new Error("tracking failed");
    });
    const uninstall = installPlaywrightBrowserStderrTap(target, registry, () => true);
    expect((target.spawn as unknown as (command: string) => ChildProcess)("chrome")).toBe(spawned[0]);
    uninstall();
  });

  it("recognizes Playwright's launcher frame and Chromium executables", () => {
    expect(
      spawnedByPlaywrightLauncher(
        "Error\n    at launchProcess (/repo/node_modules/playwright-core/lib/server/utils/processLauncher.js:118:39)",
      ),
    ).toBe(true);
    expect(
      spawnedByPlaywrightLauncher("Error\n    at openRealWorldBrowser (/repo/tests/real-world-browser.ts:1:1)"),
    ).toBe(false);
    expect(spawnedByPlaywrightLauncher(undefined)).toBe(false);
    for (const exe of ["chrome", "chrome-headless-shell", "headless_shell", "Chromium", "chrome.exe"])
      expect(isChromiumExecutable(`/x/${exe}`)).toBe(true);
    expect(isChromiumExecutable("/usr/bin/ffmpeg")).toBe(false);
  });
});

describe("screenshot-failure evidence dump", () => {
  it("matches the same transient the lane's retry matches", () => {
    expect(SCREENSHOT_CAPTURE_FAILURE.test(SCREENSHOT_ERROR)).toBe(true);
    expect(E2E_HOST_TRANSIENT_RETRY.condition.test(SCREENSHOT_ERROR)).toBe(true);
    expect(errorMessages([{ message: "a" }, {}])).toEqual(["a", ""]);
    expect(errorMessages(undefined)).toEqual([]);
  });

  it("writes stamped browser lines and a host sample, and prints one pointer line", () => {
    const directory = tempDir();
    const clock = steppingClock();
    const registry = new BrowserStderrRegistry(clock);
    const live = new FakeChild(4242);
    registry.track(live.asChild(), "/x/chrome-headless-shell");
    live.stderr!.write("[4242:ERROR:gpu] CopyOutputResult empty\npartial");
    const exited = new FakeChild(4141);
    registry.track(exited.asChild(), "/x/chrome-headless-shell");
    exited.emit("close", 0, null);

    const logs: string[] = [];
    const path = recordScreenshotFailureEvidence(
      { name: "clip-path > reference box", file: "/repo/tests/clip.e2e.test.ts", attempt: 1 },
      ["unrelated", `${SCREENSHOT_ERROR}\n  at stack`],
      { registry, directory, clock, host: FIXED_HOST, lane: "regular", log: (line) => logs.push(line) },
    );
    expect(path).toBeDefined();
    expect(logs).toEqual([expect.stringContaining(`written to ${path}`)]);
    expect(readdirSync(directory)).toHaveLength(1);
    const text = readFileSync(path!, "utf8");
    expect(text).toContain("test: clip-path > reference box");
    expect(text).toContain("attempt: 1");
    expect(text).toContain("lane: regular");
    expect(text).toContain(`error: ${SCREENSHOT_ERROR}\n`);
    expect(text).toContain("host: 2026-11-19T12:00:00.000Z load=3.50,2.25,1.00 cpus=3 freeMem=512MiB/7168MiB");
    expect(text).toMatch(/## pid=4242 exe=chrome-headless-shell started=\S+ state=live lines=2 dropped=0/);
    expect(text).toMatch(/## pid=4141 .* exited=\S+ code=0 /);
    expect(text).toMatch(/^\d{4}-\S+Z \[4242:ERROR:gpu\] CopyOutputResult empty$/m);
    expect(text).toContain("(unterminated) partial");
    // Live browsers precede exited ones.
    expect(text.indexOf("pid=4242")).toBeLessThan(text.indexOf("pid=4141"));
  });

  it("does nothing for other failures and reports, not throws, on a write error", () => {
    const logs: string[] = [];
    const registry = new BrowserStderrRegistry();
    expect(
      recordScreenshotFailureEvidence({ name: "t", file: undefined, attempt: 0 }, ["expected 1 to be 2"], {
        registry,
        log: (line) => logs.push(line),
      }),
    ).toBeUndefined();
    expect(logs).toEqual([]);

    // A file where the directory should be makes mkdir fail.
    const blocker = join(tempDir(), "not-a-directory");
    writeFileSync(blocker, "");
    const empty = recordScreenshotFailureEvidence({ name: "t", file: undefined, attempt: 0 }, [SCREENSHOT_ERROR], {
      registry,
      directory: join(blocker, "nested"),
      host: FIXED_HOST,
      log: (line) => logs.push(line),
    });
    expect(empty).toBeUndefined();
    expect(logs).toEqual([expect.stringContaining("could not write screenshot-failure evidence")]);
  });

  it("records an empty registry explicitly", () => {
    const directory = tempDir();
    const path = recordScreenshotFailureEvidence({ name: "hook", file: undefined, attempt: 0 }, [SCREENSHOT_ERROR], {
      registry: new BrowserStderrRegistry(),
      directory,
      host: FIXED_HOST,
      log: () => undefined,
    });
    const text = readFileSync(path!, "utf8");
    expect(text).toContain("file: unknown");
    expect(text).toContain("(no Playwright-launched Chromium recorded in this worker)");
  });
});

describe("evidence locations and host sampler", () => {
  it("resolves the evidence directory from explicit, output-dir, then default settings", () => {
    expect(evidenceDirectory({ DOMOTION_E2E_EVIDENCE_DIR: "x/evidence" })).toBe(resolve("x/evidence"));
    expect(evidenceDirectory({ DOMOTION_OUTPUT_DIR: "tests/output-linux" })).toBe(
      resolve("tests/output-linux/e2e-browser-evidence"),
    );
    expect(evidenceDirectory({})).toBe(resolve("tests/output/e2e-browser-evidence"));
  });

  it("samples on in CI, off locally, with explicit overrides and a bounded interval", () => {
    expect(hostSamplerEnabled({ CI: "true" })).toBe(true);
    expect(hostSamplerEnabled({})).toBe(false);
    expect(hostSamplerEnabled({ CI: "true", DOMOTION_E2E_HOST_SAMPLES: "0" })).toBe(false);
    expect(hostSamplerEnabled({ DOMOTION_E2E_HOST_SAMPLES: "1" })).toBe(true);
    expect(hostSampleIntervalMs({})).toBe(30_000);
    expect(hostSampleIntervalMs({ DOMOTION_E2E_HOST_SAMPLE_MS: "60000" })).toBe(60_000);
    expect(hostSampleIntervalMs({ DOMOTION_E2E_HOST_SAMPLE_MS: "5" })).toBe(30_000);
  });

  it("formats a real sample and one without disk numbers", () => {
    const real = sampleHost();
    expect(real.cpus).toBeGreaterThan(0);
    expect(formatHostSample(real, "lane=all")).toMatch(
      /^\S+Z load=[\d.]+,[\d.]+,[\d.]+ cpus=\d+ freeMem=\d+MiB\/\d+MiB .* lane=all$/,
    );
    expect(sampleHost(undefined, "/definitely/not/a/directory").tmpFreeBytes).toBeNull();
    expect(formatHostSample({ ...FIXED_HOST, tmpFreeBytes: null })).toContain("tmpFree=unknown");
  });

  it("writes one line at start, one per tick, and one at stop", () => {
    const file = join(tempDir(), "nested", "host-samples-regular.log");
    let tick: (() => void) | undefined;
    const unref = vi.fn();
    const clear = vi.fn();
    const stop = startHostSampler({
      file,
      intervalMs: 30_000,
      label: "lane=regular",
      sample: () => FIXED_HOST,
      setInterval: (fn, ms) => {
        expect(ms).toBe(30_000);
        tick = fn;
        return { unref };
      },
      clearInterval: clear,
    });
    tick!();
    tick!();
    stop();
    stop();
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).toMatch(/^2026-11-19T12:00:00.000Z load=3.50,2.25,1.00 .* lane=regular$/);
    expect(unref).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });
});

describe("CI wiring", () => {
  type Step = Record<string, unknown>;
  const jobs = (path: string) =>
    (parse(readFileSync(path, "utf8")) as { jobs: Record<string, { env?: Record<string, string>; steps: Step[] }> })
      .jobs;
  const paths = (step: Step | undefined) =>
    String((step?.["with"] as Record<string, unknown>)["path"])
      .split(/\r?\n/)
      .map((entry) => entry.trim());

  it("uploads the macOS e2e evidence directory after every run", () => {
    const steps = jobs(".github/workflows/ci.yml")["visual-macos"]!.steps;
    const upload = steps.find((step) => step["name"] === "Upload visual and browser-E2E results");
    expect(upload?.["if"]).toBe("always()");
    expect(paths(upload)).toContain("tests/output/e2e-browser-evidence/");
  });

  it("points the Linux regression job's e2e evidence at its uploaded output directory", () => {
    const job = jobs(".github/workflows/test-linux.yml")["regression"]!;
    expect(job.env?.["DOMOTION_E2E_EVIDENCE_DIR"]).toBe("tests/output-linux/e2e-browser-evidence");
    const upload = job.steps.find((step) => step["name"] === "Upload expected/actual/diff PNGs");
    expect(upload?.["if"]).toBe("always()");
    expect(paths(upload)).toContain("tests/output-linux/e2e-browser-evidence/");
  });
});
