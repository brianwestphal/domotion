import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildPagedCollapsedTableRecord,
  PAGED_COLLAPSED_JOINT_PRECEDENCE,
  PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
  type AuthenticatedPagedCollapsedTableRecord,
} from "../src/capture/paged-collapsed-table-record.js";
import {
  PAGED_TABLE_EVIDENCE_FIXTURES,
  REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX,
  validatePagedTableEvidenceFixtures,
  type PagedCollapsedTableMatrixCell,
} from "../tools/paged-table-evidence-fixtures.js";
import {
  PAGED_TABLE_RENDERER_EVIDENCE_ABI,
  PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES,
  PAGED_TABLE_RENDERER_EVIDENCE_PATCH_SHA256,
  pagedTableEvidenceDigest,
  pagedTableRendererArtifactDigest,
  pagedTableRendererPlatformPackaging,
  runPagedTableRendererHostileMutations,
  validateBlinkPagedTableRendererPayload,
  validatePagedTableRendererEvidenceArtifact,
  type BlinkPagedTableRendererPayload,
  type PagedTableRendererEvidenceArtifact,
  type PagedTableRendererPrintParameters,
} from "../tools/paged-table-renderer-evidence-schema.js";

const joint = {
  precedence: PAGED_COLLAPSED_JOINT_PRECEDENCE,
  winner: "self" as const,
};

function authenticated(): AuthenticatedPagedCollapsedTableRecord {
  const record = buildPagedCollapsedTableRecord({
    sourceRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
    printEpoch: {
      epochId: "epoch-1",
      documentLoaderId: "loader-1",
      browserVersion: "Chrome/140.0.0.0",
      protocolVersion: "1.3",
      printParametersSha256: "a".repeat(64),
      lifecycle: "PrintBegin-to-PrintEnd",
      logicalTransport: "blink-private-physical-fragment-tree-v1",
      logicalFactsDerivedFromPdfVectorOrRaster: false,
      sourceRestoredExactly: true,
    },
    pages: [{
      pageIndex: 0,
      pageName: null,
      emptyKind: "none",
      tableOccurrences: [{
        physicalTableFragmentId: "table:0:0",
        tableSourceIndex: 0,
        occurrenceIndex: 0,
        pageIndex: 0,
        firstTableBox: true,
        lastTableBox: true,
        writingMode: "horizontal-tb",
        direction: "ltr",
        fragmentationAxis: "physical-y",
        progression: "positive",
        totalRows: 1,
        totalColumns: 1,
        globalColumnOffsets: [0, 100],
        sectionOccurrences: [{
          physicalSectionFragmentId: "section:0:0",
          sectionSourceIndex: 0,
          sectionTag: "tbody",
          occurrenceIndex: 0,
          repeatRole: "body",
          sectionPaintSlot: 0,
          tableChildPaintSlot: 0,
          globalRows: { start: 0, endExclusive: 1 },
          logicalRowOffsets: [0, 40],
          startBreak: { kind: "none", globalRowIndex: null },
          endBreak: { kind: "none", globalRowIndex: null },
          repeatEligibility: null,
          reservedCollapsedEdgeSpace: { blockStart: 0, blockEnd: 0 },
        }],
        captionOccurrences: [],
        spanningCells: [],
        collapsedEdges: [{
          sourceEdgeIndex: 0,
          decisionOrder: 0,
          paintOrder: 0,
          axis: "block",
          globalRowBoundary: 0,
          globalColumnBoundary: 0,
          disposition: "paint-full",
          startJoint: joint,
          endJoint: joint,
        }, {
          sourceEdgeIndex: 1,
          decisionOrder: 1,
          paintOrder: 1,
          axis: "inline",
          globalRowBoundary: 0,
          globalColumnBoundary: 0,
          disposition: "paint-full",
          startJoint: joint,
          endJoint: joint,
        }],
      }],
    }],
  });
  if (record.status !== "authenticated") throw new Error(record.reason);
  return record;
}

function printParameters(): PagedTableRendererPrintParameters {
  return {
    printableArea: { x: 0, y: 0, width: 300, height: 240 },
    defaultPage: {
      width: 300,
      height: 240,
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      orientation: 0,
      pageSizeType: 0,
    },
    printerDpi: 300,
    scaleFactor: 1,
    ignoreCssMargins: false,
    ignorePageSize: false,
    rasterizePdf: false,
    printScalingOption: 2,
    usePaginatedLayout: true,
    printingInternalHeadersAndFooters: false,
    pagesPerSheet: 1,
  };
}

function sealArtifact(
  artifact: PagedTableRendererEvidenceArtifact,
): PagedTableRendererEvidenceArtifact {
  artifact.artifactDigest = pagedTableRendererArtifactDigest(artifact);
  return artifact;
}

function addMatrixFacts(
  record: AuthenticatedPagedCollapsedTableRecord,
  matrix: readonly PagedCollapsedTableMatrixCell[],
): void {
  const table = record.pages[0].tableOccurrences[0];
  const body = table.sectionOccurrences[0];
  if (matrix.includes("whole-row")) {
    body.endBreak = { kind: "whole-row", globalRowIndex: body.globalRows.endExclusive };
  }
  if (matrix.includes("continued-row")) {
    body.endBreak = {
      kind: "continued-row",
      globalRowIndex: body.globalRows.endExclusive - 1,
    };
  }
  if (matrix.includes("repeated-header-footer")) {
    const repeatEligibility = {
      knownFragmentainerBlockSize: true as const,
      atMostQuarterFragmentainer: true as const,
      applicableBreakInsideAvoid: true as const,
      noBreakInside: true as const,
      noLateStart: true as const,
      outsideNestedRepeatableContent: true as const,
      layoutSideEffectsEnabled: true as const,
    };
    table.sectionOccurrences.push({
      ...structuredClone(body),
      physicalSectionFragmentId: "section:0:1",
      sectionSourceIndex: 1,
      sectionTag: "thead",
      repeatRole: "repeated-header",
      sectionPaintSlot: 1,
      tableChildPaintSlot: 1,
      repeatEligibility: structuredClone(repeatEligibility),
    }, {
      ...structuredClone(body),
      physicalSectionFragmentId: "section:0:2",
      sectionSourceIndex: 2,
      sectionTag: "tfoot",
      repeatRole: "repeated-footer",
      sectionPaintSlot: 2,
      tableChildPaintSlot: 2,
      repeatEligibility: structuredClone(repeatEligibility),
    });
  }
  if (matrix.includes("caption")) {
    table.captionOccurrences.push({
      physicalCaptionFragmentId: "caption:0:0",
      captionSourceIndex: 0,
      occurrenceIndex: 0,
      tableChildPaintSlot: table.sectionOccurrences.length,
      side: "block-start",
    });
  }
  if (matrix.includes("span-joint")) {
    table.totalColumns = 2;
    table.globalColumnOffsets = [0, 50, 100];
    table.spanningCells.push({
      cellSourceIndex: 0,
      globalRows: { start: 0, endExclusive: 1 },
      globalColumnStart: 0,
      globalColumnEndExclusive: 2,
      interiorCollapsedEdgeIndices: [2],
    });
    table.collapsedEdges.push({
      sourceEdgeIndex: 2,
      decisionOrder: 2,
      paintOrder: null,
      axis: "block",
      globalRowBoundary: 0,
      globalColumnBoundary: 1,
      disposition: "skip-span-interior",
      startJoint: joint,
      endJoint: joint,
    });
  }
  if (matrix.includes("vertical-lr-positive")) {
    table.writingMode = "vertical-lr";
    table.fragmentationAxis = "physical-x";
    table.progression = "positive";
  }
  if (matrix.includes("vertical-rl-negative")) {
    table.writingMode = "vertical-rl";
    table.fragmentationAxis = "physical-x";
    table.progression = "negative";
  }
  if (matrix.includes("empty-terminal-page")) {
    record.pages.push({
      pageIndex: 1,
      pageName: null,
      emptyKind: "terminal-empty",
      tableOccurrences: [],
    });
  }
}

function evidenceArtifact(): PagedTableRendererEvidenceArtifact {
  const parameters = printParameters();
  const printParametersSha256 = pagedTableEvidenceDigest(parameters);
  const printRequest = {
    printBackground: true,
    preferCSSPageSize: true,
    transferMode: "ReturnAsStream" as const,
    domotionPagedTableEvidence: true,
  } as const;
  const cases = PAGED_TABLE_EVIDENCE_FIXTURES.map((fixture, requestOrdinal) => {
    const browserProcessId = 1001;
    const rendererProcessId = 2001 + requestOrdinal;
    const rendererExecutablePath = "/authenticated/headless_shell";
    const rendererExecutableSha256 = "b".repeat(64);
    const frameId = `frame-${requestOrdinal}`;
    const loaderId = `loader-${requestOrdinal}`;
    const documentUrl = "about:blank";
    const frameToken = `frame-token-${requestOrdinal}`;
    const documentToken = `document-token-${requestOrdinal}`;
    const sourceStateSha256 = pagedTableEvidenceDigest({
      fixture: fixture.id,
      state: "screen-source",
    });
    const record = structuredClone(authenticated());
    addMatrixFacts(record, fixture.matrix);
    const sidecar = JSON.stringify({
      helperAbi: PAGED_TABLE_RENDERER_EVIDENCE_ABI,
      sourceRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
      capturePhase: "after-PrintBegin-before-PrintEnd",
      logicalFactsDerivedFromPdfVectorOrRaster: false,
      frameToken,
      documentToken,
      documentUrl,
      printParameters: parameters,
      pages: record.pages,
    } satisfies BlinkPagedTableRendererPayload);
    const sidecarSha256 = createHash("sha256").update(sidecar).digest("hex");
    record.printEpoch = {
      epochId: pagedTableEvidenceDigest({
        ordinal: requestOrdinal,
        browserProcessId,
        rendererProcessId,
        rendererExecutablePath,
        rendererExecutableSha256,
        frameId,
        loaderId,
        documentUrl,
        frameToken,
        documentToken,
        browserVersion: "HeadlessChrome/140.0.0.0",
        protocolVersion: "1.3",
        printRequest,
        printParametersSha256,
        sourceStateSha256,
        sidecarSha256,
      }),
      documentLoaderId: loaderId,
      browserVersion: "HeadlessChrome/140.0.0.0",
      protocolVersion: "1.3",
      printParametersSha256,
      lifecycle: "PrintBegin-to-PrintEnd",
      logicalTransport: "blink-private-physical-fragment-tree-v1",
      logicalFactsDerivedFromPdfVectorOrRaster: false,
      sourceRestoredExactly: true,
    };
    return {
      fixtureId: fixture.id,
      matrix: [...fixture.matrix],
      requestOrdinal,
      browserProcessId,
      rendererProcessId,
      rendererExecutablePath,
      rendererExecutableSha256,
      frameId,
      loaderId,
      documentUrl,
      documentToken,
      frameToken,
      printRequest: { ...printRequest },
      printParameters: structuredClone(parameters),
      sourceStateSha256Before: sourceStateSha256,
      sourceStateSha256After: sourceStateSha256,
      sidecar,
      sidecarByteLength: Buffer.byteLength(sidecar),
      sidecarSha256,
      sourceRestoredExactly: true as const,
      pdfBytesReadForLogicalFacts: false as const,
      record,
    };
  });
  const mutations = runPagedTableRendererHostileMutations(cases[0].record);
  return sealArtifact({
    schemaVersion: 1,
    ticket: "DM-2573",
    contract: "pinned-blink-private-paged-table-response-sidecar-no-pdf-facts",
    generatedAt: "2026-08-25T00:00:00.000Z",
    artifactDigest: "",
    helper: {
      abi: PAGED_TABLE_RENDERER_EVIDENCE_ABI,
      maximumSidecarBytes: PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES,
      runtimeDefaultEnabled: false,
      transport: "Page.printToPDF-optional-bounded-response-sidecar",
      capturePhase: "after-PrintBegin-before-PrintEnd",
    },
    build: {
      chromiumRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
      skiaRevision: "62efacd37737505732dbe3d8daa62abd679626a1",
      depotToolsRevision: "612d70c7ccb01d4a405e822ad0505206de636d7e",
      sourceRoot: "/authenticated/chromium/src",
      patchPath: "/authenticated/renderer-helper.patch",
      patchSha256: PAGED_TABLE_RENDERER_EVIDENCE_PATCH_SHA256,
      sourceFiles: {
        buildHelperSha256: "1".repeat(64),
        collectorSha256: "2".repeat(64),
        fixtureManifestSha256: "3".repeat(64),
        evidenceSchemaSha256: "4".repeat(64),
        recordSchemaSha256: "5".repeat(64),
      },
      sourceDeltaMatchesPatchExactly: true,
      browserExecutablePath: "/authenticated/headless_shell",
      browserExecutableSha256: "b".repeat(64),
      rendererExecutablePath: "/authenticated/headless_shell",
      rendererExecutableSha256: "b".repeat(64),
      browserAndRendererUseSamePinnedImage: true,
      explicitlyHeadless: true,
    },
    defaultOffControl: {
      fixtureId: PAGED_TABLE_EVIDENCE_FIXTURES[0].id,
      request: {
        printBackground: true,
        preferCSSPageSize: true,
        transferMode: "ReturnAsStream",
      },
      frameId: "default-off-frame",
      loaderId: "default-off-loader",
      sourceStateSha256Before: "c".repeat(64),
      sourceStateSha256After: "c".repeat(64),
      unexpectedDomotionResponseFields: [],
      sourceRestoredExactly: true,
      pdfBytesReadForLogicalFacts: false,
    },
    cases,
    mutations,
    packaging: pagedTableRendererPlatformPackaging(),
    discriminators: {
      everyRecordSourceOwned: true,
      everySidecarBounded: true,
      everyEpochBound: true,
      everySourceRestored: true,
      browserRendererImagesAuthenticated: true,
      noPdfVectorRasterLogicalFacts: true,
      runtimeDefaultDisabled: true,
      allRequiredScenariosCovered: true,
      allHostileMutationsRejected: true,
    },
    verdict: "pinned-renderer-helper-ready",
    pass: true,
  });
}

describe("DM-2573 pinned paged-table renderer helper", () => {
  it("shares one complete source-owned corpus with the public boundary audit", () => {
    expect(validatePagedTableEvidenceFixtures()).toEqual([]);
    expect(PAGED_TABLE_EVIDENCE_FIXTURES).toHaveLength(7);
    expect(REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX).toHaveLength(8);
  });

  it("accepts only a bounded Blink payload captured inside the print lifetime", () => {
    const record = authenticated();
    const payload: BlinkPagedTableRendererPayload = {
      helperAbi: PAGED_TABLE_RENDERER_EVIDENCE_ABI,
      sourceRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
      capturePhase: "after-PrintBegin-before-PrintEnd",
      logicalFactsDerivedFromPdfVectorOrRaster: false,
      frameToken: "frame-token",
      documentToken: "document-token",
      documentUrl: "about:blank",
      printParameters: printParameters(),
      pages: record.pages,
    };
    expect(validateBlinkPagedTableRendererPayload(payload)).toEqual([]);
    expect(PAGED_TABLE_RENDERER_EVIDENCE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(pagedTableEvidenceDigest(-0)).not.toBe(pagedTableEvidenceDigest(0));

    const malformedParameters = structuredClone(payload) as unknown as {
      printParameters: { ignoreCssMargins: string; printScalingOption: number };
    };
    malformedParameters.printParameters.ignoreCssMargins = "false";
    malformedParameters.printParameters.printScalingOption = 99;
    expect(validateBlinkPagedTableRendererPayload(
      malformedParameters as unknown as BlinkPagedTableRendererPayload,
    )).toEqual(expect.arrayContaining([
      "renderer print parameters are not a paginated print contract",
      "renderer print parameter flags are not booleans",
    ]));
  });

  it("rejects active drop/dup/reorder/axis/source/epoch/teardown mutations", () => {
    const mutations = runPagedTableRendererHostileMutations(authenticated());
    expect(mutations.map((row) => row.id)).toEqual([
      "drop-page",
      "duplicate-physical-occurrence",
      "reorder-edge-decisions",
      "wrong-fragmentation-axis",
      "source-revision-drift",
      "document-epoch-drift",
      "teardown-not-restored",
    ]);
    expect(mutations.every((row) => row.rejected && row.errors.length > 0)).toBe(true);
  });

  it("binds every source-owned fixture, process, sidecar, and effective print epoch", () => {
    const artifact = evidenceArtifact();
    expect(validatePagedTableRendererEvidenceArtifact(artifact)).toEqual([]);

    artifact.cases[0].matrix = ["continued-row"];
    expect(validatePagedTableRendererEvidenceArtifact(artifact)).toContain(
      "renderer fixture matrix drifted for whole-row-pages",
    );

    const declaredOnly = evidenceArtifact();
    declaredOnly.cases[0].record.pages[0].tableOccurrences[0]
      .sectionOccurrences[0].endBreak = { kind: "none", globalRowIndex: null };
    expect(validatePagedTableRendererEvidenceArtifact(declaredOnly)).toContain(
      "renderer fixture whole-row-pages did not produce source-owned whole-row evidence",
    );

    const changedBytes = evidenceArtifact();
    changedBytes.cases[0].sidecar += " ";
    expect(validatePagedTableRendererEvidenceArtifact(changedBytes)).toContain(
      "renderer sidecar bytes differ from the retained length/hash",
    );

    const forgedMutation = evidenceArtifact();
    forgedMutation.mutations[0].errors = ["forged"];
    expect(validatePagedTableRendererEvidenceArtifact(forgedMutation)).toContain(
      "retained hostile-mutation results do not replay exactly",
    );

    const enabledByDefault = evidenceArtifact();
    enabledByDefault.defaultOffControl.unexpectedDomotionResponseFields = [
      "domotionPagedTableEvidence",
    ];
    expect(validatePagedTableRendererEvidenceArtifact(enabledByDefault)).toContain(
      "runtime-default-off print control failed",
    );
  });

  it("keeps transport optional, bounded, source-first, and trace/pixel free", () => {
    const patch = readFileSync(
      "tools/chromium-paged-table-evidence/renderer-helper.patch",
      "utf8",
    );
    expect(patch).toContain("experimental optional boolean domotionPagedTableEvidence");
    expect(patch).toContain("bool domotion_paged_table_evidence = false;");
    expect(patch).toContain("kDomotionPagedTableEvidenceMaxBytes = 8 * 1024 * 1024");
    expect(patch).toContain("after-PrintBegin-before-PrintEnd");
    expect(patch).toContain("PhysicalBoxFragment");
    expect(patch).not.toContain("DOMOTION_PAGED_TABLE_TRACE");
    expect(patch).not.toContain("SkCanvas::readPixels");
    expect(patch).not.toContain("PDFium");
    const collector = readFileSync(
      "tools/paged-table-renderer-evidence-collector.ts",
      "utf8",
    );
    expect(collector).toContain("headless: true");
    expect(collector).toContain("collectDefaultOffControl");
    expect(collector).toContain('rawSend(cdp, "IO.close"');
    expect(collector).not.toContain('"IO.read"');
    expect(collector).not.toContain("screenshot");
  });
});
