// Child-side screenshot-failure evidence (see tests/e2e-child-evidence.ts).
//
// This file is plain JavaScript on purpose. It is loaded into every Node child
// of an E2E worker through `NODE_OPTIONS=--import`, and a TypeScript loader
// cannot be used there: registering tsx in a child switches its stderr pipe to
// non-blocking mode, so a child's own `fs.writeSync(2, …)` then fails with
// EAGAIN (seen with the svg-to-video ffmpeg stub). The file uses only Node
// built-ins, touches no standard stream until the child does, and writes the
// same dump format as `writeScreenshotFailureEvidence` in
// `e2e-browser-evidence.ts`; `tests/e2e-child-evidence.test.ts` holds the two
// formats together.
import { createRequire } from "node:module";
import { mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, tmpdir, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const CHILD_EVIDENCE_FLAG = "DOMOTION_E2E_CHILD_EVIDENCE";
export const SCREENSHOT_CAPTURE_FAILURE = /Unable to capture screenshot/;
const RING_LINES = 200;
const MAX_LINE_CHARS = 2_000;
const EXITED_RETAINED = 8;
const MIB = 1024 * 1024;

/** Mirrors `evidenceDirectory` in e2e-browser-evidence.ts. */
export function evidenceDirectory(env = process.env) {
  const explicit = env["DOMOTION_E2E_EVIDENCE_DIR"];
  if (explicit != null && explicit !== "") return resolve(explicit);
  const output = env["DOMOTION_OUTPUT_DIR"];
  return resolve(output != null && output !== "" ? output : "tests/output", "e2e-browser-evidence");
}

function stampedRing(clock) {
  const lines = [];
  let partial = "";
  let dropped = 0;
  const push = (line) => {
    const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [${line.length} chars, cut]` : line;
    lines.push(`${clock().toISOString()} ${text}`);
    if (lines.length > RING_LINES) {
      lines.shift();
      dropped++;
    }
  };
  return {
    push,
    append(chunk) {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop() ?? "";
      if (partial.length > MAX_LINE_CHARS) {
        parts.push(partial);
        partial = "";
      }
      for (const line of parts) push(line);
    },
    flush() {
      if (partial !== "") push(partial);
      partial = "";
    },
    snapshot: () => ({ lines: [...lines], dropped, pending: partial }),
  };
}

/** Same Playwright-launcher test as `spawnedByPlaywrightLauncher`. */
function spawnedByPlaywrightLauncher(stack = new Error().stack) {
  return stack != null && /playwright-core[\\/]lib[\\/]server[\\/]utils[\\/]processLauncher/.test(stack);
}

/** Track Chromium that Playwright launches in this process; returns the records. */
export function tapPlaywrightBrowsers(
  spawnHost,
  clock = () => new Date(),
  isLauncherCall = spawnedByPlaywrightLauncher,
) {
  const live = new Set();
  const exited = [];
  const original = spawnHost.spawn;
  spawnHost.spawn = function (...args) {
    const child = Reflect.apply(original, this, args);
    try {
      const command = args[0];
      if (typeof command === "string" && /chrom|headless_shell/i.test(basename(command)) && isLauncherCall()) {
        const ring = stampedRing(clock);
        const record = { pid: child.pid, executable: basename(command), startedAt: clock().toISOString(), ring };
        ring.push(`[evidence] spawned ${record.executable} pid=${record.pid ?? "none"}`);
        live.add(record);
        if (child.stderr != null) {
          const decoder = new StringDecoder("utf8");
          child.stderr.on("data", (chunk) => ring.append(typeof chunk === "string" ? chunk : decoder.write(chunk)));
          child.stderr.once("end", () => ring.append(decoder.end()));
        } else ring.push("[evidence] stderr is not piped; no browser output can be retained");
        child.once("error", (error) => ring.push(`[evidence] spawn error: ${error.message}`));
        child.once("close", (code, signal) => {
          ring.flush();
          record.exitedAt = clock().toISOString();
          record.exit = signal != null ? `signal=${signal}` : `code=${code ?? "null"}`;
          ring.push(`[evidence] exited ${record.exit}`);
          live.delete(record);
          exited.unshift(record);
          exited.length = Math.min(exited.length, EXITED_RETAINED);
        });
      }
    } catch {
      // Evidence collection must never change a launch outcome.
    }
    return child;
  };
  return () => [...live, ...exited];
}

function hostLine(clock, tmp = tmpdir()) {
  let disk = "tmpFree=unknown";
  try {
    const fs = statfsSync(tmp);
    disk = `tmpFree=${Math.round((fs.bavail * fs.bsize) / MIB)}MiB/${Math.round((fs.blocks * fs.bsize) / MIB)}MiB`;
  } catch {
    // Report without disk numbers rather than drop the sample.
  }
  const load = loadavg()
    .map((value) => value.toFixed(2))
    .join(",");
  return `${clock().toISOString()} load=${load} cpus=${cpus().length} freeMem=${Math.round(freemem() / MIB)}MiB/${Math.round(totalmem() / MIB)}MiB ${disk}`;
}

function safeFileStem(text) {
  return (
    text
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "unnamed"
  );
}

/** Write the dump; same layout as `writeScreenshotFailureEvidence`. */
export function writeChildEvidence({ name, file, message, records, directory, lane, pid, clock = () => new Date() }) {
  const now = clock();
  const out = [
    "# Domotion E2E screenshot-capture failure evidence",
    `dumpedAt: ${now.toISOString()}`,
    `test: ${name}`,
    `file: ${file ?? "unknown"}`,
    "attempt: 0",
    `lane: ${lane ?? "unknown"}`,
    `workerPid: ${pid}`,
    `error: ${message.split(/\r?\n/, 1)[0] ?? ""}`,
    `host: ${hostLine(clock)}`,
    `browsers: ${records.length} (live first, then up to ${EXITED_RETAINED} most recently exited)`,
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
  const path = join(directory, `screenshot-failure-${stamp}-pid${pid}-${safeFileStem(name)}-a0.log`);
  writeFileSync(path, out.join("\n"));
  return path;
}

function chunkText(chunk) {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return "";
}

/**
 * Wrap a standard stream's `write` only when the child first uses it. Node
 * creates `process.stdout` / `process.stderr` on first access, and for a pipe
 * that switches the descriptor to non-blocking mode; touching them eagerly
 * would change how a child's own `fs.writeSync(1|2, …)` behaves.
 */
function watchLazily(proc, name, onText) {
  const wrap = (stream) => {
    const original = stream.write;
    stream.write = function (...args) {
      try {
        onText(chunkText(args[0]));
      } catch {
        // Never let evidence collection break the child's own output.
      }
      return Reflect.apply(original, this, args);
    };
  };
  const descriptor = Object.getOwnPropertyDescriptor(proc, name);
  if (descriptor?.get == null) {
    wrap(proc[name]);
    return;
  }
  let stream;
  Object.defineProperty(proc, name, {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get() {
      if (stream == null) {
        stream = descriptor.get.call(proc);
        wrap(stream);
      }
      return stream;
    },
  });
}

/**
 * Install the child-side tap: record Playwright-launched Chromium stderr, watch
 * this process's own output for the screenshot failure, and write evidence at
 * exit when it appeared. Returns `{ matched, flush }` for tests.
 */
export function installChildBrowserEvidence(
  proc = process,
  spawnHost = createRequire(import.meta.url)("node:child_process"),
  clock = () => new Date(),
) {
  const records = tapPlaywrightBrowsers(spawnHost, clock);
  let matched;
  let written;
  const onText = (text) => {
    if (matched == null && SCREENSHOT_CAPTURE_FAILURE.test(text)) matched = text;
  };
  watchLazily(proc, "stdout", onText);
  watchLazily(proc, "stderr", onText);
  const flush = () => {
    if (matched == null || written != null) return written;
    try {
      written = writeChildEvidence({
        name: `child: ${proc.argv.slice(1).join(" ")}`,
        file: proc.argv[1],
        message: matched,
        records: records(),
        directory: evidenceDirectory(proc.env),
        lane: proc.env["DOMOTION_E2E_LANE"],
        pid: proc.pid,
        clock,
      });
      proc.stderr.write(
        `[e2e-evidence] child pid ${proc.pid}: Unable to capture screenshot; browser stderr written to ${written}\n`,
      );
    } catch {
      // A missing file is visible in the artifact; never change the exit.
    }
    return written;
  };
  proc.once("exit", () => {
    flush();
  });
  return { matched: () => matched, flush };
}
