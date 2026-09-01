/**
 * Linux arm64 release-consumer evidence (DM-2353).
 *
 * This deliberately consumes the published helpers through the production
 * acquisition APIs.  It never builds a helper from the checkout: the question
 * is whether a clean arm64 consumer can download, authenticate and execute the
 * exact release artifacts that Domotion advertises.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch as osArch, platform as osPlatform, release as osRelease } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";
import { acquireGlyphHelper, assetNameFor } from "../src/render/helper-acquire.js";
import {
  acquireIcuCompanion,
  ICU_COMPANION_VERSION,
  resolveIcuCompanionTarget,
} from "../src/render/icu-helper-acquire.js";

const require = createRequire(import.meta.url);
const PKG = require("../package.json") as { version: string };
const PLAYWRIGHT_VERSION = (require("@playwright/test/package.json") as { version: string }).version;
const REPO = "brianwestphal/domotion";

// These are release facts, not tolerances.  A clobbered asset must make the
// gate red even when the replacement sidecar and GitHub API agree with each
// other.  A later Domotion release deliberately has to ratify new bytes here.
const PINNED_ARM64_RELEASES: Record<string, {
  glyph: string;
  icuExecutable: string;
  icuData: string;
}> = {
  "0.24.0": {
    glyph: "68546de5c29a60efbe1bdb86e61d14d9ba10f00020c5b50583f5bc336718c250",
    icuExecutable: "dcb7be05a66b98530d0eee0759bc79d8670fe383c338a73e873f0a346b13e6bf",
    icuData: "9f48c7f9c7c94d516a14870707e910ab94d75ae640ff6842c4af53276cd26ebe",
  },
};

export const REQUIRED_OUTCOMES = [
  "acquisition",
  "helper",
  "icu",
  "font-selection",
  "shaping",
  "decoration",
  "paint",
  "html",
  "unicode",
] as const;

const REQUIRED_ARTIFACTS = [
  "acquisition.json",
  "run-env.json",
  "logs/helper.log",
  "logs/icu.log",
  "font-selection/report.json",
  "shaping.json",
  "decoration.json",
  "paint-geometry.json",
  "paint-browser.json",
  "html/results.json",
  "unicode/results.json",
] as const;

interface ElfIdentity {
  valid: boolean;
  class: "ELF32" | "ELF64" | "unknown";
  endian: "little" | "big" | "unknown";
  machine: number | null;
  architecture: "arm64" | "x64" | "unknown";
}

interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  digest: string | null;
  browser_download_url: string;
  download_count: number;
  updated_at: string;
}

interface AssetEvidence {
  tag: string;
  name: string;
  assetId: number;
  size: number;
  updatedAt: string;
  downloadCountAtProbe: number;
  sha256: string;
  sidecarSha256: string;
  githubDigestSha256: string;
  pinnedSha256: string;
  allAuthoritiesAgree: boolean;
  path: string;
  executable: boolean;
  elf?: ElfIdentity;
}

interface AcquisitionReport {
  schemaVersion: 1;
  ticket: "DM-2353";
  generatedAt: string;
  target: { platform: string; architecture: string };
  packageVersion: string;
  icuCompanionVersion: string;
  cacheRoot: string;
  cacheWasEmpty: boolean;
  cacheReuse: {
    glyphSamePath: boolean;
    glyphSameSha256: boolean;
    glyphMtimeUnchanged: boolean;
    icuSamePath: boolean;
    icuSameSha256: boolean;
    icuMtimeUnchanged: boolean;
  };
  assets: {
    glyph: AssetEvidence;
    icuExecutable: AssetEvidence;
    icuData: AssetEvidence;
  };
  smoke: Record<string, unknown>;
  trust: {
    signing: "not-applicable-linux-elf";
    signingReason: string;
    checksums: "pinned-sidecar-github-digest-exact";
  };
  environment: Record<string, unknown>;
  environmentFingerprint: string;
  verdict: "acquisition-exact" | "acquisition-drift";
  errors: string[];
}

interface ArtifactDigest {
  path: string;
  size: number;
  sha256: string;
}

export interface FinalEvidenceReport {
  schemaVersion: 1;
  ticket: "DM-2353";
  generatedAt: string;
  target: { platform: string; architecture: string };
  acquisitionFingerprint: string | null;
  outcomes: Record<string, string>;
  artifacts: ArtifactDigest[];
  artifactSetSha256: string;
  errors: string[];
  verdict: "exact-arm64-release-parity" | "arm64-release-parity-drift";
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stable JSON used for fingerprints: object key order is never evidence. */
export function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function stableFingerprint(value: unknown): string {
  return sha256(stableJson(value));
}

/** Read only the architecture-bearing ELF header fields. */
export function parseElfIdentity(bytes: Buffer): ElfIdentity {
  if (bytes.length < 20 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    return { valid: false, class: "unknown", endian: "unknown", machine: null, architecture: "unknown" };
  }
  const elfClass = bytes[4] === 2 ? "ELF64" : bytes[4] === 1 ? "ELF32" : "unknown";
  const endian = bytes[5] === 1 ? "little" : bytes[5] === 2 ? "big" : "unknown";
  if (elfClass === "unknown" || endian === "unknown") {
    return { valid: false, class: elfClass, endian, machine: null, architecture: "unknown" };
  }
  const machine = endian === "little" ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
  return {
    valid: true,
    class: elfClass,
    endian,
    machine,
    architecture: machine === 183 ? "arm64" : machine === 62 ? "x64" : "unknown",
  };
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredArg(args: string[], flag: string): string {
  const value = argValue(args, flag);
  if (value == null || value.trim() === "") throw new Error(`${flag} is required`);
  return value;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function execText(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 30_000 }).trim();
  } catch {
    return null;
  }
}

function runJson(binary: string, args: string[], input?: unknown): unknown {
  const result = spawnSync(binary, args, {
    input: input == null ? undefined : JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`${path.basename(binary)} ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${path.basename(binary)} ${args.join(" ")} returned non-JSON output`);
  }
}

function runText(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(`${path.basename(binary)} ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function parseSidecar(text: string): string {
  const digest = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("release checksum sidecar is not a SHA-256 digest");
  return digest;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "domotion-linux-arm64-release-evidence",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token != null && token !== "") headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function releaseAssets(tag: string): Promise<ReleaseAsset[]> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: githubHeaders(),
  });
  if (!response.ok) throw new Error(`GitHub release API ${tag} returned ${response.status}`);
  const body = await response.json() as { assets?: ReleaseAsset[] };
  if (!Array.isArray(body.assets)) throw new Error(`GitHub release ${tag} omitted assets`);
  return body.assets;
}

async function assetEvidence(
  tag: string,
  assetName: string,
  localPath: string,
  pinnedSha256: string,
  assets: ReleaseAsset[],
  executable: boolean,
): Promise<AssetEvidence> {
  const asset = assets.find((candidate) => candidate.name === assetName);
  const sidecar = assets.find((candidate) => candidate.name === `${assetName}.sha256`);
  if (asset == null) throw new Error(`${tag} is missing ${assetName}`);
  if (sidecar == null) throw new Error(`${tag} is missing ${assetName}.sha256`);
  const sidecarResponse = await fetch(sidecar.browser_download_url, { headers: githubHeaders() });
  if (!sidecarResponse.ok) throw new Error(`${assetName}.sha256 returned ${sidecarResponse.status}`);
  const localBytes = readFileSync(localPath);
  const localSha256 = sha256(localBytes);
  const sidecarSha256 = parseSidecar(await sidecarResponse.text());
  const githubDigestSha256 = asset.digest?.replace(/^sha256:/, "").toLowerCase() ?? "";
  const modeExecutable = !executable || (statSync(localPath).mode & 0o111) !== 0;
  const allAuthoritiesAgree = localSha256 === sidecarSha256
    && localSha256 === githubDigestSha256
    && localSha256 === pinnedSha256
    && asset.size === localBytes.byteLength
    && modeExecutable;
  const evidence: AssetEvidence = {
    tag,
    name: assetName,
    assetId: asset.id,
    size: asset.size,
    updatedAt: asset.updated_at,
    downloadCountAtProbe: asset.download_count,
    sha256: localSha256,
    sidecarSha256,
    githubDigestSha256,
    pinnedSha256,
    allAuthoritiesAgree,
    path: localPath,
    executable: modeExecutable,
  };
  if (executable) evidence.elf = parseElfIdentity(localBytes.subarray(0, 64));
  return evidence;
}

function helperSmoke(helperPath: string): Record<string, unknown> {
  const version = runText(helperPath, ["--version"]);
  if (version !== "domotion-glyph-paths (linux/freetype) 0.4.0") {
    throw new Error(`unexpected glyph helper version: ${version}`);
  }
  const fontconfigMode = runJson(helperPath, ["--fontconfig-mode"]) as { fontations?: boolean; configReady?: boolean };
  if (fontconfigMode.fontations !== true || fontconfigMode.configReady !== true) {
    throw new Error(`glyph helper fontconfig mode is not Chromium-matched: ${JSON.stringify(fontconfigMode)}`);
  }
  const routing = runJson(helperPath, [], {
    fonts: [],
    queries: [
      { type: "familyMatch", family: "Arial", cssWeight: 550, italic: false, cssWidth: 100 },
      { type: "fcfallback", lang: "en", cps: [0x41, 0x4e00] },
    ],
  }) as { results?: Array<Record<string, unknown>> };
  const family = routing.results?.[0] as { found?: boolean; path?: string; postscriptName?: string; index?: number } | undefined;
  const fallback = routing.results?.[1] as { fonts?: Array<{ cp?: number; found?: boolean; path?: string }> } | undefined;
  if (family?.found !== true || family.path == null || !existsSync(family.path)) {
    throw new Error(`familyMatch did not resolve a readable Arial@550 face: ${JSON.stringify(family)}`);
  }
  if (fallback?.fonts?.length !== 2 || fallback.fonts.some((entry) => entry.found !== true || entry.path == null)) {
    throw new Error(`fcfallback did not resolve both Latin and Han probes: ${JSON.stringify(fallback)}`);
  }
  const outline = runJson(helperPath, [], {
    fonts: [{ ref: "matched", fontPath: family.path, postscriptName: family.postscriptName ?? "", size: 1000 }],
    queries: [
      { type: "meta", fontRef: "matched" },
      { type: "glyphs", fontRef: "matched", glyphs: [{ cp: 0x48 }] },
    ],
  }) as { results?: Array<Record<string, unknown>> };
  const meta = outline.results?.[0] as { unitsPerEm?: number; ascent?: number } | undefined;
  const glyphResult = outline.results?.[1] as { glyphs?: Array<{ id?: number; d?: string }> } | undefined;
  const glyph = glyphResult?.glyphs?.[0];
  if (!(typeof meta?.unitsPerEm === "number" && meta.unitsPerEm > 0 && typeof meta.ascent === "number")) {
    throw new Error(`glyph helper meta probe failed: ${JSON.stringify(meta)}`);
  }
  if (!(typeof glyph?.id === "number" && glyph.id > 0 && typeof glyph.d === "string" && glyph.d.length > 0)) {
    throw new Error(`glyph helper outline probe failed: ${JSON.stringify(glyph)}`);
  }
  return {
    version,
    fontconfigMode,
    familyMatch: family,
    fallback: fallback.fonts,
    meta,
    glyphH: { id: glyph.id, outlineSha256: sha256(glyph.d) },
  };
}

function icuSmoke(helperPath: string): Record<string, unknown> {
  const version = runText(helperPath, ["--version"]);
  const digest = runJson(helperPath, ["--digest"]) as Record<string, unknown>;
  const expected = {
    protocolVersion: "1",
    icuVersion: "78.2",
    codepoints: 0x110000,
    assigned: 299382,
    fnv1a64: "6c5c14d607f8d945",
  };
  if (version !== "domotion-icu 1 ICU 78.2" || stableJson(digest) !== stableJson(expected)) {
    throw new Error(`ICU companion protocol drift: version=${version}, digest=${JSON.stringify(digest)}`);
  }
  return { version, digest };
}

function fontInventory(): { source: string; count: number; digest: string; entries: string[] } {
  const output = execText("fc-list", [":", "family"]);
  if (output == null) throw new Error("fc-list is unavailable on the arm64 runner");
  const entries = [...new Set(output.split("\n").flatMap((line) => line.split(",")).map((entry) => entry.trim()).filter(Boolean))].sort();
  if (entries.length === 0) throw new Error("fontconfig reported an empty font inventory");
  return { source: "fc-list : family", count: entries.length, digest: sha256(entries.join("\n")), entries };
}

function glibcVersion(): string | null {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ?? execText("getconf", ["GNU_LIBC_VERSION"]);
}

async function captureEnvironment(assets: AcquisitionReport["assets"]): Promise<Record<string, unknown>> {
  const browser = await chromium.launch();
  let chromiumVersion: string;
  try {
    chromiumVersion = browser.version();
  } finally {
    await browser.close();
  }
  return {
    runner: {
      name: process.env.RUNNER_NAME ?? null,
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      runnerArch: process.env.RUNNER_ARCH ?? null,
    },
    host: { platform: osPlatform(), architecture: osArch(), osRelease: osRelease(), glibc: glibcVersion() },
    runtimes: {
      node: process.version,
      nodeIcu: process.versions.icu,
      nodeUnicode: process.versions.unicode,
      playwright: PLAYWRIGHT_VERSION,
      chromium: chromiumVersion,
      fontconfig: execText("fc-list", ["--version"]),
    },
    source: {
      checkoutSha: process.env.GITHUB_SHA ?? execText("git", ["rev-parse", "HEAD"]),
      packageVersion: PKG.version,
      chromiumRevision: process.env.DOMOTION_CHROMIUM_REVISION
        ?? execText("git", ["-C", "external/chromium", "rev-parse", "HEAD"]),
      harfbuzzRevision: process.env.DOMOTION_HARFBUZZ_REVISION
        ?? execText("git", ["-C", "external/harfbuzz", "rev-parse", "HEAD"]),
      skiaRevision: process.env.DOMOTION_SKIA_REVISION
        ?? execText("git", ["-C", "external/skia", "rev-parse", "HEAD"]),
      icuSourceRevision: process.env.DOMOTION_ICU_SOURCE_REVISION ?? null,
    },
    fonts: fontInventory(),
    releaseAssets: {
      glyph: { tag: assets.glyph.tag, name: assets.glyph.name, sha256: assets.glyph.sha256 },
      icuExecutable: { tag: assets.icuExecutable.tag, name: assets.icuExecutable.name, sha256: assets.icuExecutable.sha256 },
      icuData: { tag: assets.icuData.tag, name: assets.icuData.name, sha256: assets.icuData.sha256 },
    },
  };
}

const REQUIRED_SOURCE_REVISIONS = [
  "checkoutSha",
  "chromiumRevision",
  "harfbuzzRevision",
  "skiaRevision",
  "icuSourceRevision",
] as const;

/** A digest is only source evidence when every governing checkout is identified. */
export function sourceFingerprintErrors(environment: unknown): string[] {
  const source = environment != null && typeof environment === "object"
    ? (environment as { source?: unknown }).source
    : null;
  if (source == null || typeof source !== "object") {
    return ["source fingerprint is missing"];
  }
  const record = source as Record<string, unknown>;
  return REQUIRED_SOURCE_REVISIONS.flatMap((name) => (
    typeof record[name] === "string" && /^[0-9a-f]{40}$/.test(record[name])
      ? []
      : [`source fingerprint ${name} is missing or is not a full revision`]
  ));
}

function ensureCleanCacheRoot(cacheRoot: string): void {
  if (existsSync(cacheRoot) && readdirSync(cacheRoot).length !== 0) {
    throw new Error(`cache root must be empty: ${cacheRoot}`);
  }
  mkdirSync(cacheRoot, { recursive: true });
}

async function acquireEvidence(cacheRoot: string, version: string): Promise<AcquisitionReport> {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error(`DM-2353 requires a native linux/arm64 process, got ${process.platform}/${process.arch}`);
  }
  const pinned = PINNED_ARM64_RELEASES[version];
  if (pinned == null) throw new Error(`no ratified arm64 release fingerprints for Domotion ${version}`);
  ensureCleanCacheRoot(cacheRoot);
  const glyphCache = path.join(cacheRoot, "glyph");
  const icuCache = path.join(cacheRoot, "icu");
  const glyphName = assetNameFor("linux", "arm64");
  const icuTarget = resolveIcuCompanionTarget({ platform: "linux", arch: "arm64", cacheDir: icuCache });
  if (glyphName == null || icuTarget == null) throw new Error("production acquisition rejected linux/arm64");

  const glyphPath = await acquireGlyphHelper({ platform: "linux", arch: "arm64", version, cacheDir: glyphCache });
  const icuPath = await acquireIcuCompanion({ platform: "linux", arch: "arm64", cacheDir: icuCache });
  if (glyphPath == null) throw new Error(`production glyph acquisition failed for v${version}/${glyphName}`);
  if (icuPath == null) throw new Error(`production ICU acquisition failed for icu-v${ICU_COMPANION_VERSION}`);
  const glyphBefore = { sha: sha256(readFileSync(glyphPath)), mtime: statSync(glyphPath).mtimeMs };
  const icuBefore = { sha: sha256(readFileSync(icuPath)), mtime: statSync(icuPath).mtimeMs };
  const glyphAgain = await acquireGlyphHelper({ platform: "linux", arch: "arm64", version, cacheDir: glyphCache });
  const icuAgain = await acquireIcuCompanion({ platform: "linux", arch: "arm64", cacheDir: icuCache });
  const cacheReuse = {
    glyphSamePath: glyphAgain === glyphPath,
    glyphSameSha256: glyphAgain != null && sha256(readFileSync(glyphAgain)) === glyphBefore.sha,
    glyphMtimeUnchanged: statSync(glyphPath).mtimeMs === glyphBefore.mtime,
    icuSamePath: icuAgain === icuPath,
    icuSameSha256: icuAgain != null && sha256(readFileSync(icuAgain)) === icuBefore.sha,
    icuMtimeUnchanged: statSync(icuPath).mtimeMs === icuBefore.mtime,
  };

  const [glyphRelease, icuRelease] = await Promise.all([
    releaseAssets(`v${version}`),
    releaseAssets(`icu-v${ICU_COMPANION_VERSION}`),
  ]);
  const assets = {
    glyph: await assetEvidence(`v${version}`, glyphName, glyphPath, pinned.glyph, glyphRelease, true),
    icuExecutable: await assetEvidence(
      `icu-v${ICU_COMPANION_VERSION}`,
      icuTarget.executableAsset,
      icuTarget.executablePath,
      pinned.icuExecutable,
      icuRelease,
      true,
    ),
    icuData: await assetEvidence(
      `icu-v${ICU_COMPANION_VERSION}`,
      icuTarget.dataAsset,
      icuTarget.dataPath,
      pinned.icuData,
      icuRelease,
      false,
    ),
  };
  const errors: string[] = [];
  for (const [name, asset] of Object.entries(assets)) {
    if (!asset.allAuthoritiesAgree) errors.push(`${name}: release digest authorities disagree`);
    if (asset.elf != null && (!asset.elf.valid || asset.elf.class !== "ELF64" || asset.elf.endian !== "little" || asset.elf.architecture !== "arm64")) {
      errors.push(`${name}: expected little-endian ELF64 AArch64, got ${JSON.stringify(asset.elf)}`);
    }
  }
  if (Object.values(cacheReuse).some((value) => !value)) errors.push("second acquisition did not reuse byte-identical cache entries");
  const smoke = { glyph: helperSmoke(glyphPath), icu: icuSmoke(icuPath) };
  const environment = await captureEnvironment(assets);
  errors.push(...sourceFingerprintErrors(environment));
  const report: AcquisitionReport = {
    schemaVersion: 1,
    ticket: "DM-2353",
    generatedAt: new Date().toISOString(),
    target: { platform: process.platform, architecture: process.arch },
    packageVersion: version,
    icuCompanionVersion: ICU_COMPANION_VERSION,
    cacheRoot,
    cacheWasEmpty: true,
    cacheReuse,
    assets,
    smoke,
    trust: {
      signing: "not-applicable-linux-elf",
      signingReason: "Linux release helpers are unsigned ELF binaries; pinned SHA-256, release sidecars, and GitHub asset digests are the trust boundary.",
      checksums: "pinned-sidecar-github-digest-exact",
    },
    environment,
    environmentFingerprint: stableFingerprint(environment),
    verdict: errors.length === 0 ? "acquisition-exact" : "acquisition-drift",
    errors,
  };
  return report;
}

function parseOutcomes(raw: string): Record<string, string> {
  return Object.fromEntries(raw.split(",").map((part) => {
    const index = part.indexOf("=");
    if (index < 1) throw new Error(`invalid outcome: ${part}`);
    return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
}

function walkFiles(root: string, directory = root): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(root, absolute) : [path.relative(root, absolute).split(path.sep).join("/")];
  });
}

function digestArtifacts(root: string): ArtifactDigest[] {
  return walkFiles(root).sort().map((relative) => {
    const bytes = readFileSync(path.join(root, relative));
    return { path: relative, size: bytes.byteLength, sha256: sha256(bytes) };
  });
}

function readJson(relative: string, root: string): unknown {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}

interface DecorationEvidenceReport {
  platform?: string;
  architecture?: string;
  coordinateOwnership?: {
    source?: string;
    chromePaintDeviceScaleFactor?: number;
    domotionCaptureDeviceScaleFactor?: number;
  };
  tolerances?: { svgGeometry?: number };
  gates?: Record<string, boolean>;
  results?: Array<Record<string, { ok?: boolean } | null>>;
}

/** Fail closed on the coherent-DPR decoration evidence fixed by DM-2501. */
export function decorationEvidenceErrors(decoration: DecorationEvidenceReport): string[] {
  const errors: string[] = [];
  const ownership = decoration.coordinateOwnership;
  if (decoration.platform !== "linux" || decoration.architecture !== "arm64") {
    errors.push("decoration report is not native linux/arm64 evidence");
  }
  if (ownership?.source !== "blink-physical-text-fragment-same-dpr-v1"
    || ownership.chromePaintDeviceScaleFactor !== 4
    || ownership.domotionCaptureDeviceScaleFactor !== 4) {
    errors.push("decoration report does not bind Chrome paint and Domotion capture to the required DPR 4 Blink state");
  }
  if (decoration.tolerances?.svgGeometry !== 0.3) {
    errors.push("decoration SVG geometry tolerance is not the source-owned 0.3 CSS px envelope");
  }
  if (decoration.gates?.transcription !== true
    || decoration.gates.skipInk !== true
    || decoration.gates.svgGeometry !== true) {
    errors.push("decoration report does not arm every logical gate");
  }
  if (!Array.isArray(decoration.results) || decoration.results.length !== 109) {
    errors.push("decoration report is not the complete 109-row matrix");
  } else {
    const skipInkRows = decoration.results.filter((row) => row.skipInk != null);
    if (skipInkRows.length !== 30) errors.push("decoration report is not the complete 30-row skip-ink/pattern matrix");
    if (decoration.results.some((row) => row.transcription?.ok !== true
      || row.svgGeometry?.ok !== true
      || (row.skipInk != null && row.skipInk.ok !== true))) {
      errors.push("decoration report contains a gated mismatch");
    }
  }
  return errors;
}

function semanticArtifactErrors(root: string): string[] {
  const errors: string[] = [];
  const font = readJson("font-selection/report.json", root) as { summary?: { verdict?: string; mismatchTotal?: number } };
  if (font.summary?.verdict !== "exact-logical-agreement" || font.summary.mismatchTotal !== 0) errors.push("font selection report is not exact logical agreement");
  const shaping = readJson("shaping.json", root) as { verdict?: string; movementProven?: boolean; pairs?: number };
  if (shaping.verdict !== "exact-logical-agreement" || shaping.movementProven !== true || !(Number(shaping.pairs) > 0)) errors.push("shaping report is not exact and sensitivity-proven");
  const decoration = readJson("decoration.json", root) as DecorationEvidenceReport;
  errors.push(...decorationEvidenceErrors(decoration));
  const paint = readJson("paint-geometry.json", root) as { verdict?: string; movementProven?: boolean; rows?: unknown[] };
  if (paint.verdict !== "exact-logical-agreement" || paint.movementProven !== true || !Array.isArray(paint.rows) || paint.rows.length < 100) errors.push("paint source geometry report is not the full exact corpus");
  const paintBrowser = readJson("paint-browser.json", root) as { verdict?: string; architecture?: string; platform?: string; probes?: unknown[] };
  if (paintBrowser.verdict !== "browser-validates-source-rules" || paintBrowser.platform !== "linux" || paintBrowser.architecture !== "arm64" || !Array.isArray(paintBrowser.probes) || paintBrowser.probes.length === 0) errors.push("paint browser report is not native arm64 source agreement");
  for (const suite of ["html", "unicode"] as const) {
    const rows = readJson(`${suite}/results.json`, root) as Array<{ pass?: boolean; skipped?: boolean }>;
    if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => row.pass !== true || row.skipped === true)) errors.push(`${suite} visual corpus is empty, skipped, or non-passing`);
  }
  return errors;
}

export function buildFinalReport(
  acquisition: Partial<AcquisitionReport>,
  outcomes: Record<string, string>,
  artifacts: ArtifactDigest[],
  extraErrors: string[] = [],
): FinalEvidenceReport {
  const errors = [...extraErrors];
  if (acquisition.target?.platform !== "linux" || acquisition.target?.architecture !== "arm64") errors.push("acquisition target is not linux/arm64");
  if (acquisition.verdict !== "acquisition-exact") errors.push("acquisition verdict is not exact");
  if (typeof acquisition.environmentFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(acquisition.environmentFingerprint)) errors.push("acquisition environment fingerprint is missing");
  errors.push(...sourceFingerprintErrors(acquisition.environment));
  for (const name of REQUIRED_OUTCOMES) {
    if (outcomes[name] !== "success") errors.push(`${name} outcome is ${outcomes[name] ?? "missing"}`);
  }
  const artifactPaths = new Set(artifacts.map((artifact) => artifact.path));
  for (const required of REQUIRED_ARTIFACTS) if (!artifactPaths.has(required)) errors.push(`required artifact missing: ${required}`);
  const artifactSetSha256 = stableFingerprint(artifacts.map(({ path: file, size, sha256: digest }) => ({ path: file, size, sha256: digest })));
  return {
    schemaVersion: 1,
    ticket: "DM-2353",
    generatedAt: new Date().toISOString(),
    target: { platform: acquisition.target?.platform ?? "unknown", architecture: acquisition.target?.architecture ?? "unknown" },
    acquisitionFingerprint: acquisition.environmentFingerprint ?? null,
    outcomes,
    artifacts,
    artifactSetSha256,
    errors,
    verdict: errors.length === 0 ? "exact-arm64-release-parity" : "arm64-release-parity-drift",
  };
}

async function acquireCommand(args: string[]): Promise<number> {
  const output = requiredArg(args, "--json");
  const runEnvOutput = requiredArg(args, "--run-env");
  try {
    const cacheRoot = path.resolve(requiredArg(args, "--cache-root"));
    const version = argValue(args, "--glyph-version") ?? PKG.version;
    const report = await acquireEvidence(cacheRoot, version);
    writeJson(output, report);
    writeJson(runEnvOutput, { ...report.environment, fingerprint: report.environmentFingerprint });
    const githubEnv = argValue(args, "--github-env");
    if (githubEnv != null) {
      const icuTarget = resolveIcuCompanionTarget({ platform: "linux", arch: "arm64", cacheDir: path.join(cacheRoot, "icu") });
      if (icuTarget == null) throw new Error("could not resolve acquired ICU target");
      const lines = [
        `DOMOTION_HELPER_PATH=${report.assets.glyph.path}`,
        `DOMOTION_HELPER_VERSION=github-release:v${version}:sha256:${report.assets.glyph.sha256}`,
        `DOMOTION_ICU_HELPER_PATH=${report.assets.icuExecutable.path}`,
        `DOMOTION_ICU_DATA=${icuTarget.dataPath}`,
      ];
      writeFileSync(githubEnv, `${lines.join("\n")}\n`, { flag: "a" });
    }
    process.stdout.write(`${JSON.stringify({ verdict: report.verdict, environmentFingerprint: report.environmentFingerprint })}\n`);
    return report.verdict === "acquisition-exact" ? 0 : 1;
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      ticket: "DM-2353",
      generatedAt: new Date().toISOString(),
      target: { platform: process.platform, architecture: process.arch },
      verdict: "acquisition-drift",
      errors: [String(error instanceof Error ? error.message : error)],
    };
    writeJson(output, failure);
    writeJson(runEnvOutput, failure);
    process.stderr.write(`${failure.errors[0]}\n`);
    return 1;
  }
}

function finalizeCommand(args: string[]): number {
  const output = requiredArg(args, "--json");
  try {
    const acquisition = JSON.parse(readFileSync(requiredArg(args, "--acquisition"), "utf8")) as AcquisitionReport;
    const artifactsRoot = path.resolve(requiredArg(args, "--artifacts-root"));
    const outcomes = parseOutcomes(requiredArg(args, "--outcomes"));
    const artifacts = digestArtifacts(artifactsRoot).filter((artifact) => artifact.path !== path.relative(artifactsRoot, output).split(path.sep).join("/"));
    let semanticErrors: string[] = [];
    try {
      semanticErrors = semanticArtifactErrors(artifactsRoot);
    } catch (error) {
      semanticErrors = [`could not validate artifact semantics: ${String(error instanceof Error ? error.message : error)}`];
    }
    const report = buildFinalReport(acquisition, outcomes, artifacts, semanticErrors);
    writeJson(output, report);
    process.stdout.write(`${JSON.stringify({ verdict: report.verdict, artifactSetSha256: report.artifactSetSha256 })}\n`);
    return report.verdict === "exact-arm64-release-parity" ? 0 : 1;
  } catch (error) {
    const report: FinalEvidenceReport = {
      schemaVersion: 1,
      ticket: "DM-2353",
      generatedAt: new Date().toISOString(),
      target: { platform: process.platform, architecture: process.arch },
      acquisitionFingerprint: null,
      outcomes: {},
      artifacts: [],
      artifactSetSha256: stableFingerprint([]),
      errors: [String(error instanceof Error ? error.message : error)],
      verdict: "arm64-release-parity-drift",
    };
    writeJson(output, report);
    process.stderr.write(`${report.errors[0]}\n`);
    return 1;
  }
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "acquire") return acquireCommand(args);
  if (command === "finalize") return finalizeCommand(args);
  process.stderr.write("usage: linux-arm64-release-evidence.ts <acquire|finalize> ...\n");
  return 2;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
