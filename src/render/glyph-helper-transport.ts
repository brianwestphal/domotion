/**
 * Native glyph-helper discovery and synchronous process transport.
 *
 * Font adapters and platform resolvers consume this boundary without owning
 * child-process state or helper-path lifecycle.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireGlyphHelperSync } from "./helper-acquire.js";
import { hostPlatform } from "./host-platform.js";
import { profAccum, profNow, renderProfileEnabled } from "./render-profile.js";
import type { HelperRequest, HelperResponse } from "./glyph-helper-protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// In-tree helper binary per platform. These live at the repo-root
// `tools/<platform>-glyph-extractor/` dir, which is two levels up from this
// module (`src/render/` in dev, `dist/render/` once compiled).
//
// NOTE: `tools/` is NOT in the published npm `files` (only `dist` ships), so
// for a *published* consumer these paths don't exist — the on-demand
// release-asset download into a user cache (DM-886) is what provides a binary
// there. Today only an in-repo dev build or an explicit `DOMOTION_HELPER_PATH`
// resolves a real binary; everywhere else the renderer falls back to fontkit.
const HELPER_BINARIES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: path.resolve(HERE, "..", "..", "tools", "macos-glyph-extractor", "domotion-glyph-paths"),
  linux: path.resolve(HERE, "..", "..", "tools", "linux-glyph-extractor", "domotion-glyph-paths"),
  win32: path.resolve(HERE, "..", "..", "tools", "win32-glyph-extractor", "domotion-glyph-paths.exe")
};

// Resolve the helper binary for the running platform, in order:
//   1. `DOMOTION_HELPER_PATH` override (no download).
//   2. The in-tree build (in-repo dev / unpacked source), if it exists.
//   3. The on-demand download of the release asset into the user cache
//      (DM-886) — what gives a *published* consumer a helper, since `tools/`
//      isn't shipped. Lazy: this runs only when 1+2 miss and a helper-eligible font
//      is actually requested. Returns undefined on any failure → fontkit.
function resolveHelperPath(platform: NodeJS.Platform = hostPlatform()): string | undefined {
  if (process.env.DOMOTION_HELPER_PATH) return process.env.DOMOTION_HELPER_PATH;
  const inTree = HELPER_BINARIES[platform];
  if (inTree != null && existsSync(inTree)) return inTree;
  return acquireGlyphHelperSync({ platform });
}

/** Test-only: the in-tree helper path mapped for `platform`, ignoring the
 *  `DOMOTION_HELPER_PATH` override. `undefined` for platforms with no helper. */
export function __helperBinaryForPlatform(platform: NodeJS.Platform): string | undefined {
  return HELPER_BINARIES[platform];
}

/** Build a portable child-process invocation for a native helper or a Node
 * protocol adapter. Windows cannot execute a `.js`/`.mjs` path directly, even
 * when it has a Unix shebang; route those explicit adapters through the same
 * Node executable that is running Domotion. */
export function __helperInvocationForTest(
  helper: string,
  args: string[] = [],
): { command: string; args: string[] } {
  return /\.(?:cjs|mjs|js)$/i.test(helper)
    ? { command: process.execPath, args: [helper, ...args] }
    : { command: helper, args };
}

// Module-level helper-process state, memoized for the lifetime of the Node
// process (one render run). `helperAvailable`/`helperPath` cache the one-time
// availability probe; the long-lived server fds below are lazily opened on first
// use and reused for every glyph query. This is process-global during ordinary
// rendering; only `clearGlyphHelperTransport`, called at the explicit font-
// environment invalidation boundary, resets discovery and the selected carrier.
let helperAvailable: boolean | null = null;
let helperPath: string | undefined;
export function isGlyphHelperAvailable(): boolean {
  if (helperAvailable != null) return helperAvailable;
  if (process.env.DOMOTION_DISABLE_HELPER) { helperAvailable = false; return false; }
  helperPath = resolveHelperPath();
  helperAvailable = helperPath != null && existsSync(helperPath);
  return helperAvailable;
}

/** Evidence-only access to the exact resolved helper selected for this run. */
export function resolvedGlyphHelperPathForEvidence(): string | null {
  return isGlyphHelperAvailable() ? (helperPath ?? null) : null;
}


// DM-1031: persistent-helper channel. Spawning the binary fresh for each call
// costs ~16 ms (process spawn + CoreText init + font open) and was ~93% of the
// render step (DM-1029). Instead, start the binary ONCE in `--serve` mode and
// do a synchronous request/response round-trip over its stdin/stdout fds
// (~0.4 ms/call, fonts reused across calls). Falls back transparently to the
// original one-shot `spawnSync` if the persistent channel can't be established
// (e.g. an older downloaded binary that doesn't understand `--serve`).
let serverProc: ChildProcess | null = null;
let serverInFd: number | undefined;
let serverOutFd: number | undefined;
let serverLeftover = "";          // bytes read past one response (normally "")
let persistentDisabled = false;   // set once we know the binary can't serve
let persistentEverWorked = false; // distinguishes "broken binary" from a transient crash

function fdOf(stream: unknown): number | undefined {
  const s = stream as { fd?: number; _handle?: { fd?: number } } | null;
  return s?.fd ?? s?._handle?.fd;
}

let _pipeSeq = 0;

/**
 * Synchronously sleep, without burning a core.
 *
 * The connect loop below cannot yield to the event loop — the whole channel is
 * synchronous by design, and the child's `exit` event would never be delivered
 * anyway — so a plain spin would busy-wait. `Atomics.wait` on a private buffer
 * blocks the thread properly instead.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable (locked-down embedder): fall through and let
    // the caller spin. Slower, still correct.
  }
}

/**
 * DM-1889: the persistent channel on Windows, carried over a named pipe.
 *
 * DM-1421 disabled `--serve` on Windows for a real reason: Node reports a
 * spawned child's stdio pipes as fd `-1` there — no OS file descriptor — and
 * this channel is driven by synchronous `writeSync`/`readSync`, which need one.
 * The conclusion drawn then was that Windows cannot have the channel. The
 * narrower truth is that it cannot have it *over spawned stdio*: `fs.openSync`
 * on a named pipe path DOES return a real fd, and the existing loop drives it
 * unchanged.
 *
 * That mattered more than it looked. Every helper call on Windows was a fresh
 * process — ~59 ms measured, even for a request doing no work — which made the
 * conformance oracle's Windows shards ~20x slower per codepoint than macOS's and
 * the long pole of every three-platform run.
 *
 * The child is the pipe SERVER (only the server end can be created by name) and
 * we connect as the client, so the handshake is: spawn, then retry the open
 * until the child has created it. One fd serves both directions — the pipe is
 * duplex, so `serverInFd` and `serverOutFd` are deliberately the same number.
 *
 * Degradation is preserved in both directions. A helper predating `--serve-pipe`
 * dies on the unknown argument, the path never appears, the liveness check
 * notices the child is gone, and we return false — reverting to one-shot
 * spawning exactly as before.
 */
function startPersistentViaPipe(bin: string): boolean {
  const name = `\\\\.\\pipe\\domotion-glyph-${process.pid}-${_pipeSeq++}`;
  let proc: ChildProcess;
  try {
    // stdin/stdout are unused on this path; stderr stays inherited so a helper
    // diagnostic still reaches the terminal.
    const invocation = __helperInvocationForTest(bin, ["--serve-pipe", name]);
    proc = spawn(invocation.command, invocation.args, { stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    persistentDisabled = true;
    return false;
  }

  const deadline = Date.now() + 10_000;
  let fd: number | undefined;
  for (;;) {
    try {
      // "r+" — read AND write on one duplex handle.
      fd = openSync(name, "r+");
      break;
    } catch {
      // Not there yet, or never will be. `kill(pid, 0)` is an existence probe
      // that sends no signal; it is the only liveness check available here,
      // because the event loop is blocked and `proc.exitCode` would stay null
      // for a child that has already died.
      let alive = true;
      try {
        if (proc.pid != null) process.kill(proc.pid, 0);
        else alive = false;
      } catch { alive = false; }
      if (!alive || Date.now() > deadline) {
        try { proc.kill(); } catch { /* ignore */ }
        // The binary cannot serve this way. Don't retry per call.
        persistentDisabled = true;
        return false;
      }
      sleepSync(5);
    }
  }

  proc.unref();
  serverProc = proc;
  serverInFd = fd;
  serverOutFd = fd;
  serverLeftover = "";
  proc.on("error", () => { serverProc = null; });
  proc.on("exit", () => { serverProc = null; });
  if (!_persistentExitHookInstalled) {
    _persistentExitHookInstalled = true;
    process.once("exit", () => { try { serverProc?.kill(); } catch { /* ignore */ } });
  }
  return true;
}

function startPersistent(bin: string): boolean {
  if (persistentDisabled) return false;
  // `DOMOTION_HELPER_NO_SERVE=1` forces the one-shot `spawnSync` path, so the
  // channel's contribution can be MEASURED rather than assumed.
  //
  // It exists because the channel is otherwise unfalsifiable from outside: when
  // it silently degrades, every query still returns the right answer and only
  // the wall clock moves — and a wall clock has no baseline unless you can turn
  // the mechanism off. `DOMOTION_DISABLE_HELPER` is not a substitute: that
  // disables the helper entirely and therefore changes the ANSWERS, so a
  // throughput comparison against it grades two different resolvers.
  //
  // The concrete question it was added for: a Windows conformance sweep on a
  // Parallels VM measured 47 comparisons/s where the same code on a GitHub
  // Windows runner measures 636-695/s. A per-codepoint process spawn lands
  // right around 20 ms, i.e. ~50/s, which makes a degraded channel the leading
  // hypothesis — and this switch is how it gets confirmed or refuted instead of
  // repeated.
  if (process.env.DOMOTION_HELPER_NO_SERVE === "1") {
    persistentDisabled = true;
    return false;
  }
  // macOS (CoreText, DM-1031), Linux (FreeType, DM-1034), and Windows
  // (DirectWrite, DM-1035) all implement `--serve`. An old binary on any
  // platform that predates `--serve` still self-heals: it dies on the unknown
  // flag, the first round-trip fails (EOF / closed stdout), and
  // `persistentDisabled` flips below since `persistentEverWorked` is still
  // false — reverting transparently to the one-shot `spawnSync` path. So the
  // persistent channel is safe to attempt on every platform that ships a helper.
  if (hostPlatform() !== "darwin" && hostPlatform() !== "linux" && hostPlatform() !== "win32") {
    persistentDisabled = true;
    return false;
  }
  // DM-1889: Windows gets the same channel over a different carrier. See
  // `startPersistentViaPipe` — a spawned stdio pipe has no OS fd there, which is
  // what DM-1421 hit, but a NAMED pipe opened by path does.
  if (hostPlatform() === "win32") return startPersistentViaPipe(bin);
  try {
    const invocation = __helperInvocationForTest(bin, ["--serve"]);
    const proc = spawn(invocation.command, invocation.args, { stdio: ["pipe", "pipe", "inherit"] });
    const inFd = fdOf(proc.stdin);
    const outFd = fdOf(proc.stdout);
    // DM-1421: a Windows spawned pipe exposes fd `-1` (no real OS fd), so the
    // synchronous `writeSync`/`readSync` this channel relies on can't drive it
    // there — `writeSync(-1)` throws. Treat a missing OR negative fd as
    // unusable: kill the doomed child and disable serve for the session so we
    // fall back to one-shot `spawnSync` (correct + avoids re-spawning a serve
    // child every call). macOS/Linux expose real (>=0) fds and keep serve.
    // Retained as a guard for any platform whose pipes behave the same way.
    if (inFd == null || outFd == null || inFd < 0 || outFd < 0) {
      try { proc.kill(); } catch { /* ignore */ }
      persistentDisabled = true;
      return false;
    }
    // Don't let the long-lived child (or its pipe handles) keep the parent's
    // event loop alive — otherwise the process hangs at exit waiting on the
    // serve loop. unref() is libuv-handle-only; our synchronous readSync/
    // writeSync go straight to the fds and are unaffected. The `exit` hook
    // below then kills the child as the parent shuts down.
    proc.unref();
    (proc.stdin as { unref?: () => void } | null)?.unref?.();
    (proc.stdout as { unref?: () => void } | null)?.unref?.();
    serverProc = proc;
    serverInFd = inFd;
    serverOutFd = outFd;
    serverLeftover = "";
    proc.on("error", () => { serverProc = null; });
    proc.on("exit", () => { serverProc = null; });
    if (!_persistentExitHookInstalled) {
      _persistentExitHookInstalled = true;
      process.once("exit", () => { try { serverProc?.kill(); } catch { /* ignore */ } });
    }
    return true;
  } catch {
    return false;
  }
}
let _persistentExitHookInstalled = false;

/** Synchronous request → response over the persistent `--serve` child. Returns
 *  null (and disables the channel as appropriate) if it can't complete, so the
 *  caller falls back to one-shot spawnSync. */
function callHelperPersistent(request: HelperRequest, bin: string): HelperResponse | null {
  if (persistentDisabled) return null;
  if (serverProc == null && !startPersistent(bin)) return null;
  try {
    // Envelope-level split, DEMO_TIMING-gated: the `helperms-q:` accumulators one
    // level up time the WHOLE round trip, which cannot distinguish "the helper is
    // slow" from "we are spending it on serialisation and bytes". These four
    // labels plus the two byte counters are what separate them.
    const _s0 = profNow();
    const line = Buffer.from(JSON.stringify(request) + "\n", "utf-8");
    if (renderProfileEnabled) {
      profAccum("helperenv:serialize", profNow() - _s0);
      profAccum("helperenv:bytes-out", line.length);
    }
    const _w0 = profNow();
    let off = 0;
    const wDeadline = Date.now() + 30_000;
    while (off < line.length) {
      try {
        off += writeSync(serverInFd!, line, off, line.length - off);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
          if (Date.now() > wDeadline) throw new Error("helper write timeout");
          continue;
        }
        throw e;
      }
    }
    if (renderProfileEnabled) profAccum("helperenv:write", profNow() - _w0);
    // Everything between the last byte written and the newline arriving: the
    // helper's own work plus both pipe traversals. Not separable from this side.
    const _r0 = profNow();
    let bytesIn = 0;
    const tmp = Buffer.allocUnsafe(1 << 20);
    const rDeadline = Date.now() + 30_000;
    while (!serverLeftover.includes("\n")) {
      let n: number;
      try {
        n = readSync(serverOutFd!, tmp, 0, tmp.length, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
          if (Date.now() > rDeadline) throw new Error("helper read timeout");
          continue;
        }
        throw e;
      }
      if (n > 0) { serverLeftover += tmp.toString("utf-8", 0, n); bytesIn += n; }
      else if (n === 0) throw new Error("helper closed stdout"); // EOF
    }
    if (renderProfileEnabled) {
      profAccum("helperenv:roundtrip", profNow() - _r0);
      profAccum("helperenv:bytes-in", bytesIn);
    }
    const _p0 = profNow();
    const nl = serverLeftover.indexOf("\n");
    const respLine = serverLeftover.slice(0, nl);
    serverLeftover = serverLeftover.slice(nl + 1);
    const resp = JSON.parse(respLine) as HelperResponse;
    if (renderProfileEnabled) profAccum("helperenv:parse", profNow() - _p0);
    persistentEverWorked = true;
    return resp;
  } catch {
    // Channel broken. Tear it down. If it never once worked, the binary almost
    // certainly doesn't support `--serve` (old release) — disable for the
    // session so we don't keep paying a failed spawn. If it had worked before,
    // this was a transient crash; leave it enabled so the next call respawns.
    try { serverProc?.kill(); } catch { /* ignore */ }
    serverProc = null;
    serverLeftover = "";
    if (!persistentEverWorked) persistentDisabled = true;
    return null;
  }
}

export function callGlyphHelper(request: HelperRequest): HelperResponse {
  // `isGlyphHelperAvailable()` (the gate every caller passes) sets
  // `helperPath`; re-resolve defensively in case it's called standalone.
  const bin = helperPath ?? resolveHelperPath();
  if (bin == null) throw new Error("no glyph helper binary for this platform");
  // DM-1029: time the helper round-trip (the dominant render cost for
  // native-extractor fonts). No-op unless DEMO_TIMING. Label kept as
  // `helper-spawnSync` so the DM-1029 before/after numbers line up even though
  // DM-1031 made the common path a persistent-process round-trip.
  const _t0 = profNow();
  // DM-1033: per-query-type tally so the timing breakdown shows WHERE the
  // round-trips come from (shape vs coverage-glyphs vs id-glyphs vs fallback vs
  // family vs meta) — drives the batching analysis. One round-trip can carry
  // several queries; count the dominant (first) query's type plus a roll-up.
  if (renderProfileEnabled) {
    const q0 = request.queries[0];
    if (q0 != null) profAccum(`helper-q:${q0.type}`, 0);
  }
  const persistent = callHelperPersistent(request, bin);
  if (persistent != null) {
    profAccum("helper-spawnSync", profNow() - _t0);
    // …and the MILLISECONDS per query type, beside the counts above. The two
    // answer different questions and the counts alone mislead: a profile of the
    // macOS resolver found MORE `glyphs` coverage probes than `fallback` asks
    // (19,777 vs 15,263), which reads as "coverage dominates" — while by time
    // the fallback ask is 49% of the total and coverage 33%, because a
    // `fallback` round-trip costs roughly twice a `glyphs` one.
    if (renderProfileEnabled) {
      const q0 = request.queries[0];
      if (q0 != null) profAccum(`helperms-q:${q0.type}`, profNow() - _t0);
    }
    return persistent;
  }
  // Fallback: original one-shot spawnSync.
  const invocation = __helperInvocationForTest(bin);
  const proc = spawnSync(invocation.command, invocation.args, {
    input: JSON.stringify(request),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024
  });
  profAccum("helper-spawnSync", profNow() - _t0);
  if (proc.status !== 0) {
    throw new Error(`glyph helper failed (exit ${proc.status}): ${proc.stderr}`);
  }
  return JSON.parse(proc.stdout) as HelperResponse;
}

/**
 * Reset helper discovery and the selected carrier at a font-environment
 * generation boundary. This is transport lifecycle only; resolver/font caches
 * are owned by their respective modules.
 */
export function clearGlyphHelperTransport(): void {
  helperAvailable = null;
  helperPath = undefined;
  try { serverProc?.kill(); } catch { /* already gone */ }
  serverProc = null;
  serverInFd = undefined;
  serverOutFd = undefined;
  serverLeftover = "";
  persistentDisabled = false;
}
