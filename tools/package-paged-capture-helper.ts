#!/usr/bin/env node
/** Build a deterministic, caller-supplied DM-2709 helper bundle from GN truth. */

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { z } from "zod";

import {
  PAGED_CAPTURE_HELPER_BUNDLE_SCHEMA_VERSION,
  PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION,
  PAGED_CAPTURE_HELPER_MAX_SIDECAR_BYTES,
  PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY,
  PAGED_CAPTURE_HELPER_RUNTIME_ABI,
  PAGED_CAPTURE_HELPER_TABLE_OWNERSHIP_CAPABILITY,
  PAGED_CAPTURE_HELPER_TRANSPORT_ABI,
  launchPagedCaptureHelper,
  pagedCaptureHelperLaunchEnvironmentForTest,
  pagedCaptureHelperRuntimeDependenciesDigest,
  parsePagedCaptureHelperBundleManifest,
  type PagedCaptureHelperBundleManifest,
  type PagedCaptureHelperBundleMember,
} from "../src/capture/paged-capture-helper.js";
import {
  PAGED_CAPTURE_HELPER_PATCH_SHA256,
  PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256,
  PAGED_CAPTURE_SKIA_REVISION,
} from "../src/capture/paged-capture-bundle.js";
import { PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION } from "../src/capture/paged-collapsed-table-record.js";
import {
  validatePagedTableRendererEvidenceArtifact,
  type PagedTableRendererEvidenceArtifact,
} from "./paged-table-renderer-evidence-schema.js";

const packageConfigSchema = z.strictObject({
  sourceRoot: z.string().min(1),
  outDirectory: z.string().min(1),
  bundleDirectory: z.string().min(1),
  sourceArchiveUrl: z.string().url().refine((value) => value.startsWith("https://")),
  minimumPlatformVersion: z.string().regex(/^\d+(?:\.\d+)*$/),
  linuxSandboxMode: z.enum(["user-namespace", "disabled-explicitly"]).optional(),
});
type PackageConfig = z.infer<typeof packageConfigSchema>;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configFlag = process.argv.indexOf("--config");
if (configFlag < 0 || configFlag + 1 >= process.argv.length) {
  throw new Error("usage: package-paged-capture-helper --config <package-config.json> [--smoke]");
}
const configPath = resolve(process.argv[configFlag + 1]);
const config: PackageConfig = packageConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
const sourceRoot = realpathSync(resolve(config.sourceRoot));
const outDirectory = realpathSync(resolve(config.outDirectory));
const bundleDirectory = resolve(config.bundleDirectory);
const patchPath = resolve(projectRoot, "tools/chromium-paged-page-record/renderer-page-record.patch");
const skiaPatchPath = resolve(projectRoot, "tools/chromium-paged-page-record/skia-deterministic-svg.patch");
const retainedBuildEvidencePath = resolve(
  projectRoot,
  ".pr-notes/artifacts/dm2573-paged-table-renderer-evidence.json",
);
const RETAINED_BUILD_EVIDENCE_SHA256 =
  "da3be96954dd0ee2334c98bc4dd124ebb408c6680b26e5c410fd80633932e68a" as const;
const RETAINED_HELPER_EXECUTABLE_SHA256 =
  "081c32065ddaaeb6f725390804bb1b7b052123bbc2c03c24b0bf737cb1f54b95" as const;
const RETAINED_RUNTIME_DEPENDENCIES_SHA256 =
  "7d71c064f5e32c0f2cb4077b812d9cf9029f1e0d9b21fd71a669a07e5acd929d" as const;

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const fileSha256 = (path: string): string => sha256(readFileSync(path));
const gitRevision = (path: string): string => execFileSync(
  "git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" },
).trim();
const toPosix = (value: string): string => value.split(sep).join("/");
const inside = (root: string, path: string): boolean => {
  const tail = relative(root, path);
  return tail === "" || (!tail.startsWith(`..${sep}`) && tail !== ".." && !isAbsolute(tail));
};
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

function assertPinnedSource(): void {
  if (gitRevision(sourceRoot) !== PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION
      || gitRevision(resolve(sourceRoot, "third_party/skia")) !== PAGED_CAPTURE_SKIA_REVISION) {
    throw new Error("paged helper packager source does not match Chromium/Skia pins");
  }
  const depotTools = realpathSync(resolve(sourceRoot, "../../../depot_tools"));
  if (gitRevision(depotTools) !== PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION) {
    throw new Error("paged helper packager depot_tools revision drifted");
  }
  if (fileSha256(patchPath) !== PAGED_CAPTURE_HELPER_PATCH_SHA256) {
    throw new Error("paged helper retained patch digest drifted");
  }
  if (fileSha256(skiaPatchPath) !== PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256) {
    throw new Error("paged helper retained Skia patch digest drifted");
  }
  const expectedPaths = [...readFileSync(patchPath, "utf8").matchAll(/^diff --git a\/(.+?) b\//gm)]
    .map((match) => match[1]).sort();
  const expectedSkiaPaths = [...readFileSync(skiaPatchPath, "utf8").matchAll(/^diff --git a\/(.+?) b\//gm)]
    .map((match) => match[1]).sort();
  const actualPaths = execFileSync(
    "git", ["-C", sourceRoot, "status", "--porcelain=v1", "-z"], { encoding: "utf8" },
  ).split("\0").filter(Boolean).map((line) => line.slice(3)).sort();
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) {
    throw new Error("paged helper Chromium dirty paths differ from the retained patch");
  }
  const skiaRoot = resolve(sourceRoot, "third_party/skia");
  const actualSkiaPaths = execFileSync(
    "git", ["-C", skiaRoot, "status", "--porcelain=v1", "-z"], { encoding: "utf8" },
  ).split("\0").filter(Boolean).map((line) => line.slice(3)).sort();
  if (canonicalJson(actualSkiaPaths) !== canonicalJson(expectedSkiaPaths)) {
    throw new Error("paged helper Skia dirty paths differ from the retained patch");
  }
  if (execFileSync("git", ["-C", depotTools, "status", "--porcelain=v1"], { encoding: "utf8" }).trim() !== "") {
    throw new Error(`paged helper nested source checkout is dirty: ${depotTools}`);
  }
  const installedDelta = execFileSync("git", ["-C", sourceRoot, "diff", "--binary", "--unified=0", "HEAD"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!installedDelta.equals(readFileSync(patchPath))) {
    throw new Error("paged helper Chromium source delta differs from the retained patch");
  }
  const installedSkiaDelta = execFileSync("git", ["-C", skiaRoot, "diff", "--binary", "--unified=0", "HEAD"], {
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!installedSkiaDelta.equals(readFileSync(skiaPatchPath))) {
    throw new Error("paged helper Skia source delta differs from the retained patch");
  }
}

function assertRetainedBuildEvidence(executablePath: string): Uint8Array {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      "paged helper packaging has reviewed build evidence only for darwin/arm64; " +
      "cross-platform release evidence is owned by DM-2713",
    );
  }
  const evidenceBytes = readFileSync(retainedBuildEvidencePath);
  if (sha256(evidenceBytes) !== RETAINED_BUILD_EVIDENCE_SHA256) {
    throw new Error("paged helper retained build-evidence file digest drifted");
  }
  const evidence = JSON.parse(evidenceBytes.toString("utf8")) as PagedTableRendererEvidenceArtifact;
  const errors = validatePagedTableRendererEvidenceArtifact(evidence);
  if (errors.length > 0) {
    throw new Error(`paged helper retained build evidence is invalid: ${errors.join("; ")}`);
  }
  if (evidence.build.browserExecutableSha256 !== RETAINED_HELPER_EXECUTABLE_SHA256
      || evidence.build.rendererExecutableSha256 !== RETAINED_HELPER_EXECUTABLE_SHA256
      || fileSha256(executablePath) !== RETAINED_HELPER_EXECUTABLE_SHA256) {
    throw new Error("paged helper executable differs from its reviewed retained build evidence");
  }
  return evidenceBytes;
}

function gnPath(): string {
  if (process.platform === "darwin") return resolve(sourceRoot, "buildtools/mac/gn");
  if (process.platform === "linux") return resolve(sourceRoot, "buildtools/linux64/gn");
  if (process.platform === "win32") return resolve(sourceRoot, "buildtools/win/gn.exe");
  throw new Error(`unsupported helper packaging platform ${process.platform}`);
}

function runtimeDependencyPaths(): string[] {
  const outputArgument = toPosix(relative(sourceRoot, outDirectory));
  const stdout = execFileSync(
    gnPath(), ["desc", outputArgument, "//headless:headless_shell", "runtime_deps", "--all"],
    { cwd: sourceRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const paths = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const entry = raw.trim();
    if (entry === "") continue;
    const sourcePath = entry.startsWith("//")
      ? resolve(sourceRoot, entry.slice(2))
      : resolve(outDirectory, entry.replace(/^\.\//, ""));
    if (!inside(outDirectory, sourcePath) || !existsSync(sourcePath)) {
      throw new Error(`GN runtime dependency is absent or outside the build output: ${entry}`);
    }
    const sourceStat = lstatSync(sourcePath);
    if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
      throw new Error(`GN runtime dependency is not a file or symlink: ${entry}`);
    }
    const resolvedParent = realpathSync(dirname(sourcePath));
    const resolvedSource = realpathSync(sourcePath);
    if (!inside(outDirectory, resolvedParent) || !inside(outDirectory, resolvedSource)) {
      throw new Error(`GN runtime dependency resolves outside the build output: ${entry}`);
    }
    paths.add(sourcePath);
  }
  return [...paths].sort((left, right) =>
    toPosix(relative(outDirectory, left)).localeCompare(toPosix(relative(outDirectory, right))));
}

function copyMember(sourcePath: string, relativePath: string): void {
  if (relativePath === "" || isAbsolute(relativePath) || relativePath.includes("\\")
      || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`unsafe paged helper bundle member path: ${relativePath}`);
  }
  const destination = resolve(bundleDirectory, ...relativePath.split("/"));
  if (!inside(bundleDirectory, destination)) {
    throw new Error(`paged helper destination escaped its bundle: ${relativePath}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  const sourceStat = lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    symlinkSync(readlinkSync(sourcePath), destination);
    return;
  }
  copyFileSync(sourcePath, destination, constants.COPYFILE_FICLONE);
}

function member(relativePath: string, role: PagedCaptureHelperBundleMember["role"]): PagedCaptureHelperBundleMember {
  const path = resolve(bundleDirectory, ...relativePath.split("/"));
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    const linkTarget = readlinkSync(path);
    return {
      kind: "symlink",
      path: relativePath,
      role,
      linkTarget: toPosix(linkTarget),
      byteLength: Buffer.byteLength(linkTarget),
      sha256: sha256(linkTarget),
      mode: info.mode & 0o777,
    };
  }
  return {
    kind: "file",
    path: relativePath,
    role,
    byteLength: info.size,
    sha256: fileSha256(path),
    mode: info.mode & 0o777,
  };
}

async function protocolReceipt(executablePath: string): Promise<{
  product: string;
  protocolVersion: string;
  schemaSha256: string;
}> {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: process.platform !== "linux"
      || config.linuxSandboxMode !== "disabled-explicitly",
    env: pagedCaptureHelperLaunchEnvironmentForTest(process.env, process.platform, bundleDirectory),
  });
  try {
    const browserCdp = await browser.newBrowserCDPSession();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const pageCdp = await context.newCDPSession(page);
      try {
        const version = await browserCdp.send("Browser.getVersion");
        const schema = await pageCdp.send("Schema.getDomains");
        return {
          product: version.product,
          protocolVersion: version.protocolVersion,
          schemaSha256: sha256(canonicalJson(schema)),
        };
      } finally {
        await pageCdp.detach();
      }
    } finally {
      await context.close();
      await browserCdp.detach();
    }
  } finally {
    await browser.close();
  }
}

function darwinCodeSignatureIdentity(path: string): string {
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", path], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codesign failed with status ${result.status}`);
  return `${result.stdout}\n${result.stderr}`.split("\n")
    .filter((line) => /^(Identifier|Format|CodeDirectory|CDHash|Signature|TeamIdentifier)=/.test(line))
    .sort().join("\n");
}

function platformRecord(
  executablePath: string,
  members: PagedCaptureHelperBundleMember[],
): PagedCaptureHelperBundleManifest["platform"] {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`unsupported helper architecture ${process.arch}`);
  }
  if (process.platform === "darwin") {
    let quarantineState: "absent" | "present" = "absent";
    try {
      execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", executablePath], { stdio: "ignore" });
      quarantineState = "present";
    } catch {
      quarantineState = "absent";
    }
    return {
      os: "darwin",
      architecture: process.arch,
      minimumVersion: config.minimumPlatformVersion,
      codeSignatureIdentity: darwinCodeSignatureIdentity(executablePath),
      quarantineState,
    };
  }
  if (process.platform === "linux") {
    const dynamic = execFileSync("readelf", ["-d", executablePath], { encoding: "utf8" });
    const needed = dynamic.split("\n").filter((line) => line.includes("(NEEDED)")).map((line) => line.trim()).sort();
    return {
      os: "linux",
      architecture: process.arch,
      glibcMinimum: config.minimumPlatformVersion,
      sandboxMode: config.linuxSandboxMode ?? "user-namespace",
      dtNeededSha256: sha256(needed.join("\n")),
    };
  }
  const signatureScript = [
    `$s=Get-AuthenticodeSignature -LiteralPath '${executablePath.replaceAll("'", "''")}'`,
    "$s | Select-Object Status,StatusMessage,@{n='Signer';e={$_.SignerCertificate.Thumbprint}} | ConvertTo-Json -Compress",
  ].join(";");
  const authenticodeIdentity = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", signatureScript,
  ], { encoding: "utf8" }).trim();
  return {
    os: "win32",
    architecture: process.arch,
    minimumBuild: config.minimumPlatformVersion,
    authenticodeIdentity,
    dllClosureSha256: sha256(canonicalJson(members.filter((member) =>
      member.kind === "file" && member.path.toLowerCase().endsWith(".dll")))),
  };
}

async function main(): Promise<void> {
  assertPinnedSource();
  if (existsSync(bundleDirectory) && readdirSync(bundleDirectory).length > 0) {
    throw new Error("paged helper bundle directory must not already contain files");
  }
  mkdirSync(bundleDirectory, { recursive: true });
  const dependencies = runtimeDependencyPaths();
  const dependencyRelativePaths = dependencies.map((path) => toPosix(relative(outDirectory, path)));
  const executableRelativePath = process.platform === "win32" ? "headless_shell.exe" : "headless_shell";
  if (!dependencyRelativePaths.includes(executableRelativePath)) {
    throw new Error("GN runtime dependency closure omitted headless_shell");
  }
  for (let index = 0; index < dependencies.length; index++) {
    copyMember(dependencies[index], dependencyRelativePaths[index]);
  }
  const retainedBuildEvidence = assertRetainedBuildEvidence(
    resolve(outDirectory, executableRelativePath),
  );

  const scratch = mkdtempSync(resolve(tmpdir(), "domotion-helper-package-"));
  try {
    const licensePath = resolve(scratch, "LICENSE.headless_shell");
    execFileSync(process.platform === "win32" ? "python.exe" : "python3", [
      resolve(sourceRoot, "tools/licenses/licenses.py"),
      "license_file",
      licensePath,
      "--gn-target", "//headless:headless_shell",
      "--gn-out-dir", outDirectory,
    ], { cwd: sourceRoot, stdio: "inherit", maxBuffer: 64 * 1024 * 1024 });
    copyMember(licensePath, "LICENSE.headless_shell");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const protocol = await protocolReceipt(resolve(bundleDirectory, executableRelativePath));
  const runtimeDepsReceipt = `${dependencyRelativePaths.join("\n")}\n`;
  const sourceReceipt = {
    chromiumRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
    skiaRevision: PAGED_CAPTURE_SKIA_REVISION,
    depotToolsRevision: PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION,
    patchSha256: PAGED_CAPTURE_HELPER_PATCH_SHA256,
    skiaPatchSha256: PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256,
    target: "//headless:headless_shell",
  };
  const receipts: Array<[string, string | Uint8Array]> = [
    ["domotion/args.gn", readFileSync(resolve(outDirectory, "args.gn"))],
    ["domotion/build-evidence.json", retainedBuildEvidence],
    ["domotion/protocol.json", `${JSON.stringify(protocol, null, 2)}\n`],
    ["domotion/renderer-helper.patch", readFileSync(patchPath)],
    ["domotion/skia-deterministic-svg.patch", readFileSync(skiaPatchPath)],
    ["domotion/runtime_deps.txt", runtimeDepsReceipt],
    ["domotion/source.json", `${JSON.stringify(sourceReceipt, null, 2)}\n`],
  ];
  for (const [path, bytes] of receipts) {
    const destination = resolve(bundleDirectory, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }

  // Re-check both mutable source and the exact output after all packaging work,
  // immediately before publishing their authenticated manifest identities.
  assertPinnedSource();
  assertRetainedBuildEvidence(resolve(outDirectory, executableRelativePath));

  const runtimePaths = new Set(dependencyRelativePaths);
  const allPaths = [
    ...dependencyRelativePaths,
    "LICENSE.headless_shell",
    ...receipts.map(([path]) => path),
  ].sort();
  const members = allPaths.map((path) => member(
    path,
    path === executableRelativePath
      ? "executable"
      : runtimePaths.has(path)
        ? "runtime-dependency"
        : path === "LICENSE.headless_shell"
          ? "license"
          : "metadata",
  ));
  const runtimeDependenciesSha256 = pagedCaptureHelperRuntimeDependenciesDigest(members);
  if (runtimeDependenciesSha256 !== RETAINED_RUNTIME_DEPENDENCIES_SHA256) {
    throw new Error(
      "paged helper GN runtime closure differs from the reviewed darwin/arm64 build",
    );
  }
  const manifest = parsePagedCaptureHelperBundleManifest({
    schemaVersion: PAGED_CAPTURE_HELPER_BUNDLE_SCHEMA_VERSION,
    runtimeAbi: PAGED_CAPTURE_HELPER_RUNTIME_ABI,
    transportAbi: PAGED_CAPTURE_HELPER_TRANSPORT_ABI,
    capabilities: [
      PAGED_CAPTURE_HELPER_TABLE_OWNERSHIP_CAPABILITY,
      PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY,
    ],
    platform: platformRecord(resolve(bundleDirectory, executableRelativePath), members),
    source: {
      chromiumRevision: sourceReceipt.chromiumRevision,
      skiaRevision: sourceReceipt.skiaRevision,
      depotToolsRevision: sourceReceipt.depotToolsRevision,
      patchSha256: sourceReceipt.patchSha256,
      skiaPatchSha256: sourceReceipt.skiaPatchSha256,
    },
    protocol,
    runtime: {
      executablePath: executableRelativePath,
      runtimeDependenciesSha256,
      defaultEnabled: false,
      maximumSidecarBytes: PAGED_CAPTURE_HELPER_MAX_SIDECAR_BYTES,
    },
    distribution: {
      mode: "caller-supplied-local-bundle",
      automaticDownloads: false,
      updatePolicy: "manual-pinned-only",
      sourceArchiveUrl: config.sourceArchiveUrl,
      licenseFiles: ["LICENSE.headless_shell"],
    },
    members,
  });
  const manifestPath = resolve(bundleDirectory, "paged-capture-helper.json");
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestBytes);
  const manifestSha256 = sha256(manifestBytes);

  if (process.argv.includes("--smoke")) {
    const launched = await launchPagedCaptureHelper({
      manifestPath,
      expectedManifestSha256: manifestSha256,
      capability: PAGED_CAPTURE_HELPER_TABLE_OWNERSHIP_CAPABILITY,
    });
    await launched.browser.close();
  }
  console.log(JSON.stringify({
    manifestPath,
    manifestSha256,
    memberCount: members.length,
    runtimeDependencyCount: dependencyRelativePaths.length,
    smokePassed: process.argv.includes("--smoke"),
  }, null, 2));
}

await main();
