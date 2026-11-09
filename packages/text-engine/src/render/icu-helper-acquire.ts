/** On-demand acquisition for the independently versioned ICU companion. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostPlatform } from "./host-platform.js";

export const ICU_COMPANION_VERSION = "78.2-domotion.2";
const LEGACY_ICU_COMPANION_VERSION = "78.2-domotion.1";
const DOWNLOAD_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_BUDGET_MS = 55_000;
const DOWNLOAD_ATTEMPTS = 3;

export interface IcuCompanionTarget {
  releaseVersion: string;
  executableAsset: string;
  dataAsset: string;
  directory: string;
  executablePath: string;
  dataPath: string;
  runtimeAssets: Array<{ asset: string; path: string }>;
}

export interface IcuAcquireOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  cacheDir?: string;
}

export function icuAcquireWorkerArgs(workerPath: string, target: IcuCompanionTarget): string[] {
  return workerPath.endsWith(".ts")
    ? ["--import", "tsx", workerPath, JSON.stringify(target)]
    : [workerPath, JSON.stringify(target)];
}

/**
 * Decode the download worker's argv target (the JSON `icuAcquireWorkerArgs` wrote), or `null` when
 * it is missing, not JSON, or not the expected shape. The worker writes files at these paths, so a
 * malformed argument exits 2 instead of reaching `downloadIcuCompanion` with `undefined` fields.
 */
export function parseIcuCompanionTarget(raw: string | undefined): IcuCompanionTarget | null {
  if (raw == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nonEmpty = (field: unknown): field is string => typeof field === "string" && field !== "";
  const fields = ["releaseVersion", "executableAsset", "dataAsset", "directory", "executablePath", "dataPath"] as const;
  if (!fields.every((key) => nonEmpty(record[key]))) return null;
  if (!/^78\.2-domotion\.[1-9]\d*$/.test(record.releaseVersion as string)) return null;
  const assets = record.runtimeAssets;
  if (!Array.isArray(assets)) return null;
  const runtimeAssets: Array<{ asset: string; path: string }> = [];
  for (const item of assets as unknown[]) {
    if (item == null || typeof item !== "object") return null;
    const { asset, path: assetPath } = item as Record<string, unknown>;
    if (!nonEmpty(asset) || !nonEmpty(assetPath)) return null;
    runtimeAssets.push({ asset, path: assetPath });
  }
  return {
    releaseVersion: record.releaseVersion as string,
    executableAsset: record.executableAsset as string,
    dataAsset: record.dataAsset as string,
    directory: record.directory as string,
    executablePath: record.executablePath as string,
    dataPath: record.dataPath as string,
    runtimeAssets,
  };
}

export function icuAssetStem(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `domotion-icu-darwin-${arch}`;
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) return `domotion-icu-linux-${arch}`;
  if (platform === "win32" && (arch === "arm64" || arch === "x64")) return `domotion-icu-win32-${arch}`;
  return null;
}

export function icuCacheDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  version = ICU_COMPANION_VERSION,
): string {
  const suffix = path.join("domotion", "icu", version);
  if (platform === "darwin") return path.join(home, "Library", "Caches", suffix);
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), suffix);
  return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), suffix);
}

export function resolveIcuCompanionTarget(
  opts: IcuAcquireOptions = {},
  version = ICU_COMPANION_VERSION,
): IcuCompanionTarget | null {
  const platform = opts.platform ?? hostPlatform();
  const stem = icuAssetStem(platform, opts.arch ?? process.arch);
  if (stem == null) return null;
  const directory = opts.cacheDir ?? icuCacheDir(platform, process.env, homedir(), version);
  const executableAsset = platform === "win32" ? `${stem}.exe` : stem;
  const dataAsset = `${stem}.icudtl.dat`;
  return {
    releaseVersion: version,
    executableAsset,
    dataAsset,
    directory,
    executablePath: path.join(directory, platform === "win32" ? "domotion-icu.exe" : "domotion-icu"),
    dataPath: path.join(directory, "icudtl.dat"),
    runtimeAssets:
      platform === "win32"
        ? ["icuuc78.dll", "icudt78.dll"].map((name) => ({
            asset: `${stem}.${name}`,
            path: path.join(directory, name),
          }))
        : [],
  };
}

function parseSha(text: string): string {
  return text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

class IcuDownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchVerifiedAttempt(asset: string, version: string, remainingMs: number): Promise<Buffer> {
  const url = `https://github.com/brianwestphal/domotion/releases/download/icu-v${version}/${asset}`;
  const signal = AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs));
  const [body, sha] = await Promise.all([fetch(url, { signal }), fetch(`${url}.sha256`, { signal })]);
  const failures = [
    { name: "asset", response: body },
    { name: "checksum", response: sha },
  ].filter(({ response }) => !response.ok);
  if (failures.length > 0) {
    // A missing sidecar must not leave the large data download running while
    // another attempt or the legacy release starts using the same connection pool.
    await Promise.all([body.body?.cancel(), sha.body?.cancel()]);
    throw new IcuDownloadError(
      failures.map(({ name, response }) => `${name} HTTP ${response.status}`).join(", "),
      failures.every(({ response }) => transientStatus(response.status)),
    );
  }
  const bytes = Buffer.from(await body.arrayBuffer());
  const expected = parseSha(await sha.text());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== actual) {
    throw new IcuDownloadError(`SHA-256 mismatch (expected ${expected || "empty"}, received ${actual})`, false);
  }
  return bytes;
}

async function fetchVerified(asset: string, version: string, deadline: number): Promise<Buffer | null> {
  let lastFailure = "";
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; ++attempt) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      process.stderr.write(
        `domotion: ICU download ${version}/${asset} exhausted its ${DOWNLOAD_BUDGET_MS}ms budget after ${attempt - 1} attempt(s): ${lastFailure}\n`,
      );
      return null;
    }
    try {
      return await fetchVerifiedAttempt(asset, version, remainingMs);
    } catch (error) {
      const retryable =
        error instanceof IcuDownloadError
          ? error.retryable
          : error instanceof Error && ["TypeError", "TimeoutError", "AbortError"].includes(error.name);
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
      lastFailure = `${reason}${cause}`;
      if (retryable && attempt < DOWNLOAD_ATTEMPTS) {
        const backoffMs = Math.min(attempt * 250, Math.max(0, deadline - Date.now()));
        if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      process.stderr.write(
        `domotion: ICU download ${version}/${asset} failed after ${attempt} attempt(s): ${reason}${cause}\n`,
      );
      return null;
    }
  }
  return null;
}

export async function downloadIcuCompanion(target: IcuCompanionTarget): Promise<boolean> {
  // Leave worker startup/teardown room inside the synchronous 60-second cap.
  const deadline = Date.now() + DOWNLOAD_BUDGET_MS;
  const [executable, data, ...runtime] = await Promise.all([
    fetchVerified(target.executableAsset, target.releaseVersion, deadline),
    fetchVerified(target.dataAsset, target.releaseVersion, deadline),
    ...target.runtimeAssets.map((item) => fetchVerified(item.asset, target.releaseVersion, deadline)),
  ]);
  if (executable == null || data == null || runtime.some((bytes) => bytes == null)) return false;
  mkdirSync(target.directory, { recursive: true });
  const nonce = `${process.pid}-${Date.now()}`;
  const executableTmp = `${target.executablePath}.tmp-${nonce}`;
  const dataTmp = `${target.dataPath}.tmp-${nonce}`;
  writeFileSync(executableTmp, executable);
  chmodSync(executableTmp, 0o755);
  writeFileSync(dataTmp, data);
  // Install data first. A concurrent process can never observe a new helper
  // without its matching data; rename is atomic within the cache directory.
  renameSync(dataTmp, target.dataPath);
  for (let i = 0; i < target.runtimeAssets.length; ++i) {
    const item = target.runtimeAssets[i];
    const tmp = `${item.path}.tmp-${nonce}`;
    writeFileSync(tmp, runtime[i]!);
    renameSync(tmp, item.path);
  }
  renameSync(executableTmp, target.executablePath);
  return true;
}

function installed(target: IcuCompanionTarget): boolean {
  return (
    existsSync(target.executablePath) &&
    existsSync(target.dataPath) &&
    target.runtimeAssets.every((item) => existsSync(item.path))
  );
}

function downloadSync(target: IcuCompanionTarget): boolean {
  const workerPath = fileURLToPath(import.meta.url);
  // Source checkouts need tsx's .js→.ts import remapping; published dist does not.
  const workerArgs = icuAcquireWorkerArgs(workerPath, target);
  const proc = spawnSync(process.execPath, workerArgs, { timeout: DOWNLOAD_TIMEOUT_MS, encoding: "utf8" });
  if (proc.status === 0 && installed(target)) return true;
  const outcome =
    proc.error != null && "code" in proc.error && proc.error.code === "ETIMEDOUT"
      ? `timed out after ${DOWNLOAD_TIMEOUT_MS}ms`
      : `exited ${proc.status ?? "without status"}${proc.signal == null ? "" : ` (${proc.signal})`}`;
  const details = [proc.error?.message, proc.stderr?.trim()].filter(Boolean).join("; ").slice(0, 2_000);
  process.stderr.write(
    `domotion: ICU acquisition worker ${target.releaseVersion}/${target.executableAsset} ${outcome}${details ? `: ${details}` : ""}\n`,
  );
  return false;
}

let failed = false;
let preferredDownloadFailed = false;
export function acquireIcuCompanionSync(opts: IcuAcquireOptions = {}): string | undefined {
  if (process.env.DOMOTION_ICU_HELPER_PATH) return process.env.DOMOTION_ICU_HELPER_PATH;
  if (process.env.DOMOTION_DISABLE_ICU_HELPER === "1") return undefined;
  const target = resolveIcuCompanionTarget(opts);
  if (target == null) return undefined;
  if (installed(target)) return target.executablePath;
  if (!preferredDownloadFailed) {
    if (downloadSync(target)) return target.executablePath;
    preferredDownloadFailed = true;
  }
  // Keep the published .1 companion usable while the new .2 assets are built
  // and uploaded. Recheck .2 on a fresh process, so it takes over after release.
  const legacy = resolveIcuCompanionTarget(opts, LEGACY_ICU_COMPANION_VERSION)!;
  if (installed(legacy)) return legacy.executablePath;
  if (failed) return undefined;
  if (downloadSync(legacy)) return legacy.executablePath;
  failed = true;
  process.stderr.write(
    "domotion: WARNING: Chromium-matched ICU companion is unavailable; continuing with best-effort JavaScript Unicode classification. Font routing and shaping may differ from Chromium.\n",
  );
  return undefined;
}

export async function acquireIcuCompanion(opts: IcuAcquireOptions = {}): Promise<string | null> {
  if (process.env.DOMOTION_ICU_HELPER_PATH) return process.env.DOMOTION_ICU_HELPER_PATH;
  const target = resolveIcuCompanionTarget(opts);
  if (target == null) return null;
  if (installed(target)) {
    recoverIcuFromDegradedMode();
    return target.executablePath;
  }
  let ok: boolean;
  try {
    ok = await downloadIcuCompanion(target);
  } catch {
    ok = false;
  }
  if (ok) {
    preferredDownloadFailed = false;
    recoverIcuFromDegradedMode();
    return target.executablePath;
  }
  const legacy = resolveIcuCompanionTarget(opts, LEGACY_ICU_COMPANION_VERSION)!;
  if (!installed(legacy)) {
    try {
      ok = await downloadIcuCompanion(legacy);
    } catch {
      ok = false;
    }
    if (!ok) return null;
  }
  recoverIcuFromDegradedMode();
  return legacy.executablePath;
}

const icuRecoveryListeners = new Set<() => void>();

/**
 * Register a callback for the degraded → live transition: a successful
 * `acquireIcuCompanion()` after the synchronous acquisition already failed in
 * this process. Classification answers computed in between came from the
 * JavaScript fallback and feed font-routing memos, so the listeners must drop
 * them (the ICU memo itself, and the font-environment invalidation).
 */
export function onIcuCompanionRecovered(listener: () => void): () => void {
  icuRecoveryListeners.add(listener);
  return () => icuRecoveryListeners.delete(listener);
}

function recoverIcuFromDegradedMode(): void {
  if (!failed) return;
  failed = false;
  for (const listener of icuRecoveryListeners) listener();
}

export function __resetIcuAcquireStateForTest(): void {
  failed = false;
  preferredDownloadFailed = false;
}

/** Test-only: latch the synchronous-acquisition failure without a download attempt. */
export function __latchIcuAcquireFailureForTest(): void {
  failed = true;
}

const isWorker =
  process.argv[1] != null && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isWorker) {
  const target = parseIcuCompanionTarget(process.argv[2]);
  if (target == null) process.exit(2);
  downloadIcuCompanion(target)
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch(() => process.exit(1));
}
