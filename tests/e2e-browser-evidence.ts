/**
 * Bounded evidence for the hosted-runner `Unable to capture screenshot`
 * transient in the browser E2E lane.
 *
 * Chromium returns that DevTools error when six consecutive browser-side
 * surface copies come back empty (`PageHandler::ScreenshotCaptured`,
 * content/browser/devtools/protocol/page_handler.cc:1831, and the retry loop in
 * render_widget_host_impl.cc:3853-3882 at 7d859f27). Two causes fit that
 * shape: an invalid or evicted local surface id, or an empty viz
 * `CopyOutputResult`. Telling them apart needs the browser's own stderr and the
 * host's state at the time, and earlier CI failures kept neither.
 *
 * This module keeps both without making a passing lane louder:
 *
 * - Every Chromium that Playwright launches inside a Vitest worker gets a
 *   fixed-size ring of its most recent stderr lines, each stamped with the
 *   wall-clock time the worker received it. Nothing is printed while tests pass.
 * - When a failure message names the screenshot transient, the worker writes
 *   every retained ring (live browsers plus the most recently exited ones) and
 *   a host sample to one file, and prints a one-line pointer.
 * - A host sampler appends one line of load average, free memory and temporary
 *   disk usage at a fixed interval for the whole Vitest run.
 *
 * The hook is a wrapper around `child_process.spawn` that taps only processes
 * spawned by Playwright's own process launcher. It reads the stderr pipe
 * Playwright already consumes, adds no Chromium flags, and changes no launch
 * option, so the measured browser is the same browser the lane always ran.
 */
import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Lines retained per browser. */
export const BROWSER_STDERR_RING_LINES = 200;
/** Longest retained line; longer lines are cut and marked. */
export const BROWSER_STDERR_MAX_LINE_CHARS = 2_000;
/** Exited browsers kept after their process closes, newest first. */
export const EXITED_BROWSERS_RETAINED = 8;
/** Default host-sample interval. */
export const HOST_SAMPLE_INTERVAL_MS = 30_000;

/** The DevTools failure this evidence exists to attribute. */
export const SCREENSHOT_CAPTURE_FAILURE = /Unable to capture screenshot/;

type Clock = () => Date;

/** A fixed-capacity ring of wall-clock-stamped lines, fed by arbitrary chunks. */
export class StampedLineRing {
  private readonly lines: string[] = [];
  private partial = "";
  private dropped = 0;

  constructor(
    readonly capacity: number = BROWSER_STDERR_RING_LINES,
    private readonly clock: Clock = () => new Date(),
    private readonly maxLineChars: number = BROWSER_STDERR_MAX_LINE_CHARS,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("ring capacity must be a positive integer");
  }

  /** Append a raw stream chunk; complete lines are stamped on arrival. */
  append(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    // An unterminated line can grow without bound; stamp it once it is too long.
    if (this.partial.length > this.maxLineChars) {
      parts.push(this.partial);
      this.partial = "";
    }
    for (const line of parts) this.push(line);
  }

  /** Record one complete line (for lifecycle markers written by this module). */
  push(line: string): void {
    const text =
      line.length > this.maxLineChars ? `${line.slice(0, this.maxLineChars)} [${line.length} chars, cut]` : line;
    this.lines.push(`${this.clock().toISOString()} ${text}`);
    if (this.lines.length > this.capacity) {
      this.lines.shift();
      this.dropped++;
    }
  }

  /** Stamp any unterminated tail, for example when the stream ends. */
  flush(): void {
    if (this.partial !== "") this.push(this.partial);
    this.partial = "";
  }

  snapshot(): { lines: readonly string[]; dropped: number; pending: string } {
    return { lines: [...this.lines], dropped: this.dropped, pending: this.partial };
  }
}

export interface BrowserStderrRecord {
  pid: number | undefined;
  executable: string;
  startedAt: string;
  exitedAt?: string;
  exit?: string;
  ring: StampedLineRing;
}

/** Live and recently exited browsers in this process. */
export class BrowserStderrRegistry {
  private readonly live = new Set<BrowserStderrRecord>();
  private readonly exited: BrowserStderrRecord[] = [];

  constructor(
    private readonly clock: Clock = () => new Date(),
    readonly exitedRetained: number = EXITED_BROWSERS_RETAINED,
    readonly ringLines: number = BROWSER_STDERR_RING_LINES,
  ) {}

  /** Start recording a spawned browser's stderr. */
  track(child: ChildProcess, command: string): BrowserStderrRecord {
    const ring = new StampedLineRing(this.ringLines, this.clock);
    const record: BrowserStderrRecord = {
      pid: child.pid,
      executable: basename(command),
      startedAt: this.clock().toISOString(),
      ring,
    };
    ring.push(`[evidence] spawned ${record.executable} pid=${record.pid ?? "none"}`);
    this.live.add(record);
    const stderr = child.stderr;
    if (stderr != null) {
      // Decode privately: setEncoding() would change the chunks Playwright's
      // own reader receives from the same stream.
      const decoder = new StringDecoder("utf8");
      stderr.on("data", (chunk: string | Buffer) =>
        ring.append(typeof chunk === "string" ? chunk : decoder.write(chunk)),
      );
      stderr.once("end", () => ring.append(decoder.end()));
    } else ring.push("[evidence] stderr is not piped; no browser output can be retained");
    child.once("error", (error: Error) => ring.push(`[evidence] spawn error: ${error.message}`));
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      ring.flush();
      record.exitedAt = this.clock().toISOString();
      record.exit = signal != null ? `signal=${signal}` : `code=${code ?? "null"}`;
      ring.push(`[evidence] exited ${record.exit}`);
      this.live.delete(record);
      this.exited.unshift(record);
      this.exited.length = Math.min(this.exited.length, this.exitedRetained);
    });
    return record;
  }

  /** Live browsers first (oldest launch first), then exited ones (newest exit first). */
  records(): BrowserStderrRecord[] {
    return [...this.live, ...this.exited];
  }
}

const REGISTRY_KEY = Symbol.for("domotion.e2e.browserStderrRegistry");
const TAP_KEY = Symbol.for("domotion.e2e.browserStderrTap");

/**
 * The worker-wide registry. Vitest re-evaluates setup files for every test
 * file in the same fork, so the registry lives on `globalThis` rather than in
 * module scope; otherwise each file would see an empty one.
 */
export function workerBrowserRegistry(): BrowserStderrRegistry {
  const store = globalThis as Record<symbol, unknown>;
  // A module reload yields a new class identity, so keep the first registry
  // structurally rather than by instanceof.
  const existing = store[REGISTRY_KEY];
  if (existing != null) return existing as BrowserStderrRegistry;
  const registry = new BrowserStderrRegistry();
  store[REGISTRY_KEY] = registry;
  return registry;
}

/** True when the current call stack is Playwright's own browser launcher. */
export function spawnedByPlaywrightLauncher(stack: string | undefined = new Error().stack): boolean {
  return stack != null && /playwright-core[\\/]lib[\\/]server[\\/]utils[\\/]processLauncher/.test(stack);
}

/** Chromium-family executables Playwright launches (`chrome`, `chromium`, `chrome-headless-shell`, `headless_shell`). */
export function isChromiumExecutable(command: string): boolean {
  return /chrom|headless_shell/i.test(basename(command));
}

interface SpawnHost {
  spawn: (...args: never[]) => ChildProcess;
}

/**
 * Wrap `host.spawn` so each Chromium spawned by Playwright's launcher is
 * tracked. Idempotent per host object. Returns an uninstall function.
 *
 * Only Playwright launcher spawns are tapped: Playwright reads the stderr pipe
 * itself (readline), so the stream is already flowing and one more `data`
 * listener cannot change what it sees. A caller that spawns Chromium directly
 * may read its stderr later, and an early listener would put that stream into
 * flowing mode first, so those spawns are left alone.
 */
export function installPlaywrightBrowserStderrTap(
  host: SpawnHost,
  registry: BrowserStderrRegistry = workerBrowserRegistry(),
  isLauncherCall: () => boolean = () => spawnedByPlaywrightLauncher(),
): () => void {
  const tagged = host as SpawnHost & Record<symbol, unknown>;
  const installed = tagged[TAP_KEY];
  if (typeof installed === "function") return installed as () => void;
  const original = host.spawn;
  const wrapped = function (this: unknown, ...args: unknown[]): ChildProcess {
    const child = Reflect.apply(original, this, args) as ChildProcess;
    try {
      const command = args[0];
      if (typeof command === "string" && isChromiumExecutable(command) && isLauncherCall())
        registry.track(child, command);
    } catch {
      // Evidence collection must never change a launch outcome.
    }
    return child;
  };
  host.spawn = wrapped as SpawnHost["spawn"];
  const uninstall = (): void => {
    if (host.spawn === wrapped) host.spawn = original;
    delete tagged[TAP_KEY];
  };
  tagged[TAP_KEY] = uninstall;
  return uninstall;
}

export interface HostSample {
  at: string;
  loadavg: [number, number, number];
  cpus: number;
  freeMemBytes: number;
  totalMemBytes: number;
  tmpDir: string;
  tmpFreeBytes: number | null;
  tmpTotalBytes: number | null;
}

export function sampleHost(clock: Clock = () => new Date(), tmp: string = tmpdir()): HostSample {
  let tmpFreeBytes: number | null = null;
  let tmpTotalBytes: number | null = null;
  try {
    const fs = statfsSync(tmp);
    tmpFreeBytes = fs.bavail * fs.bsize;
    tmpTotalBytes = fs.blocks * fs.bsize;
  } catch {
    // Report the sample without disk numbers rather than drop it.
  }
  const [one, five, fifteen] = loadavg();
  return {
    at: clock().toISOString(),
    loadavg: [one ?? 0, five ?? 0, fifteen ?? 0],
    cpus: cpus().length,
    freeMemBytes: freemem(),
    totalMemBytes: totalmem(),
    tmpDir: tmp,
    tmpFreeBytes,
    tmpTotalBytes,
  };
}

const MIB = 1024 * 1024;
export function formatHostSample(sample: HostSample, label = ""): string {
  const load = sample.loadavg.map((value) => value.toFixed(2)).join(",");
  const mem = `freeMem=${Math.round(sample.freeMemBytes / MIB)}MiB/${Math.round(sample.totalMemBytes / MIB)}MiB`;
  const tmp =
    sample.tmpFreeBytes == null || sample.tmpTotalBytes == null
      ? "tmpFree=unknown"
      : `tmpFree=${Math.round(sample.tmpFreeBytes / MIB)}MiB/${Math.round(sample.tmpTotalBytes / MIB)}MiB`;
  return `${sample.at} load=${load} cpus=${sample.cpus} ${mem} ${tmp}${label === "" ? "" : ` ${label}`}`;
}

/** Where evidence files land: explicit dir, else `<output dir>/e2e-browser-evidence`. */
export function evidenceDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["DOMOTION_E2E_EVIDENCE_DIR"];
  if (explicit != null && explicit !== "") return resolve(explicit);
  const output = env["DOMOTION_OUTPUT_DIR"];
  return resolve(output != null && output !== "" ? output : "tests/output", "e2e-browser-evidence");
}

export interface FailureTrigger {
  /** Test or suite name, with its file. */
  name: string;
  file: string | undefined;
  /** Zero-based attempt (Vitest `retryCount`). */
  attempt: number;
  message: string;
}

/** Collect the error messages from a Vitest task result. */
export function errorMessages(errors: readonly { message?: unknown }[] | undefined): string[] {
  return (errors ?? []).map((error) => String(error.message ?? ""));
}

/** The first message naming the screenshot transient, if any. */
export function screenshotFailureMessage(messages: readonly string[]): string | undefined {
  return messages.find((message) => SCREENSHOT_CAPTURE_FAILURE.test(message));
}

function safeFileStem(text: string): string {
  return (
    text
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "unnamed"
  );
}

/** Write one evidence file for a screenshot-capture failure and return its path. */
export function writeScreenshotFailureEvidence(
  trigger: FailureTrigger,
  options: {
    registry?: BrowserStderrRegistry;
    directory?: string;
    clock?: Clock;
    host?: HostSample;
    lane?: string;
  } = {},
): string {
  const registry = options.registry ?? workerBrowserRegistry();
  const clock = options.clock ?? (() => new Date());
  const directory = options.directory ?? evidenceDirectory();
  const now = clock();
  const host = options.host ?? sampleHost(clock);
  const records = registry.records();
  const out: string[] = [
    "# Domotion E2E screenshot-capture failure evidence",
    `dumpedAt: ${now.toISOString()}`,
    `test: ${trigger.name}`,
    `file: ${trigger.file ?? "unknown"}`,
    `attempt: ${trigger.attempt}`,
    `lane: ${options.lane ?? process.env["DOMOTION_E2E_LANE"] ?? "unknown"}`,
    `workerPid: ${process.pid}`,
    `error: ${trigger.message.split(/\r?\n/, 1)[0] ?? ""}`,
    `host: ${formatHostSample(host)}`,
    `browsers: ${records.length} (live first, then up to ${registry.exitedRetained} most recently exited)`,
    "",
  ];
  if (records.length === 0) out.push("(no Playwright-launched Chromium recorded in this worker)");
  for (const record of records) {
    const snap = record.ring.snapshot();
    out.push(
      `## pid=${record.pid ?? "none"} exe=${record.executable} started=${record.startedAt} ` +
        `${record.exitedAt == null ? "state=live" : `exited=${record.exitedAt} ${record.exit ?? ""}`} ` +
        `lines=${snap.lines.length} dropped=${snap.dropped}`,
      ...snap.lines,
    );
    if (snap.pending !== "") out.push(`(unterminated) ${snap.pending}`);
    out.push("");
  }
  mkdirSync(directory, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = join(
    directory,
    `screenshot-failure-${stamp}-pid${process.pid}-${safeFileStem(trigger.name.split(" > ").at(-1) ?? "")}-a${trigger.attempt}.log`,
  );
  writeFileSync(path, out.join("\n"));
  return path;
}

/**
 * Dump evidence when `messages` name the screenshot transient. Returns the
 * file path, or undefined when nothing matched or the write failed (evidence
 * must never replace the test's own failure).
 */
export function recordScreenshotFailureEvidence(
  trigger: Omit<FailureTrigger, "message">,
  messages: readonly string[],
  options: Parameters<typeof writeScreenshotFailureEvidence>[1] & { log?: (line: string) => void } = {},
): string | undefined {
  const message = screenshotFailureMessage(messages);
  if (message == null) return undefined;
  const log = options.log ?? ((line: string) => console.warn(line));
  try {
    const path = writeScreenshotFailureEvidence({ ...trigger, message }, options);
    log(`[e2e-evidence] Unable to capture screenshot: browser stderr and host state written to ${path}`);
    return path;
  } catch (error) {
    log(`[e2e-evidence] could not write screenshot-failure evidence: ${String(error)}`);
    return undefined;
  }
}

/** Whether the host sampler runs: on in CI, off locally, overridable either way. */
export function hostSamplerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env["DOMOTION_E2E_HOST_SAMPLES"];
  if (flag === "1") return true;
  if (flag === "0") return false;
  return env["CI"] === "true" || env["CI"] === "1";
}

export function hostSampleIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env["DOMOTION_E2E_HOST_SAMPLE_MS"]);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : HOST_SAMPLE_INTERVAL_MS;
}

/**
 * Append one host line now, every `intervalMs`, and once more at stop. The
 * timer is unref'd so it never holds the Vitest process open.
 */
export function startHostSampler(options: {
  file: string;
  intervalMs?: number;
  label?: string;
  sample?: () => HostSample;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => unknown };
  clearInterval?: (handle: unknown) => void;
}): () => void {
  const sample = options.sample ?? (() => sampleHost());
  const label = options.label ?? "";
  const write = (): void => {
    try {
      appendFileSync(options.file, `${formatHostSample(sample(), label)}\n`);
    } catch {
      // A missing sample line is visible in the file; never fail the lane for it.
    }
  };
  mkdirSync(dirname(options.file), { recursive: true });
  write();
  const schedule =
    options.setInterval ??
    ((fn: () => void, ms: number): NodeJS.Timeout => globalThis.setInterval(fn, ms) as NodeJS.Timeout);
  const cancel = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
  const handle = schedule(write, options.intervalMs ?? HOST_SAMPLE_INTERVAL_MS);
  handle.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    cancel(handle);
    write();
  };
}
