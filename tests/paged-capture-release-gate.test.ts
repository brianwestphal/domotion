import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PAGED_CAPTURE_HELPER_ABI,
  PAGED_CAPTURE_HELPER_PATCH_SHA256,
  PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256,
  PAGED_CAPTURE_SKIA_REVISION,
} from "../src/capture/paged-capture-bundle.js";
import { PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION } from "../src/capture/paged-collapsed-table-record.js";
import { PAGED_CAPTURE_HELPER_DEPOT_TOOLS_REVISION } from "../src/capture/paged-capture-helper.js";
import {
  PAGED_CAPTURE_RELEASE_MATRIX,
  PAGED_CAPTURE_RELEASE_PLATFORMS,
  PAGED_CAPTURE_RELEASE_ROLES,
  adjudicatePagedCaptureRelease,
  pagedCaptureReleaseArtifactDigest,
  runPagedCaptureReleaseMutations,
  validatePagedCaptureReleaseArtifact,
  type PagedCaptureReleaseArtifact,
} from "../tools/paged-capture-release-gate.js";

const digest = "a".repeat(64);

function artifact(
  os: PagedCaptureReleaseArtifact["platform"]["os"],
  role: PagedCaptureReleaseArtifact["role"],
): PagedCaptureReleaseArtifact {
  const value: PagedCaptureReleaseArtifact = {
    schemaVersion: 1,
    ticket: "DM-2713",
    role,
    platform: { os, architecture: os === "darwin" ? "arm64" : "x64" },
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
      helperManifestSha256: digest,
      executableSha256: "b".repeat(64),
      runtimeDependenciesSha256: "c".repeat(64),
      platformIdentitySha256: "d".repeat(64),
      completeGnRuntimeClosure: true,
      manifestVerifiedBeforeCapture: true,
      manifestVerifiedAfterCapture: true,
      liveBrowserRendererImagesAuthenticated: true,
    },
    matrix: PAGED_CAPTURE_RELEASE_MATRIX.map((id, index) => ({
      id,
      passed: true,
      logicalEvidenceSha256: index.toString(16).padStart(64, "0"),
    })),
    bundle: {
      manifestSha256: "e".repeat(64),
      manifestRehashedExactly: true,
      pageAssetCount: 2,
      allAssetsRehashedExactly: true,
      deterministicPagePaths: true,
      logicalIdentitySha256: "f".repeat(64),
    },
    pages: [0, 1].map((pageIndex) => ({
      selectionIndex: pageIndex,
      pageIndex,
      pageNumber: pageIndex + 1,
      svgSha256: String(pageIndex + 1).repeat(64),
      selfContained: true,
      externalReferences: false,
      nativeInk: {
        dpr1PngSha256: "1".repeat(64),
        dpr2PngSha256: "2".repeat(64),
        comparison: "exact-png-bytes",
      },
    })),
    pdfDownstream: {
      input: "published-page-svg",
      outputCount: 2,
      everyInputSvgRehashed: true,
      usedForLogicalFacts: false,
    },
    mutations: [],
    artifactDigest: "",
    pass: true,
  };
  value.mutations = runPagedCaptureReleaseMutations(value);
  value.artifactDigest = pagedCaptureReleaseArtifactDigest(value);
  return value;
}

describe("DM-2713 authenticated paged-capture release gate", () => {
  it("accepts only the complete exact logical, package, page, DPR, and downstream matrix", () => {
    const reports = PAGED_CAPTURE_RELEASE_PLATFORMS.flatMap((platform) =>
      PAGED_CAPTURE_RELEASE_ROLES.map((role) => artifact(platform, role)));
    expect(reports.every((report) => validatePagedCaptureReleaseArtifact(report).length === 0)).toBe(true);
    expect(adjudicatePagedCaptureRelease(reports)).toEqual({
      ready: true,
      blockers: [],
      summary: "READY: 0 paged-capture release blocker(s)",
    });
  });

  it("rejects every retained hostile mutation independently", () => {
    const results = runPagedCaptureReleaseMutations(artifact("darwin", "proposal"));
    expect(results).toHaveLength(13);
    expect(results.every((result) => result.rejected && result.errors.length > 0)).toBe(true);
  });

  it("does not let native ink excuse logical or PDF ownership drift", () => {
    const reports = PAGED_CAPTURE_RELEASE_PLATFORMS.flatMap((platform) =>
      PAGED_CAPTURE_RELEASE_ROLES.map((role) => artifact(platform, role)));
    reports[0].stageOrder.logicalGate = 2 as 1;
    reports[0].pdfDownstream.usedForLogicalFacts = true as false;
    reports[0].artifactDigest = pagedCaptureReleaseArtifactDigest(reports[0]);
    const result = adjudicatePagedCaptureRelease(reports);
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("darwin/proposal: logical/native/bundle/PDF stage order drifted");
    expect(result.blockers).toContain("darwin/proposal: PDF is not proven downstream-only from published page SVGs");
  });

  it("pins a six-report three-platform workflow without tolerance overrides", () => {
    const workflow = readFileSync(".github/workflows/paged-capture-release.yml", "utf8");
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("proposal");
    expect(workflow).toContain("validation");
    expect(workflow).toContain("paged-capture:helper:package");
    expect(workflow).toContain("paged-page-record:smoke");
    expect(workflow).toContain("paged-capture:release:collect");
    expect(workflow).toContain("paged-capture:release:gate");
    expect(workflow).not.toMatch(/continue-on-error|threshold|tolerance/i);
  });

  it("removes the stale macOS-only helper packaging receipt", () => {
    const packager = readFileSync("tools/package-paged-capture-helper.ts", "utf8");
    expect(packager).toContain("currentBuildEvidence");
    expect(packager).toContain('ticket: "DM-2713"');
    expect(packager).not.toContain("reviewed build evidence only for darwin/arm64");
    expect(packager).not.toContain("RETAINED_HELPER_EXECUTABLE_SHA256");
  });
});
