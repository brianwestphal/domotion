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
import { existsSync, readSync, writeSync } from "node:fs";
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

// Spawn the helper once, request meta + a batch of glyphs in one envelope.
interface HelperRequest {
  fonts: Array<{ ref: string; postscriptName?: string; fontPath?: string; size: number }>;
  queries: Array<
    | { type: "meta"; fontRef: string }
    | { type: "glyphs"; fontRef: string; glyphs: Array<{ cp?: number; id?: number }> }
    | { type: "fallback"; fontRef: string; cps: number[] }
    | { type: "family"; name: string }
    | { type: "shape"; fontRef: string; text: string }
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
}
interface FamilyResponse {
  type: "family";
  found: boolean;
  postscriptName?: string;
  familyName?: string;
  path?: string;
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
}): GlyphHelperFontInstance | null {
  if (!isGlyphHelperAvailable()) return null;

  // Open at size=1000 first so we can read unitsPerEm. Then re-open at
  // size=unitsPerEm so all glyph paths come back in design-unit space — this
  // matches fontkit's coordinate convention so the existing
  // `scale(fontSize/unitsPerEm, ...)` transform in text-to-path.ts works.
  let metaResp: MetaResponse;
  try {
    const probe = callHelper({
      fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, size: 1000 }],
      queries: [{ type: "meta", fontRef: "f" }]
    });
    const r = probe.results[0];
    if (r.type !== "meta") throw new Error("unexpected response shape");
    metaResp = r;
  } catch {
    return null;
  }

  const unitsPerEm = metaResp.unitsPerEm;
  const renderSize = unitsPerEm;

  // Per-(cp, id) caches — each glyph is fetched at most once per Node process.
  const cpToGlyph = new Map<number, GlyphHelperGlyph>();
  const idToGlyph = new Map<number, GlyphHelperGlyph>();
  const missingCp = new Set<number>();
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
        path: { commands: parseSvgPath(g.d) },
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
      fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, size: renderSize }],
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
      fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, size: renderSize }],
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
      path: { commands: parseSvgPath(g.d) }
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
        fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, size: renderSize }],
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
          fonts: [{ ref: "f", postscriptName: spec.postscriptName, fontPath: spec.fontPath, size: renderSize }],
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
            path: { commands: parseSvgPath(sg.d) }
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
}

const _systemFallbackCache = new Map<number, SystemFallbackFont | null>();

/** Authoritative per-codepoint system font fallback, matching Chrome-on-macOS.
 *
 *  Blink's `font_cache_mac.mm::PlatformFallbackFontForCharacter` →
 *  `GetSubstituteFont` calls `CTFontCreateForString(baseFont, str, range)` to
 *  walk CoreText's system cascade and find the font that renders a character
 *  the primary font lacks (returning null when the result is LastResort). This
 *  exposes the same call so the renderer can resolve fallback fonts the way
 *  Chrome actually does, instead of relying on the sampled per-block table.
 *
 *  Returns a map from codepoint to the resolved font (or null for LastResort).
 *  Results are memoized process-wide; `basePostscriptName` selects the cascade
 *  base (defaults to Helvetica — a neutral sans base whose system cascade is
 *  what an un-styled element resolves through). Returns an empty map when the
 *  helper binary isn't available (non-macOS / unbuilt). */
export function resolveSystemFallbackFonts(
  cps: number[],
  basePostscriptName: string = "Helvetica",
): Map<number, SystemFallbackFont | null> {
  const out = new Map<number, SystemFallbackFont | null>();
  if (!isGlyphHelperAvailable()) return out;
  const need: number[] = [];
  for (const cp of cps) {
    if (_systemFallbackCache.has(cp)) out.set(cp, _systemFallbackCache.get(cp)!);
    else need.push(cp);
  }
  if (need.length === 0) return out;
  let resp: HelperResponse;
  try {
    resp = callHelper({
      fonts: [{ ref: "base", postscriptName: basePostscriptName, size: 16 }],
      queries: [{ type: "fallback", fontRef: "base", cps: need }],
    });
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
      ? { postscriptName: e.postscriptName, familyName: e.familyName ?? "", path: e.path }
      : null;
    _systemFallbackCache.set(e.cp, resolved);
    out.set(e.cp, resolved);
  }
  return out;
}

/** A real installed font resolved by name via CoreText. */
export interface InstalledFont {
  postscriptName: string;
  familyName: string;
  path: string;
}

const _installedFontCache = new Map<string, InstalledFont | null>();

/** Resolve a CSS font-family NAME to a real installed font, the way Blink's
 *  FontFallbackList picks `first_candidate_` — the first family in the stack
 *  that actually loads (font_fallback_iterator.cc). Backed by
 *  `CTFontCreateWithName` with a name-match guard so a substituted default
 *  doesn't masquerade as the requested family. Returns null when the name
 *  isn't a real installed font (caller keeps walking the stack), or when the
 *  helper binary isn't available (non-macOS / unbuilt). Memoized process-wide.
 *  darwin-only. */
export function resolveInstalledFont(name: string): InstalledFont | null {
  const key = name.toLowerCase();
  if (_installedFontCache.has(key)) return _installedFontCache.get(key)!;
  let resolved: InstalledFont | null = null;
  if (isGlyphHelperAvailable()) {
    try {
      const resp = callHelper({ fonts: [], queries: [{ type: "family", name }] });
      const r = resp.results[0];
      if (r != null && r.type === "family" && r.found && r.path && r.postscriptName) {
        resolved = { postscriptName: r.postscriptName, familyName: r.familyName ?? "", path: r.path };
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
export function clearGlyphHelperCache(): void {
  helperAvailable = null;
  helperPath = undefined;
  _systemFallbackCache.clear();
  _installedFontCache.clear();
}
