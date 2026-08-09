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
import { hostPlatform } from "./host-platform.js";
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
  /** DM-1880: CoreText's `kCTFontTraitBold` / `kCTFontTraitItalic` symbolic
   *  traits for the resolved face. macOS's synthetic-bold rule asks the TRAIT
   *  rather than a weight number (`mac/font_cache_mac.mm:424-427`), and the two
   *  disagree often enough that substituting a weight regressed a fixture.
   *  Absent from helper binaries predating the field. */
  traitBold?: boolean;
  traitItalic?: boolean;
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
    // `baseFamilyName` / `locale` are the win32 helper's two remaining
    // `MapCharacters` arguments (DM-1871 / DM-1896); the macOS and Linux helpers
    // ignore both.
    | {
        type: "fallback"; fontRef: string; cps: number[];
        cssWeight?: number; bold?: boolean; italic?: boolean;
        baseFamilyName?: string; locale?: string;
      }
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
    // macOS declared-family style match — Blink's `BestStyleMatchForFamilyNS`
    // over `NSFontManager.availableMembersOfFontFamily`, compared with
    // `BetterChoiceCT` (nearest CSS weight, bold in the trait-precedence loop;
    // `platform/fonts/mac/font_matcher_mac.mm:172-277` at Chromium tag
    // 147.0.7727.15, the build Playwright pins). This is the step that picks
    // WHICH CUT of a declared family a run opens; the `family` query above is
    // name resolution and does not run it.
    | { type: "familyMatch"; family: string; cssWeight?: number; italic?: boolean; bold?: boolean;
        /** CSS `font-stretch` as a percentage (100 = `normal`). The helper turns
         *  it into the condensed / expanded symbolic trait the way Blink's
         *  `ComputeDesiredTraits` does. Absent = 100, i.e. the previous behavior. */
        cssWidth?: number }
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
  /** macOS only: the substituted CTFont handle's variation axes (CT order) with
   *  the handle's CURRENT position (`value` = CTFontCopyVariation overlay the
   *  axis default). Blink clones the substituted typeface at `opsz` = the CSS
   *  specified size only when that differs from this current position
   *  (`VariableAxisChangeEffective`), and CoreText pre-sets `opsz` on SOME
   *  substituted handles — so whether Chrome renames the face with baked-in
   *  coordinates is a property of the handle, only observable here. Absent for
   *  static faces and older helper binaries. */
  ctAxes?: Array<{ tag: string; min: number; def: number; max: number; value: number }>;
  /** Whether the reported face actually has a glyph for `cp`, decided inside the
   *  helper where the font is already open. The caller needs this — Blink's
   *  fallback iterator only uses a stage's font when it has a glyph — and until
   *  the helper answered it, the caller asked in a SECOND round trip.
   *
   *  It cannot be inferred from `found`: `CTFontCreateForString` does return a
   *  face that renders the string, but the in-family re-selection Blink runs on
   *  the nomination replaces it with a different cut at the requested traits,
   *  and that cut need not carry the character.
   *
   *  Absent on older helper binaries, which is why the caller keeps its probe as
   *  a fallback rather than treating a missing field as "not covered". */
  covered?: boolean;
}
interface FamilyResponse {
  type: "family";
  found: boolean;
  postscriptName?: string;
  familyName?: string;
  path?: string;
  /** DM-1721: resolved axis values of a variable-face match (win32 ≥0.2.0). */
  axes?: Record<string, number>;
  /** macOS only (helper ≥ the build carrying the family-query axis report):
   *  the resolved CTFont handle's variation axes with its CURRENT position —
   *  same encoding as `FallbackResponseEntry.ctAxes`. For a variable family
   *  this identifies the FACE the name denotes: CoreText resolves AppKit
   *  member / named-instance / clone names ("Skia-Regular_Light") to a handle
   *  whose variation is already at that instance's coordinates. Absent for
   *  static faces and older binaries. */
  ctAxes?: Array<{ tag: string; min: number; def: number; max: number; value: number }>;
}
interface FamilyMatchResponse {
  type: "familyMatch";
  found: boolean;
  /** The chosen family member's PostScript name. */
  postscriptName?: string;
  /** The chosen member's CSS weight, as the matcher scored it. */
  weight?: number;
  /** Every family member the matcher scanned, in enumeration order. */
  candidates?: Array<{
    name: string; weight: number; descriptorWeight: number;
    /** `CTFontSymbolicTraits` masked to italic / bold / condensed / expanded. */
    traits: number; appKitWeight: number; appKitTraits: number;
  }>;
  // Linux helper only (the fontconfig transcription of Skia's
  // `SkFontConfigInterfaceDirect::matchFamilyName`): the resolved file, its
  // TTC member index, the matched family, and the matched face's style as
  // Skia would report `outStyle` — Blink consults that for synthetic bold /
  // italic, so the Node side needs the same numbers.
  path?: string;
  index?: number;
  family?: string;
  width?: number;
  italic?: boolean;
}
interface HelperResponse {
  results: Array<
    | (MetaResponse & { type: "meta" })
    | { type: "glyphs"; glyphs: GlyphResponse[] }
    | { type: "fallback"; fonts: FallbackResponseEntry[] }
    | FamilyResponse
    | FamilyMatchResponse
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

/**
 * A shaped run: glyph ids with their positions and source-cluster mapping.
 *
 * Deliberately carries NO outlines. See `shapeFallback` — the point of this
 * shape is that shaping and outline production can come from different engines.
 */
export interface ShapedRunFallback {
  ids: number[];
  positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
  clusters: number[];
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
  /**
   * DM-1883: a shaper to use when THIS helper has no `shape` query.
   *
   * Not every platform helper implements `shape`. macOS does; the Windows
   * DirectWrite helper implements only `fallback`/`family`/`glyphs`/`meta`. On a
   * helper without it, `shapeText()` can never succeed, so every shaped run fell
   * through to the naive per-codepoint branch below — one glyph per codepoint,
   * zero offsets, no cluster map. For Arabic that is precisely isolated
   * letterforms with correct advances, which is what Chromium-on-Windows
   * comparisons showed: joining lost, ink 13–18% light, extents byte-identical.
   *
   * Injected rather than imported because this module is the engine-agnostic
   * native-helper layer and deliberately has no fontkit dependency; both callers
   * live in `font-resolution.ts`, which already imports it.
   *
   * It supplies ONLY ids, positions and clusters — the GSUB/GPOS work that is
   * missing. Outlines still come from this helper by glyph id, which is what
   * keeps DirectWrite's resolved variable-axis location (DM-1721) in the
   * picture: handing the whole `layout()` to fontkit would trade an Arabic
   * shaping bug for a variable-instance one. Glyph ids index the same gid space
   * because it is the same file.
   *
   * Self-scoping by construction: it is consulted only where the helper's own
   * `shape` query returned null, so a platform that has one is untouched.
   */
  shapeFallback?: (text: string, direction?: "ltr" | "rtl") => ShapedRunFallback | null;
  /**
   * DM-1916: consult `shapeFallback` BEFORE this helper's own `shape` query,
   * rather than only where that query fails.
   *
   * Set for a face carrying both `trak` and `STAT`, where HarfBuzz applies AAT
   * tracking interpolated from the run's point size
   * (`hb-ot-shape.cc:216-220`) and Blink feeds it the CSS pixel size on every
   * run (`harfbuzz_face.cc:641-647`). Measured on PingFang, "fi fl ffi", first
   * advance in font units: HarfBuzz at the run's 16 px gives 397, the CoreText
   * helper gives 381 — it opens the face at size = unitsPerEm, so it tracks as
   * though every run were 1000 px. Neither number is wrong for its own engine;
   * only one of them is Chrome's.
   *
   * Outlines are untouched: this seam carries ids, positions and clusters, and
   * the glyphs still come from this helper by id. That split is Chrome's own —
   * Blink shapes with HarfBuzz and rasterizes from the platform typeface — and
   * it is the difference between this and routing the whole `layout()` away,
   * which silently moved outline production too and made the Thai fixture worse
   * (worstTile 0.0940 → 0.1214) while shaping byte-identically.
   */
  preferShapeFallback?: boolean;
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
  // Opening at `unitsPerEm` (rather than at the run's pixel size) is deliberate,
  // and the reason is subtler than "design-unit geometry" — it was tried the
  // other way and reverted, so the trap is recorded here rather than rediscovered.
  //
  // Apple's system UI faces ARE optically size-dependent: CoreText applies
  // optical sizing from the requested point size, so the same face opened at 13
  // and at 1000 reports different advances (`.SFDevanagari` 836 vs 792 per em,
  // `.SFNS` 545.9 vs 502.0). Ordinary faces do not (Helvetica, Times New Roman
  // and Arial Unicode are identical at every size). That much is real.
  //
  // What does NOT follow is that we should open at the run's size to match
  // Chrome. Blink does not inherit CoreText's implicit sizing — it OVERRIDES it,
  // cloning the typeface at `opsz` = the specified size, clamped to the axis
  // range (`mac/font_platform_data_mac.mm:169-185`). When the clamp lands on the
  // axis default, `VariableAxisChangeEffective` returns false and Blink does not
  // clone at all, so Chrome paints the DEFAULT instance. Opening at the run size
  // reintroduces CoreText's implicit sizing underneath that, which double-counts.
  //
  // Measured: a 32 px Gujarati run clamps `opsz` to 28 (= the default), so Chrome
  // paints the default instance. Opening at 32 shifted our advance 592 -> 596 and
  // moved every glyph in the row right; Chrome's `expected.png` was byte-identical
  // across the two arms while ours moved, and three Indic blocks went from 0
  // regions to 6 / 2 / 1. The verification that had argued for it was a
  // `system-ui` run, where the explicit clone dominates and both models agree —
  // a slice that could not distinguish them.
  //
  // So: apply the axis explicitly (`resolveDarwinAxisLocation`) and open at
  // design size. Those are the same mechanism Blink uses, in the same order.
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

  /** Shape via the injected shaper, taking outlines from THIS helper by id.
   *
   *  Called from two places in `layout()` — ahead of the platform shape query
   *  on a `preferShapeFallback` face, and after it fails everywhere else — so
   *  the "ids and positions only, outlines stay here" contract is written once
   *  rather than twice. Returns null when there is no shaper, when it declines,
   *  or when what it returned doesn't line up; every caller then continues.
   *
   *  Both callers gate on `fullyCovered` first; this deliberately does not
   *  re-check it, since the coverage probe lives in `layout()`. */
  function shapeViaFallback(text: string, direction?: "ltr" | "rtl"): {
    glyphs: GlyphHelperGlyph[];
    positions: Array<{ xAdvance: number; yAdvance: number; xOffset: number; yOffset: number }>;
    clusters: number[];
  } | null {
    if (spec.shapeFallback == null) return null;
    let ext: ShapedRunFallback | null = null;
    // A shaper is an optimisation of correctness, never a correctness
    // requirement: if it throws, the caller's remaining paths still render text.
    try { ext = spec.shapeFallback(text, direction); } catch { ext = null; }
    if (ext == null || ext.ids.length === 0 || ext.ids.length !== ext.positions.length) return null;
    return { glyphs: ext.ids.map((id) => fetchById(id)), positions: ext.positions, clusters: ext.clusters };
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
    // DM-1880: CoreText's own bold trait, so the macOS synthetic-bold rule can
    // ask the question Blink asks instead of inferring it from a weight.
    ...(metaResp.traitBold != null ? { faceIsBoldTrait: metaResp.traitBold } : {}),
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
      // A `preferShapeFallback` face never reaches `shapeText`, so pre-warming
      // its cache is a helper round-trip whose result nothing will read.
      if (spec.preferShapeFallback === true) return;
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

    layout(
      text: string,
      _features?: string[], _script?: string, _language?: string,
      // DM-1894: forwarded to the injected shaper. Blink passes direction into
      // the shaper rather than letting it be inferred from content, and a
      // helper-backed face is exactly where that inference used to happen.
      direction?: "ltr" | "rtl",
    ): {
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
      // DM-1916: on a face where the injected shaper is the authoritative one
      // (`preferShapeFallback` — `trak` + `STAT`, where this helper cannot
      // reproduce Chrome's size-dependent tracking), ask it first. Same
      // `fullyCovered` gate as below and for the same reason: an uncovered
      // codepoint must reach the naive branch so the renderer's own `.notdef`
      // handling applies rather than a shaper's substituted tofu.
      const preferred = (spec.preferShapeFallback === true && fullyCovered)
        ? shapeViaFallback(text, direction)
        : null;
      if (preferred != null) return preferred;
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

      // DM-1883: the helper could not shape. Before dropping to the naive path,
      // let an injected shaper do the GSUB/GPOS work; outlines still come from
      // this helper, by id. On a helper with no `shape` query (Windows) this is
      // the difference between joined Arabic and isolated letterforms.
      //
      // Gated on `fullyCovered` for the same reason the helper shape is: an
      // uncovered codepoint must reach the naive branch so the renderer's own
      // `.notdef` handling applies, rather than having a shaper substitute a
      // different tofu.
      if (fullyCovered) {
        const ext = shapeViaFallback(text, direction);
        if (ext != null) return ext;
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
  /** macOS only: the substituted handle's variation axes + CURRENT position —
   *  the state Blink's clone gate (`VariableAxisChangeEffective`) compares
   *  against. See `FallbackResponseEntry.ctAxes`. */
  ctAxes?: Array<{ tag: string; min: number; def: number; max: number; value: number }>;
  /** Whether this face covers the codepoint it was resolved for, answered by the
   *  helper alongside the nomination. `undefined` on a binary that predates the
   *  field — the caller then probes as it always did. */
  covered?: boolean;
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
    // DM-1871: `baseFamilyName` too — on Windows the answer is a function of the
    // run's primary family, so a key blind to it would serve whichever primary
    // asked first to every later caller. Same hazard the cascade base already
    // documents, one platform over.
    // DM-1896: `locale` too, and this one is the sharpest of the set — a unified
    // Han ideograph resolves to a Japanese face under `ja` and a Chinese one
    // under `zh-Hans`, so a locale-blind key on a multilingual page serves
    // whichever language asked first to every later run. Wrong quietly, in a way
    // that reads as a font-inventory problem rather than as a cache defect.
    // `monoEmojiReplacement` joins for the same reason the rest of the
    // description does: it changes the answer (Apple Color Emoji vs the
    // monochrome cascade), so a key blind to it would serve a color answer
    // to a forced-text ask or vice versa.
    : `${base}\u0000${cp}\u0000${req.weight}\u0000${req.italic ? 1 : 0}\u0000${req.fontSize}\u0000${req.basePath ?? ""}\u0000${req.systemUi ? 1 : 0}\u0000${req.stretch ?? 100}\u0000${req.baseFamilyName ?? ""}\u0000${req.locale ?? ""}\u0000${req.monoEmojiReplacement === true ? 1 : 0}`;

/** The CSS description the fallback answer depends on. CoreText nominates one
 *  face per family for a character; Blink then re-selects WITHIN that family at
 *  the requested traits + weight (`GetAlternateFontPlatformData`,
 *  font_cache_mac.mm), so two runs differing only in weight resolve to different
 *  cuts of the same family. Measured: at weight 700 that moves 8,121 of a
 *  27,790-codepoint stride (29%) off the face CoreText nominated. */
export interface SystemFallbackRequest {
  /**
   * DM-1871: the run's PRIMARY family name, for Windows.
   *
   * Blink passes it as `MapCharacters`' `baseFamilyName` —
   * `GetDWriteFallbackFamily` takes `font_description.Family().FamilyName()`
   * and Skia forwards it (`win/font_cache_skia_win.cc:234-240` →
   * `SkFontMgr_win_dw.cpp:928-939`, rev 7d859f27). It is what lets the primary
   * family's own font linking participate in DirectWrite's answer, so a null
   * base asks a different question than Chrome asks.
   *
   * Ignored on macOS and Linux, whose fallback APIs take no such argument.
   */
  baseFamilyName?: string;
  /**
   * DM-1896: the BCP-47 tag the fallback query is asked with, for Windows.
   *
   * Blink resolves it per codepoint with `FallbackLocaleForCharacter` and pushes
   * `LocaleForSkFontMgr()` of the result into `matchFamilyStyleCharacter`'s
   * one-element bcp47 vector (`win/font_cache_skia_win.cc:228-240`, rev
   * 7d859f27); Skia hands it to `MapCharacters` as the analysis source's locale
   * name. It is what disambiguates unified Han: the same ideograph resolves to a
   * different face under `ja` than under `zh-Hans`.
   *
   * NOT the raw CSS `lang` — the reduction is Blink's, and it drops the region
   * while keeping the script (`zh-CN` → `zh-Hans`). Produce it with
   * `blinkWinFallbackLocale`; passing a hand-built tag risks the failure mode
   * Skia documents at the call site, where bare `zh` "misses completely and may
   * produce a Japanese font".
   *
   * Ignored on macOS (CoreText's cascade takes no locale) and on Linux (whose
   * fontconfig query carries its own, differently-shaped, `:lang=` tag).
   */
  locale?: string;
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
  /** macOS only: apply Blink's monochrome-emoji replacement inside the helper —
   *  when the cascade answers "Apple Color Emoji" for this ask, re-ask
   *  `CTFontCreateForString` from an "Apple Symbols" base carrying the color
   *  font's default cascade list (`GetSubstituteFont`,
   *  `mac/font_cache_mac.mm:156-184`, rev 7d859f27). The caller sets it where
   *  Blink's gate holds: a non-emoji-presentation (kText-priority) ask on a
   *  `Character::IsEmoji` codepoint — today that is the `font-variant-emoji:
   *  text` override. An older helper binary ignores the field and answers the
   *  color font (the pre-override behavior). */
  monoEmojiReplacement?: boolean;
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
  if (hostPlatform() !== "linux" || !isGlyphHelperAvailable() || cps.length === 0) return out;
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
        ? {
          cssWeight: req.weight, bold: req.weight >= 600, italic: req.italic,
          // DM-1871: Windows only — the macOS and Linux helpers ignore it.
          ...(req.baseFamilyName != null && req.baseFamilyName !== ""
            ? { baseFamilyName: req.baseFamilyName } : {}),
          // DM-1896: Windows only, same reason. An absent field leaves the
          // helper on its own `en-us` default, which is what it did before —
          // so an older Node side against a newer helper degrades to the
          // previous behavior rather than to no locale at all.
          ...(req.locale != null && req.locale !== "" ? { locale: req.locale } : {}),
          // macOS only — Blink's monochrome-emoji replacement inside
          // `GetSubstituteFont` (see `SystemFallbackRequest.monoEmojiReplacement`).
          // An older helper ignores the field and answers the color font.
          ...(req.monoEmojiReplacement === true ? { monoEmoji: true } : {}),
        }
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
    resp = callHelper(buildFallbackEnvelope(basePostscriptName, need, req, hostPlatform()));
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
  // DM-1893: walk the response, but only trust entries we ASKED about.
  //
  // The loop used to iterate `r.fonts` and write whatever came back, which
  // trusted the response to be both complete and in-domain and checked neither.
  // Two distinct hazards, and the first is shaped like a live bug: a batch that
  // half-populates leaves the missing codepoints to fall through to the lazy
  // path, which is a different ask order — and ask order is exactly what this
  // area has already been bitten by (an under-keyed helper cache made the
  // answer a function of which spec asked first). A partial response would have
  // been silent.
  const asked = new Set(need);
  let outOfDomain = 0;
  for (const e of r.fonts) {
    if (!asked.has(e.cp)) { outOfDomain++; continue; }
    const resolved: SystemFallbackFont | null = e.found && e.path && e.postscriptName
      ? { postscriptName: e.postscriptName, familyName: e.familyName ?? "", path: e.path, resolvedAxes: e.axes, ctAxes: e.ctAxes, covered: e.covered }
      : null;
    _systemFallbackCache.set(fallbackCacheKey(basePostscriptName, e.cp, req), resolved);
    out.set(e.cp, resolved);
  }
  // Anything asked for and not answered is left OUT of both the cache and the
  // result rather than cached as null: `undefined` reads as "ask again", which
  // is the recoverable state. Caching a null here would turn one short response
  // into a permanently wrong answer for those codepoints.
  const missing = need.reduce((n, cp) => n + (out.has(cp) ? 0 : 1), 0);
  if (missing > 0 || outOfDomain > 0) {
    _fallbackResponseAnomalies.push({ asked: need.length, answered: r.fonts.length, missing, outOfDomain });
  }
  return out;
}

/** DM-1893: short or out-of-domain fallback responses, in call order.
 *
 *  Recorded rather than thrown because a short response is recoverable — the
 *  unanswered codepoints simply get asked again lazily. But it is NOT harmless:
 *  an unanswered codepoint gets re-asked later, in a different order, and this
 *  area has been bitten by ask-order dependence before.
 *
 *  Historical note (DM-1893): this was instrumented while chasing the
 *  conformance oracle disagreeing with itself run to run, where a silent
 *  partial response was a leading candidate. Measured at zero anomalies across
 *  batch sizes 64–8192; the disagreement itself turned out to be Chrome's own
 *  answers flipping among CJK cousin faces between runs, now detected by the
 *  oracle's per-face `chromeFaceCounts` baseline comparison.
 *
 *  Read with `takeFallbackResponseAnomalies()`; a run that reports none has
 *  eliminated the short-response candidate rather than merely not looked. */
interface FallbackResponseAnomaly { asked: number; answered: number; missing: number; outOfDomain: number }
const _fallbackResponseAnomalies: FallbackResponseAnomaly[] = [];

/** Drain the recorded anomalies. Empty means every call answered exactly what
 *  it was asked. */
export function takeFallbackResponseAnomalies(): FallbackResponseAnomaly[] {
  return _fallbackResponseAnomalies.splice(0, _fallbackResponseAnomalies.length);
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
  /** macOS: the resolved handle's variation axes + CURRENT position (see
   *  `FamilyResponse.ctAxes`). The face's own coordinates — what a declared
   *  family's axis location must pin instead of a CSS-derived `wght`, since
   *  Blink's mac path applies only `opsz` + font-variation-settings on top of
   *  the matched face (font_platform_data_mac.mm:113-208, tag 147.0.7727.15). */
  ctAxes?: Array<{ tag: string; min: number; def: number; max: number; value: number }>;
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
/**
 * Every family / PostScript name CoreText can resolve WITHOUT downloading,
 * fetched once per process.
 *
 * `CTFontCreateWithName` on a family macOS ships only as a downloadable asset
 * does not fail — it raises the system "needs to download font X" panel and
 * blocks until answered. Unattended there is nobody to answer: one such lookup
 * was measured blocking ~16 minutes, and it is the cause of several
 * otherwise-unexplained stalls (a 30s unit timeout, a 425s static-chain walk,
 * an agent that reported "no progress for 600s").
 *
 * It is also a parity defect: an uninstalled face is unavailable to Blink,
 * which walks on. Accepting a download would make us paint a face Chrome does
 * not have and would change the host's font inventory as a side effect of
 * measuring — which silently invalidates comparison against a CI runner with a
 * different set.
 *
 * ONE bulk fetch, cached, rather than a per-name check. Both per-name variants
 * were tried and reverted: enumerating inside the Swift `family` handler
 * re-scans thousands of faces on every one-shot spawn (a static-chain walk went
 * to 425s), and a `CTFontDescriptorCopyAttribute` URL probe still reaches
 * CoreText's matching path and still blocks on the panel. Null means "could not
 * ask" and admits everything, so a helper-less host is unaffected.
 */
let _installedNames: Set<string> | null | undefined;

function installedNameSet(): Set<string> | null {
  if (_installedNames !== undefined) return _installedNames;
  _installedNames = null;
  if (hostPlatform() === "darwin" && isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({ fonts: [], queries: [{ type: "families" } as never] });
      const r = resp?.results?.[0] as { names?: string[] } | undefined;
      if (Array.isArray(r?.names) && r.names.length > 0) {
        const set = new Set<string>();
        for (const n of r.names) {
          const l = n.toLowerCase();
          set.add(l);
          set.add(l.replace(/ /g, ""));
        }
        _installedNames = set;
      }
    } catch { /* leave null — admit everything rather than lose coverage */ }
  }
  return _installedNames;
}

function isInstalledName(nameKey: string): boolean {
  const set = installedNameSet();
  if (set == null) return true; // could not ask
  return set.has(nameKey) || set.has(nameKey.replace(/ /g, ""));
}

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

let _systemUiFamily: string | null | undefined;

/**
 * The OS's UI font family — what CSS `system-ui` means on this host.
 *
 * DM-1881. Blink does not carry a literal here: `FontCache::SystemFontFamily()`
 * returns `MenuFontFamily()` (`win/font_cache_skia_win.cc:130-133`, rev
 * 7d859f27), and `CreateTypeface` asserts `DCHECK_NE(family, kSystemUi)` —
 * `system-ui` never reaches font matching as a name, it is replaced by whatever
 * the OS reports. So we ask the OS too, through the helper's `systemfont` query
 * (`SystemParametersInfo(SPI_GETNONCLIENTMETRICS)`), rather than baking in
 * "Segoe UI": that literal is correct on current Windows 11 and wrong by
 * construction, surviving only until a differently-configured host runs it.
 *
 * Memoised for the process — the OS metric does not change under us mid-render.
 * `null` when the helper cannot answer, which leaves the caller on its existing
 * filename-table path rather than failing.
 */
export function resolveSystemUiFamily(): string | null {
  if (_systemUiFamily !== undefined) return _systemUiFamily;
  _systemUiFamily = null;
  if (hostPlatform() !== "win32" || !isGlyphHelperAvailable()) return _systemUiFamily;
  try {
    const resp = callHelper({ fonts: [], queries: [{ type: "systemfont" } as never] });
    const r = resp.results[0] as unknown as { type?: string; found?: boolean; family?: string } | undefined;
    if (r?.type === "systemfont" && r.found === true && typeof r.family === "string" && r.family !== "") {
      _systemUiFamily = r.family;
    }
  } catch {
    // An older helper answers "unknown query type"; keep null and let the
    // caller degrade to the table, which is the pre-DM-1881 behaviour.
  }
  return _systemUiFamily;
}

/** Test seam: drop the memoised system-ui family. */
export function __clearSystemUiFamilyForTest(): void {
  _systemUiFamily = undefined;
}

export function resolveInstalledFont(
  name: string, style?: InstalledFontStyle,
): InstalledFont | null {
  const nameKey = name.toLowerCase();
  if (hiddenFamilies().has(nameKey)) return null;
  // A name macOS ships only as a DOWNLOADABLE asset must never reach
  // `CTFontCreateWithName` — see `installedNameSet`. Blink treats an
  // uninstalled face as unavailable and walks on, which is what returning null
  // here does.
  if (!isInstalledName(nameKey)) return null;
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
        resolved = { postscriptName: r.postscriptName, familyName: r.familyName ?? "", path: r.path, resolvedAxes: r.axes, ctAxes: r.ctAxes };
      }
    } catch { resolved = null; }
  }
  _installedFontCache.set(key, resolved);
  return resolved;
}

/** The face a declared CSS family resolves to at one style. */
export interface FamilyStyleMatch {
  /** PostScript name of the chosen family member. */
  postscriptName: string;
  /** The CSS weight the matcher scored the chosen member at. */
  weight: number;
  /** True when the chosen member carries CoreText's italic symbolic trait. */
  italic: boolean;
}

/** `kCTFontTraitItalic` — bit 0 of `CTFontSymbolicTraits`. */
const CT_TRAIT_ITALIC = 1 << 0;

const _familyStyleMatchCache = new Map<string, FamilyStyleMatch | null>();

/**
 * Which CUT of a declared CSS family a run at this style opens — macOS only.
 *
 * Blink runs a candidate scan over the family's AppKit members and picks with
 * its own comparator: `BestStyleMatchForFamilyNS` (`:231-277`) →
 * `BetterChoiceCT` (`:172-220`), in
 * `platform/fonts/mac/font_matcher_mac.mm` at Chromium tag 147.0.7727.15 —
 * the Chrome build Playwright pins, which is what every capture runs against.
 * (The local `external/chromium` checkout carries a newer, directional
 * comparator that the shipping build does not have; the helper transcribes
 * the tag, not the checkout.) That algorithm lives in the helper (Swift,
 * where AppKit and CoreText are reachable); this is the Node side of the
 * call.
 *
 * It is a DIFFERENT question from `resolveInstalledFont`, which resolves a name
 * to a face and, on macOS, does not run the style match at all. It is also a
 * different question from the per-codepoint fallback's in-family re-selection
 * (`GetAlternateFontPlatformData`, CoreText's own nearest-weight walk), which
 * is not this algorithm and measurably disagrees with it — asked for PingFang
 * SC at CSS 300, CoreText re-selection answers Light where Chrome paints Thin.
 *
 * Returns null when the helper is unavailable, the platform is not macOS, or
 * the family has no AppKit members — in every case the caller must keep the
 * selection it already had.
 *
 * The cache key carries the family AND the style — weight, italic and WIDTH,
 * because the answer is a function of all three: a style-blind key would serve
 * whichever weight asked first to every later caller, which is exactly the
 * defect this call exists to fix.
 */
export function resolveFamilyStyleMatch(
  family: string, style?: { weight?: number; italic?: boolean; stretch?: number },
): FamilyStyleMatch | null {
  if (hostPlatform() !== "darwin" || family === "") return null;
  const weight = style?.weight ?? 400;
  const italic = style?.italic === true;
  // CSS `font-stretch` as a percentage, 100 = `normal`. It reaches the helper as
  // `cssWidth` and lands in Blink's `ComputeDesiredTraits`
  // (`mac/font_matcher_mac.mm:185-202`, rev 7d859f27), which turns any width
  // below 100 into the condensed symbolic trait and any width above it into the
  // expanded one. `BetterChoiceCT` compares condensed before either of its other
  // two masks, so this is the FIRST thing the comparator looks at — a stack
  // asking for a condensed face and a matcher that never hears about it do not
  // disagree slightly, they disagree about which cut of the family to open.
  const stretch = style?.stretch ?? 100;
  const key = `${family.toLowerCase()}|${weight}|${italic ? 1 : 0}|${stretch}`;
  const cached = _familyStyleMatchCache.get(key);
  if (cached !== undefined) return cached;
  let resolved: FamilyStyleMatch | null = null;
  if (isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({ fonts: [], queries: [{ type: "familyMatch", family, cssWeight: weight, italic, cssWidth: stretch }] });
      const r = resp.results[0];
      if (r != null && r.type === "familyMatch" && r.found && r.postscriptName != null && r.postscriptName !== "") {
        const chosen = (r.candidates ?? []).find((c) => c.name === r.postscriptName);
        resolved = {
          postscriptName: r.postscriptName,
          weight: r.weight ?? weight,
          italic: ((chosen?.traits ?? 0) & CT_TRAIT_ITALIC) !== 0,
        };
      }
    } catch {
      // An older helper answers "unknown query type"; keep null so the caller
      // degrades to its existing selection rather than failing.
      resolved = null;
    }
  }
  _familyStyleMatchCache.set(key, resolved);
  return resolved;
}

/** The face a declared family resolves to at one style on Linux (fontconfig). */
export interface LinuxFamilyMatch {
  /** Resolved font file. */
  path: string;
  /** TTC member index — Blink opens the face by file + index. */
  index: number;
  /** PostScript name of the matched face ("" when the face declares none). */
  postscriptName: string;
  /** The matched family name (`FC_FAMILY[0]` of the match). */
  family: string;
  /** The matched face's weight in CSS space, as Skia reports `outStyle`. */
  weight: number;
  /** True when the matched face's fontconfig slant is italic/oblique. */
  italic: boolean;
}

const _linuxFamilyMatchCache = new Map<string, LinuxFamilyMatch | null>();

/**
 * Which CUT of a declared family a run at this style opens — Linux only.
 *
 * This is the same question `resolveFamilyStyleMatch` answers on macOS, decided
 * by entirely different code in Blink: on Linux `FontCache::CreateTypeface`
 * reduces to `skia::DefaultFontMgr()->matchFamilyStyle(name,
 * font_description.SkiaFontStyle())` (`fonts/skia/font_cache_skia.cc`, tag
 * 147.0.7727.15), the Linux font manager is fontconfig-backed
 * (`SkFontMgr_New_FCI`, `skia/ext/font_utils.cc:86-89`), and the whole decision
 * lives in `SkFontConfigInterfaceDirect::matchFamilyName` (Skia rev fd139e79 —
 * the revision tag 147's DEPS pins — `src/ports/SkFontConfigInterface_direct.cpp:592-713`).
 * The Linux glyph helper carries the transcription (`familyMatch` query,
 * `tools/linux-glyph-extractor/src/main.cpp`); this is the Node side of the call.
 *
 * Returns null when the platform is not Linux, the helper is unavailable or too
 * old to know the query, or the matcher REJECTED the family (fontconfig always
 * returns *something*, so Skia accepts only a face whose family list matches the
 * request, the post-substitution name, or a metric-compatible replacement —
 * rejection is how Blink walks to the next CSS family). In every null case the
 * caller must keep the selection it already had.
 */
export function resolveLinuxFamilyMatch(
  family: string, style?: { weight?: number; italic?: boolean; stretch?: number },
): LinuxFamilyMatch | null {
  // An EMPTY family is a real Blink request, not junk: the terminal rung of
  // `FontCache::GetLastResortFallbackFont` is `legacyMakeTypeface(nullptr,
  // style)` (`fonts/skia/font_cache_skia.cc`, tag 147.0.7727.15), which the
  // FCI font manager forwards to `matchFamilyName(nullptr, …)`
  // (`SkFontMgr_FontConfigInterface.cpp:253-256`, Skia rev fd139e79) — a
  // pattern with no FC_FAMILY term, which fontconfig matches against
  // everything and `IsFallbackFontAllowed("")` then accepts. The helper's
  // `familyMatch` query mirrors that when `family` is "".
  if (hostPlatform() !== "linux") return null;
  const weight = style?.weight ?? 400;
  const italic = style?.italic === true;
  const stretch = style?.stretch ?? 100;
  const key = `${family.toLowerCase()}|${weight}|${italic ? 1 : 0}|${stretch}`;
  const cached = _linuxFamilyMatchCache.get(key);
  if (cached !== undefined) return cached;
  let resolved: LinuxFamilyMatch | null = null;
  if (isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({ fonts: [], queries: [{ type: "familyMatch", family, cssWeight: weight, italic, cssWidth: stretch }] });
      const r = resp.results[0];
      if (r != null && r.type === "familyMatch" && r.found
          && typeof r.path === "string" && r.path !== "") {
        resolved = {
          path: r.path,
          index: typeof r.index === "number" ? r.index : 0,
          postscriptName: r.postscriptName ?? "",
          family: r.family ?? "",
          weight: r.weight ?? weight,
          italic: r.italic === true,
        };
      }
    } catch {
      // An older helper answers "unknown query type"; keep null so the caller
      // degrades to its existing selection rather than failing.
      resolved = null;
    }
  }
  _linuxFamilyMatchCache.set(key, resolved);
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

/**
 * CoreText's `kCTFontTraitBold` for a face, which is the exact bit Blink's
 * macOS synthetic-bold rule tests: `Weight() > 500 && !(traits & kCTFontTraitBold)`
 * (`mac/font_cache_mac.mm:424-427`, rev 7d859f27).
 *
 * This exists because OS/2 `fsSelection` bit 5 is NOT the same fact, however
 * much it looks like it. `/System/Library/Fonts/Times.ttc` is the case that
 * proved it: every face in the container — Roman, **Bold**, Italic, BoldItalic —
 * reports `fsSelection.regular = true` and `fsSelection.bold = false`, which the
 * OpenType spec forbids (REGULAR is mutually exclusive with BOLD and ITALIC).
 * CoreText answers `traitBold: true` for `Times-Bold` regardless, because it
 * derives the trait from the font's registered traits rather than from that bit.
 *
 * Reading the bit instead made every `serif` heading paint synthetic bold ON TOP
 * of the real Times-Bold cut — visibly heavier than Chrome, 9 diff regions on
 * `20-font-style-variant`.
 *
 * Returns null when the helper is unavailable or the face is unknown, so the
 * caller keeps its previous signal rather than assuming "not bold".
 *
 * **The echoed name is checked, and that check is load-bearing.** CoreText
 * restricts access to the dot-prefixed system faces and silently substitutes
 * `TimesNewRomanPSMT` for them — passing the containing file's path does not
 * lift the restriction. Measured: asking for `.LucidaGrandeUI-Bold`,
 * `.HiraKakuInterface-W7` or `.PingFangUITextSC-Regular` returns Times New
 * Roman's metrics under Times New Roman's name, with `traitBold: false`. Taking
 * that at face value would report 17 genuinely-bold system faces as not-bold and
 * synthesise bold over them — the same defect this function exists to fix, just
 * pointed at a different set of faces. So an answer is only accepted when the
 * helper hands back the face that was asked for.
 */
const _traitBoldCache = new Map<string, boolean | null>();
export function resolveFaceTraitBold(
  postscriptName: string, path?: string,
): boolean | null {
  if (postscriptName === "") return null;
  const key = `${path ?? ""} ${postscriptName}`;
  const hit = _traitBoldCache.get(key);
  if (hit !== undefined) return hit;
  let out: boolean | null = null;
  if (isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({
        fonts: [{ ref: "f", postscriptName, ...(path != null && path !== "" ? { path } : {}), size: 16 }],
        queries: [{ type: "meta", fontRef: "f" }],
      });
      const r = resp.results[0];
      if (r != null && r.type === "meta") {
        const meta = r as unknown as MetaResponse & { postscriptName?: string };
        const got = meta.postscriptName;
        // Only trust the trait when CoreText opened the face we named. A
        // mismatch means it substituted (see the dot-prefixed note above).
        if (got === postscriptName && typeof meta.traitBold === "boolean") {
          out = meta.traitBold;
        }
      }
    } catch { /* helper failed — keep null so the caller falls back */ }
  }
  _traitBoldCache.set(key, out);
  return out;
}

/**
 * Drop ONLY the two memos keyed per codepoint — the CoreText cascade answers and
 * the fontconfig fallback answers.
 *
 * Everything else this module memoizes is keyed by family or by face, so it is
 * bounded by the host's font inventory (hundreds of entries). These two are
 * keyed by `(base face, codepoint, …)` and are therefore unbounded in the
 * codepoint universe: one entry per codepoint per distinct base, kept for the
 * life of the process.
 *
 * That is fine for a render, which touches the codepoints on one page. It is not
 * fine for an exhaustive sweep. Measured: the font-conformance oracle's
 * full-corpus macOS run put 22 stacks × 292,466 codepoints through one process
 * and **four of twenty shards died with `JavaScript heap out of memory`**, while
 * the canonical six-stack slice — one stack per shard, so 292k entries rather
 * than 6.4M — had never shown it. The oracle already trimmed the memos
 * `font-resolution.ts` owns every batch; the ones actually holding the bytes sat
 * one module below and had no caller outside the unit tests.
 *
 * Separate from `clearGlyphHelperCache()` because that one also forgets which
 * helper binary was resolved, which would re-probe the filesystem on every
 * trim. Every dropped entry is a pure function of its key, so this costs
 * re-queries and never a different answer.
 */
export function clearGlyphHelperCodepointMemos(): void {
  _systemFallbackCache.clear();
  _fcFallbackCache.clear();
}

/**
 * How many per-codepoint memo entries are currently retained.
 *
 * Diagnostic only — it exists so "these memos are bounded across a batch reset"
 * is assertable rather than argued. A test that merely calls the clear function
 * and checks nothing would pass against the defect it is guarding, which is how
 * this grew unbounded with a clear function already sitting in the file.
 */
export function glyphHelperCodepointMemoSize(): number {
  return _systemFallbackCache.size + _fcFallbackCache.size;
}

export function clearGlyphHelperCache(): void {
  _traitBoldCache.clear();
  helperAvailable = null;
  helperPath = undefined;
  // …and the resolved TRANSPORT, for the same reason as the resolved path.
  //
  // `persistentDisabled` is a once-per-process latch: the channel sets it when
  // it cannot start, and nothing cleared it. That is right for a helper binary
  // that genuinely cannot serve — it stops us re-spawning a doomed child on
  // every call — but it also made `DOMOTION_HELPER_NO_SERVE` a one-way switch,
  // so a process that ever ran with it set kept the slow transport afterwards
  // even with the variable removed. A test measuring the two transports in one
  // process therefore compared the slow path against itself and reported the
  // switch as inert, which is how this was found.
  //
  // Re-arming is self-healing and cheap: a binary that really cannot serve
  // fails its first round-trip and latches again.
  //
  // The RUNNING channel has to go with it. `callHelper` only calls
  // `startPersistent` when `serverProc` is null, so leaving a live child in
  // place means the transport never gets re-decided — clearing the latch alone
  // changed nothing, and `DOMOTION_HELPER_NO_SERVE` stayed inert for any
  // process that had already opened a channel. That is exactly how the switch
  // looked like a no-op in its own test.
  try { serverProc?.kill(); } catch { /* already gone */ }
  serverProc = null;
  serverInFd = undefined;
  serverOutFd = undefined;
  serverLeftover = "";
  persistentDisabled = false;
  clearGlyphHelperCodepointMemos();
  _installedFontCache.clear();
  _familyStyleMatchCache.clear();
  _linuxFamilyMatchCache.clear();
}
