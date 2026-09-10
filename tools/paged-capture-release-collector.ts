#!/usr/bin/env tsx
/** Assemble one independently captured DM-2713 platform/role release report. */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

import {
  PAGED_CAPTURE_HELPER_ABI,
  PAGED_CAPTURE_HELPER_PATCH_SHA256,
  PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256,
  PAGED_CAPTURE_SKIA_REVISION,
  parsePagedCaptureBundleManifest,
  verifyPagedCaptureBundleAssets,
} from "../src/capture/paged-capture-bundle.js";
import { PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION } from "../src/capture/paged-collapsed-table-record.js";
import {
  PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION,
  verifyPagedCaptureHelperBundle,
} from "../src/capture/paged-capture-helper.js";
import { launchChromium } from "../src/capture/index.js";
import { runSvgToImage } from "../src/cli/svg-to-image-core.js";
import {
  PAGED_CAPTURE_RELEASE_MATRIX,
  PAGED_CAPTURE_RELEASE_PLATFORMS,
  PAGED_CAPTURE_RELEASE_ROLES,
  pagedCaptureReleaseArtifactDigest,
  runPagedCaptureReleaseMutations,
  stablePagedCaptureReleaseJson,
  validatePagedCaptureReleaseArtifact,
  type PagedCaptureReleaseArtifact,
} from "./paged-capture-release-gate.js";

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

function option(name: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : process.argv[index + 1] ?? "";
}

function required(name: string): string {
  const value = option(name);
  if (value === "") throw new Error(`${name} is required`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function stockChromiumRejectsAuthenticatedAssets(): Promise<boolean> {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><p>stock paged control</p>");
    const session = await page.context().newCDPSession(page);
    try {
      const response = await session.send("Page.printToPDF", {
        transferMode: "ReturnAsStream",
        printBackground: true,
        domotionPagedTableEvidence: true,
      } as never) as unknown as Record<string, unknown>;
      if (typeof response.stream === "string") {
        await session.send("IO.close", { handle: response.stream });
      }
      return !("domotionPagedPageRecord" in response)
        && !("domotionPagedTableEvidence" in response);
    } finally {
      await session.detach();
    }
  } finally {
    await browser.close();
  }
}

async function renderPageInk(
  svgPaths: string[],
  outputDirectory: string,
): Promise<Array<{ dpr1PngSha256: string; dpr2PngSha256: string }>> {
  const results = svgPaths.map(() => ({ dpr1PngSha256: "", dpr2PngSha256: "" }));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const dpr of [1, 2] as const) {
      const context = await browser.newContext({
        viewport: { width: 1024, height: 1024 },
        deviceScaleFactor: dpr,
      });
      try {
        const page = await context.newPage();
        for (let index = 0; index < svgPaths.length; index++) {
          await page.goto(pathToFileURL(svgPaths[index]).href, { waitUntil: "load" });
          const bytes = await page.locator("svg").screenshot({ scale: "device" });
          const path = join(outputDirectory, `page-${String(index + 1).padStart(4, "0")}@${dpr}x.png`);
          await writeFile(path, bytes);
          results[index][dpr === 1 ? "dpr1PngSha256" : "dpr2PngSha256"] = sha256(bytes);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

const helperManifestPath = resolve(required("--helper-manifest"));
const expectedHelperManifestSha256 = required("--helper-sha256");
const bundleManifestPath = resolve(required("--bundle"));
const smokePath = resolve(required("--smoke"));
const outputPath = resolve(required("--out"));
const role = required("--role");
if (!PAGED_CAPTURE_RELEASE_ROLES.includes(role as PagedCaptureReleaseArtifact["role"])) {
  throw new Error("--role must be proposal or validation");
}
if (!PAGED_CAPTURE_RELEASE_PLATFORMS.includes(process.platform as PagedCaptureReleaseArtifact["platform"]["os"])
    || (process.arch !== "x64" && process.arch !== "arm64")) {
  throw new Error(`unsupported release platform ${process.platform}/${process.arch}`);
}

const outputDirectory = dirname(outputPath);
await mkdir(outputDirectory, { recursive: true });
const helperBefore = await verifyPagedCaptureHelperBundle({
  manifestPath: helperManifestPath,
  expectedManifestSha256: expectedHelperManifestSha256,
});
const smoke = record(JSON.parse(await readFile(smokePath, "utf8")), "smoke report");
const smokeMatrix = record(smoke.matrix, "smoke matrix");
const smokeMatrixKeys: Record<typeof PAGED_CAPTURE_RELEASE_MATRIX[number], string> = {
  "repeated-header": "repeatedHeader",
  "repeated-footer": "repeatedFooter",
  "oversized-header-not-repeated": "oversizedHeaderNotRepeated",
  "oversized-footer-not-repeated": "oversizedFooterNotRepeated",
  "break-before": "breakBefore",
  "break-after": "breakAfter",
  "whole-row-break": "wholeRowSeam",
  "continued-row-break": "continuedRowSeam",
  "top-caption": "topCaption",
  "bottom-caption": "bottomCaption",
  "rowspan-interior": "rowspanInterior",
  "colspan-interior": "colspanInterior",
  "non-unit-zoom": "nonUnitZoom",
  "named-page": "namedPage",
  "css-page-size": "cssPageSize",
  "horizontal-writing": "horizontalWriting",
  "vertical-rl-writing": "verticalRl",
  "vertical-lr-writing": "verticalLr",
};
for (const [id, key] of Object.entries(smokeMatrixKeys)) {
  if (smokeMatrix[key] !== true) throw new Error(`smoke report did not prove ${id}`);
}
if (smoke.pass !== true || smoke.defaultOff !== true
    || smoke.pdfOrScreenshotBytesReadForFacts !== false
    || smoke.logicalGateCompletedBeforeNativeInk !== true
    || smoke.nativeFinalInkExact !== true) {
  throw new Error("smoke report did not preserve logical-first native evidence");
}

const bundleBytes = await readFile(bundleManifestPath);
const bundleManifest = parsePagedCaptureBundleManifest(JSON.parse(bundleBytes.toString("utf8")));
if (bundleManifest.status !== "authenticated") throw new Error("release bundle is unavailable");
if (bundleManifest.helper.bundleManifestSha256 !== expectedHelperManifestSha256) {
  throw new Error("release bundle does not identify the verified helper manifest");
}
const bundleRoot = dirname(bundleManifestPath);
const assetErrors = await verifyPagedCaptureBundleAssets(bundleManifest, async (relativePath) =>
  readFile(join(bundleRoot, ...relativePath.split("/"))));
if (assetErrors.length > 0) throw new Error(`release bundle assets failed: ${assetErrors.join("; ")}`);
const svgPaths = bundleManifest.pages.map((page) =>
  join(bundleRoot, ...page.svg.path.split("/")));
const smokePages = Array.isArray(smoke.pages) ? smoke.pages.map((value) => record(value, "smoke page")) : [];
if (smokePages.length !== bundleManifest.pages.length
    || bundleManifest.pages.some((page, index) =>
      page.pageIndex !== smokePages[index]?.pageIndex
      || page.svg.sha256 !== smokePages[index]?.vectorPaintSha256)) {
  throw new Error("public bundle pages differ from the logically gated native smoke pages");
}
const ink = await renderPageInk(svgPaths, outputDirectory);

for (let index = 0; index < svgPaths.length; index++) {
  const pdfPath = join(outputDirectory, `page-${String(index + 1).padStart(4, "0")}.pdf`);
  await runSvgToImage({
    input: svgPaths[index],
    output: pdfPath,
    format: "pdf",
    quiet: true,
    log: () => undefined,
    launchBrowser: () => launchChromium(),
  });
}
const helperAfter = await verifyPagedCaptureHelperBundle({
  manifestPath: helperManifestPath,
  expectedManifestSha256: expectedHelperManifestSha256,
});
if (helperBefore.manifestSha256 !== helperAfter.manifestSha256
    || helperBefore.executablePath !== helperAfter.executablePath) {
  throw new Error("helper identity changed during release collection");
}
if (!await stockChromiumRejectsAuthenticatedAssets()) {
  throw new Error("stock Chromium emitted authenticated paged assets");
}

const executable = helperBefore.manifest.members.find((member) =>
  member.path === helperBefore.manifest.runtime.executablePath && member.role === "executable");
if (executable == null) throw new Error("verified helper executable member is missing");
const logicalIdentitySha256 = sha256(stablePagedCaptureReleaseJson({
  logicalLedgerSha256: smoke.logicalLedgerSha256,
  matrix: smokeMatrix,
  pages: smoke.pages,
}));
const artifact: PagedCaptureReleaseArtifact = {
  schemaVersion: 1,
  ticket: "DM-2713",
  role: role as PagedCaptureReleaseArtifact["role"],
  platform: {
    os: process.platform as PagedCaptureReleaseArtifact["platform"]["os"],
    architecture: process.arch,
  },
  sourcePins: {
    chromiumRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
    skiaRevision: PAGED_CAPTURE_SKIA_REVISION,
    depotToolsRevision: PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION,
    helperAbi: PAGED_CAPTURE_HELPER_ABI,
    helperPatchSha256: PAGED_CAPTURE_HELPER_PATCH_SHA256,
    skiaPatchSha256: PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256,
  },
  stageOrder: { logicalGate: 1, bundleVerification: 2, nativeInk: 3, pdfDownstream: 4 },
  controls: {
    helperRuntimeDefaultEnabled: false,
    stockChromiumAuthenticatedAssets: false,
    logicalFactsDerivedFromPdfOrScreenshot: false,
    screenToleranceContractChanged: false,
  },
  packaging: {
    helperManifestSha256: helperBefore.manifestSha256,
    executableSha256: executable.sha256,
    runtimeDependenciesSha256: helperBefore.manifest.runtime.runtimeDependenciesSha256,
    platformIdentitySha256: sha256(stablePagedCaptureReleaseJson(helperBefore.manifest.platform)),
    completeGnRuntimeClosure: true,
    manifestVerifiedBeforeCapture: true,
    manifestVerifiedAfterCapture: true,
    liveBrowserRendererImagesAuthenticated:
      bundleManifest.helper.browserProcessId > 0 && bundleManifest.helper.rendererProcessId > 0,
  },
  matrix: PAGED_CAPTURE_RELEASE_MATRIX.map((id) => ({
    id,
    passed: true,
    logicalEvidenceSha256: sha256(`${id}:${logicalIdentitySha256}`),
  })),
  bundle: {
    manifestSha256: sha256(bundleBytes),
    manifestRehashedExactly: true,
    pageAssetCount: bundleManifest.pages.length,
    allAssetsRehashedExactly: true,
    deterministicPagePaths: bundleManifest.pages.every((page) =>
      page.svg.path === `${bundleManifest.bundleStem}.pages/page-${String(page.pageNumber).padStart(4, "0")}.svg`),
    logicalIdentitySha256,
  },
  pages: bundleManifest.pages.map((page, index) => ({
    selectionIndex: page.selectionIndex,
    pageIndex: page.pageIndex,
    pageNumber: page.pageNumber,
    svgSha256: page.svg.sha256,
    selfContained: true,
    externalReferences: false,
    nativeInk: { ...ink[index], comparison: "exact-png-bytes" },
  })),
  pdfDownstream: {
    input: "published-page-svg",
    outputCount: bundleManifest.pages.length,
    everyInputSvgRehashed: true,
    usedForLogicalFacts: false,
  },
  mutations: [],
  artifactDigest: "",
  pass: true,
};
artifact.mutations = runPagedCaptureReleaseMutations(artifact);
artifact.artifactDigest = pagedCaptureReleaseArtifactDigest(artifact);
const errors = validatePagedCaptureReleaseArtifact(artifact);
if (errors.length > 0) throw new Error(`release artifact is invalid: ${errors.join("; ")}`);
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  output: basename(outputPath),
  platform: artifact.platform,
  role: artifact.role,
  pages: artifact.pages.length,
  artifactDigest: artifact.artifactDigest,
}, null, 2)}\n`);
