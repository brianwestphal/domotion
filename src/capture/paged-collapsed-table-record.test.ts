import { describe, expect, it } from "vitest";

import {
  buildPagedCollapsedTableRecord,
  PAGED_COLLAPSED_JOINT_PRECEDENCE,
  PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
  REQUIRED_PAGED_COLLAPSED_TABLE_FACTS,
  unavailablePagedCollapsedTableRecord,
  validateAuthenticatedPagedCollapsedTableRecord,
  type AuthenticatedPagedCollapsedTableRecord,
  type PagedCollapsedRepeatEligibility,
  type PagedCollapsedTableRecordInput,
} from "./paged-collapsed-table-record.js";

const eligibility: PagedCollapsedRepeatEligibility = {
  knownFragmentainerBlockSize: true,
  atMostQuarterFragmentainer: true,
  applicableBreakInsideAvoid: true,
  noBreakInside: true,
  noLateStart: true,
  outsideNestedRepeatableContent: true,
  layoutSideEffectsEnabled: true,
};

const joint = (winner: "self" | "neighbor" | "tie" | "absent-at-fragment-boundary") => ({
  precedence: PAGED_COLLAPSED_JOINT_PRECEDENCE,
  winner,
});

function input(): PagedCollapsedTableRecordInput {
  return {
    sourceRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
    printEpoch: {
      epochId: "print-epoch-1",
      documentLoaderId: "loader-1",
      browserVersion: "Chrome/140.0.0.0",
      protocolVersion: "1.3",
      printParametersSha256: "a".repeat(64),
      lifecycle: "PrintBegin-to-PrintEnd",
      logicalTransport: "blink-private-physical-fragment-tree-v1",
      logicalFactsDerivedFromPdfVectorOrRaster: false,
      sourceRestoredExactly: true,
    },
    pages: [
      {
        pageIndex: 0,
        pageName: null,
        emptyKind: "none",
        tableOccurrences: [{
          physicalTableFragmentId: "table:0/occurrence:0",
          tableSourceIndex: 0,
          occurrenceIndex: 0,
          pageIndex: 0,
          firstTableBox: true,
          lastTableBox: false,
          writingMode: "horizontal-tb",
          direction: "ltr",
          fragmentationAxis: "physical-y",
          progression: "positive",
          totalRows: 4,
          totalColumns: 2,
          globalColumnOffsets: [0, 80, 200],
          sectionOccurrences: [
            {
              physicalSectionFragmentId: "section:head/occurrence:0",
              sectionSourceIndex: 0,
              sectionTag: "thead",
              occurrenceIndex: 0,
              repeatRole: "original-header",
              sectionPaintSlot: 0,
              tableChildPaintSlot: 1,
              globalRows: { start: 0, endExclusive: 1 },
              logicalRowOffsets: [0, 32],
              startBreak: { kind: "none", globalRowIndex: null },
              endBreak: { kind: "none", globalRowIndex: null },
              repeatEligibility: null,
              reservedCollapsedEdgeSpace: { blockStart: 0, blockEnd: 0 },
            },
            {
              physicalSectionFragmentId: "section:body/occurrence:0",
              sectionSourceIndex: 1,
              sectionTag: "tbody",
              occurrenceIndex: 0,
              repeatRole: "body",
              sectionPaintSlot: 1,
              tableChildPaintSlot: 2,
              globalRows: { start: 1, endExclusive: 3 },
              logicalRowOffsets: [32, 110, 210],
              startBreak: { kind: "none", globalRowIndex: null },
              endBreak: { kind: "continued-row", globalRowIndex: 2 },
              repeatEligibility: null,
              reservedCollapsedEdgeSpace: { blockStart: 0, blockEnd: 0 },
            },
            {
              physicalSectionFragmentId: "section:foot/occurrence:0",
              sectionSourceIndex: 2,
              sectionTag: "tfoot",
              occurrenceIndex: 0,
              repeatRole: "repeated-footer",
              sectionPaintSlot: 2,
              tableChildPaintSlot: 3,
              globalRows: { start: 3, endExclusive: 4 },
              logicalRowOffsets: [210, 242],
              startBreak: { kind: "none", globalRowIndex: null },
              endBreak: { kind: "none", globalRowIndex: null },
              repeatEligibility: { ...eligibility },
              reservedCollapsedEdgeSpace: { blockStart: 0, blockEnd: 3 },
            },
          ],
          captionOccurrences: [{
            physicalCaptionFragmentId: "caption:0/occurrence:0",
            captionSourceIndex: 0,
            occurrenceIndex: 0,
            tableChildPaintSlot: 0,
            side: "block-start",
          }],
          spanningCells: [{
            cellSourceIndex: 3,
            globalRows: { start: 1, endExclusive: 3 },
            globalColumnStart: 0,
            globalColumnEndExclusive: 2,
            interiorCollapsedEdgeIndices: [5],
          }],
          collapsedEdges: [
            {
              sourceEdgeIndex: 0,
              decisionOrder: 0,
              paintOrder: 0,
              axis: "inline",
              globalRowBoundary: 0,
              globalColumnBoundary: 0,
              disposition: "paint-full",
              startJoint: joint("self"),
              endJoint: joint("neighbor"),
            },
            {
              sourceEdgeIndex: 5,
              decisionOrder: 1,
              paintOrder: null,
              axis: "block",
              globalRowBoundary: 2,
              globalColumnBoundary: 1,
              disposition: "skip-span-interior",
              startJoint: joint("tie"),
              endJoint: joint("tie"),
            },
            {
              sourceEdgeIndex: 8,
              decisionOrder: 2,
              paintOrder: null,
              axis: "inline",
              globalRowBoundary: 2,
              globalColumnBoundary: 0,
              disposition: "omit-at-continued-row-end",
              startJoint: joint("absent-at-fragment-boundary"),
              endJoint: joint("absent-at-fragment-boundary"),
            },
          ],
        }],
      },
      {
        pageIndex: 1,
        pageName: null,
        emptyKind: "none",
        tableOccurrences: [{
          physicalTableFragmentId: "table:0/occurrence:1",
          tableSourceIndex: 0,
          occurrenceIndex: 1,
          pageIndex: 1,
          firstTableBox: false,
          lastTableBox: true,
          writingMode: "horizontal-tb",
          direction: "ltr",
          fragmentationAxis: "physical-y",
          progression: "positive",
          totalRows: 4,
          totalColumns: 2,
          globalColumnOffsets: [0, 80, 200],
          sectionOccurrences: [
            {
              physicalSectionFragmentId: "section:head/occurrence:1",
              sectionSourceIndex: 0,
              sectionTag: "thead",
              occurrenceIndex: 1,
              repeatRole: "repeated-header",
              sectionPaintSlot: 0,
              tableChildPaintSlot: 0,
              globalRows: { start: 0, endExclusive: 1 },
              logicalRowOffsets: [0, 32],
              startBreak: { kind: "none", globalRowIndex: null },
              endBreak: { kind: "none", globalRowIndex: null },
              repeatEligibility: { ...eligibility },
              reservedCollapsedEdgeSpace: { blockStart: 3, blockEnd: 0 },
            },
            {
              physicalSectionFragmentId: "section:body/occurrence:1",
              sectionSourceIndex: 1,
              sectionTag: "tbody",
              occurrenceIndex: 1,
              repeatRole: "body",
              sectionPaintSlot: 1,
              tableChildPaintSlot: 1,
              globalRows: { start: 2, endExclusive: 3 },
              logicalRowOffsets: [32, 126],
              startBreak: { kind: "continued-row", globalRowIndex: 2 },
              endBreak: { kind: "none", globalRowIndex: null },
              repeatEligibility: null,
              reservedCollapsedEdgeSpace: { blockStart: 0, blockEnd: 0 },
            },
            {
              physicalSectionFragmentId: "section:foot/occurrence:1",
              sectionSourceIndex: 2,
              sectionTag: "tfoot",
              occurrenceIndex: 1,
              repeatRole: "original-footer",
              sectionPaintSlot: 2,
              tableChildPaintSlot: 2,
              globalRows: { start: 3, endExclusive: 4 },
              logicalRowOffsets: [126, 158],
              startBreak: { kind: "none", globalRowIndex: null },
              endBreak: { kind: "none", globalRowIndex: null },
              repeatEligibility: { ...eligibility },
              reservedCollapsedEdgeSpace: { blockStart: 0, blockEnd: 3 },
            },
          ],
          captionOccurrences: [],
          spanningCells: [],
          collapsedEdges: [
            {
              sourceEdgeIndex: 6,
              decisionOrder: 0,
              paintOrder: null,
              axis: "inline",
              globalRowBoundary: 2,
              globalColumnBoundary: 0,
              disposition: "omit-at-continued-row-start",
              startJoint: joint("absent-at-fragment-boundary"),
              endJoint: joint("absent-at-fragment-boundary"),
            },
            {
              sourceEdgeIndex: 7,
              decisionOrder: 1,
              paintOrder: 0,
              axis: "block",
              globalRowBoundary: 2,
              globalColumnBoundary: 1,
              disposition: "paint-full",
              startJoint: joint("self"),
              endJoint: joint("self"),
            },
          ],
        }],
      },
      {
        pageIndex: 2,
        pageName: null,
        emptyKind: "terminal-empty",
        tableOccurrences: [],
      },
    ],
  };
}

function authenticated(): AuthenticatedPagedCollapsedTableRecord {
  const record = buildPagedCollapsedTableRecord(input());
  if (record.status !== "authenticated") throw new Error(record.reason);
  return record;
}

describe("paged collapsed-table private logical record", () => {
  it("authenticates page/table/section/repeat/break/span/edge ownership without PDF facts", () => {
    const record = authenticated();
    expect(validateAuthenticatedPagedCollapsedTableRecord(record)).toEqual([]);
    expect(record.pages).toHaveLength(3);
    expect(record.pages[1].tableOccurrences[0].sectionOccurrences.map((row) => row.repeatRole)).toEqual([
      "repeated-header",
      "body",
      "original-footer",
    ]);
    expect(record.pages[0].tableOccurrences[0].sectionOccurrences.at(-1)?.repeatRole)
      .toBe("repeated-footer");
    expect(record.provenance.pdfRole).toBe("downstream-integration-evidence-only");
  });

  it.each([
    ["wrong page index", (record: AuthenticatedPagedCollapsedTableRecord) => { record.pages[1].pageIndex = 4; }],
    ["wrong writing progression", (record: AuthenticatedPagedCollapsedTableRecord) => { record.pages[0].tableOccurrences[0].fragmentationAxis = "physical-x"; }],
    ["missing repeat eligibility", (record: AuthenticatedPagedCollapsedTableRecord) => { record.pages[1].tableOccurrences[0].sectionOccurrences[0].repeatEligibility = null; }],
    ["false repeat eligibility", (record: AuthenticatedPagedCollapsedTableRecord) => {
      const repeat = record.pages[0].tableOccurrences[0].sectionOccurrences[2]
        .repeatEligibility as unknown as { noBreakInside: boolean };
      repeat.noBreakInside = false;
    }],
    ["wrong repeat role", (record: AuthenticatedPagedCollapsedTableRecord) => { record.pages[0].tableOccurrences[0].sectionOccurrences[0].repeatRole = "body"; }],
    ["wrong continued row", (record: AuthenticatedPagedCollapsedTableRecord) => { record.pages[1].tableOccurrences[0].sectionOccurrences[1].startBreak.globalRowIndex = 1; }],
    ["edge disposition without its break", (record: AuthenticatedPagedCollapsedTableRecord) => { record.pages[0].tableOccurrences[0].collapsedEdges[2].disposition = "paint-half-at-whole-row-end"; record.pages[0].tableOccurrences[0].collapsedEdges[2].paintOrder = 1; }],
    ["nonconsecutive child paint slot", (record: AuthenticatedPagedCollapsedTableRecord) => { record.pages[0].tableOccurrences[0].sectionOccurrences[2].tableChildPaintSlot = 7; }],
    ["painted span interior", (record: AuthenticatedPagedCollapsedTableRecord) => { record.pages[0].tableOccurrences[0].collapsedEdges[1].disposition = "paint-full"; record.pages[0].tableOccurrences[0].collapsedEdges[1].paintOrder = 1; }],
    ["wrong edge order", (record: AuthenticatedPagedCollapsedTableRecord) => { record.pages[0].tableOccurrences[0].collapsedEdges[2].decisionOrder = 9; }],
    ["wrong joint order", (record: AuthenticatedPagedCollapsedTableRecord) => {
      const jointRecord = record.pages[0].tableOccurrences[0].collapsedEdges[0].startJoint as unknown as {
        precedence: readonly string[];
      };
      jointRecord.precedence = ["under", "after", "before", "over"];
    }],
    ["nonterminal terminal page", (record: AuthenticatedPagedCollapsedTableRecord) => { record.pages[1].emptyKind = "terminal-empty"; record.pages[1].tableOccurrences = []; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const record = authenticated();
    mutate(record);
    expect(validateAuthenticatedPagedCollapsedTableRecord(record)).not.toEqual([]);
  });

  it("keeps public printToPDF explicitly unavailable with every missing fact named", () => {
    const record = unavailablePagedCollapsedTableRecord("public protocol carries PDF bytes only");
    expect(record.status).toBe("unavailable");
    expect(record.missingFacts).toEqual(REQUIRED_PAGED_COLLAPSED_TABLE_FACTS);
    expect(record.provenance).toEqual({
      publicProtocol: "Page.printToPDF-pdf-bytes-or-stream-only",
      screenCssomMayNotSubstitute: true,
      pdfVectorOrRasterMayNotSubstitute: true,
    });
  });
});
