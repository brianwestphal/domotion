/**
 * Authenticated runtime boundary for the separately distributed paged-capture
 * Chromium helper. This module never downloads a browser and never falls back
 * to Playwright's stock Chromium.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { release as osRelease } from "node:os";

import {
  chromium,
  type Browser,
  type LaunchOptions,
} from "@playwright/test";
import { z } from "zod";

import {
  PAGED_CAPTURE_HELPER_PATCH_SHA256,
  PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256,
  PAGED_CAPTURE_SKIA_REVISION,
} from "./paged-capture-bundle.js";
import {
  PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
  buildPagedCollapsedTableRecord,
  type PagedCollapsedPageRecord,
} from "./paged-collapsed-table-record.js";

export const PAGED_CAPTURE_HELPER_BUNDLE_SCHEMA_VERSION = 2 as const;
export const PAGED_CAPTURE_HELPER_RUNTIME_ABI =
  "domotion-paged-capture-helper-runtime-v2" as const;
export const PAGED_CAPTURE_HELPER_TRANSPORT_ABI =
  "domotion-paged-capture-combined-v2" as const;
export const PAGED_CAPTURE_HELPER_TABLE_TRANSPORT_ABI =
  "domotion-paged-table-physical-fragment-v1" as const;
export const PAGED_CAPTURE_HELPER_TABLE_OWNERSHIP_CAPABILITY =
  "paged-table-ownership-v1" as const;
export const PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY =
  "paged-page-svg-v1" as const;
export const PAGED_CAPTURE_HELPER_MAX_SIDECAR_BYTES = 67_108_864 as const;
export const PAGED_CAPTURE_HELPER_MAX_TABLE_SIDECAR_BYTES = 8_388_608 as const;
export const PAGED_CAPTURE_HELPER_MAX_PAGE_RECORD_BYTES = 67_108_864 as const;
export const PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION =
  "612d70c7ccb01d4a405e822ad0505206de636d7e" as const;

const execFileAsync = promisify(execFile);
const SHA256 = /^[0-9a-f]{64}$/;
const DOTTED_VERSION = /^\d+(?:\.\d+)*$/;
const sha256Schema = z.string().regex(SHA256, "expected lowercase SHA-256");
const memberPathSchema = z.string().superRefine((value, context) => {
  if (value === "" || isAbsolute(value) || value.includes("\\")) {
    context.addIssue({ code: "custom", message: "expected a relative POSIX path" });
    return;
  }
  const components = value.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    context.addIssue({ code: "custom", message: "path contains an unsafe component" });
  }
});
const linkTargetSchema = z.string().superRefine((value, context) => {
  if (value === "" || isAbsolute(value) || value.includes("\\")) {
    context.addIssue({ code: "custom", message: "expected a relative POSIX symlink target" });
  }
});
const memberRoleSchema = z.enum([
  "executable",
  "runtime-dependency",
  "license",
  "metadata",
]);
const memberBase = {
  path: memberPathSchema,
  role: memberRoleSchema,
  byteLength: z.number().int().safe().nonnegative(),
  sha256: sha256Schema,
  mode: z.number().int().min(0).max(0o777),
};
const memberSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...memberBase, kind: z.literal("file") }),
  z.strictObject({
    ...memberBase,
    kind: z.literal("symlink"),
    linkTarget: linkTargetSchema,
  }),
]);

const platformSchema = z.discriminatedUnion("os", [
  z.strictObject({
    os: z.literal("darwin"),
    architecture: z.enum(["x64", "arm64"]),
    minimumVersion: z.string().regex(DOTTED_VERSION),
    codeSignatureIdentity: z.string().min(1),
    quarantineState: z.enum(["absent", "present"]),
  }),
  z.strictObject({
    os: z.literal("linux"),
    architecture: z.enum(["x64", "arm64"]),
    glibcMinimum: z.string().regex(DOTTED_VERSION),
    sandboxMode: z.enum(["user-namespace", "disabled-explicitly"]),
    dtNeededSha256: sha256Schema,
  }),
  z.strictObject({
    os: z.literal("win32"),
    architecture: z.enum(["x64", "arm64"]),
    minimumBuild: z.string().regex(/^\d+$/),
    authenticodeIdentity: z.string().min(1),
    dllClosureSha256: sha256Schema,
  }),
]);

export const pagedCaptureHelperBundleManifestSchema = z.strictObject({
  schemaVersion: z.literal(PAGED_CAPTURE_HELPER_BUNDLE_SCHEMA_VERSION),
  runtimeAbi: z.literal(PAGED_CAPTURE_HELPER_RUNTIME_ABI),
  transportAbi: z.literal(PAGED_CAPTURE_HELPER_TRANSPORT_ABI),
  capabilities: z.tuple([
    z.literal(PAGED_CAPTURE_HELPER_TABLE_OWNERSHIP_CAPABILITY),
    z.literal(PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY),
  ]),
  platform: platformSchema,
  source: z.strictObject({
    chromiumRevision: z.literal(PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION),
    skiaRevision: z.literal(PAGED_CAPTURE_SKIA_REVISION),
    depotToolsRevision: z.literal(PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION),
    patchSha256: z.literal(PAGED_CAPTURE_HELPER_PATCH_SHA256),
    skiaPatchSha256: z.literal(PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256),
  }),
  protocol: z.strictObject({
    product: z.string().min(1),
    protocolVersion: z.string().min(1),
    schemaSha256: sha256Schema,
  }),
  runtime: z.strictObject({
    executablePath: memberPathSchema,
    runtimeDependenciesSha256: sha256Schema,
    defaultEnabled: z.literal(false),
    maximumSidecarBytes: z.literal(PAGED_CAPTURE_HELPER_MAX_SIDECAR_BYTES),
  }),
  distribution: z.strictObject({
    mode: z.literal("caller-supplied-local-bundle"),
    automaticDownloads: z.literal(false),
    updatePolicy: z.literal("manual-pinned-only"),
    sourceArchiveUrl: z.string().url().refine((value) => value.startsWith("https://"), {
      message: "source archive URL must use HTTPS",
    }),
    licenseFiles: z.array(memberPathSchema).min(1),
  }),
  members: z.array(memberSchema).min(2),
}).superRefine((manifest, context) => {
  const paths = manifest.members.map((member) => member.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", path: ["members"], message: "member paths must be unique" });
  }
  if (paths.some((path, index) => index > 0 && paths[index - 1] >= path)) {
    context.addIssue({ code: "custom", path: ["members"], message: "members must be path-sorted" });
  }
  const executable = manifest.members.find((member) => member.path === manifest.runtime.executablePath);
  if (executable?.kind !== "file" || executable.role !== "executable") {
    context.addIssue({
      code: "custom",
      path: ["runtime", "executablePath"],
      message: "executablePath must name one regular executable member",
    });
  }
  if (manifest.members.filter((member) => member.role === "executable").length !== 1) {
    context.addIssue({ code: "custom", path: ["members"], message: "expected exactly one executable" });
  }
  if (manifest.members.every((member) => member.role !== "runtime-dependency")) {
    context.addIssue({
      code: "custom",
      path: ["members"],
      message: "expected at least one GN runtime dependency",
    });
  }
  if (manifest.platform.os !== "win32" && executable != null && (executable.mode & 0o111) === 0) {
    context.addIssue({
      code: "custom",
      path: ["members", paths.indexOf(executable.path), "mode"],
      message: "helper executable has no executable mode bit",
    });
  }
  if (new Set(manifest.distribution.licenseFiles).size !== manifest.distribution.licenseFiles.length) {
    context.addIssue({
      code: "custom",
      path: ["distribution", "licenseFiles"],
      message: "license files must be unique",
    });
  }
  for (const licensePath of manifest.distribution.licenseFiles) {
    if (!manifest.members.some((member) => member.path === licensePath && member.role === "license")) {
      context.addIssue({
        code: "custom",
        path: ["distribution", "licenseFiles"],
        message: `license file is not declared as a license member: ${licensePath}`,
      });
    }
  }
  const membersByPath = new Map(manifest.members.map((member) => [member.path, member]));
  for (const member of manifest.members) {
    if (member.kind !== "symlink") continue;
    let targetPath = posix.normalize(posix.join(posix.dirname(member.path), member.linkTarget));
    const seen = new Set([member.path]);
    let target = membersByPath.get(targetPath);
    while (target?.kind === "symlink" && !seen.has(targetPath)) {
      seen.add(targetPath);
      targetPath = posix.normalize(posix.join(posix.dirname(target.path), target.linkTarget));
      target = membersByPath.get(targetPath);
    }
    if (targetPath === ".." || targetPath.startsWith("../") || target?.kind !== "file") {
      context.addIssue({
        code: "custom",
        path: ["members", paths.indexOf(member.path), "linkTarget"],
        message: "symlink chain must stay inside the bundle and terminate at a declared regular member",
      });
    }
  }
  const runtimeDigest = pagedCaptureHelperRuntimeDependenciesDigest(manifest.members);
  if (manifest.runtime.runtimeDependenciesSha256 !== runtimeDigest) {
    context.addIssue({
      code: "custom",
      path: ["runtime", "runtimeDependenciesSha256"],
      message: "runtime dependency digest does not match executable/runtime members",
    });
  }
});

export type PagedCaptureHelperBundleManifest = z.infer<
  typeof pagedCaptureHelperBundleManifestSchema
>;
export type PagedCaptureHelperBundleMember = z.infer<typeof memberSchema>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function pagedCaptureHelperRuntimeDependenciesDigest(
  members: PagedCaptureHelperBundleMember[],
): string {
  return sha256(canonicalJson(members.filter((member) =>
    member.role === "executable" || member.role === "runtime-dependency")));
}

export function parsePagedCaptureHelperBundleManifest(
  input: unknown,
): PagedCaptureHelperBundleManifest {
  return pagedCaptureHelperBundleManifestSchema.parse(input);
}

async function sha256File(path: string): Promise<{ sha256: string; byteLength: number }> {
  const digest = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    byteLength += chunk.length;
  }
  return { sha256: digest.digest("hex"), byteLength };
}

async function sha256Handle(handle: FileHandle): Promise<{ sha256: string; byteLength: number }> {
  const digest = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
    digest.update(chunk);
    byteLength += chunk.length;
  }
  return { sha256: digest.digest("hex"), byteLength };
}

function pathIsInside(root: string, candidate: string): boolean {
  const tail = relative(root, candidate);
  return tail === "" || (!tail.startsWith(`..${sep}`) && tail !== ".." && !isAbsolute(tail));
}

async function rejectSymlinkedParents(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`paged helper member has an undeclared symlink parent: ${relativePath}`);
    }
  }
}

async function bundleLeafPaths(root: string, directory = root): Promise<string[]> {
  const leaves: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      leaves.push(...await bundleLeafPaths(root, path));
    } else {
      leaves.push(relative(root, path).split(sep).join("/"));
    }
  }
  return leaves;
}

export interface VerifyPagedCaptureHelperBundleOptions {
  manifestPath: string;
  /** Trust anchor published alongside the separately distributed bundle. */
  expectedManifestSha256: string;
}

interface VerifyPagedCaptureHelperBundleDependencies {
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  verifyPlatformLoader: boolean;
}

export interface VerifiedPagedCaptureHelperBundle {
  rootPath: string;
  manifestPath: string;
  manifestSha256: string;
  executablePath: string;
  manifest: PagedCaptureHelperBundleManifest;
}

function compareVersions(left: string, right: string): number {
  if (!DOTTED_VERSION.test(left) || !DOTTED_VERSION.test(right)) {
    throw new Error("paged helper platform version is not a dotted numeric version");
  }
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  if ([...leftParts, ...rightParts].some((part) => !Number.isSafeInteger(part))) {
    throw new Error("paged helper platform version component is not a safe integer");
  }
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function darwinCodeSignatureIdentity(path: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    "/usr/bin/codesign", ["-dv", "--verbose=4", path],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const facts = `${stdout}\n${stderr}`.split("\n")
    .filter((line) => /^(Identifier|Format|CodeDirectory|CDHash|Signature|TeamIdentifier)=/.test(line))
    .sort();
  return facts.join("\n");
}

async function verifyPlatformLoaderMetadata(
  manifest: PagedCaptureHelperBundleManifest,
  executablePath: string,
): Promise<void> {
  if (manifest.platform.os === "darwin") {
    const identity = await darwinCodeSignatureIdentity(executablePath);
    if (identity !== manifest.platform.codeSignatureIdentity) {
      throw new Error("paged helper macOS code-signature identity mismatch");
    }
    const { stdout: version } = await execFileAsync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" });
    if (compareVersions(version.trim(), manifest.platform.minimumVersion) < 0) {
      throw new Error("paged helper requires a newer macOS version");
    }
    let quarantineState: "absent" | "present" = "absent";
    try {
      await execFileAsync("/usr/bin/xattr", ["-p", "com.apple.quarantine", executablePath]);
      quarantineState = "present";
    } catch {
      quarantineState = "absent";
    }
    if (quarantineState !== manifest.platform.quarantineState) {
      throw new Error("paged helper macOS quarantine state mismatch");
    }
    return;
  }
  if (manifest.platform.os === "linux") {
    const { stdout: glibc } = await execFileAsync("getconf", ["GNU_LIBC_VERSION"], { encoding: "utf8" });
    const runtimeVersion = glibc.trim().replace(/^glibc\s+/, "");
    if (compareVersions(runtimeVersion, manifest.platform.glibcMinimum) < 0) {
      throw new Error("paged helper requires a newer glibc version");
    }
    const { stdout: dynamic } = await execFileAsync("readelf", ["-d", executablePath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const needed = dynamic.split("\n").filter((line) => line.includes("(NEEDED)")).map((line) => line.trim()).sort();
    if (sha256(needed.join("\n")) !== manifest.platform.dtNeededSha256) {
      throw new Error("paged helper ELF DT_NEEDED identity mismatch");
    }
    return;
  }
  if (manifest.platform.os === "win32") {
    const script = [
      `$s=Get-AuthenticodeSignature -LiteralPath '${executablePath.replaceAll("'", "''")}'`,
      "$s | Select-Object Status,StatusMessage,@{n='Signer';e={$_.SignerCertificate.Thumbprint}} | ConvertTo-Json -Compress",
    ].join(";");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (stdout.trim() !== manifest.platform.authenticodeIdentity) {
      throw new Error("paged helper Windows Authenticode identity mismatch");
    }
    const runtimeBuild = Number(osRelease().split(".").at(-1));
    if (!Number.isSafeInteger(runtimeBuild) || runtimeBuild < Number(manifest.platform.minimumBuild)) {
      throw new Error("paged helper requires a newer Windows build");
    }
    const dllMembers = manifest.members.filter((member) =>
      member.kind === "file" && member.path.toLowerCase().endsWith(".dll"));
    if (sha256(canonicalJson(dllMembers)) !== manifest.platform.dllClosureSha256) {
      throw new Error("paged helper Windows DLL closure identity mismatch");
    }
  }
}

async function verifyPagedCaptureHelperBundleWithDependencies(
  options: VerifyPagedCaptureHelperBundleOptions,
  dependencies: VerifyPagedCaptureHelperBundleDependencies,
): Promise<VerifiedPagedCaptureHelperBundle> {
  if (!SHA256.test(options.expectedManifestSha256)) {
    throw new Error("paged helper expected manifest digest must be lowercase SHA-256");
  }
  const manifestPath = await realpath(resolve(options.manifestPath));
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("paged helper manifest exceeds the 4 MiB bound");
  }
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== options.expectedManifestSha256) {
    throw new Error("paged helper manifest digest mismatch");
  }
  const manifest = parsePagedCaptureHelperBundleManifest(JSON.parse(manifestBytes.toString("utf8")));
  const platform = dependencies.platform;
  const architecture = dependencies.architecture;
  if (manifest.platform.os !== platform || manifest.platform.architecture !== architecture) {
    throw new Error(
      `paged helper platform mismatch: bundle is ${manifest.platform.os}/${manifest.platform.architecture}, ` +
      `runtime is ${platform}/${architecture}`,
    );
  }

  const rootPath = await realpath(dirname(manifestPath));
  for (const member of manifest.members) {
    await rejectSymlinkedParents(rootPath, member.path);
    const memberPath = resolve(rootPath, ...member.path.split("/"));
    if (!pathIsInside(rootPath, memberPath)) throw new Error(`paged helper path escaped bundle: ${member.path}`);
    const memberStat = await lstat(memberPath);
    if (member.kind === "symlink") {
      if (!memberStat.isSymbolicLink()) throw new Error(`paged helper member is not a symlink: ${member.path}`);
      if ((memberStat.mode & 0o777) !== member.mode) {
        throw new Error(`paged helper mode mismatch: ${member.path}`);
      }
      const linkTarget = await readlink(memberPath);
      if (linkTarget !== member.linkTarget || member.byteLength !== Buffer.byteLength(linkTarget)
          || member.sha256 !== sha256(linkTarget)) {
        throw new Error(`paged helper symlink identity mismatch: ${member.path}`);
      }
      const resolvedTarget = await realpath(memberPath);
      if (!pathIsInside(rootPath, resolvedTarget)) {
        throw new Error(`paged helper symlink escaped bundle: ${member.path}`);
      }
      continue;
    }
    if (!memberStat.isFile() || memberStat.isSymbolicLink()) {
      throw new Error(`paged helper member is not a regular file: ${member.path}`);
    }
    if ((memberStat.mode & 0o777) !== member.mode) {
      throw new Error(`paged helper mode mismatch: ${member.path}`);
    }
    const memberDigest = await sha256File(memberPath);
    if (memberDigest.byteLength !== member.byteLength || memberDigest.sha256 !== member.sha256) {
      throw new Error(`paged helper member identity mismatch: ${member.path}`);
    }
    const resolvedMember = await realpath(memberPath);
    if (!pathIsInside(rootPath, resolvedMember)) {
      throw new Error(`paged helper member escaped bundle: ${member.path}`);
    }
  }

  const manifestRelativePath = relative(rootPath, manifestPath).split(sep).join("/");
  const actualLeaves = (await bundleLeafPaths(rootPath))
    .filter((path) => path !== manifestRelativePath)
    .sort();
  const declaredLeaves = manifest.members.map((member) => member.path);
  if (canonicalJson(actualLeaves) !== canonicalJson(declaredLeaves)) {
    throw new Error("paged helper bundle inventory differs from the authenticated manifest");
  }

  const executablePath = resolve(rootPath, ...manifest.runtime.executablePath.split("/"));
  if (dependencies.verifyPlatformLoader) {
    await verifyPlatformLoaderMetadata(manifest, executablePath);
  }
  return {
    rootPath,
    manifestPath,
    manifestSha256,
    executablePath,
    manifest,
  };
}

export function verifyPagedCaptureHelperBundle(
  options: VerifyPagedCaptureHelperBundleOptions,
): Promise<VerifiedPagedCaptureHelperBundle> {
  return verifyPagedCaptureHelperBundleWithDependencies(options, {
    platform: process.platform,
    architecture: process.arch,
    verifyPlatformLoader: true,
  });
}

/** @internal Test seam; not exported from the package barrel. */
export function verifyPagedCaptureHelperBundleForTest(
  options: VerifyPagedCaptureHelperBundleOptions,
  dependencies: Omit<VerifyPagedCaptureHelperBundleDependencies, "verifyPlatformLoader">,
): Promise<VerifiedPagedCaptureHelperBundle> {
  return verifyPagedCaptureHelperBundleWithDependencies(options, {
    ...dependencies,
    verifyPlatformLoader: false,
  });
}

export interface PagedCaptureProcessAuthentication {
  browserProcessId: number;
  rendererProcessIds: number[];
  executableSha256: string;
  product: string;
  protocolVersion: string;
}

export interface PagedCaptureProcessAuthDependencies {
  processImage?: (processId: number) => Promise<{
    reportedPath: string;
    identity(): Promise<{ sha256: string; byteLength: number }>;
    close(): Promise<void>;
  }>;
}

async function openedProcessImage(
  reportedPath: string,
  openPath: string,
  expected?: { device: bigint; inode: bigint },
): Promise<{
  reportedPath: string;
  identity(): Promise<{ sha256: string; byteLength: number }>;
  close(): Promise<void>;
}> {
  const handle = await open(openPath, "r");
  try {
    if (expected != null) {
      const stats = await handle.stat({ bigint: true }) as BigIntStats;
      if (stats.dev !== expected.device || stats.ino !== expected.inode) {
        throw new Error("paged helper mapped process image changed before it could be opened");
      }
    }
    return {
      reportedPath,
      identity: () => sha256Handle(handle),
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function systemProcessImage(
  processId: number,
): Promise<{
  reportedPath: string;
  identity(): Promise<{ sha256: string; byteLength: number }>;
  close(): Promise<void>;
}> {
  if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error("invalid helper process id");
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-nP", "-FfDin", "-a", "-p", String(processId), "-d", "txt"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    const lines = stdout.split("\n");
    let device: bigint | null = null;
    let inode: bigint | null = null;
    let mappedPath: string | null = null;
    for (const line of lines) {
      if (line === "ftxt") {
        device = null;
        inode = null;
        mappedPath = null;
      } else if (line.startsWith("D")) {
        device = BigInt(line.slice(1));
      } else if (line.startsWith("i")) {
        inode = BigInt(line.slice(1));
      } else if (line.startsWith("n/")) {
        mappedPath = line.slice(1);
      }
      if (device != null && inode != null && mappedPath != null) {
        const reportedPath = await realpath(mappedPath);
        return openedProcessImage(reportedPath, reportedPath, { device, inode });
      }
    }
    throw new Error(`paged helper macOS executable mapping is absent for process ${processId}`);
  }
  if (process.platform === "linux") {
    const hashPath = `/proc/${processId}/exe`;
    return openedProcessImage(await realpath(hashPath), hashPath);
  }
  if (process.platform === "win32") {
    const script = `(Get-Process -Id ${processId} -ErrorAction Stop).Path`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    const path = stdout.trim();
    if (path === "") throw new Error(`paged helper Windows executable mapping is absent for process ${processId}`);
    const reportedPath = await realpath(path);
    // Windows prevents replacement/deletion of a running image section under
    // its normal sharing mode; keep one open handle through hashing as well.
    return openedProcessImage(reportedPath, reportedPath);
  }
  throw new Error("paged helper live process authentication is unsupported on this host");
}

function sameExecutable(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

type RawCdp = {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

const finiteNumber = z.number().finite();
const positiveFiniteNumber = finiteNumber.positive();
export const pagedNativePrintParametersSchema = z.strictObject({
  printableArea: z.strictObject({
    x: finiteNumber,
    y: finiteNumber,
    width: positiveFiniteNumber,
    height: positiveFiniteNumber,
  }),
  defaultPage: z.strictObject({
    width: positiveFiniteNumber,
    height: positiveFiniteNumber,
    marginTop: finiteNumber,
    marginRight: finiteNumber,
    marginBottom: finiteNumber,
    marginLeft: finiteNumber,
    orientation: z.number().int().min(0).max(2),
    pageSizeType: z.number().int().min(0).max(3),
  }),
  printerDpi: z.number().int().positive(),
  scaleFactor: positiveFiniteNumber,
  ignoreCssMargins: z.boolean(),
  ignorePageSize: z.boolean(),
  rasterizePdf: z.boolean(),
  printScalingOption: z.number().int().min(0).max(4),
  usePaginatedLayout: z.literal(true),
  printingInternalHeadersAndFooters: z.boolean(),
  pagesPerSheet: z.number().int().positive(),
  shouldPrintBackgrounds: z.boolean(),
});

const handshakePayloadSchema = z.strictObject({
  helperAbi: z.literal(PAGED_CAPTURE_HELPER_TABLE_TRANSPORT_ABI),
  sourceRevision: z.literal(PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION),
  capturePhase: z.literal("after-PrintBegin-before-PrintEnd"),
  logicalFactsDerivedFromPdfVectorOrRaster: z.literal(false),
  frameToken: z.string().min(1),
  documentToken: z.string().min(1),
  documentUrl: z.string().min(1),
  printCaptureId: z.string().uuid(),
  printParameters: pagedNativePrintParametersSchema,
  pages: z.array(z.unknown()).min(1),
});

export interface PagedCaptureHelperTransportAuthentication {
  frameId: string;
  loaderId: string;
  browserProcessId: number;
  rendererProcessId: number;
  sidecarSha256: string;
  sidecarByteLength: number;
  pageRecordSha256: string;
  pageRecordByteLength: number;
  printLayoutStateSha256: string;
  processAuthentication: PagedCaptureProcessAuthentication;
  pdfBytesReadForLogicalFacts: false;
  printLayoutEpochRestoredExactly: true;
  runtimeDefaultDisabled: true;
}

async function pagePrintLayoutStateSha256(page: import("@playwright/test").Page): Promise<string> {
  const state = await page.evaluate(() => ({
    url: document.URL,
    html: document.documentElement.outerHTML,
    scroll: [window.scrollX, window.scrollY],
    viewport: [window.innerWidth, window.innerHeight, window.devicePixelRatio],
    printMediaMatches: window.matchMedia("print").matches,
    styles: Array.from(document.styleSheets, (sheet) =>
      Array.from(sheet.cssRules, (rule) => rule.cssText)),
  }));
  return sha256(canonicalJson(state));
}

async function closeUnopenedPdfStream(cdp: RawCdp, result: Record<string, unknown>): Promise<void> {
  if (typeof result.stream !== "string" || result.stream === "") {
    throw new Error("paged helper print handshake omitted its unopened PDF stream");
  }
  await cdp.send("IO.close", { handle: result.stream });
  if (typeof result.data === "string" && result.data !== "") {
    throw new Error("paged helper print handshake unexpectedly returned inline PDF bytes");
  }
}

/**
 * Prove both halves of the patched transport: ordinary print has no Domotion
 * response fields, while an explicit request returns a bounded Blink-owned
 * sidecar and the exact live browser/renderer PIDs after restoring the observed
 * top-level print-layout state and frame/loader epoch.
 */
async function authenticatePagedCaptureHelperTransportWithDependencies(
  browser: Browser,
  helper: VerifiedPagedCaptureHelperBundle,
  processDependencies: PagedCaptureProcessAuthDependencies,
): Promise<PagedCaptureHelperTransportAuthentication> {
  if (!helper.manifest.capabilities.includes(PAGED_CAPTURE_HELPER_TABLE_OWNERSHIP_CAPABILITY)) {
    throw new Error("paged helper does not declare the requested table-ownership capability");
  }
  const context = await browser.newContext({ viewport: { width: 480, height: 360 } });
  try {
    const page = await context.newPage();
    await page.setContent([
      "<!doctype html><style>",
      "@page{size:240px 240px;margin:16px}",
      "table{border-collapse:collapse}td{border:1px solid black;padding:4px}",
      "</style><table><tbody><tr><td>Domotion paged helper handshake</td></tr></tbody></table>",
    ].join(""), { waitUntil: "load" });
    const cdpSession = await context.newCDPSession(page);
    const cdp = cdpSession as unknown as RawCdp;
    try {
      const frameTree = await cdp.send("Page.getFrameTree") as {
        frameTree?: { frame?: { id?: unknown; loaderId?: unknown } };
      };
      const frameId = frameTree.frameTree?.frame?.id;
      const loaderId = frameTree.frameTree?.frame?.loaderId;
      if (typeof frameId !== "string" || frameId === ""
          || typeof loaderId !== "string" || loaderId === "") {
        throw new Error("paged helper print handshake frame/loader identity is unavailable");
      }
      const schema = await cdp.send("Schema.getDomains");
      if (sha256(canonicalJson(schema)) !== helper.manifest.protocol.schemaSha256) {
        throw new Error("paged helper live protocol schema digest mismatch");
      }
      const printLayoutStateSha256 = await pagePrintLayoutStateSha256(page);
      const baseRequest = {
        printBackground: true,
        preferCSSPageSize: true,
        transferMode: "ReturnAsStream",
      };
      const ordinary = await cdp.send("Page.printToPDF", baseRequest);
      await closeUnopenedPdfStream(cdp, ordinary);
      const unexpectedOrdinaryFields = Object.keys(ordinary).filter((key) => key.startsWith("domotion"));
      if (unexpectedOrdinaryFields.length > 0) {
        throw new Error("paged helper default-off print exposed Domotion response fields");
      }
      if (await pagePrintLayoutStateSha256(page) !== printLayoutStateSha256) {
        throw new Error("paged helper ordinary print did not restore its observed print-layout state");
      }

      const response = await cdp.send("Page.printToPDF", {
        ...baseRequest,
        domotionPagedTableEvidence: true,
      });
      await closeUnopenedPdfStream(cdp, response);
      if (typeof response.domotionPagedTableEvidence !== "string"
          || response.domotionPagedTableEvidence === "") {
        throw new Error("paged helper active print omitted its Blink sidecar");
      }
      const sidecarByteLength = Buffer.byteLength(response.domotionPagedTableEvidence);
      if (sidecarByteLength > PAGED_CAPTURE_HELPER_MAX_TABLE_SIDECAR_BYTES) {
        throw new Error("paged helper Blink sidecar exceeded its hard bound");
      }
      const payload = handshakePayloadSchema.parse(JSON.parse(response.domotionPagedTableEvidence));
      if (payload.printParameters.shouldPrintBackgrounds !== baseRequest.printBackground) {
        throw new Error("paged helper native print-background parameter differs from the request");
      }
      if (typeof response.domotionPagedPageRecord !== "string"
          || response.domotionPagedPageRecord === "") {
        throw new Error("paged helper active print omitted its page-paint sidecar");
      }
      const pageRecordByteLength = Buffer.byteLength(response.domotionPagedPageRecord);
      if (pageRecordByteLength > PAGED_CAPTURE_HELPER_MAX_PAGE_RECORD_BYTES) {
        throw new Error("paged helper page-paint sidecar exceeded its hard bound");
      }
      const pageRecord = JSON.parse(response.domotionPagedPageRecord) as Record<string, unknown>;
      if (pageRecord.helperAbi !== "domotion-paged-page-record-v1"
          || pageRecord.sourceRevision !== PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION
          || pageRecord.printCaptureId !== payload.printCaptureId
          || !Array.isArray(pageRecord.pages)
          || pageRecord.pages.length === 0
          || pageRecord.pages.some((candidate) => {
            if (typeof candidate !== "object" || candidate == null) return true;
            const pagePaint = candidate as Record<string, unknown>;
            return pagePaint.status !== "authenticated"
              || typeof pagePaint.vectorPaintSvg !== "string"
              || !/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/.test(pagePaint.vectorPaintSvg);
          })) {
        throw new Error("paged helper page-paint sidecar failed its live capability proof");
      }
      if (payload.documentUrl !== page.url()) {
        throw new Error("paged helper Blink sidecar document differs from the handshake page");
      }
      if (response.domotionSourceRestoredExactly !== true
          || await pagePrintLayoutStateSha256(page) !== printLayoutStateSha256) {
        throw new Error("paged helper active print did not restore its print-layout epoch");
      }
      const afterFrameTree = await cdp.send("Page.getFrameTree") as typeof frameTree;
      if (afterFrameTree.frameTree?.frame?.id !== frameId
          || afterFrameTree.frameTree?.frame?.loaderId !== loaderId) {
        throw new Error("paged helper frame/loader epoch changed during print handshake");
      }
      const record = buildPagedCollapsedTableRecord({
        sourceRevision: payload.sourceRevision,
        printEpoch: {
          epochId: sha256(response.domotionPagedTableEvidence),
          documentLoaderId: loaderId,
          frameToken: payload.frameToken,
          documentToken: payload.documentToken,
          documentUrl: payload.documentUrl,
          printCaptureId: payload.printCaptureId,
          browserVersion: helper.manifest.protocol.product,
          protocolVersion: helper.manifest.protocol.protocolVersion,
          printParametersSha256: sha256(canonicalJson(payload.printParameters)),
          lifecycle: "PrintBegin-to-PrintEnd",
          logicalTransport: "blink-private-physical-fragment-tree-v1",
          logicalFactsDerivedFromPdfVectorOrRaster: false,
          sourceRestoredExactly: true,
        },
        pages: payload.pages as PagedCollapsedPageRecord[],
      });
      if (record.status !== "authenticated") {
        throw new Error(`paged helper Blink sidecar failed ownership validation: ${record.reason}`);
      }
      if (!record.pages.some((page) => page.tableOccurrences.some((table) =>
        table.collapsedEdges.length > 0))) {
        throw new Error("paged helper handshake did not prove collapsed-table ownership");
      }
      const browserProcessId = Number(response.domotionBrowserProcessId);
      const rendererProcessId = Number(response.domotionRendererProcessId);
      if (!Number.isSafeInteger(browserProcessId) || browserProcessId <= 0
          || !Number.isSafeInteger(rendererProcessId) || rendererProcessId <= 0) {
        throw new Error("paged helper active print omitted valid response process IDs");
      }
      const processAuthentication = await authenticatePagedCaptureHelperProcessesWithDependencies(
        browser,
        helper,
        processDependencies,
      );
      if (processAuthentication.browserProcessId !== browserProcessId
          || !processAuthentication.rendererProcessIds.includes(rendererProcessId)) {
        throw new Error("paged helper response process IDs differ from authenticated live processes");
      }
      return {
        frameId,
        loaderId,
        browserProcessId,
        rendererProcessId,
        sidecarSha256: sha256(response.domotionPagedTableEvidence),
        sidecarByteLength,
        pageRecordSha256: sha256(response.domotionPagedPageRecord),
        pageRecordByteLength,
        printLayoutStateSha256,
        processAuthentication,
        pdfBytesReadForLogicalFacts: false,
        printLayoutEpochRestoredExactly: true,
        runtimeDefaultDisabled: true,
      };
    } finally {
      await cdpSession.detach();
    }
  } finally {
    await context.close();
  }
}

export function authenticatePagedCaptureHelperTransport(
  browser: Browser,
  helper: VerifiedPagedCaptureHelperBundle,
): Promise<PagedCaptureHelperTransportAuthentication> {
  return authenticatePagedCaptureHelperTransportWithDependencies(browser, helper, {});
}

/** @internal Test seam; not exported from the package barrel. */
export function authenticatePagedCaptureHelperTransportForTest(
  browser: Browser,
  helper: VerifiedPagedCaptureHelperBundle,
  processDependencies: PagedCaptureProcessAuthDependencies,
): Promise<PagedCaptureHelperTransportAuthentication> {
  return authenticatePagedCaptureHelperTransportWithDependencies(
    browser,
    helper,
    processDependencies,
  );
}

async function authenticatePagedCaptureHelperProcessesWithDependencies(
  browser: Browser,
  helper: VerifiedPagedCaptureHelperBundle,
  dependencies: PagedCaptureProcessAuthDependencies = {},
): Promise<PagedCaptureProcessAuthentication> {
  if (helper.manifest.platform.os !== process.platform
      || helper.manifest.platform.architecture !== process.arch) {
    throw new Error("paged helper live authentication requires the actual host platform");
  }
  const cdp = await browser.newBrowserCDPSession();
  try {
    const raw = cdp as unknown as RawCdp;
    const version = await raw.send("Browser.getVersion") as {
      product?: unknown;
      protocolVersion?: unknown;
    };
    if (version.product !== helper.manifest.protocol.product
        || version.protocolVersion !== helper.manifest.protocol.protocolVersion) {
      throw new Error("paged helper live product/protocol identity mismatch");
    }
    const processResult = await raw.send("SystemInfo.getProcessInfo") as {
      processInfo?: Array<{ id?: unknown; type?: unknown }>;
    };
    if (!Array.isArray(processResult.processInfo)) {
      throw new Error("paged helper SystemInfo process list is unavailable");
    }
    const rows = processResult.processInfo.filter((row): row is { id: number; type: string } =>
      Number.isSafeInteger(row.id) && (row.id as number) > 0 && typeof row.type === "string");
    const browsers = rows.filter((row) => row.type.toLowerCase() === "browser");
    const renderers = rows.filter((row) => row.type.toLowerCase() === "renderer");
    if (browsers.length !== 1 || renderers.length === 0) {
      throw new Error("paged helper requires one live browser and at least one live renderer process");
    }

    const expectedPath = await realpath(helper.executablePath);
    const expectedMember = helper.manifest.members.find((member) =>
      member.path === helper.manifest.runtime.executablePath);
    if (!expectedMember || expectedMember.kind !== "file") {
      throw new Error("paged helper executable manifest member is unavailable");
    }
    const resolveProcessImage = dependencies.processImage ?? systemProcessImage;
    for (const row of [...browsers, ...renderers]) {
      const image = await resolveProcessImage(row.id);
      try {
        const livePath = await realpath(image.reportedPath);
        if (!sameExecutable(livePath, expectedPath)) {
          throw new Error(`paged helper live ${row.type} image path mismatch for process ${row.id}`);
        }
        const liveIdentity = await image.identity();
        if (liveIdentity.sha256 !== expectedMember.sha256
            || liveIdentity.byteLength !== expectedMember.byteLength) {
          throw new Error(`paged helper live ${row.type} image digest mismatch for process ${row.id}`);
        }
      } finally {
        await image.close();
      }
    }
    return {
      browserProcessId: browsers[0].id,
      rendererProcessIds: renderers.map((row) => row.id).sort((left, right) => left - right),
      executableSha256: expectedMember.sha256,
      product: version.product,
      protocolVersion: version.protocolVersion,
    };
  } finally {
    await cdp.detach();
  }
}

export function authenticatePagedCaptureHelperProcesses(
  browser: Browser,
  helper: VerifiedPagedCaptureHelperBundle,
): Promise<PagedCaptureProcessAuthentication> {
  return authenticatePagedCaptureHelperProcessesWithDependencies(browser, helper);
}

/** @internal Test seam; not exported from the package barrel. */
export function authenticatePagedCaptureHelperProcessesForTest(
  browser: Browser,
  helper: VerifiedPagedCaptureHelperBundle,
  dependencies: PagedCaptureProcessAuthDependencies,
): Promise<PagedCaptureProcessAuthentication> {
  return authenticatePagedCaptureHelperProcessesWithDependencies(browser, helper, dependencies);
}

export interface LaunchPagedCaptureHelperOptions extends Pick<
  VerifyPagedCaptureHelperBundleOptions,
  "manifestPath" | "expectedManifestSha256"
> {
  capability:
    | typeof PAGED_CAPTURE_HELPER_TABLE_OWNERSHIP_CAPABILITY
    | typeof PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY;
  launchOptions?: Pick<LaunchOptions, "slowMo" | "timeout">;
}

/** @internal Pure launch-environment constructor, exported only for hostile-input tests. */
export function pagedCaptureHelperLaunchEnvironmentForTest(
  inherited: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  bundleRoot: string,
): NodeJS.ProcessEnv {
  const names = platform === "win32"
    ? []
    : ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = inherited[name];
    if (value != null && !value.includes("\0")) environment[name] = value;
  }
  if (platform === "win32") {
    // Never trust inherited SystemRoot/WINDIR/PATH as loader roots. Windows
    // resolves system DLLs through its native loader; a helper that requires
    // ambient executable search paths fails closed instead of widening trust.
    environment.PATH = bundleRoot;
  } else {
    environment.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  }
  return environment;
}

export interface LaunchedPagedCaptureHelper {
  browser: Browser;
  helper: VerifiedPagedCaptureHelperBundle;
  authentication: PagedCaptureProcessAuthentication;
  transport: PagedCaptureHelperTransportAuthentication;
  authenticateLiveProcesses(): Promise<PagedCaptureProcessAuthentication>;
}

export interface LaunchedPagedCaptureHelperAuthority {
  browser: Browser;
  helper: VerifiedPagedCaptureHelperBundle;
  authenticateLiveProcesses(): Promise<PagedCaptureProcessAuthentication>;
}

const launchedPagedCaptureHelpers = new WeakMap<
  LaunchedPagedCaptureHelper,
  LaunchedPagedCaptureHelperAuthority
>();

function freezeJsonValue<T>(value: T): T {
  if (typeof value !== "object" || value == null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeJsonValue(child);
  return Object.freeze(value);
}

/** Runtime proof that a helper handle was produced by this module's verified launch. */
export function isLaunchedPagedCaptureHelper(
  value: unknown,
): value is LaunchedPagedCaptureHelper {
  return typeof value === "object" && value != null
    && launchedPagedCaptureHelpers.has(value as LaunchedPagedCaptureHelper);
}

/** @internal Immutable launch authority lookup for the capture transaction. */
export function launchedPagedCaptureHelperAuthority(
  value: LaunchedPagedCaptureHelper,
): LaunchedPagedCaptureHelperAuthority | null {
  return launchedPagedCaptureHelpers.get(value) ?? null;
}

/**
 * Launch only the authenticated caller-supplied helper. A temporary page makes
 * renderer-image authentication part of launch rather than a later optional
 * check. Capture callers must re-run authenticateLiveProcesses after creating
 * their target page so every then-live renderer is covered.
 */
export async function launchPagedCaptureHelper(
  options: LaunchPagedCaptureHelperOptions,
): Promise<LaunchedPagedCaptureHelper> {
  const launchOptionKeys = Object.keys(options.launchOptions ?? {});
  if (launchOptionKeys.some((key) => !["slowMo", "timeout"].includes(key))) {
    throw new Error("paged helper launch options contain an unauthenticated browser control");
  }
  const helper = await verifyPagedCaptureHelperBundle(options);
  if (!helper.manifest.capabilities.includes(options.capability)) {
    throw new Error("paged helper does not provide the explicitly requested capability");
  }
  const chromiumSandbox = helper.manifest.platform.os !== "linux"
    || helper.manifest.platform.sandboxMode !== "disabled-explicitly";
  const browser = await chromium.launch({
    ...options.launchOptions,
    executablePath: helper.executablePath,
    headless: true,
    chromiumSandbox,
    env: pagedCaptureHelperLaunchEnvironmentForTest(process.env, process.platform, helper.rootPath),
  });
  try {
    const transport = await authenticatePagedCaptureHelperTransport(browser, helper);
    const authentication = transport.processAuthentication;
    const reverified = await verifyPagedCaptureHelperBundle(options);
    if (reverified.manifestSha256 !== helper.manifestSha256) {
      throw new Error("paged helper manifest changed during launch");
    }
    const authenticatedHelper: VerifiedPagedCaptureHelperBundle = Object.freeze({
      ...reverified,
      manifest: freezeJsonValue(pagedCaptureHelperBundleManifestSchema.parse(reverified.manifest)),
    });
    const authenticateLiveProcesses = async () => {
      const current = await verifyPagedCaptureHelperBundle(options);
      return authenticatePagedCaptureHelperProcesses(browser, current);
    };
    const launched: LaunchedPagedCaptureHelper = Object.freeze({
      browser,
      helper: authenticatedHelper,
      authentication,
      transport,
      authenticateLiveProcesses,
    });
    launchedPagedCaptureHelpers.set(launched, Object.freeze({
      browser,
      helper: authenticatedHelper,
      authenticateLiveProcesses,
    }));
    return launched;
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}
