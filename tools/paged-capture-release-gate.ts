#!/usr/bin/env tsx
/** Strict terminal gate for authenticated paged capture (DM-2713). */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PAGED_CAPTURE_HELPER_ABI,
  PAGED_CAPTURE_HELPER_PATCH_SHA256,
  PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256,
  PAGED_CAPTURE_SKIA_REVISION,
} from "../src/capture/paged-capture-bundle.js";
import { PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION } from "../src/capture/paged-collapsed-table-record.js";
import { PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION } from "../src/capture/paged-capture-helper.js";

export const PAGED_CAPTURE_RELEASE_PLATFORMS = ["darwin", "linux", "win32"] as const;
export const PAGED_CAPTURE_RELEASE_ROLES = ["proposal", "validation"] as const;
export const PAGED_CAPTURE_RELEASE_MATRIX = [
  "repeated-header",
  "repeated-footer",
  "oversized-header-not-repeated",
  "oversized-footer-not-repeated",
  "break-before",
  "break-after",
  "whole-row-break",
  "continued-row-break",
  "top-caption",
  "bottom-caption",
  "rowspan-interior",
  "colspan-interior",
  "non-unit-zoom",
  "named-page",
  "css-page-size",
  "horizontal-writing",
  "vertical-rl-writing",
  "vertical-lr-writing",
] as const;
export const PAGED_CAPTURE_RELEASE_MUTATIONS = [
  "missing-matrix-cell",
  "logical-after-native-ink",
  "helper-default-enabled",
  "stock-browser-authenticated",
  "source-pin-drift",
  "helper-manifest-drift",
  "bundle-manifest-drift",
  "page-asset-drift",
  "external-page-reference",
  "dpr-render-missing",
  "screen-tolerance-broadened",
  "pdf-used-for-logical-facts",
  "pdf-before-bundle-verification",
] as const;

type Platform = typeof PAGED_CAPTURE_RELEASE_PLATFORMS[number];
type Role = typeof PAGED_CAPTURE_RELEASE_ROLES[number];
type MatrixCell = typeof PAGED_CAPTURE_RELEASE_MATRIX[number];
type MutationId = typeof PAGED_CAPTURE_RELEASE_MUTATIONS[number];

export interface PagedCaptureReleaseArtifact {
  schemaVersion: 1;
  ticket: "DM-2713";
  role: Role;
  platform: { os: Platform; architecture: "x64" | "arm64" };
  sourcePins: {
    chromiumRevision: typeof PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION;
    skiaRevision: typeof PAGED_CAPTURE_SKIA_REVISION;
    depotToolsRevision: typeof PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION;
    helperAbi: typeof PAGED_CAPTURE_HELPER_ABI;
    helperPatchSha256: typeof PAGED_CAPTURE_HELPER_PATCH_SHA256;
    skiaPatchSha256: typeof PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256;
  };
  stageOrder: {
    logicalGate: 1;
    bundleVerification: 2;
    nativeInk: 3;
    pdfDownstream: 4;
  };
  controls: {
    helperRuntimeDefaultEnabled: false;
    stockChromiumAuthenticatedAssets: false;
    logicalFactsDerivedFromPdfOrScreenshot: false;
    screenToleranceContractChanged: false;
  };
  packaging: {
    helperManifestSha256: string;
    executableSha256: string;
    runtimeDependenciesSha256: string;
    platformIdentitySha256: string;
    completeGnRuntimeClosure: true;
    manifestVerifiedBeforeCapture: true;
    manifestVerifiedAfterCapture: true;
    liveBrowserRendererImagesAuthenticated: true;
  };
  matrix: Array<{ id: MatrixCell; passed: true; logicalEvidenceSha256: string }>;
  bundle: {
    manifestSha256: string;
    manifestRehashedExactly: true;
    pageAssetCount: number;
    allAssetsRehashedExactly: true;
    deterministicPagePaths: true;
    logicalIdentitySha256: string;
  };
  pages: Array<{
    selectionIndex: number;
    pageIndex: number;
    pageNumber: number;
    svgSha256: string;
    selfContained: true;
    externalReferences: false;
    nativeInk: {
      dpr1PngSha256: string;
      dpr2PngSha256: string;
      comparison: "exact-png-bytes";
    };
  }>;
  pdfDownstream: {
    input: "published-page-svg";
    outputCount: number;
    everyInputSvgRehashed: true;
    usedForLogicalFacts: false;
  };
  mutations: Array<{ id: MutationId; rejected: true; errors: string[] }>;
  artifactDigest: string;
  pass: true;
}

export interface PagedCaptureReleaseResult {
  ready: boolean;
  blockers: string[];
  summary: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function stablePagedCaptureReleaseJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePagedCaptureReleaseJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) =>
      `${JSON.stringify(key)}:${stablePagedCaptureReleaseJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function pagedCaptureReleaseArtifactDigest(
  artifact: Omit<PagedCaptureReleaseArtifact, "artifactDigest"> | PagedCaptureReleaseArtifact,
): string {
  const { artifactDigest: _ignored, ...unsigned } = artifact as PagedCaptureReleaseArtifact;
  return sha256(stablePagedCaptureReleaseJson(unsigned));
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactIds(actual: unknown[], expected: readonly string[]): boolean {
  const ids = actual.map((value) => String(object(value)?.id ?? ""));
  return ids.length === expected.length
    && ids.every((id, index) => id === expected[index]);
}

function validateCore(value: unknown): string[] {
  const errors: string[] = [];
  const artifact = object(value);
  if (artifact == null) return ["release artifact must be an object"];
  const platform = object(artifact.platform);
  const pins = object(artifact.sourcePins);
  const stages = object(artifact.stageOrder);
  const controls = object(artifact.controls);
  const packaging = object(artifact.packaging);
  const bundle = object(artifact.bundle);
  const pdf = object(artifact.pdfDownstream);
  const matrix = Array.isArray(artifact.matrix) ? artifact.matrix : [];
  const pages = Array.isArray(artifact.pages) ? artifact.pages : [];

  if (artifact.schemaVersion !== 1 || artifact.ticket !== "DM-2713" || artifact.pass !== true)
    errors.push("release identity or pass verdict is invalid");
  if (!PAGED_CAPTURE_RELEASE_ROLES.includes(artifact.role as Role))
    errors.push("release role is invalid");
  if (platform == null || !PAGED_CAPTURE_RELEASE_PLATFORMS.includes(platform.os as Platform)
      || !["x64", "arm64"].includes(String(platform.architecture)))
    errors.push("platform identity is invalid");
  if (pins == null
      || pins.chromiumRevision !== PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION
      || pins.skiaRevision !== PAGED_CAPTURE_SKIA_REVISION
      || pins.depotToolsRevision !== PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION
      || pins.helperAbi !== PAGED_CAPTURE_HELPER_ABI
      || pins.helperPatchSha256 !== PAGED_CAPTURE_HELPER_PATCH_SHA256
      || pins.skiaPatchSha256 !== PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256)
    errors.push("source pins drifted");
  if (stages == null || stages.logicalGate !== 1 || stages.bundleVerification !== 2
      || stages.nativeInk !== 3 || stages.pdfDownstream !== 4)
    errors.push("logical/native/bundle/PDF stage order drifted");
  if (controls == null || controls.helperRuntimeDefaultEnabled !== false
      || controls.stockChromiumAuthenticatedAssets !== false
      || controls.logicalFactsDerivedFromPdfOrScreenshot !== false
      || controls.screenToleranceContractChanged !== false)
    errors.push("negative controls or screen tolerance isolation failed");
  if (packaging == null
      || ["helperManifestSha256", "executableSha256", "runtimeDependenciesSha256", "platformIdentitySha256"]
        .some((key) => !SHA256.test(String(packaging[key] ?? "")))
      || packaging.completeGnRuntimeClosure !== true
      || packaging.manifestVerifiedBeforeCapture !== true
      || packaging.manifestVerifiedAfterCapture !== true
      || packaging.liveBrowserRendererImagesAuthenticated !== true)
    errors.push("helper packaging or live process authentication is incomplete");
  if (!exactIds(matrix, PAGED_CAPTURE_RELEASE_MATRIX)
      || matrix.some((value) => {
        const row = object(value);
        return row?.passed !== true || !SHA256.test(String(row.logicalEvidenceSha256 ?? ""));
      }))
    errors.push("exact paged logical matrix is incomplete");
  if (bundle == null || !SHA256.test(String(bundle.manifestSha256 ?? ""))
      || !SHA256.test(String(bundle.logicalIdentitySha256 ?? ""))
      || bundle.manifestRehashedExactly !== true || bundle.allAssetsRehashedExactly !== true
      || bundle.deterministicPagePaths !== true || !Number.isSafeInteger(bundle.pageAssetCount)
      || Number(bundle.pageAssetCount) <= 0 || Number(bundle.pageAssetCount) !== pages.length)
    errors.push("published bundle integrity is incomplete");
  if (pages.length === 0 || pages.some((value, index) => {
    const page = object(value);
    const nativeInk = object(page?.nativeInk);
    return page == null || page.selectionIndex !== index
      || !Number.isSafeInteger(page.pageIndex) || Number(page.pageIndex) < 0
      || page.pageNumber !== Number(page.pageIndex) + 1
      || (index > 0 && Number(page.pageIndex) <= Number(object(pages[index - 1])?.pageIndex))
      || !SHA256.test(String(page.svgSha256 ?? ""))
      || page.selfContained !== true || page.externalReferences !== false
      || nativeInk?.comparison !== "exact-png-bytes"
      || !SHA256.test(String(nativeInk.dpr1PngSha256 ?? ""))
      || !SHA256.test(String(nativeInk.dpr2PngSha256 ?? ""));
  })) errors.push("per-page self-containment or DPR final-ink evidence is incomplete");
  if (pdf == null || pdf.input !== "published-page-svg"
      || pdf.everyInputSvgRehashed !== true || pdf.usedForLogicalFacts !== false
      || pdf.outputCount !== pages.length)
    errors.push("PDF is not proven downstream-only from published page SVGs");
  return errors;
}

export function runPagedCaptureReleaseMutations(
  seed: PagedCaptureReleaseArtifact,
): PagedCaptureReleaseArtifact["mutations"] {
  const mutate = (id: MutationId, change: (draft: PagedCaptureReleaseArtifact) => void) => {
    const draft = structuredClone(seed);
    draft.mutations = [];
    draft.artifactDigest = "0".repeat(64);
    change(draft);
    const errors = validateCore(draft);
    return { id, rejected: true as const, errors };
  };
  return [
    mutate("missing-matrix-cell", (draft) => { draft.matrix.pop(); }),
    mutate("logical-after-native-ink", (draft) => { draft.stageOrder.logicalGate = 2 as 1 }),
    mutate("helper-default-enabled", (draft) => { draft.controls.helperRuntimeDefaultEnabled = true as false }),
    mutate("stock-browser-authenticated", (draft) => { draft.controls.stockChromiumAuthenticatedAssets = true as false }),
    mutate("source-pin-drift", (draft) => { draft.sourcePins.chromiumRevision = "0".repeat(40) as typeof PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION }),
    mutate("helper-manifest-drift", (draft) => { draft.packaging.helperManifestSha256 = "x" }),
    mutate("bundle-manifest-drift", (draft) => { draft.bundle.manifestRehashedExactly = false as true }),
    mutate("page-asset-drift", (draft) => { draft.bundle.allAssetsRehashedExactly = false as true }),
    mutate("external-page-reference", (draft) => { draft.pages[0].externalReferences = true as false }),
    mutate("dpr-render-missing", (draft) => { draft.pages[0].nativeInk.dpr2PngSha256 = "" }),
    mutate("screen-tolerance-broadened", (draft) => { draft.controls.screenToleranceContractChanged = true as false }),
    mutate("pdf-used-for-logical-facts", (draft) => { draft.pdfDownstream.usedForLogicalFacts = true as false }),
    mutate("pdf-before-bundle-verification", (draft) => { draft.stageOrder.pdfDownstream = 3 as 4 }),
  ];
}

export function validatePagedCaptureReleaseArtifact(value: unknown): string[] {
  const errors = validateCore(value);
  const artifact = object(value);
  if (artifact == null) return errors;
  const mutations = Array.isArray(artifact.mutations) ? artifact.mutations : [];
  if (!exactIds(mutations, PAGED_CAPTURE_RELEASE_MUTATIONS)
      || mutations.some((value) => {
        const row = object(value);
        return row?.rejected !== true || !Array.isArray(row.errors) || row.errors.length === 0;
      })) errors.push("hostile mutation matrix is incomplete");
  else if (stablePagedCaptureReleaseJson(mutations)
      !== stablePagedCaptureReleaseJson(runPagedCaptureReleaseMutations(
        artifact as unknown as PagedCaptureReleaseArtifact,
      ))) errors.push("hostile mutation results do not replay exactly");
  if (SHA256.test(String(artifact.artifactDigest ?? ""))) {
    if (pagedCaptureReleaseArtifactDigest(artifact as unknown as PagedCaptureReleaseArtifact)
        !== artifact.artifactDigest) errors.push("release artifact digest drifted");
  } else errors.push("release artifact digest is invalid");
  return errors;
}

export function adjudicatePagedCaptureRelease(
  inputs: readonly unknown[],
): PagedCaptureReleaseResult {
  const blockers: string[] = [];
  const reports = new Map<string, PagedCaptureReleaseArtifact>();
  const seen = new Set<string>();
  for (const input of inputs) {
    const errors = validatePagedCaptureReleaseArtifact(input);
    const artifact = object(input);
    const key = `${String(object(artifact?.platform)?.os ?? "<missing>")}/${String(artifact?.role ?? "<missing>")}`;
    if (seen.has(key)) blockers.push(`${key}: duplicate release report`);
    seen.add(key);
    if (errors.length > 0) blockers.push(...errors.map((error) => `${key}: ${error}`));
    if (artifact != null && errors.length === 0) reports.set(key, input as PagedCaptureReleaseArtifact);
  }
  for (const platform of PAGED_CAPTURE_RELEASE_PLATFORMS) {
    const proposal = reports.get(`${platform}/proposal`);
    const validation = reports.get(`${platform}/validation`);
    if (proposal == null) blockers.push(`${platform}: missing proposal report`);
    if (validation == null) blockers.push(`${platform}: missing validation report`);
    if (proposal != null && validation != null) {
      if (proposal.packaging.helperManifestSha256 !== validation.packaging.helperManifestSha256
          || proposal.packaging.executableSha256 !== validation.packaging.executableSha256)
        blockers.push(`${platform}: proposal/validation helper identity drifted`);
      if (proposal.bundle.logicalIdentitySha256 !== validation.bundle.logicalIdentitySha256
          || stablePagedCaptureReleaseJson(proposal.matrix)
            !== stablePagedCaptureReleaseJson(validation.matrix))
        blockers.push(`${platform}: proposal/validation logical evidence drifted`);
      const proposalInk = proposal.pages.map((page) => page.nativeInk);
      const validationInk = validation.pages.map((page) => page.nativeInk);
      const proposalPages = proposal.pages.map(({ nativeInk: _ink, ...page }) => page);
      const validationPages = validation.pages.map(({ nativeInk: _ink, ...page }) => page);
      if (stablePagedCaptureReleaseJson(proposalPages)
          !== stablePagedCaptureReleaseJson(validationPages))
        blockers.push(`${platform}: proposal/validation page SVGs drifted`);
      if (stablePagedCaptureReleaseJson(proposalInk)
          !== stablePagedCaptureReleaseJson(validationInk))
        blockers.push(`${platform}: proposal/validation native page ink drifted`);
    }
  }
  const unique = [...new Set(blockers)];
  return {
    ready: unique.length === 0,
    blockers: unique,
    summary: `${unique.length === 0 ? "READY" : "NOT READY"}: ${unique.length} paged-capture release blocker(s)`,
  };
}

function findReports(root: string): unknown[] {
  const found: unknown[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && basename(child) === "paged-capture-release.json")
        found.push(JSON.parse(readFileSync(child, "utf8")) as unknown);
    }
  };
  visit(root);
  return found;
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reports = option(process.argv.slice(2), "--reports");
  if (reports === "") throw new Error("--reports is required");
  const result = adjudicatePagedCaptureRelease(findReports(resolve(reports)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ready) process.exitCode = 1;
}
