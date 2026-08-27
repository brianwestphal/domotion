import { createHash } from "node:crypto";

import {
  PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
  validateAuthenticatedPagedCollapsedTableRecord,
  type AuthenticatedPagedCollapsedTableRecord,
  type PagedCollapsedPageRecord,
} from "../src/capture/paged-collapsed-table-record.js";
import {
  PAGED_TABLE_EVIDENCE_FIXTURES,
  REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX,
  type PagedCollapsedTableMatrixCell,
} from "./paged-table-evidence-fixtures.js";

export const PAGED_TABLE_RENDERER_EVIDENCE_ABI =
  "domotion-paged-table-physical-fragment-v1" as const;
export const PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
export const PAGED_TABLE_RENDERER_EVIDENCE_CHROMIUM_REVISION =
  PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION;
export const PAGED_TABLE_RENDERER_EVIDENCE_DEPOT_TOOLS_REVISION =
  "612d70c7ccb01d4a405e822ad0505206de636d7e" as const;
export const PAGED_TABLE_RENDERER_EVIDENCE_SKIA_REVISION =
  "62efacd37737505732dbe3d8daa62abd679626a1" as const;
export const PAGED_TABLE_RENDERER_EVIDENCE_PATCH_SHA256 =
  "4068425916b306c7f0765f9e911caccd924f89e3512f5bc741e7f87503825642" as const;

export interface PagedTableRendererPrintParameters {
  printableArea: { x: number; y: number; width: number; height: number };
  defaultPage: {
    width: number;
    height: number;
    marginTop: number;
    marginRight: number;
    marginBottom: number;
    marginLeft: number;
    orientation: number;
    pageSizeType: number;
  };
  printerDpi: number;
  scaleFactor: number;
  ignoreCssMargins: boolean;
  ignorePageSize: boolean;
  rasterizePdf: boolean;
  printScalingOption: number;
  usePaginatedLayout: true;
  printingInternalHeadersAndFooters: boolean;
  pagesPerSheet: number;
}

export interface PagedTableRendererPrintRequest {
  printBackground: true;
  preferCSSPageSize: true;
  transferMode: "ReturnAsStream";
  domotionPagedTableEvidence: true;
}

/** The bounded string generated inside Blink while print layout is alive. */
export interface BlinkPagedTableRendererPayload {
  helperAbi: typeof PAGED_TABLE_RENDERER_EVIDENCE_ABI;
  sourceRevision: typeof PAGED_TABLE_RENDERER_EVIDENCE_CHROMIUM_REVISION;
  capturePhase: "after-PrintBegin-before-PrintEnd";
  logicalFactsDerivedFromPdfVectorOrRaster: false;
  frameToken: string;
  documentToken: string;
  documentUrl: string;
  printParameters: PagedTableRendererPrintParameters;
  pages: PagedCollapsedPageRecord[];
}

export interface PagedTableRendererMutationResult {
  id:
    | "drop-page"
    | "duplicate-physical-occurrence"
    | "reorder-edge-decisions"
    | "wrong-fragmentation-axis"
    | "source-revision-drift"
    | "document-epoch-drift"
    | "teardown-not-restored";
  rejected: boolean;
  errors: string[];
}

export interface PagedTableRendererEvidenceCase {
  fixtureId: string;
  matrix: PagedCollapsedTableMatrixCell[];
  requestOrdinal: number;
  browserProcessId: number;
  rendererProcessId: number;
  rendererExecutablePath: string;
  rendererExecutableSha256: string;
  frameId: string;
  loaderId: string;
  documentUrl: string;
  documentToken: string;
  frameToken: string;
  printRequest: PagedTableRendererPrintRequest;
  printParameters: PagedTableRendererPrintParameters;
  sourceStateSha256Before: string;
  sourceStateSha256After: string;
  sidecar: string;
  sidecarByteLength: number;
  sidecarSha256: string;
  sourceRestoredExactly: true;
  pdfBytesReadForLogicalFacts: false;
  record: AuthenticatedPagedCollapsedTableRecord;
}

export interface PagedTableRendererDefaultOffControl {
  fixtureId: string;
  request: Omit<PagedTableRendererPrintRequest, "domotionPagedTableEvidence">;
  frameId: string;
  loaderId: string;
  sourceStateSha256Before: string;
  sourceStateSha256After: string;
  unexpectedDomotionResponseFields: string[];
  sourceRestoredExactly: true;
  pdfBytesReadForLogicalFacts: false;
}

export interface PagedTableRendererPlatformPackaging {
  platform: "macOS" | "Linux" | "Windows";
  executableName: "headless_shell" | "headless_shell.exe";
  requiredCompanions: string[];
  archiveRequirements: string[];
  identityRule: string;
}

export function pagedTableRendererPlatformPackaging(): PagedTableRendererPlatformPackaging[] {
  return [
    {
      platform: "macOS",
      executableName: "headless_shell",
      requiredCompanions: [
        "icudtl.dat",
        "headless_lib_data.pak",
        "headless_lib_strings.pak",
        "snapshot_blob.bin",
        "GN runtime_deps-selected v8_context_snapshot.<architecture>.bin",
        "GN runtime_deps-selected ANGLE/SwiftShader dylibs and vk_swiftshader_icd.json",
      ],
      archiveRequirements: [
        "preserve executable bits and relative resource paths",
        "record codesign identity or explicit unsigned-ad-hoc state",
        "clear or record quarantine metadata before execution",
        "generate and retain the exact GN runtime_deps closure",
      ],
      identityRule: "sha256 the launched headless_shell and every packaged resource; renderer is the same executable image with --type=renderer",
    },
    {
      platform: "Linux",
      executableName: "headless_shell",
      requiredCompanions: [
        "icudtl.dat",
        "headless_lib_data.pak",
        "headless_lib_strings.pak",
        "snapshot_blob.bin",
        "GN runtime_deps-selected v8_context_snapshot*.bin",
        "locales/",
        "GN runtime_deps-selected ANGLE/SwiftShader .so files and vk_swiftshader_icd.json",
      ],
      archiveRequirements: [
        "preserve ELF mode, symlinks, and relative rpaths",
        "record distro/kernel/glibc and sandbox mode",
        "generate and retain the exact GN runtime_deps closure",
      ],
      identityRule: "sha256 executable, ELF DT_NEEDED closure, resources, and live /proc process maps before collection",
    },
    {
      platform: "Windows",
      executableName: "headless_shell.exe",
      requiredCompanions: [
        "icudtl.dat",
        "headless_lib_data.pak",
        "headless_lib_strings.pak",
        "snapshot_blob.bin",
        "GN runtime_deps-selected v8_context_snapshot*.bin",
        "locales\\",
        "all GN runtime_deps-selected DLL and SwiftShader dependencies",
      ],
      archiveRequirements: [
        "retain Authenticode state and long-path-safe relative layout",
        "record Windows build, architecture, and runtime DLL closure",
        "generate and retain the exact GN runtime_deps closure",
      ],
      identityRule: "sha256 headless_shell.exe, loaded DLL closure, and resources; authenticate browser and renderer PIDs from SystemInfo",
    },
  ];
}

export interface PagedTableRendererEvidenceArtifact {
  schemaVersion: 1;
  ticket: "DM-2573";
  contract: "pinned-blink-private-paged-table-response-sidecar-no-pdf-facts";
  generatedAt: string;
  artifactDigest: string;
  helper: {
    abi: typeof PAGED_TABLE_RENDERER_EVIDENCE_ABI;
    maximumSidecarBytes: typeof PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES;
    runtimeDefaultEnabled: false;
    transport: "Page.printToPDF-optional-bounded-response-sidecar";
    capturePhase: "after-PrintBegin-before-PrintEnd";
  };
  build: {
    chromiumRevision: typeof PAGED_TABLE_RENDERER_EVIDENCE_CHROMIUM_REVISION;
    skiaRevision: typeof PAGED_TABLE_RENDERER_EVIDENCE_SKIA_REVISION;
    depotToolsRevision: typeof PAGED_TABLE_RENDERER_EVIDENCE_DEPOT_TOOLS_REVISION;
    sourceRoot: string;
    patchPath: string;
    patchSha256: string;
    sourceFiles: {
      buildHelperSha256: string;
      collectorSha256: string;
      fixtureManifestSha256: string;
      evidenceSchemaSha256: string;
      recordSchemaSha256: string;
    };
    sourceDeltaMatchesPatchExactly: true;
    browserExecutablePath: string;
    browserExecutableSha256: string;
    rendererExecutablePath: string;
    rendererExecutableSha256: string;
    browserAndRendererUseSamePinnedImage: true;
    explicitlyHeadless: true;
  };
  defaultOffControl: PagedTableRendererDefaultOffControl;
  cases: PagedTableRendererEvidenceCase[];
  mutations: PagedTableRendererMutationResult[];
  packaging: PagedTableRendererPlatformPackaging[];
  discriminators: {
    everyRecordSourceOwned: boolean;
    everySidecarBounded: boolean;
    everyEpochBound: boolean;
    everySourceRestored: boolean;
    browserRendererImagesAuthenticated: boolean;
    noPdfVectorRasterLogicalFacts: boolean;
    runtimeDefaultDisabled: boolean;
    allRequiredScenariosCovered: boolean;
    allHostileMutationsRejected: boolean;
  };
  verdict: "pinned-renderer-helper-ready" | "pinned-renderer-helper-incomplete";
  pass: boolean;
}

const SHA256 = /^[a-f0-9]{64}$/;

export function stablePagedTableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stablePagedTableJson).join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stablePagedTableJson(object[key])}`).join(",")}}`;
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "number:-0";
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Number.POSITIVE_INFINITY) return "number:+Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "number:-Infinity";
    return `number:${JSON.stringify(value)}`;
  }
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "boolean:true" : "boolean:false";
  if (value === null) return "null";
  return `other:${JSON.stringify(value)}`;
}

export function pagedTableEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(stablePagedTableJson(value)).digest("hex");
}

export function pagedTableRendererArtifactDigest(
  artifact: PagedTableRendererEvidenceArtifact,
): string {
  const { artifactDigest: _artifactDigest, ...body } = artifact;
  return pagedTableEvidenceDigest(body);
}

export function validateBlinkPagedTableRendererPayload(
  payload: BlinkPagedTableRendererPayload,
): string[] {
  const errors: string[] = [];
  if (payload.helperAbi !== PAGED_TABLE_RENDERER_EVIDENCE_ABI) {
    errors.push("wrong renderer helper ABI");
  }
  if (payload.sourceRevision !== PAGED_TABLE_RENDERER_EVIDENCE_CHROMIUM_REVISION) {
    errors.push("renderer helper source revision drifted");
  }
  if (payload.capturePhase !== "after-PrintBegin-before-PrintEnd") {
    errors.push("renderer payload was not captured inside the print-layout lifetime");
  }
  if (payload.logicalFactsDerivedFromPdfVectorOrRaster !== false) {
    errors.push("renderer payload claims downstream PDF/vector/raster facts");
  }
  if (payload.frameToken.trim() === "" || payload.documentToken.trim() === "") {
    errors.push("renderer frame/document identity is incomplete");
  }
  if (payload.documentUrl.trim() === "") errors.push("renderer document URL is empty");
  if (payload.pages.length === 0) errors.push("renderer payload has no pages");
  const params = payload.printParameters;
  for (const value of [
    params.printableArea.x,
    params.printableArea.y,
    params.printableArea.width,
    params.printableArea.height,
    params.defaultPage.width,
    params.defaultPage.height,
    params.defaultPage.marginTop,
    params.defaultPage.marginRight,
    params.defaultPage.marginBottom,
    params.defaultPage.marginLeft,
    params.defaultPage.orientation,
    params.defaultPage.pageSizeType,
    params.printerDpi,
    params.scaleFactor,
    params.printScalingOption,
    params.pagesPerSheet,
  ]) {
    if (!Number.isFinite(value)) errors.push("renderer print parameters contain a non-finite value");
  }
  if (params.printableArea.width <= 0 || params.printableArea.height <= 0
      || params.defaultPage.width <= 0 || params.defaultPage.height <= 0
      || !Number.isInteger(params.defaultPage.orientation)
      || params.defaultPage.orientation < 0 || params.defaultPage.orientation > 2
      || !Number.isInteger(params.defaultPage.pageSizeType)
      || params.defaultPage.pageSizeType < 0 || params.defaultPage.pageSizeType > 3
      || !Number.isInteger(params.printerDpi) || params.printerDpi <= 0
      || params.scaleFactor <= 0
      || !Number.isInteger(params.printScalingOption)
      || params.printScalingOption < 0 || params.printScalingOption > 4
      || !Number.isInteger(params.pagesPerSheet) || params.pagesPerSheet <= 0
      || params.usePaginatedLayout !== true) {
    errors.push("renderer print parameters are not a paginated print contract");
  }
  for (const value of [
    params.ignoreCssMargins,
    params.ignorePageSize,
    params.rasterizePdf,
    params.printingInternalHeadersAndFooters,
  ]) {
    if (typeof value !== "boolean") {
      errors.push("renderer print parameter flags are not booleans");
    }
  }
  return [...new Set(errors)];
}

function cloneRecord(
  record: AuthenticatedPagedCollapsedTableRecord,
): AuthenticatedPagedCollapsedTableRecord {
  return structuredClone(record);
}

function firstTable(record: AuthenticatedPagedCollapsedTableRecord) {
  return record.pages.flatMap((page) => page.tableOccurrences)[0];
}

function caseTables(row: PagedTableRendererEvidenceCase) {
  return row.record.pages.flatMap((page) => page.tableOccurrences);
}

/**
 * Prove that a manifest label moved the corresponding Blink-owned fact. The
 * manifest selects cases; it is not itself evidence that the intended print
 * condition occurred.
 */
export function rendererCaseProvesMatrixCell(
  row: PagedTableRendererEvidenceCase,
  cell: PagedCollapsedTableMatrixCell,
): boolean {
  const tables = caseTables(row);
  const sections = tables.flatMap((table) => table.sectionOccurrences);
  if (cell === "whole-row") {
    return sections.some((section) =>
      section.startBreak.kind === "whole-row"
      || section.endBreak.kind === "whole-row");
  }
  if (cell === "continued-row") {
    return sections.some((section) =>
      section.startBreak.kind === "continued-row"
      || section.endBreak.kind === "continued-row");
  }
  if (cell === "repeated-header-footer") {
    return sections.some((section) => section.repeatRole === "repeated-header")
      && sections.some((section) => section.repeatRole === "repeated-footer");
  }
  if (cell === "caption") {
    return tables.some((table) => table.captionOccurrences.length > 0);
  }
  if (cell === "span-joint") {
    return tables.some((table) => table.spanningCells.some((span) =>
      span.interiorCollapsedEdgeIndices.length > 0
      && span.interiorCollapsedEdgeIndices.every((edgeIndex) =>
        table.collapsedEdges.some((edge) =>
          edge.sourceEdgeIndex === edgeIndex
          && edge.disposition === "skip-span-interior"))));
  }
  if (cell === "vertical-lr-positive") {
    return tables.some((table) => table.writingMode === "vertical-lr"
      && table.fragmentationAxis === "physical-x"
      && table.progression === "positive");
  }
  if (cell === "vertical-rl-negative") {
    return tables.some((table) => table.writingMode === "vertical-rl"
      && table.fragmentationAxis === "physical-x"
      && table.progression === "negative");
  }
  return row.record.pages.some((page) =>
    page.emptyKind === "terminal-empty" && page.tableOccurrences.length === 0);
}

function mutationResult(
  id: PagedTableRendererMutationResult["id"],
  record: AuthenticatedPagedCollapsedTableRecord,
): PagedTableRendererMutationResult {
  const errors = validateAuthenticatedPagedCollapsedTableRecord(record);
  return { id, rejected: errors.length > 0, errors };
}

/** Active hostile mutations: every mutation must move and fail exact validation. */
export function runPagedTableRendererHostileMutations(
  source: AuthenticatedPagedCollapsedTableRecord,
): PagedTableRendererMutationResult[] {
  const results: PagedTableRendererMutationResult[] = [];

  const droppedPage = cloneRecord(source);
  droppedPage.pages = [];
  results.push(mutationResult("drop-page", droppedPage));

  const duplicate = cloneRecord(source);
  const duplicateTable = firstTable(duplicate);
  if (duplicateTable) {
    const page = duplicate.pages[duplicateTable.pageIndex];
    page.tableOccurrences.push(structuredClone(duplicateTable));
  }
  results.push(mutationResult("duplicate-physical-occurrence", duplicate));

  const reordered = cloneRecord(source);
  const reorderedTable = firstTable(reordered);
  if (reorderedTable && reorderedTable.collapsedEdges.length > 1) {
    [reorderedTable.collapsedEdges[0], reorderedTable.collapsedEdges[1]] =
      [reorderedTable.collapsedEdges[1], reorderedTable.collapsedEdges[0]];
  } else if (reordered.pages.length > 1) {
    [reordered.pages[0], reordered.pages[1]] = [reordered.pages[1], reordered.pages[0]];
  } else {
    reordered.pages[0].pageIndex = 1;
  }
  results.push(mutationResult("reorder-edge-decisions", reordered));

  const wrongAxis = cloneRecord(source);
  const wrongAxisTable = firstTable(wrongAxis);
  if (wrongAxisTable) {
    wrongAxisTable.fragmentationAxis = wrongAxisTable.fragmentationAxis === "physical-x"
      ? "physical-y"
      : "physical-x";
  }
  results.push(mutationResult("wrong-fragmentation-axis", wrongAxis));

  const sourceDrift = cloneRecord(source) as AuthenticatedPagedCollapsedTableRecord & {
    sourceRevision: string;
  };
  sourceDrift.sourceRevision = "f".repeat(40);
  results.push(mutationResult("source-revision-drift", sourceDrift));

  const epochDrift = cloneRecord(source);
  epochDrift.printEpoch.documentLoaderId = "";
  epochDrift.printEpoch.printParametersSha256 = "not-a-sha256";
  results.push(mutationResult("document-epoch-drift", epochDrift));

  const teardown = cloneRecord(source);
  teardown.printEpoch.sourceRestoredExactly = false;
  results.push(mutationResult("teardown-not-restored", teardown));

  return results;
}

export function validatePagedTableRendererEvidenceArtifact(
  artifact: PagedTableRendererEvidenceArtifact,
): string[] {
  const errors: string[] = [];
  if (artifact.schemaVersion !== 1 || artifact.ticket !== "DM-2573") {
    errors.push("wrong DM-2573 artifact identity");
  }
  if (!Number.isFinite(Date.parse(artifact.generatedAt))) {
    errors.push("renderer helper artifact timestamp is invalid");
  }
  if (!SHA256.test(artifact.artifactDigest)
      || artifact.artifactDigest !== pagedTableRendererArtifactDigest(artifact)) {
    errors.push("renderer helper artifact digest changed");
  }
  if (artifact.contract !== "pinned-blink-private-paged-table-response-sidecar-no-pdf-facts") {
    errors.push("wrong renderer evidence contract");
  }
  if (artifact.helper.abi !== PAGED_TABLE_RENDERER_EVIDENCE_ABI
      || artifact.helper.maximumSidecarBytes !== PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES
      || artifact.helper.runtimeDefaultEnabled !== false
      || artifact.helper.transport !== "Page.printToPDF-optional-bounded-response-sidecar"
      || artifact.helper.capturePhase !== "after-PrintBegin-before-PrintEnd") {
    errors.push("renderer helper transport/lifetime contract changed");
  }
  if (artifact.build.chromiumRevision !== PAGED_TABLE_RENDERER_EVIDENCE_CHROMIUM_REVISION
      || artifact.build.skiaRevision !== PAGED_TABLE_RENDERER_EVIDENCE_SKIA_REVISION
      || artifact.build.depotToolsRevision !== PAGED_TABLE_RENDERER_EVIDENCE_DEPOT_TOOLS_REVISION) {
    errors.push("renderer helper build source pin drifted");
  }
  if (artifact.build.patchSha256 !== PAGED_TABLE_RENDERER_EVIDENCE_PATCH_SHA256) {
    errors.push("renderer helper patch hash drifted");
  }
  for (const digest of [
    artifact.build.patchSha256,
    artifact.build.sourceFiles.buildHelperSha256,
    artifact.build.sourceFiles.collectorSha256,
    artifact.build.sourceFiles.fixtureManifestSha256,
    artifact.build.sourceFiles.evidenceSchemaSha256,
    artifact.build.sourceFiles.recordSchemaSha256,
    artifact.build.browserExecutableSha256,
    artifact.build.rendererExecutableSha256,
  ]) {
    if (!SHA256.test(digest)) errors.push("renderer helper build identity is not sha256");
  }
  if (!artifact.build.browserAndRendererUseSamePinnedImage
      || artifact.build.sourceDeltaMatchesPatchExactly !== true
      || artifact.build.sourceRoot.trim() === ""
      || artifact.build.patchPath.trim() === ""
      || artifact.build.browserExecutablePath.trim() === ""
      || artifact.build.rendererExecutablePath.trim() === ""
      || artifact.build.browserExecutablePath !== artifact.build.rendererExecutablePath
      || artifact.build.browserExecutableSha256 !== artifact.build.rendererExecutableSha256
      || artifact.build.explicitlyHeadless !== true) {
    errors.push("browser/renderer executable binding is incomplete");
  }
  if (artifact.cases.length !== PAGED_TABLE_EVIDENCE_FIXTURES.length) {
    errors.push("renderer helper artifact does not match the source-owned fixture count");
  }
  const defaultOff = artifact.defaultOffControl;
  if (!PAGED_TABLE_EVIDENCE_FIXTURES.some((row) => row.id === defaultOff.fixtureId)
      || defaultOff.request.printBackground !== true
      || defaultOff.request.preferCSSPageSize !== true
      || defaultOff.request.transferMode !== "ReturnAsStream"
      || "domotionPagedTableEvidence" in defaultOff.request
      || defaultOff.frameId.trim() === ""
      || defaultOff.loaderId.trim() === ""
      || !SHA256.test(defaultOff.sourceStateSha256Before)
      || defaultOff.sourceStateSha256Before !== defaultOff.sourceStateSha256After
      || defaultOff.unexpectedDomotionResponseFields.length !== 0
      || defaultOff.sourceRestoredExactly !== true
      || defaultOff.pdfBytesReadForLogicalFacts !== false) {
    errors.push("runtime-default-off print control failed");
  }
  const expectedFixtures = new Map(PAGED_TABLE_EVIDENCE_FIXTURES.map((fixture) =>
    [fixture.id, fixture]));
  const observedFixtures = new Set<string>();
  const observedEpochs = new Set<string>();
  const observedSidecars = new Set<string>();
  const observedFrameIds = new Set<string>();
  const observedLoaderIds = new Set<string>();
  const observedDocumentTokens = new Set<string>();
  const observedFrameTokens = new Set<string>();
  const browserProcessIds = new Set<number>();
  const browserVersions = new Set<string>();
  const protocolVersions = new Set<string>();
  for (const [index, row] of artifact.cases.entries()) {
    const expectedFixture = expectedFixtures.get(row.fixtureId);
    if (!expectedFixture) {
      errors.push(`unknown renderer fixture ${row.fixtureId}`);
    } else if (row.matrix.length !== expectedFixture.matrix.length
        || row.matrix.some((cell, cellIndex) =>
          cell !== expectedFixture.matrix[cellIndex])) {
      errors.push(`renderer fixture matrix drifted for ${row.fixtureId}`);
    }
    for (const cell of row.matrix) {
      if (!rendererCaseProvesMatrixCell(row, cell)) {
        errors.push(
          `renderer fixture ${row.fixtureId} did not produce source-owned ${cell} evidence`,
        );
      }
    }
    if (observedFixtures.has(row.fixtureId)) {
      errors.push(`duplicate renderer fixture ${row.fixtureId}`);
    }
    observedFixtures.add(row.fixtureId);
    if (row.requestOrdinal !== index) {
      errors.push("renderer request ordinals are not consecutive in manifest order");
    }
    if (!Number.isInteger(row.browserProcessId) || row.browserProcessId <= 0
        || !Number.isInteger(row.rendererProcessId) || row.rendererProcessId <= 0) {
      errors.push("browser/renderer process identity is invalid");
    }
    if (row.rendererExecutablePath !== artifact.build.rendererExecutablePath
        || row.rendererExecutableSha256 !== artifact.build.rendererExecutableSha256
        || !SHA256.test(row.rendererExecutableSha256)) {
      errors.push("live renderer process executable differs from the authenticated image");
    }
    browserProcessIds.add(row.browserProcessId);
    browserVersions.add(row.record.printEpoch.browserVersion);
    protocolVersions.add(row.record.printEpoch.protocolVersion);
    if (row.frameId.trim() === "" || row.loaderId.trim() === ""
        || row.documentUrl.trim() === "" || row.documentToken.trim() === ""
        || row.frameToken.trim() === "") {
      errors.push("frame/document/loader epoch identity is incomplete");
    }
    for (const [label, value, observed] of [
      ["frame", row.frameId, observedFrameIds],
      ["loader", row.loaderId, observedLoaderIds],
      ["document", row.documentToken, observedDocumentTokens],
      ["Blink frame", row.frameToken, observedFrameTokens],
    ] as const) {
      if (observed.has(value)) errors.push(`duplicate renderer ${label} identity`);
      observed.add(value);
    }
    if (row.printRequest.printBackground !== true
        || row.printRequest.preferCSSPageSize !== true
        || row.printRequest.transferMode !== "ReturnAsStream"
        || row.printRequest.domotionPagedTableEvidence !== true) {
      errors.push("renderer CDP print request differs from the evidence-only stream contract");
    }
    const retainedSidecarByteLength = Buffer.byteLength(row.sidecar);
    const retainedSidecarSha256 = createHash("sha256")
      .update(row.sidecar)
      .digest("hex");
    if (row.sidecarByteLength !== retainedSidecarByteLength
        || row.sidecarSha256 !== retainedSidecarSha256) {
      errors.push("renderer sidecar bytes differ from the retained length/hash");
    }
    if (row.sidecarByteLength <= 0
        || row.sidecarByteLength > PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES
        || !SHA256.test(row.sidecarSha256)) {
      errors.push("renderer response sidecar is empty, oversized, or unauthenticated");
    }
    try {
      const payload = JSON.parse(row.sidecar) as BlinkPagedTableRendererPayload;
      errors.push(...validateBlinkPagedTableRendererPayload(payload).map((error) =>
        `renderer sidecar: ${error}`));
      if (payload.frameToken !== row.frameToken
          || payload.documentToken !== row.documentToken
          || payload.documentUrl !== row.documentUrl) {
        errors.push("retained frame/document tokens differ from the Blink sidecar");
      }
      if (stablePagedTableJson(payload.printParameters)
          !== stablePagedTableJson(row.printParameters)) {
        errors.push("retained print parameters differ from the Blink sidecar");
      }
      if (stablePagedTableJson(payload.pages)
          !== stablePagedTableJson(row.record.pages)) {
        errors.push("retained paged record differs from the Blink sidecar");
      }
    } catch {
      errors.push("renderer response sidecar is not valid JSON");
    }
    if (!SHA256.test(row.sourceStateSha256Before)
        || row.sourceStateSha256Before !== row.sourceStateSha256After) {
      errors.push("browser source-state fingerprint did not restore exactly");
    }
    if (observedSidecars.has(row.sidecarSha256)) {
      errors.push("duplicate renderer response sidecar identity");
    }
    observedSidecars.add(row.sidecarSha256);
    if (row.sourceRestoredExactly !== true || row.pdfBytesReadForLogicalFacts !== false) {
      errors.push("renderer case violated teardown or downstream-output isolation");
    }
    errors.push(...validateAuthenticatedPagedCollapsedTableRecord(row.record));
    if (row.record.printEpoch.documentLoaderId !== row.loaderId) {
      errors.push("record loader epoch differs from the CDP navigation epoch");
    }
    const printParametersSha256 = pagedTableEvidenceDigest(row.printParameters);
    if (row.record.printEpoch.printParametersSha256 !== printParametersSha256) {
      errors.push("record print-parameter fingerprint differs from retained effective parameters");
    }
    const expectedEpochId = pagedTableEvidenceDigest({
      ordinal: row.requestOrdinal,
      browserProcessId: row.browserProcessId,
      rendererProcessId: row.rendererProcessId,
      rendererExecutablePath: row.rendererExecutablePath,
      rendererExecutableSha256: row.rendererExecutableSha256,
      frameId: row.frameId,
      loaderId: row.loaderId,
      documentUrl: row.documentUrl,
      frameToken: row.frameToken,
      documentToken: row.documentToken,
      browserVersion: row.record.printEpoch.browserVersion,
      protocolVersion: row.record.printEpoch.protocolVersion,
      printRequest: row.printRequest,
      printParametersSha256,
      sourceStateSha256: row.sourceStateSha256Before,
      sidecarSha256: row.sidecarSha256,
    });
    if (row.record.printEpoch.epochId !== expectedEpochId) {
      errors.push("record epoch fingerprint does not bind the retained process/document/print sidecar");
    }
    if (observedEpochs.has(row.record.printEpoch.epochId)) {
      errors.push("duplicate renderer print epoch identity");
    }
    observedEpochs.add(row.record.printEpoch.epochId);
  }
  if (browserProcessIds.size !== 1 || browserVersions.size !== 1
      || protocolVersions.size !== 1) {
    errors.push("renderer corpus was not collected in one authenticated browser/protocol epoch");
  }
  if (observedFrameIds.has(defaultOff.frameId)
      || observedLoaderIds.has(defaultOff.loaderId)) {
    errors.push("runtime-default-off control reused an evidence epoch");
  }
  for (const fixture of PAGED_TABLE_EVIDENCE_FIXTURES) {
    if (!observedFixtures.has(fixture.id)) {
      errors.push(`missing renderer fixture ${fixture.id}`);
    }
  }
  const mutationIds = new Set(artifact.mutations.map((row) => row.id));
  for (const id of [
    "drop-page",
    "duplicate-physical-occurrence",
    "reorder-edge-decisions",
    "wrong-fragmentation-axis",
    "source-revision-drift",
    "document-epoch-drift",
    "teardown-not-restored",
  ] as const) {
    if (!mutationIds.has(id)) errors.push(`missing hostile mutation ${id}`);
  }
  if (artifact.mutations.some((row) => !row.rejected || row.errors.length === 0)) {
    errors.push("one or more hostile mutations escaped exact validation");
  }
  const mutationSeed = artifact.cases.find((row) =>
    row.record.pages.some((page) => page.tableOccurrences.some((table) =>
      table.collapsedEdges.length > 1)))?.record;
  if (!mutationSeed) {
    errors.push("renderer corpus has no retained hostile-mutation seed");
  } else if (stablePagedTableJson(artifact.mutations)
      !== stablePagedTableJson(runPagedTableRendererHostileMutations(mutationSeed))) {
    errors.push("retained hostile-mutation results do not replay exactly");
  }
  const packaging = new Set(artifact.packaging.map((row) => row.platform));
  if (packaging.size !== 3 || artifact.packaging.length !== 3
      || !["macOS", "Linux", "Windows"].every((platform) => packaging.has(
    platform as PagedTableRendererPlatformPackaging["platform"],
  ))) {
    errors.push("three-platform packaging assessment is incomplete");
  }
  for (const row of artifact.packaging) {
    const expectedExecutable = row.platform === "Windows"
      ? "headless_shell.exe"
      : "headless_shell";
    if (row.executableName !== expectedExecutable
        || row.requiredCompanions.length === 0
        || row.archiveRequirements.length === 0
        || row.requiredCompanions.some((value) => value.trim() === "")
        || row.archiveRequirements.some((value) => value.trim() === "")
        || row.identityRule.trim() === "") {
      errors.push(`incomplete ${row.platform} helper packaging assessment`);
    }
  }
  if (stablePagedTableJson(artifact.packaging)
      !== stablePagedTableJson(pagedTableRendererPlatformPackaging())) {
    errors.push("renderer platform packaging assessment drifted");
  }
  const expected = {
    everyRecordSourceOwned: artifact.cases.every((row) =>
      validateAuthenticatedPagedCollapsedTableRecord(row.record).length === 0),
    everySidecarBounded: artifact.cases.every((row) => row.sidecarByteLength > 0
      && row.sidecarByteLength <= PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES
      && row.sidecarByteLength === Buffer.byteLength(row.sidecar)
      && row.sidecarSha256 === createHash("sha256").update(row.sidecar).digest("hex")),
    everyEpochBound: artifact.cases.every((row) => row.record.printEpoch.documentLoaderId === row.loaderId),
    everySourceRestored: artifact.cases.every((row) => row.sourceRestoredExactly
      && row.sourceStateSha256Before === row.sourceStateSha256After),
    browserRendererImagesAuthenticated:
      artifact.build.browserExecutableSha256 === artifact.build.rendererExecutableSha256
      && artifact.cases.every((row) =>
        row.rendererExecutablePath === artifact.build.rendererExecutablePath
        && row.rendererExecutableSha256 === artifact.build.rendererExecutableSha256),
    noPdfVectorRasterLogicalFacts:
      !artifact.defaultOffControl.pdfBytesReadForLogicalFacts
      && artifact.cases.every((row) => !row.pdfBytesReadForLogicalFacts
        && !row.record.printEpoch.logicalFactsDerivedFromPdfVectorOrRaster),
    runtimeDefaultDisabled:
      !("domotionPagedTableEvidence" in artifact.defaultOffControl.request)
      && artifact.defaultOffControl.unexpectedDomotionResponseFields.length === 0
      && artifact.defaultOffControl.sourceRestoredExactly,
    allRequiredScenariosCovered: REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX.every(
      (cell) => artifact.cases.some((row) =>
        row.matrix.includes(cell) && rendererCaseProvesMatrixCell(row, cell)),
    ),
    allHostileMutationsRejected: artifact.mutations.every((row) => row.rejected),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (artifact.discriminators[key as keyof typeof expected] !== value || !value) {
      errors.push(`renderer discriminator failed: ${key}`);
    }
  }
  if (artifact.pass !== (errors.length === 0)
      || artifact.verdict !== (artifact.pass
        ? "pinned-renderer-helper-ready"
        : "pinned-renderer-helper-incomplete")) {
    errors.push("renderer helper verdict disagrees with exact evidence");
  }
  return [...new Set(errors)];
}
