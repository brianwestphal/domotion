/** On-demand acquisition for the independently versioned ICU companion. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostPlatform } from "./host-platform.js";

export const ICU_COMPANION_VERSION = "78.2-domotion.1";
const RELEASE_BASE = `https://github.com/brianwestphal/domotion/releases/download/icu-v${ICU_COMPANION_VERSION}`;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface IcuCompanionTarget {
  executableAsset: string;
  dataAsset: string;
  directory: string;
  executablePath: string;
  dataPath: string;
}

export interface IcuAcquireOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  cacheDir?: string;
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
  home = homedir()
): string {
  const suffix = path.join("domotion", "icu", ICU_COMPANION_VERSION);
  if (platform === "darwin") return path.join(home, "Library", "Caches", suffix);
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), suffix);
  return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), suffix);
}

export function resolveIcuCompanionTarget(opts: IcuAcquireOptions = {}): IcuCompanionTarget | null {
  const platform = opts.platform ?? hostPlatform();
  const stem = icuAssetStem(platform, opts.arch ?? process.arch);
  if (stem == null) return null;
  const directory = opts.cacheDir ?? icuCacheDir(platform);
  const executableAsset = platform === "win32" ? `${stem}.exe` : stem;
  const dataAsset = `${stem}.icudtl.dat`;
  return {
    executableAsset,
    dataAsset,
    directory,
    executablePath: path.join(directory, platform === "win32" ? "domotion-icu.exe" : "domotion-icu"),
    dataPath: path.join(directory, "icudtl.dat"),
  };
}

function parseSha(text: string): string {
  return text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

async function fetchVerified(asset: string): Promise<Buffer | null> {
  const url = `${RELEASE_BASE}/${asset}`;
  const [body, sha] = await Promise.all([fetch(url), fetch(`${url}.sha256`)]);
  if (!body.ok || !sha.ok) return null;
  const bytes = Buffer.from(await body.arrayBuffer());
  const expected = parseSha(await sha.text());
  const actual = createHash("sha256").update(bytes).digest("hex");
  return expected.length === 64 && expected === actual ? bytes : null;
}

export async function downloadIcuCompanion(target: IcuCompanionTarget): Promise<boolean> {
  const [executable, data] = await Promise.all([
    fetchVerified(target.executableAsset),
    fetchVerified(target.dataAsset),
  ]);
  if (executable == null || data == null) return false;
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
  renameSync(executableTmp, target.executablePath);
  return true;
}

let failed = false;
export function acquireIcuCompanionSync(opts: IcuAcquireOptions = {}): string | undefined {
  if (process.env.DOMOTION_ICU_HELPER_PATH) return process.env.DOMOTION_ICU_HELPER_PATH;
  if (process.env.DOMOTION_DISABLE_ICU_HELPER === "1") return undefined;
  const target = resolveIcuCompanionTarget(opts);
  if (target == null) return undefined;
  if (existsSync(target.executablePath) && existsSync(target.dataPath)) return target.executablePath;
  if (failed) return undefined;
  const proc = spawnSync(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify(target)], {
    timeout: DOWNLOAD_TIMEOUT_MS,
    encoding: "utf8",
  });
  if (proc.status === 0 && existsSync(target.executablePath) && existsSync(target.dataPath)) {
    return target.executablePath;
  }
  failed = true;
  process.stderr.write(
    "domotion: WARNING: Chromium-matched ICU companion is unavailable; continuing with best-effort JavaScript Unicode classification. Font routing and shaping may differ from Chromium.\n"
  );
  return undefined;
}

export async function acquireIcuCompanion(opts: IcuAcquireOptions = {}): Promise<string | null> {
  if (process.env.DOMOTION_ICU_HELPER_PATH) return process.env.DOMOTION_ICU_HELPER_PATH;
  const target = resolveIcuCompanionTarget(opts);
  if (target == null) return null;
  if (existsSync(target.executablePath) && existsSync(target.dataPath)) return target.executablePath;
  try {
    return await downloadIcuCompanion(target) ? target.executablePath : null;
  } catch {
    return null;
  }
}

export function __resetIcuAcquireState(): void { failed = false; }

const isWorker = process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isWorker) {
  const raw = process.argv[2];
  if (raw == null) process.exit(2);
  downloadIcuCompanion(JSON.parse(raw) as IcuCompanionTarget)
    .then(ok => process.exit(ok ? 0 : 1))
    .catch(() => process.exit(1));
}
