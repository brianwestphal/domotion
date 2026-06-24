/**
 * On-demand acquisition of the native glyph-helper binary (DM-886). Downloads
 * the platform/arch release asset into a per-user cache, SHA-256-verifies it
 * against the `.sha256` sidecar the release workflow uploads, `chmod`s it, and
 * reuses it. This is what gives a *published-npm* consumer a working helper on
 * any platform — the in-tree `tools/` binaries aren't shipped (see docs/50,
 * docs/16), so without this layer `isHelperAvailable()` is always false for
 * them.
 *
 * **Lazy first-render fetch** (the chosen trigger — docs/50): the synchronous
 * resolver in `glyph-helper.ts` calls `acquireGlyphHelperSync()` when no in-tree /
 * `DOMOTION_HELPER_PATH` binary is found. The download runs in a short-lived
 * child `node` process (this same module, re-invoked as a script) so the
 * otherwise-synchronous render path can block on it exactly once. The async
 * `acquireGlyphHelper()` is exported for consumers who'd rather pre-warm the
 * cache (e.g. in CI) before rendering.
 *
 * Every failure — offline, 404 (no asset for this version/arch), SHA mismatch,
 * unsupported arch, unwritable cache — resolves to "no helper", i.e. the exact
 * fontkit fall-through as a missing helper, with a single warning per process.
 * It never throws into the renderer. `DOMOTION_DISABLE_HELPER` skips it (the
 * caller checks that first); `DOMOTION_HELPER_PATH` still overrides (no
 * download).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// dist/render/helper-acquire.js → ../../package.json is the package root (same
// in src/ under tsx). Keeps the asset version honest to the installed package.
const PKG_VERSION = (require("../../package.json") as { version: string }).version;

const REPO = "brianwestphal/domotion";
const RELEASE_BASE = `https://github.com/${REPO}/releases/download`;
// How long the synchronous first-render download may block before giving up
// (and falling back to fontkit for the rest of the process).
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Release-asset basename for a platform/arch, or `null` when no asset exists
 * (→ fontkit fallback). macOS ships one universal (arm64 + x86_64) binary;
 * Linux/Windows have per-arch x64 + arm64 assets (DM-886).
 */
export function assetNameFor(platform: NodeJS.Platform, arch: string): string | null {
  switch (platform) {
    case "darwin":
      return "domotion-glyph-paths-darwin-universal";
    case "linux":
      if (arch === "x64") return "domotion-glyph-paths-linux-x64";
      if (arch === "arm64") return "domotion-glyph-paths-linux-arm64";
      return null;
    case "win32":
      if (arch === "x64") return "domotion-glyph-paths-win32-x64.exe";
      if (arch === "arm64") return "domotion-glyph-paths-win32-arm64.exe";
      return null;
    default:
      return null;
  }
}

/**
 * Per-user cache directory for the helper, versioned by the package version so
 * a Domotion upgrade fetches a fresh binary and older installs keep their own.
 * macOS → `~/Library/Caches`, Windows → `%LOCALAPPDATA%`, Linux/other →
 * `$XDG_DATA_HOME` (default `~/.local/share`). DM-886.
 */
export function cacheDirFor(
  platform: NodeJS.Platform,
  version: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", "domotion", version, "bin");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return path.join(localAppData, "domotion", version, "bin");
  }
  const xdgData = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  return path.join(xdgData, "domotion", version, "bin");
}

/** Parse a `shasum`/`sha256sum` sidecar (`<hex>  <filename>`) → lowercase hex. */
export function parseSha256Sidecar(text: string): string {
  return text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface AcquireOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  version?: string;
  /** Override the cache directory (tests). */
  cacheDir?: string;
}

function resolveTarget(opts: AcquireOptions): { asset: string; dest: string; assetUrl: string; shaUrl: string } | null {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const version = opts.version ?? PKG_VERSION;
  const asset = assetNameFor(platform, arch);
  if (asset == null) return null;
  const dir = opts.cacheDir ?? cacheDirFor(platform, version);
  const dest = path.join(dir, asset);
  const assetUrl = `${RELEASE_BASE}/v${version}/${asset}`;
  return { asset, dest, assetUrl, shaUrl: `${assetUrl}.sha256` };
}

/** Download the asset + sidecar, SHA-verify, and install atomically + chmod.
 *  Returns true on success. The download primitive behind both the worker
 *  subprocess and the async API; exported so it can be tested against a local
 *  server with explicit URLs. */
export async function downloadAndInstall(assetUrl: string, shaUrl: string, dest: string): Promise<boolean> {
  const [assetRes, shaRes] = await Promise.all([fetch(assetUrl), fetch(shaUrl)]);
  if (!assetRes.ok || !shaRes.ok) return false;
  const buf = Buffer.from(await assetRes.arrayBuffer());
  const expected = parseSha256Sidecar(await shaRes.text());
  if (expected.length === 0 || sha256Hex(buf) !== expected) return false;
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, buf);
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest); // atomic — avoids a torn binary if two processes race
  return true;
}

const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  process.stderr.write(`domotion: ${msg}\n`);
}

let syncFailedThisProcess = false;

/**
 * Synchronous acquisition for the render path. Returns the cached binary path,
 * downloading it (blocking, in a child process) on first need, or `undefined`
 * on any failure (warn-once → fontkit fallback). At most one download attempt
 * per process.
 */
export function acquireGlyphHelperSync(opts: AcquireOptions = {}): string | undefined {
  const target = resolveTarget(opts);
  if (target == null) return undefined;
  if (existsSync(target.dest)) return target.dest;
  if (syncFailedThisProcess) return undefined;

  // Run the download in a child `node` invocation of THIS module (worker mode
  // at the bottom of the file) so the synchronous renderer can block on it.
  const proc = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), target.dest, target.assetUrl, target.shaUrl],
    { timeout: DOWNLOAD_TIMEOUT_MS, encoding: "utf-8" }
  );
  if (proc.status === 0 && existsSync(target.dest)) return target.dest;

  syncFailedThisProcess = true;
  // DM-1325: this is a PERF-only fallback — fontkit produces the same glyph
  // paths, so the SVG output is byte-for-byte unaffected; only render speed
  // differs. Word the warning so it doesn't read as a correctness problem.
  warnOnce(`glyph helper (${target.asset}) unavailable — using fontkit instead. This is a performance-only fallback; the SVG output is unaffected. To speed up runs, set DOMOTION_HELPER_PATH to a local binary or pre-warm with acquireGlyphHelper().`);
  return undefined;
}

/**
 * Asynchronously acquire the helper into the user cache (pre-warm). Returns the
 * binary path or `null` on failure. Exposed so consumers can warm the cache
 * (e.g. once in CI) instead of paying the lazy first-render download.
 */
export async function acquireGlyphHelper(opts: AcquireOptions = {}): Promise<string | null> {
  const target = resolveTarget(opts);
  if (target == null) return null;
  if (existsSync(target.dest)) return target.dest;
  try {
    const ok = await downloadAndInstall(target.assetUrl, target.shaUrl, target.dest);
    return ok ? target.dest : null;
  } catch {
    return null;
  }
}

/** Test-only: reset the per-process "sync download already failed" latch. */
export function __resetAcquireState(): void {
  syncFailedThisProcess = false;
  warned.clear();
}

// ── Worker mode ──
// When this module is the process entry point (re-invoked by
// `acquireGlyphHelperSync`), run the download and exit 0/1. The arg vector is
// `[dest, assetUrl, shaUrl]`. Guarded so a normal `import` never triggers it.
const isWorkerEntry =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isWorkerEntry) {
  const [dest, assetUrl, shaUrl] = process.argv.slice(2);
  if (dest == null || assetUrl == null || shaUrl == null) process.exit(2);
  downloadAndInstall(assetUrl, shaUrl, dest)
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch(() => process.exit(1));
}
