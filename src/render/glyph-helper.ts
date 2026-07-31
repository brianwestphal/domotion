/**
 * Native glyph-outline extraction via a platform's system-font engine helper:
 * CoreText on macOS (`tools/macos-glyph-extractor`, DM-385 / DM-388), FreeType
 * on Linux (`tools/linux-glyph-extractor`, DM-872), DirectWrite on Windows
 * (`tools/win32-glyph-extractor`, DM-837).
 *
 * Used as the path-extraction backend for fonts whose outlines fontkit can't
 * read — primarily PingFang on macOS, whose outlines live in the proprietary
 * Apple `hvgl` table; the Linux/Windows analogues cover CFF/CJK outlines their
 * native engine reads faithfully but fontkit can't. Each helper opens the font
 * through the platform engine (which Chromium also rasterizes through, so the
 * outlines are byte-faithful to the painted page) and returns SVG path data we
 * drop into the same `<defs>`/`<use>` pipeline as fontkit-extracted glyphs.
 *
 * All three helpers speak the identical stdin/stdout JSON IPC and emit outlines
 * in font design units, y-up (fontkit's convention), so everything below the
 * binary selection — the wrapper, `parseSvgPath`, the scale transform in
 * `text-to-path.ts` — is engine-agnostic. (Originally macOS-only `coretext.ts`;
 * generalized to all platforms in DM-881 and renamed in DM-888.)
 *
 * The wrapper exposes a fontkit-compatible subset of the `Font` API (the
 * fields `text-to-path.ts` reads): `unitsPerEm`, ascent/descent, underline /
 * strikeout metrics, `glyphForCodePoint`, `getGlyph`, and `layout`. The
 * renderer treats it interchangeably with a fontkit Font.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireGlyphHelperSync } from "./helper-acquire.js";
import { profAccum, profNow, renderProfileEnabled } from "./render-profile.js";

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
//   1. `DOMOTION_HELPER_PATH` override (verbatim — no download).
//   2. The in-tree build (in-repo dev / unpacked source), if it exists.
//   3. The on-demand download of the release asset into the user cache
//      (DM-886) — what gives a *published* consumer a helper, since `tools/`
//      isn't shipped. Lazy: this runs only when 1+2 miss and a helper-eligible font
//      is actually requested. Returns undefined on any failure → fontkit.
function resolveHelperPath(platform: NodeJS.Platform = process.platform): string | undefined {
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

// Module-level helper-process state, memoized for the lifetime of the Node
// process (one render run). `helperAvailable`/`helperPath` cache the one-time
// availability probe; the long-lived server fds below are lazily opened on first
// use and reused for every glyph query. This is intentionally process-global
// (single-process model) — there is no reset hook because a fresh process starts
// clean and the helper binary/path can't change mid-run.
let helperAvailable: boolean | null = null;
let helperPath: string | undefined;
export function isGlyphHelperAvailable(): boolean {
  if (helperAvailable != null) return helperAvailable;
  if (process.env.DOMOTION_DISABLE_HELPER) { helperAvailable = false; return false; }
  helperPath = resolveHelperPath();
  helperAvailable = helperPath != null && existsSync(helperPath);
  return helperAvailable;
}

interface PathCommand { command: string; args: number[] }

interface GlyphHelperGlyph {
  id: number;
  advanceWidth: number;
  path: { commands: PathCommand[] };
  codePoints?: number[];
}

interface MetaResponse {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition?: number;
  underlineThickness?: number;
  strikeoutPosition?: number;
  strikeoutThickness?: number;
  /** False when the helper could not guarantee the face is the requested
   *  PostScript name — the by-name-only route, where the platform substitutes a
   *  default for an unknown name rather than failing. Absent from older helper
   *  binaries, so treat only an explicit `false` as a negative. */
  nameMatched?: boolean;
  /** How the face was resolved: `nameMatchedInFile` | `firstFaceNoNameRequested`
   *  | `byNameVerified` | `byNameUnverified` | `systemUI`. Diagnostic. */
  resolution?: string;
  /** The PostScript name of the face actually opened. */
  postscriptName?: string;
}

interface GlyphResponse {
  id: number;
  advance: number;
  bbox: { x: number; y: number; w: number; h: number };
  d: string;
}

// Parse the Swift helper's SVG path-data string into fontkit's command-array
// format. The helper emits exactly: `M x y`, `L x y`, `Q cx cy x y`,
// `C c1x c1y c2x c2y x y`, `Z` — space-separated, no relative variants.
function parseSvgPath(d: string): PathCommand[] {
  if (d.length === 0) return [];
  const tokens = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: PathCommand[] = [];
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i++];
    switch (t) {
      case "M": out.push({ command: "moveTo", args: [num(), num()] }); break;
      case "L": out.push({ command: "lineTo", args: [num(), num()] }); break;
      case "Q": out.push({ command: "quadraticCurveTo", args: [num(), num(), num(), num()] }); break;
      case "C": out.push({ command: "bezierCurveTo", args: [num(), num(), num(), num(), num(), num()] }); break;
      case "Z": out.push({ command: "closePath", args: [] }); break;
    }
  }
  return out;
}

// Every helper path command is a run of (x, y) pairs — moveTo/lineTo carry one,
// quadraticCurveTo two, bezierCurveTo three, closePath none — so the y values
// are always the odd-indexed args.
function pathMinY(commands: PathCommand[]): number | null {
  let min: number | null = null;
  for (const c of commands) {
    for (let i = 1; i < c.args.length; i += 2) {
      if (min == null || c.args[i] < min) min = c.args[i];
    }
  }
  return min;
}

function translateCommandsY(commands: PathCommand[], dy: number): PathCommand[] {
  if (dy === 0) return commands;
  return commands.map((c) => {
    if (c.args.length === 0) return c;
    const args = c.args.slice();
    for (let i = 1; i < args.length; i += 2) args[i] += dy;
    return { command: c.command, args };
  });
}

/** Glyph ids sampled to measure a face's outline offset. Low ids so every font
 *  has them; a spread so a few blank ones (`.notdef`, space) still leave inked
 *  samples to compare. */
export const OFFSET_PROBE_GLYPHS = [3, 4, 5, 6, 7, 8, 15, 20];

/**
 * DM-1831: the vertical offset between the outline CoreText hands us
 * (`CTFontCreatePathForGlyph`) and the box CoreText says the glyph occupies
 * (`CTFontGetBoundingRectsForGlyphs`). Chrome paints at the BOUNDING RECT, so
 * where the two disagree the raw outline lands in the wrong place.
 *
 * Apple Color Emoji is the one macOS face where they disagree: CoreText reports
 * every one of its glyphs 100 units (0.125 em at its 800 upem) BELOW the
 * outline it returns for that same glyph — unanimous across 102 outline glyphs,
 * and matching Chrome's painted output exactly (dx 0, dy -100.0, pixel-exact at
 * font-size 800, where one unit is one px). Ten ordinary faces (Helvetica,
 * Apple Symbols, Hiragino Sans, Times New Roman, Menlo, Zapf Dingbats, STIX Two
 * Math, Geeza Pro, Thonburi, Kohinoor Devanagari) report exactly 0 across 600
 * glyphs each. The visible symptom was a lone U+20E3 COMBINING ENCLOSING KEYCAP
 * — one of the few Apple Color Emoji glyphs that is a real outline rather than
 * an sbix bitmap, so it takes the glyph-path pipeline instead of the
 * raster-overlay one — painting its box ~4 px high at font-size 32.
 *
 * The offset is a property of the FACE, so it is measured once per font and
 * never per glyph, and only from a UNANIMOUS, MATERIAL reading. Both guards
 * earn their place: `pathMinY` is a control-point minimum while CoreText's rect
 * is a tight curve bound, so a face whose extrema sit off its control points
 * reports sub-unit noise rather than a real offset (PingFang SC scatters deltas
 * of 0 to -1 unit at 1000 upem). A genuine offset is two orders of magnitude
 * larger, so requiring agreement AND at least 1% of the em keeps that noise
 * from being read as signal.
 *
 * `probeUnitsPerEm` is the size the probe glyphs were requested at; the result
 * is scaled into the font's design-unit space.
 */
export function measureOutlineOffsetY(
  glyphs: GlyphResponse[], unitsPerEm: number, probeUnitsPerEm: number,
): number {
  const seen: number[] = [];
  for (const g of glyphs) {
    if (g == null || g.d.length === 0 || g.bbox == null) continue;
    const minY = pathMinY(parseSvgPath(g.d));
    if (minY == null) continue;
    seen.push(Math.round((g.bbox.y - minY) * unitsPerEm / probeUnitsPerEm));
  }
  if (seen.length === 0) return 0;
  const first = seen[0];
  if (!seen.every((v) => v === first)) return 0;
  return Math.abs(first) >= unitsPerEm * 0.01 ? first : 0;
}

// Spawn the helper once, request meta + a batch of glyphs in one envelope.
interface HelperRequest {
  fonts: Array<{ ref: string; postscriptName?: string; fontPath?: string; size: number; variations?: Record<string, number> }>;
  queries: Array<
    | { type: "meta"; fontRef: string }
    | { type: "glyphs"; fontRef: string; glyphs: Array<{ cp?: number; id?: number }> }
    // `cssWeight` / `bold` / `italic` drive the in-family re-selection the macOS
    // helper performs after the cascade walk (Blink's
    // `GetAlternateFontPlatformData`). Absent → the nominated face stands.
    | { type: "fallback"; fontRef: string; cps: number[]; cssWeight?: number; bold?: boolean; italic?: boolean }
    // DM-1878: the style fields pick the CUT within the family — on Windows
    // `GetFirstMatchingFont(weight, stretch, style)`, i.e. what
    // `matchFamilyStyle(name, font_description.SkiaFontStyle())` bottoms out in.
    // Absent → DirectWrite's default face, which is what Blink's presence probe
    // `matchFamilyStyle(name, SkFontStyle())` asks for, so omitting them is the
    // correct transcription for a presence check rather than just a fallback.
    | {
        type: "family"; name: string;
        cssWeight?: number; italic?: boolean; cssSlant?: number; cssStretch?: number;
      }
    | { type: "shape"; fontRef: string; text: string }
    // DM-1886 (Linux): per-codepoint fallback via fontconfig sort-and-walk.
    | { type: "fcfallback"; lang: string; cps: number[] }
  >;
}
// DM-1028: one shaped glyph from the CoreText `shape` query. Coordinates are
// in font design units, y-up. `cluster` is the UTF-16 source index in the
// shaped text; `ax`/`ay` are the glyph advance and `dx`/`dy` the GPOS offset
// from the glyph's pen origin. `d` is the outline (drawn from the run's own
// CoreText font, so a sub-substitution still draws the right glyph).
interface ShapeResponseGlyph {
  id: number;
  cluster: number;
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  d: string;
}
interface FallbackResponseEntry {
  cp: number;
  found: boolean;
  postscriptName?: string;
  familyName?: string;
  path?: string;
  /** DM-1721 (win32 helper ≥0.2.0): when the mapped face is a variable-font
   *  instance, the axis location DirectWrite resolved it to (e.g.
   *  `{wght: 400, opsz: 10.5}` for "Segoe UI Variable Text" — DirectWrite pins
   *  named optical subfamilies at a fixed opsz at every font size). Absent for
   *  static faces, the macOS/Linux helpers, and older win32 binaries. */
  axes?: Record<string, number>;
}
interface FamilyResponse {
  type: "family";
  found: boolean;
  postscriptName?: string;
  familyName?: string;
  path?: string;
  /** DM-1721: resolved axis values of a variable-face match (win32 ≥0.2.0). */
  axes?: Record<string, number>;
}
interface HelperResponse {
  results: Array<
    | (MetaResponse & { type: "meta" })
    | { type: "glyphs"; glyphs: GlyphResponse[] }
    | { type: "fallback"; fonts: FallbackResponseEntry[] }
    | FamilyResponse
    | { type: "shape"; glyphs?: ShapeResponseGlyph[]; error?: string }
  >;
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
    proc = spawn(bin, ["--serve-pipe", name], { stdio: ["ignore", "ignore", "inherit"] });
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
  // macOS (CoreText, DM-1031), Linux (FreeType, DM-1034), and Windows
  // (DirectWrite, DM-1035) all implement `--serve`. An old binary on any
  // platform that predates `--serve` still self-heals: it dies on the unknown
  // flag, the first round-trip fails (EOF / closed stdout), and
  // `persistentDisabled` flips below since `persistentEverWorked` is still
  // false — reverting transparently to the one-shot `spawnSync` path. So the
  // persistent channel is safe to attempt on every platform that ships a helper.
  if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
    persistentDisabled = true;
    return false;
  }
  // DM-1889: Windows gets the same channel over a different carrier. See
  // `startPersistentViaPipe` — a spawned stdio pipe has no OS fd there, which is
  // what DM-1421 hit, but a NAMED pipe opened by path does.
  if (process.platform === "win32") return startPersistentViaPipe(bin);
  try {
    const proc = spawn(bin, ["--serve"], { stdio: ["pipe", "pipe", "inherit"] });
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
    const line = Buffer.from(JSON.stringify(request) + "\n", "utf-8");
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
      if (n > 0) serverLeftover += tmp.toString("utf-8", 0, n);
      else if (n === 0) throw new Error("helper closed stdout"); // EOF
    }
    const nl = serverLeftover.indexOf("\n");
    const respLine = serverLeftover.slice(0, nl);
    serverLeftover = serverLeftover.slice(nl + 1);
    const resp = JSON.parse(respLine) as HelperResponse;
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

function callHelper(request: HelperRequest): HelperResponse {
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
    return persistent;
  }
  // Fallback: original one-shot spawnSync.
  const proc = spawnSync(bin, [], {
    input: JSON.stringify(request),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024
  });
  profAccum("helper-spawnSync", profNow() - _t0);
  if (proc.status !== 0) {
    throw new Error(`glyph helper failed (exit ${proc.status}): ${proc.stderr}`);
  }
  return JSON.parse(proc.stdout);
}

export interface GlyphHelperFontInstance {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  underlinePosition: number;
  underlineThickness: number;
  "OS/2"?: { yStrikeoutPosition?: number; yStrikeoutSize?: number };
  availableFeatures?: string[];
  /** DM-1033: batch-fetch coverage for every codepoint in `cps` in ONE helper
   *  round-trip, priming the cache so subsequent per-codepoint
   *  `glyphForCodePoint` checks (the font-run-splitting walk) hit cache instead
   *  of issuing one round-trip each. Already-cached / known-missing codepoints
   *  are skipped. */
  warmGlyphs(cps: number[]): void;
  /** DM-1037: batch the per-run `shape` queries. `layout(text)` issues one
   *  `shape` helper round-trip per distinct run text; pre-warming every run
   *  text of an element here collapses them into ONE envelope (many `shape`
   *  queries → one round-trip), priming the same per-run-text shape cache that
   *  `layout()` reads. Only texts this font FULLY covers are warmed — mirroring
   *  `layout()`'s shape gate — so a text the layout call would never shape isn't
   *  speculatively shaped. Already-cached texts are skipped. Populating the
   *  cache never changes which result `layout()` returns, so the emitted runs
   *  stay byte-identical to the lazy per-run path. */
  warmShapes(texts: string[]): void;
  glyphForCodePoint(cp: number): GlyphHelperGlyph;
  getGlyph(id: number): GlyphHelperGlyph;
  layout(text: string, features?: string[]): {
    glyphs: GlyphHelperGlyph[];
    positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
    /** DM-1028: per-glyph UTF-16 source index in `text` (CoreText cluster).
     *  Present whenever the run was shaped via the CoreText `shape` query;
     *  the renderer uses it to anchor each cluster at its captured xOffset and
     *  to lay multi-glyph clusters (dotted circle + mark, conjuncts) out from
     *  that single anchor. Absent only when shaping fell back to the naive
     *  per-codepoint path. */
    clusters?: number[];
  };
}

export function createGlyphHelperFont(spec: {
  postscriptName?: string;
  fontPath?: string;
  /** DM-1721: axis location to open a VARIABLE file at. DirectWrite opening a
   *  variable file by path yields the DEFAULT fvar instance (it does not apply
   *  axes internally the way CoreText named faces do), so Windows callers pass
   *  the resolved location here; the helper applies it via
   *  IDWriteFontResource::CreateFontFace. Omitted on macOS. */
  variations?: Record<string, number>;
}): GlyphHelperFontInstance | null {
  if (!isGlyphHelperAvailable()) return null;

  // Open at size=1000 first so we can read unitsPerEm. Then re-open at
  // size=unitsPerEm so all glyph paths come back in design-unit space — this
  // matches fontkit's coordinate convention so the existing
  // `scale(fontSize/unitsPerEm, ...)` transform in text-to-path.ts works.
  let metaResp: MetaResponse;
  let offsetProbe: GlyphResponse[] = [];
  try {
    const probe = callHelper({
      fonts: [
        { ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, variations: spec.variations, size: 1000 },
        // DM-1831: a SECOND handle on the same face, opened by system NAME
        // rather than by file. See `outlineOffsetY` — CoreText only reports the
        // Apple Color Emoji baseline adjustment through the system-registered
        // font, so the by-path handle above can never observe it.
        ...(spec.postscriptName != null && spec.variations == null
          ? [{ ref: "n", postscriptName: spec.postscriptName, size: 1000 }]
          : [])
      ],
      queries: [
        { type: "meta" as const, fontRef: "f" },
        ...(spec.postscriptName != null && spec.variations == null
          ? [
            // Ask what the by-NAME handle actually resolved to before trusting
            // its geometry — see the guard below.
            { type: "meta" as const, fontRef: "n" },
            { type: "glyphs" as const, fontRef: "n", glyphs: OFFSET_PROBE_GLYPHS.map((id) => ({ id })) },
          ]
          : [])
      ]
    });
    const r = probe.results[0];
    if (r.type !== "meta") throw new Error("unexpected response shape");
    metaResp = r;
    const nMeta = probe.results[1];
    const r1 = probe.results[2];
    // The by-name handle is opened WITHOUT a file, so the platform substitutes a
    // default when it cannot resolve the name rather than failing. CoreText
    // refuses to resolve Apple's dot-prefixed system names that way and returns
    // TimesNewRomanPSMT — measured for `.SFDevanagari-Regular`,
    // `.ThonburiUI-Regular`, `.SFBangla-Regular` and every sibling. Reading a
    // face-wide baseline correction off Times and applying it to a Devanagari
    // face would translate every glyph in the run by a wrong amount, so use this
    // probe only when the handle is confirmed to BE the requested face.
    //
    // In practice the existing unanimity + 1%-of-em guards in
    // `measureOutlineOffsetY` currently zero those readings out, so this is
    // defense in depth rather than a fix for a live misrender — but it removes
    // the dependence on two thresholds happening to absorb a wrong font's
    // geometry.
    const byNameIsRequestedFace = nMeta != null && nMeta.type === "meta"
      && nMeta.nameMatched !== false
      && (nMeta.postscriptName == null || nMeta.postscriptName === spec.postscriptName);
    if (byNameIsRequestedFace && r1 != null && r1.type === "glyphs") offsetProbe = r1.glyphs;
  } catch {
    return null;
  }

  const unitsPerEm = metaResp.unitsPerEm;
  const renderSize = unitsPerEm;

  // Per-(cp, id) caches — each glyph is fetched at most once per Node process.
  const cpToGlyph = new Map<number, GlyphHelperGlyph>();
  const idToGlyph = new Map<number, GlyphHelperGlyph>();
  const missingCp = new Set<number>();

  // Probe glyphs come back in the 1000-unit probe space; scale to design units.
  const outlineOffsetY = measureOutlineOffsetY(offsetProbe, unitsPerEm, 1000);

  /** Parse a helper outline into the renderer's command space, moved to where
   *  CoreText (and therefore Chrome) actually paints it. */
  function glyphCommands(d: string): PathCommand[] {
    return translateCommandsY(parseSvgPath(d), outlineOffsetY);
  }
  // DM-1028: per-run-text shape cache so identical runs shape once.
  const shapeCache = new Map<string, ShapeResponseGlyph[] | null>();

  // Ingest a `glyphs` query result for the codepoints in `need`, populating
  // `cpToGlyph` / `missingCp` / `idToGlyph`. Shared by the lazy `fetchByCps`
  // path and the combined coverage+shape primer (DM-1033).
  function ingestGlyphs(need: number[], glyphs: GlyphResponse[]): void {
    for (let i = 0; i < need.length; i++) {
      const cp = need[i];
      const g = glyphs[i];
      if (g == null) {
        missingCp.add(cp);
        continue;
      }
      // DM-1018: a glyph id of 0 is `.notdef` — the font doesn't cover this
      // codepoint. We STILL store the glyph (with its outline) rather than
      // marking it missing, because Blink draws the primary font's `.notdef`
      // for uncovered codepoints and that outline is often inked (SF Compact's
      // `.notdef` is the SignWriting stripes frame). `glyphForCodePoint(cp).id`
      // still reports 0, so the fallback-chain coverage check (`id !== 0`)
      // correctly treats the codepoint as uncovered and keeps walking; the
      // stored outline is only ever emitted when the renderer deliberately
      // paints the primary's `.notdef` (the DM-1018 terminal in
      // splitTextIntoFontRuns).
      const glyph: GlyphHelperGlyph = {
        id: g.id,
        advanceWidth: g.advance,
        path: { commands: glyphCommands(g.d) },
        codePoints: [cp]
      };
      cpToGlyph.set(cp, glyph);
      if (g.id !== 0) idToGlyph.set(g.id, glyph);
    }
  }

  function fetchByCps(cps: number[]): void {
    const need = cps.filter((cp) => !cpToGlyph.has(cp) && !missingCp.has(cp));
    if (need.length === 0) return;
    const resp = callHelper({
      fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, variations: spec.variations, size: renderSize }],
      queries: [{ type: "glyphs", fontRef: "f", glyphs: need.map((cp) => ({ cp })) }]
    });
    const r = resp.results[0];
    if (r.type !== "glyphs") return;
    ingestGlyphs(need, r.glyphs);
  }

  function fetchById(id: number): GlyphHelperGlyph {
    const cached = idToGlyph.get(id);
    if (cached != null) return cached;
    const resp = callHelper({
      fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, variations: spec.variations, size: renderSize }],
      queries: [{ type: "glyphs", fontRef: "f", glyphs: [{ id }] }]
    });
    const r = resp.results[0];
    if (r.type !== "glyphs") {
      const empty: GlyphHelperGlyph = { id, advanceWidth: 0, path: { commands: [] } };
      idToGlyph.set(id, empty);
      return empty;
    }
    const g = r.glyphs[0];
    const glyph: GlyphHelperGlyph = {
      id: g.id,
      advanceWidth: g.advance,
      path: { commands: glyphCommands(g.d) }
    };
    idToGlyph.set(id, glyph);
    return glyph;
  }

  function notdef(id = 0): GlyphHelperGlyph {
    return { id, advanceWidth: 0, path: { commands: [] } };
  }

  // DM-1028: shape `text` with CoreText (CTLine) → the shaped glyph stream
  // (ids, advances, GPOS offsets, source clusters, outlines). Returns null on
  // any helper error so `layout()` can fall back to the naive per-codepoint
  // path. Cached per run text.
  function shapeText(text: string): ShapeResponseGlyph[] | null {
    const cached = shapeCache.get(text);
    if (cached !== undefined) return cached;
    let shaped: ShapeResponseGlyph[] | null = null;
    try {
      const resp = callHelper({
        fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, variations: spec.variations, size: renderSize }],
        queries: [{ type: "shape", fontRef: "f", text }]
      });
      const r = resp.results[0];
      if (r.type === "shape" && Array.isArray(r.glyphs)) shaped = r.glyphs;
    } catch {
      shaped = null;
    }
    shapeCache.set(text, shaped);
    return shaped;
  }

  return {
    unitsPerEm,
    ascent: metaResp.ascent ?? 0,
    descent: metaResp.descent ?? 0,
    underlinePosition: metaResp.underlinePosition ?? 0,
    underlineThickness: metaResp.underlineThickness ?? 0,
    "OS/2": {
      yStrikeoutPosition: metaResp.strikeoutPosition,
      yStrikeoutSize: metaResp.strikeoutThickness
    },
    availableFeatures: [],

    warmGlyphs(cps: number[]): void {
      fetchByCps(cps);
    },

    // DM-1037: batch the per-run `shape` round-trips. Mirrors `shapeText`'s
    // per-text behavior exactly (same `{type:"shape",fontRef:"f",text}` query,
    // same result-parsing, same cache write) but folds every text into ONE
    // envelope so the helper is consulted once instead of once per run. Each
    // batched query produces the identical result the lazy single-query call
    // would, so the populated cache is byte-identical to lazily shaping.
    warmShapes(texts: string[]): void {
      const need: string[] = [];
      const seen = new Set<string>();
      for (const t of texts) {
        if (t.length === 0 || seen.has(t) || shapeCache.has(t)) continue;
        seen.add(t);
        // Gate identical to `layout()`'s: only shape a run this font FULLY
        // covers. Coverage must already be known (the selection walk / the
        // DM-1036 coverage pre-warm populated it); if it isn't, conservatively
        // skip and let `layout()` shape this text lazily — no behavior change,
        // just no batching win for that one text.
        const cps = [...t].map((c) => c.codePointAt(0)!);
        const fullyCovered = cps.every(
          (cp) => cpToGlyph.has(cp) && !missingCp.has(cp) && (cpToGlyph.get(cp)!.id) !== 0
        );
        if (fullyCovered) need.push(t);
      }
      if (need.length === 0) return;
      let resp: HelperResponse;
      try {
        resp = callHelper({
          fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, variations: spec.variations, size: renderSize }],
          queries: need.map((t) => ({ type: "shape" as const, fontRef: "f", text: t }))
        });
      } catch {
        return; // batch failed wholesale — leave cache empty so layout() retries per-text
      }
      for (let i = 0; i < need.length; i++) {
        const r = resp.results[i];
        // A missing result (results array shorter than queries) is left
        // uncached so `layout()` re-issues a single-query shape for it rather
        // than caching a divergent value — preserves byte-identity under a
        // partial batch failure. A present result is parsed exactly as
        // `shapeText` does (including caching `null` on an error/non-shape
        // response, matching the Linux/Windows "unknown query type" path).
        if (r == null) continue;
        const shaped = r.type === "shape" && Array.isArray(r.glyphs) ? r.glyphs : null;
        shapeCache.set(need[i], shaped);
      }
    },

    glyphForCodePoint(cp: number): GlyphHelperGlyph {
      if (missingCp.has(cp)) return notdef(0);
      if (!cpToGlyph.has(cp)) fetchByCps([cp]);
      return cpToGlyph.get(cp) ?? notdef(0);
    },

    getGlyph(id: number): GlyphHelperGlyph {
      return fetchById(id);
    },

    layout(text: string): {
      glyphs: GlyphHelperGlyph[];
      positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
      clusters?: number[];
    } {
      // DM-1028: shape with CoreText so Brahmic clusters (dotted-circle
      // insertion for an orphaned combining mark, conjuncts, mark-to-base
      // GPOS) round-trip. The old naive path mapped one glyph per codepoint
      // with zero offsets — it dropped the dotted circle and every mark
      // position. CoreText's USE shaping matches Chrome's painted cluster for
      // these scripts (fontkit's USE engine is broken for them).
      //
      // Gate: shape ONLY when this font covers every source codepoint. For an
      // UNCOVERED codepoint the renderer's DM-1018 path draws the primary
      // font's `.notdef` (SF Compact's SignWriting stripes, the no-font
      // Brahmic tofu box) — but CTLine, asked to shape an uncovered codepoint,
      // substitutes a DIFFERENT font's tofu, which regressed Sutton SignWriting
      // (was pixel-clean) and the no-font Devanagari-Extended block. So
      // uncovered runs stay on the naive per-codepoint path, where glyph 0's
      // stored `.notdef` outline reaches the renderer unchanged.
      const cps0 = [...text].map((c) => c.codePointAt(0)!);
      fetchByCps(cps0); // batch the coverage probe (cached, reused below)
      const fullyCovered = cps0.every((cp) => !missingCp.has(cp) && (cpToGlyph.get(cp)?.id ?? 0) !== 0);
      const shaped = fullyCovered ? shapeText(text) : null;
      if (shaped != null && shaped.length > 0) {
        // DM-1111: neutralize CoreText's isolated-mark bearing compensation so a
        // LONE combining mark matches Chrome's (HarfBuzz) paint. When a shaped
        // run has NO advancing base glyph — i.e. it's nothing but zero-advance
        // orphan marks with nothing to attach to, as in the per-Unicode-block
        // mark fixtures (Combining Diacritical Marks for Symbols U+20D0–20FF,
        // Tai Tham, …) — CoreText positions each mark with a positive xOffset
        // (dx ≈ −leftSideBearing) that cancels the glyph's native (negative) LSB,
        // so the mark paints AT the pen as if it were spacing. HarfBuzz applies
        // NO such offset for a baseless mark: it paints the outline at its native
        // bearing, with the ink extending LEFT of the pen (verified against
        // Chrome's painted output — the ink lands ~|LSB| px left of where
        // CoreText would place it). Zeroing dx for these glyphs reproduces the
        // HarfBuzz/Chrome position.
        //
        // The gate keys off the SHAPED glyphs, not the source text: if the run
        // contains any advancing glyph (a real base, or the ◌ CoreText inserts
        // for an orphaned Brahmic mark — DM-1028), the marks are genuinely
        // attached to it via GPOS, which Chrome also applies, so their dx is
        // kept untouched. Only when the entire run is zero-advance marks (no base
        // present) is the dx a CoreText-only spacing artifact to drop.
        const hasAdvancingBase = shaped.some((sg) => sg.ax > 0);
        const glyphs: GlyphHelperGlyph[] = [];
        const positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }> = [];
        const clusters: number[] = [];
        for (const sg of shaped) {
          const glyph: GlyphHelperGlyph = {
            id: sg.id,
            advanceWidth: sg.ax,
            // Shaped outlines carry no bounding rect of their own, so they use
            // the font-level offset the coverage probe above already learned
            // (`layout` always runs `fetchByCps` before shaping).
            path: { commands: glyphCommands(sg.d) }
          };
          // Cache the outline by id so a later getGlyph(id) reuses it.
          if (sg.id !== 0 && !idToGlyph.has(sg.id)) idToGlyph.set(sg.id, glyph);
          glyphs.push(glyph);
          const dropBearingComp = !hasAdvancingBase && sg.ax === 0;
          positions.push({ xAdvance: sg.ax, yAdvance: sg.ay, xOffset: dropBearingComp ? 0 : sg.dx, yOffset: sg.dy });
          clusters.push(sg.cluster);
        }
        return { glyphs, positions, clusters };
      }

      // Fallback: naive per-codepoint mapping (CoreText shaping unavailable).
      // Batch every codepoint in one helper call before assembling the result.
      const cps: number[] = [];
      for (const ch of text) cps.push(ch.codePointAt(0)!);
      fetchByCps(cps);

      const glyphs: GlyphHelperGlyph[] = [];
      const positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }> = [];
      for (const cp of cps) {
        const g = cpToGlyph.get(cp) ?? notdef(0);
        glyphs.push(g);
        positions.push({ xAdvance: g.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 });
      }
      return { glyphs, positions };
    }
  };
}

/** Resolved system fallback font for a codepoint Chrome would substitute via
 *  CoreText's `CTFontCreateForString` cascade. `null` when CoreText falls
 *  through to LastResort (Chrome paints its own last-resort tofu there). */
export interface SystemFallbackFont {
  postscriptName: string;
  familyName: string;
  path: string;
  /** DM-1721: the axis location the platform matcher resolved the face to,
   *  when it is a variable-font instance (win32 DirectWrite helper ≥0.2.0
   *  reports this; macOS/Linux resolvers don't). See
   *  `FallbackResponseEntry.axes`. */
  resolvedAxes?: Record<string, number>;
}

// Keyed on `<basePostscriptName>\u0000<cp>\u0000<weight>\u0000<italic>\u0000<size>`,
// NOT on the codepoint alone. CoreText's cascade depends on the font you ask
// FROM — asking for U+20BF from SF Pro Text answers SF Pro Text, while asking
// from Helvetica answers .NewYork. A cp-only key therefore served whichever base
// happened to ask first to every later caller, silently, for the rest of the
// process. The CSS description joins the key for the same reason: the in-family
// re-selection below makes the answer weight- and style-dependent.
const _systemFallbackCache = new Map<string, SystemFallbackFont | null>();
const fallbackCacheKey = (base: string, cp: number, req?: SystemFallbackRequest): string =>
  req == null
    ? `${base}\u0000${cp}`
    // DM-1859: `systemUi` and `stretch` join the key for the same reason the rest
    // of the description did — they change which base the cascade is walked FROM,
    // so a key blind to them would serve a named-family answer to a system-ui run.
    : `${base}\u0000${cp}\u0000${req.weight}\u0000${req.italic ? 1 : 0}\u0000${req.fontSize}\u0000${req.basePath ?? ""}\u0000${req.systemUi ? 1 : 0}\u0000${req.stretch ?? 100}`;

/** The CSS description the fallback answer depends on. CoreText nominates one
 *  face per family for a character; Blink then re-selects WITHIN that family at
 *  the requested traits + weight (`GetAlternateFontPlatformData`,
 *  font_cache_mac.mm), so two runs differing only in weight resolve to different
 *  cuts of the same family. Measured: at weight 700 that moves 8,121 of a
 *  27,790-codepoint stride (29%) off the face CoreText nominated. */
export interface SystemFallbackRequest {
  /** CSS `font-weight` (1..1000). */
  weight: number;
  /** CSS `font-style: italic | oblique`. */
  italic: boolean;
  /** Computed pixel size — what Blink hands CoreText for both the cascade walk
   *  and the in-family re-selection. */
  fontSize: number;
  /** On-disk file of the cascade base, when the caller knows it. REQUIRED for
   *  Apple's hidden `.`-prefixed faces: CoreText refuses to resolve those by
   *  name and hands back Times New Roman WITHOUT erroring, so a name-only lookup
   *  would silently walk the wrong font's cascade. With a path the helper opens
   *  the exact face out of the file. */
  basePath?: string;
  /** DM-1859: the run's primary is the CSS `system-ui` / `BlinkMacSystemFont`
   *  keyword, i.e. the platform UI font.
   *
   *  Blink does not resolve that through family matching — `CreateFontPlatformData`
   *  routes it to `MatchSystemUIFont` (`mac/font_cache_mac.mm:409-412`), which
   *  builds the base with `CTFontCreateUIFontForLanguage`. The UI font carries its
   *  OWN cascade list, the one that reaches Apple's hidden `.…UI` variants, and
   *  only that API returns it: measured, opening `/System/Library/Fonts/SFNS.ttf`
   *  by path answers U+6F22 with `PingFangSC-Regular` at every size, while Chrome
   *  answers `.PingFangUITextSC-Regular` at 13px and `.PingFangUIDisplaySC-Regular`
   *  at 20px. So this is not expressible as a `basePath` — it needs the helper's
   *  `systemUI` base mode.
   *
   *  `stretch` rides along because `MatchSystemUIFont` takes it: at weight 400 and
   *  width 100 it returns the traited font directly, and otherwise applies clamped
   *  `wght`/`wdth` variation axes. */
  systemUi?: boolean;
  /** CSS `font-stretch` as a percentage (100 = normal). Only consulted for the
   *  `systemUi` base, mirroring `MatchSystemUIFont`'s `desired_width`. */
  stretch?: number;
}

/** Authoritative per-codepoint system font fallback, matching Chrome-on-macOS.
 *
 *  Blink's `font_cache_mac.mm::PlatformFallbackFontForCharacter` →
 *  `GetSubstituteFont` calls `CTFontCreateForString(baseFont, str, range)` to
 *  walk CoreText's system cascade and find the font that renders a character
 *  the primary font lacks (returning null when the result is LastResort). This
 *  exposes the same call so the renderer can resolve fallback fonts the way
 *  Chrome actually does, instead of relying on the sampled per-block table.
 *
 *  `GetSubstituteFont` is only half of what Blink does: the cascade nominates
 *  one face per family regardless of the weight the CSS asked for, and
 *  `GetAlternateFontPlatformData` then re-selects within that family at the
 *  requested traits + weight. Pass `req` to get that second half — the helper
 *  runs the same `CTFontCreateWithFontDescriptor` call Blink runs, so a
 *  weight-700 run resolves Songti SC Bold where a weight-400 run resolves Songti
 *  SC Regular. Omitting `req` keeps the nominated face (the pre-DM-1854
 *  behavior), which is what the Windows helper — whose DirectWrite path does its
 *  own weight matching — still wants.
 *
 *  Returns a map from codepoint to the resolved font (or null for LastResort).
 *  Results are memoized process-wide; `basePostscriptName` selects the cascade
 *  base (defaults to Helvetica — a neutral sans base whose system cascade is
 *  what an un-styled element resolves through). Returns an empty map when the
 *  helper binary isn't available (non-macOS / unbuilt). */
/** One fontconfig sort-and-walk answer (DM-1886, Linux only). */
export interface FcFallbackFont {
  path: string;
  /** TTC member index. Blink creates the face by file + index, so a `.ttc`
   *  member is only addressable with it (`font_cache_linux.cc:99-104`). */
  index: number;
  /** Blink reads these back and MUTATES the FontDescription with them — a bold
   *  face raises a sub-bold request; a non-bold face under a bold request turns
   *  on SYNTHETIC bold (`font_cache_linux.cc:106-129`). */
  isBold: boolean;
  isItalic: boolean;
  family?: string;
}

/**
 * Per-codepoint fallback via fontconfig, the way Chrome asks it (DM-1886).
 *
 * Linux only. Returns an empty map when the helper is unavailable OR when it is
 * an older binary that doesn't know the query — the caller then keeps the
 * `fc-match` path. Absence of an answer is never a reason to invent one: a
 * codepoint no font covers reports `found:false` and maps to `null`, which is
 * what Chrome does (`GetFontForCharacter` returns false → the caller keeps its
 * last resort).
 *
 * The helper walks a locale-sorted set and filters by real charset coverage, so
 * unlike `fc-match ":charset="` it cannot return a non-covering face — see the
 * `fcfallback` comment in `tools/linux-glyph-extractor/src/main.cpp`.
 */
const _fcFallbackCache = new Map<string, FcFallbackFont | null>();

export function resolveFcFallbackFonts(
  cps: number[], lang: string = "en",
): Map<number, FcFallbackFont | null> {
  const out = new Map<number, FcFallbackFont | null>();
  if (process.platform !== "linux" || !isGlyphHelperAvailable() || cps.length === 0) return out;
  // DM-1889: memoize per (lang, cp), and ask only about what is not already
  // known. Without this a batch warm would query and discard, leaving the
  // per-codepoint caller to re-ask for every one — the warm would look like it
  // worked while buying nothing. Keyed on lang too because the sorted set the
  // answer comes from is a function of the locale.
  const need: number[] = [];
  for (const cp of cps) {
    const k = `${lang}\u0000${cp}`;
    if (_fcFallbackCache.has(k)) out.set(cp, _fcFallbackCache.get(k)!);
    else need.push(cp);
  }
  if (need.length === 0) return out;
  try {
    const resp = callHelper({ fonts: [], queries: [{ type: "fcfallback", lang, cps: need }] });
    const r: any = resp.results[0];
    // An older helper answers `{error:"unknown query type"}`; treat that as "no
    // helper for this question" rather than as "no font", so the caller falls
    // back instead of tofuing every codepoint.
    if (r == null || r.type !== "fcfallback" || !Array.isArray(r.fonts)) return out;
    for (const e of r.fonts) {
      if (e == null || typeof e.cp !== "number") continue;
      const resolved = e.found === true && typeof e.path === "string" && e.path !== ""
        ? {
            path: e.path,
            index: typeof e.index === "number" ? e.index : 0,
            isBold: e.isBold === true,
            isItalic: e.isItalic === true,
            family: typeof e.family === "string" ? e.family : undefined,
          }
        : null;
      out.set(e.cp, resolved);
      _fcFallbackCache.set(`${lang}\u0000${e.cp}`, resolved);
    }
  } catch {
    return new Map();
  }
  return out;
}

/**
 * The request envelope for a per-codepoint system-fallback query.
 *
 * Split out and platform-parameterised so the one decision that differs between
 * platforms — whether to declare a base font — is explicit and testable rather
 * than an inline branch. That decision was wrong on Windows for a long time, in
 * a way nothing caught (DM-1889).
 *
 * **macOS/Linux declare a base; Windows must not.** The platforms ask genuinely
 * different questions. `CTFontCreateForString` resolves *from* a base face, so on
 * macOS the answer depends on it and omitting it would change results. DirectWrite
 * takes no base at all: the win32 helper's `runFallbackQuery(query, factory)` is
 * not even handed the envelope's font map, so the entry could only ever be inert.
 *
 * It was worse than inert. The base is named ("Helvetica") with no `fontPath`,
 * the win32 helper cannot open a font by family name, and one-shot mode treats an
 * unopenable *declared* font as fatal — it dies before running a single query.
 * With the persistent channel disabled on Windows because a spawned pipe has no
 * OS fd there, one-shot was the ONLY path, so every call came back as an error
 * envelope with no `results` and the caller read that as "no fallback font" for
 * every codepoint.
 *
 * So the live DirectWrite per-codepoint resolver was shipped default-on and never
 * actually answered on Windows; that platform's conformance numbers were scoring
 * the static fallback chain alone. Verified on a Windows 11 host: the identical
 * envelope answers correctly over the persistent channel — where an unopenable
 * ref is merely absent — and errors out one-shot.
 */
export function buildFallbackEnvelope(
  basePostscriptName: string,
  cps: number[],
  req: SystemFallbackRequest | undefined,
  platform: NodeJS.Platform,
): HelperRequest {
  return {
    fonts: platform === "win32" ? [] : [{
      ref: "base", postscriptName: basePostscriptName, size: req?.fontSize ?? 16,
      ...(req?.basePath != null ? { fontPath: req.basePath } : {}),
      // DM-1859: the platform UI font, built the way `MatchSystemUIFont` builds
      // it. The helper derives the symbolic traits from these CSS values itself
      // (Blink's `kBoldThreshold` is 600 and lives on that side), so pass the
      // numbers rather than pre-computed booleans.
      ...(req?.systemUi === true
        ? {
          systemUI: true,
          cssWeight: req.weight,
          cssSlant: req.italic ? 1 : 0,
          cssWidth: req.stretch ?? 100,
        }
        : {}),
    }],
    queries: [{
      // `fontRef` is kept even on Windows, where no base is declared: the helper
      // ignores it for this query, and the macOS/Linux helpers require it. One
      // query shape for all three.
      type: "fallback", fontRef: "base", cps,
      ...(req != null
        // `bold` mirrors Blink's `platform_data.synthetic_bold_` OR: our base
        // font stands in for the run primary at its regular cut, so a bold
        // request arrives as the synthetic trait rather than in the face.
        ? { cssWeight: req.weight, bold: req.weight >= 600, italic: req.italic }
        : {}),
    }],
  };
}

export function resolveSystemFallbackFonts(
  cps: number[],
  basePostscriptName: string = "Helvetica",
  req?: SystemFallbackRequest,
): Map<number, SystemFallbackFont | null> {
  const out = new Map<number, SystemFallbackFont | null>();
  if (!isGlyphHelperAvailable()) return out;
  const need: number[] = [];
  for (const cp of cps) {
    if (_systemFallbackCache.has(fallbackCacheKey(basePostscriptName, cp, req))) out.set(cp, _systemFallbackCache.get(fallbackCacheKey(basePostscriptName, cp, req))!);
    else need.push(cp);
  }
  if (need.length === 0) return out;
  let resp: HelperResponse;
  try {
    resp = callHelper(buildFallbackEnvelope(basePostscriptName, need, req, process.platform));
  } catch {
    // Helper failure → treat all as unresolved this call (don't poison cache).
    for (const cp of need) out.set(cp, null);
    return out;
  }
  const r = resp.results[0];
  if (r == null || r.type !== "fallback") {
    for (const cp of need) out.set(cp, null);
    return out;
  }
  for (const e of r.fonts) {
    const resolved: SystemFallbackFont | null = e.found && e.path && e.postscriptName
      ? { postscriptName: e.postscriptName, familyName: e.familyName ?? "", path: e.path, resolvedAxes: e.axes }
      : null;
    _systemFallbackCache.set(fallbackCacheKey(basePostscriptName, e.cp, req), resolved);
    out.set(e.cp, resolved);
  }
  return out;
}

/** A real installed font resolved by name via CoreText (macOS) or the
 *  DirectWrite system font collection (Windows, DM-1721). */
export interface InstalledFont {
  postscriptName: string;
  familyName: string;
  path: string;
  /** DM-1721: axis location the matcher resolved a VARIABLE face to (win32
   *  helper ≥0.2.0). For named optical subfamilies ("Segoe UI Variable Text")
   *  this carries the fixed opsz DirectWrite pins at every font size. */
  resolvedAxes?: Record<string, number>;
}

const _installedFontCache = new Map<string, InstalledFont | null>();

/** Resolve a CSS font-family NAME to a real installed font, the way Blink's
 *  FontFallbackList picks `first_candidate_` — the first family in the stack
 *  that actually loads (font_fallback_iterator.cc). Backed by
 *  `CTFontCreateWithName` on macOS (with a name-match guard so a substituted
 *  default doesn't masquerade as the requested family) and, since DM-1721, by
 *  the DirectWrite system font collection's exact `FindFamilyName` lookup on
 *  Windows (win32 helper ≥0.2.0; older binaries answer the query with an
 *  error → null, preserving the previous fall-through). Returns null when the
 *  name isn't a real installed font (caller keeps walking the stack), or when
 *  the helper binary isn't available (Linux / unbuilt). Memoized
 *  process-wide. */
/**
 * Families to pretend are not installed, from `DOMOTION_HIDE_FAMILIES`
 * (comma-separated, case-insensitive).
 *
 * Font selection is only correct when it matches what Chrome paints ON THE SAME
 * MACHINE, and machines genuinely differ: a developer Mac carrying Apple's
 * downloadable SF Pro and Google's Noto Sans resolves a stack quite differently
 * from a stock install or a CI runner. That asymmetry made a whole class of
 * "wrong font" failures reproduce only on CI, which is a terrible place to
 * debug — every iteration is a push and a sweep.
 *
 * This makes the leaner machine reproducible on the richer one:
 *
 *   DOMOTION_HIDE_FAMILIES="SF Pro Text,SF Pro Display,SF Pro,Noto Sans" \
 *     npx tsx tests/html-test-suite.tsx --only 0400-04FF-cyrillic
 *
 * It hides families from *our* resolver only — Chrome still sees them, so the
 * expected paint is unchanged. That makes it a debugging instrument for "what
 * would our resolver pick without this font", NOT a simulation of the runner
 * (whose Chrome also lacks them). Read the two sides accordingly.
 */
function hiddenFamilies(): Set<string> {
  const raw = process.env.DOMOTION_HIDE_FAMILIES;
  if (raw == null || raw.trim() === "") return new Set();
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== ""));
}

/**
 * The run's CSS style, for callers that want the FACE a family resolves to
 * rather than merely whether the family exists (DM-1878).
 *
 * These are two different Blink calls with the same API, and conflating them is
 * what made a weight-700 Windows run paint the regular cut:
 *
 *  - `IsFontPresent` is `matchFamilyStyle(name, SkFontStyle())` — the DEFAULT
 *    style (`win/font_fallback_win.cc:54-59`). Omit `style` for this.
 *  - face selection is `matchFamilyStyle(name, font_description.SkiaFontStyle())`
 *    — the run's real style (`fonts/skia/font_cache_skia.cc:293-295`, reached
 *    from `CreateTypeface`). Pass `style` for this.
 *
 * Windows only in practice: DirectWrite picks the cut inside the family lookup,
 * whereas the macOS helper's `family` query is a CoreText name resolution with
 * its own in-family re-selection step downstream. (Chromium rev 7d859f27.)
 */
export interface InstalledFontStyle {
  /** CSS `font-weight`, 1–1000. Blink clamps outside that to normal. */
  weight?: number;
  /** Italic FLAG, for the common case where the renderer has no angle. */
  italic?: boolean;
  /** CSS `font-style` angle when known; >0 italic, >14 oblique. */
  slant?: number;
  /** CSS `font-stretch` percentage; 100 is normal. */
  stretch?: number;
}

export function resolveInstalledFont(
  name: string, style?: InstalledFontStyle,
): InstalledFont | null {
  const nameKey = name.toLowerCase();
  if (hiddenFamilies().has(nameKey)) return null;
  // The style joins the cache key for the same reason the cascade base does in
  // `systemFallbackKeyCache`: the answer is a function of the style you ask
  // with, so a style-blind key would serve whichever style asked FIRST to every
  // later caller — and the presence probe (no style) usually asks first.
  const key = style == null
    ? nameKey
    : `${nameKey}|${style.weight ?? 400}|${style.italic === true ? 1 : 0}|${style.slant ?? 0}|${style.stretch ?? 100}`;
  if (_installedFontCache.has(key)) return _installedFontCache.get(key)!;
  let resolved: InstalledFont | null = null;
  if (isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({ fonts: [], queries: [{
        type: "family", name,
        // Omitted entirely when there is no style, so the request is
        // byte-identical to the pre-DM-1878 one and an older helper binary
        // behaves exactly as before.
        ...(style != null ? {
          cssWeight: style.weight ?? 400,
          italic: style.italic === true,
          cssSlant: style.slant ?? 0,
          cssStretch: style.stretch ?? 100,
        } : {}),
      }] });
      const r = resp.results[0];
      if (r != null && r.type === "family" && r.found && r.path && r.postscriptName) {
        resolved = { postscriptName: r.postscriptName, familyName: r.familyName ?? "", path: r.path, resolvedAxes: r.axes };
      }
    } catch { resolved = null; }
  }
  _installedFontCache.set(key, resolved);
  return resolved;
}

/**
 * Drop the in-memory glyph-resolution caches: the helper-availability probe
 * result + resolved path, and the system-fallback / installed-font lookup
 * caches. Exposed for parity with `clearWebfonts` / `clearGlyphDefs`.
 *
 * DM-1073: this deliberately does NOT tear down the persistent `--serve`
 * channel (`serverProc` / `serverInFd` / `serverOutFd` / `serverLeftover`) or
 * reset the `persistentDisabled` latch. That channel is process-lifetime by
 * design — spawned lazily on first use and reaped by the `process.on("exit")`
 * hook (`_persistentExitHookInstalled`), reused across captures. A cache-clear
 * is not a shutdown, so the live serve process and its disabled-latch persist.
 */
/**
 * Test-only: the RAW `meta` response for a face, so a suite can tell a stale
 * helper binary from a font regression (DM-1873).
 *
 * The binary is a gitignored build artifact, and `isGlyphHelperAvailable()`
 * answers "is one resolvable", not "does it speak the interface this Node side
 * reads" — a fresh worktree resolves the downloaded RELEASE ASSET, which can
 * predate fields added since. When that happens the helper suites do not skip;
 * they run and fail on missing data, and the failures read as a font regression.
 * `--version` cannot distinguish them: it reports a binary version that was not
 * bumped when `nameMatched` / `resolution` were added.
 *
 * Not part of the runtime contract — the renderer treats every field here as
 * optional and degrades correctly on an older binary (see `MetaResponse`).
 */
export function __helperMetaForTest(postscriptName: string): MetaResponse | null {
  if (!isGlyphHelperAvailable()) return null;
  try {
    const resp = callHelper({
      fonts: [{ ref: "f", postscriptName, size: 16 }],
      queries: [{ type: "meta", fontRef: "f" }],
    });
    const r = resp.results[0];
    return r != null && r.type === "meta" ? (r as unknown as MetaResponse) : null;
  } catch {
    return null;
  }
}

export function clearGlyphHelperCache(): void {
  helperAvailable = null;
  helperPath = undefined;
  _systemFallbackCache.clear();
  _fcFallbackCache.clear();
  _installedFontCache.clear();
}
