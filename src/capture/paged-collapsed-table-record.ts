/**
 * Exact logical ownership contract for collapsed tables in Blink's paginated
 * fragment tree.
 *
 * The public DevTools protocol does not expose this record. `Page.printToPDF`
 * enters print mode, serializes pages, leaves print mode, and returns only PDF
 * bytes (or a stream). Callers must therefore provide a private Blink fragment
 * transport carrying every field below, or keep the route explicitly
 * unavailable. PDF/vector/raster output is never accepted as logical input.
 */

export const PAGED_COLLAPSED_TABLE_RECORD_VERSION = 1 as const;
export const PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION =
  "7d859f271cbda744098ac69f44978d4edfa62be3" as const;

export const PAGED_COLLAPSED_TABLE_SOURCE_PINS = {
  chromium: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
  pageProtocol:
    "third_party/blink/public/devtools_protocol/domains/Page.pdl:922-985",
  headlessPrintProtocol:
    "headless/lib/browser/protocol/page_handler.cc:37-115",
  printLifecycle:
    "components/printing/renderer/print_render_frame_helper.cc:799-944,1085-1135,1368-1420,2273-2398",
  paginatedRoot:
    "third_party/blink/renderer/core/layout/paginated_root_layout_algorithm.cc:28-155",
  sectionRows:
    "third_party/blink/renderer/core/layout/table/table_section_layout_algorithm.cc:47-164",
  repeatedSections:
    "third_party/blink/renderer/core/layout/table/table_layout_algorithm.cc:1002-1151,1271-1339,1452-1528,1701-1719",
  collapsedPaint:
    "third_party/blink/renderer/core/paint/table_painters.cc:35-328,490-727",
} as const;

export const REQUIRED_PAGED_COLLAPSED_TABLE_FACTS = [
  "print-epoch",
  "page-index",
  "page-progression",
  "table-occurrence",
  "section-occurrence",
  "global-row-span",
  "continued-row-break-state",
  "repeated-header-occurrence",
  "repeated-footer-occurrence",
  "caption-occurrence",
  "cell-span-interior",
  "collapsed-edge-order",
  "collapsed-joint-order",
  "writing-direction",
] as const;

export type RequiredPagedCollapsedTableFact =
  typeof REQUIRED_PAGED_COLLAPSED_TABLE_FACTS[number];

export type PagedCollapsedTableWritingMode =
  | "horizontal-tb"
  | "vertical-rl"
  | "vertical-lr"
  | "sideways-rl"
  | "sideways-lr";
export type PagedCollapsedTableDirection = "ltr" | "rtl";
export type PagedCollapsedPhysicalAxis = "physical-x" | "physical-y";
export type PagedCollapsedProgression = "positive" | "negative";

export interface PagedCollapsedPrintBreakState {
  kind: "none" | "whole-row" | "continued-row";
  globalRowIndex: number | null;
}

export interface PagedCollapsedGlobalRowSpan {
  start: number;
  endExclusive: number;
}

export interface PagedCollapsedRepeatEligibility {
  knownFragmentainerBlockSize: true;
  atMostQuarterFragmentainer: true;
  applicableBreakInsideAvoid: true;
  noBreakInside: true;
  noLateStart: true;
  outsideNestedRepeatableContent: true;
  layoutSideEffectsEnabled: true;
}

export interface PagedCollapsedSectionOccurrence {
  physicalSectionFragmentId: string;
  sectionSourceIndex: number;
  sectionTag: "thead" | "tbody" | "tfoot";
  occurrenceIndex: number;
  repeatRole:
    | "body"
    | "original-header"
    | "repeated-header"
    | "original-footer"
    | "repeated-footer";
  sectionPaintSlot: number;
  tableChildPaintSlot: number;
  globalRows: PagedCollapsedGlobalRowSpan;
  logicalRowOffsets: number[];
  startBreak: PagedCollapsedPrintBreakState;
  endBreak: PagedCollapsedPrintBreakState;
  repeatEligibility: PagedCollapsedRepeatEligibility | null;
  reservedCollapsedEdgeSpace: {
    blockStart: number;
    blockEnd: number;
  };
}

export interface PagedCollapsedCaptionOccurrence {
  physicalCaptionFragmentId: string;
  captionSourceIndex: number;
  occurrenceIndex: number;
  tableChildPaintSlot: number;
  side: "block-start" | "block-end";
}

export interface PagedCollapsedSpanningCell {
  cellSourceIndex: number;
  globalRows: PagedCollapsedGlobalRowSpan;
  globalColumnStart: number;
  globalColumnEndExclusive: number;
  interiorCollapsedEdgeIndices: number[];
}

export const PAGED_COLLAPSED_JOINT_PRECEDENCE = [
  "after",
  "under",
  "before",
  "over",
] as const;

export interface PagedCollapsedJointDecision {
  precedence: typeof PAGED_COLLAPSED_JOINT_PRECEDENCE;
  winner: "self" | "neighbor" | "tie" | "absent-at-fragment-boundary";
}

export interface PagedCollapsedEdgeDecision {
  sourceEdgeIndex: number;
  decisionOrder: number;
  paintOrder: number | null;
  axis: "inline" | "block";
  globalRowBoundary: number;
  globalColumnBoundary: number;
  disposition:
    | "paint-full"
    | "paint-half-at-whole-row-start"
    | "paint-half-at-whole-row-end"
    | "omit-at-continued-row-start"
    | "omit-at-continued-row-end"
    | "skip-shared-section-edge"
    | "skip-span-interior";
  startJoint: PagedCollapsedJointDecision;
  endJoint: PagedCollapsedJointDecision;
}

export interface PagedCollapsedTableOccurrence {
  physicalTableFragmentId: string;
  tableSourceIndex: number;
  occurrenceIndex: number;
  pageIndex: number;
  firstTableBox: boolean;
  lastTableBox: boolean;
  writingMode: PagedCollapsedTableWritingMode;
  direction: PagedCollapsedTableDirection;
  fragmentationAxis: PagedCollapsedPhysicalAxis;
  progression: PagedCollapsedProgression;
  totalRows: number;
  totalColumns: number;
  globalColumnOffsets: number[];
  sectionOccurrences: PagedCollapsedSectionOccurrence[];
  captionOccurrences: PagedCollapsedCaptionOccurrence[];
  spanningCells: PagedCollapsedSpanningCell[];
  collapsedEdges: PagedCollapsedEdgeDecision[];
}

export interface PagedCollapsedPageRecord {
  pageIndex: number;
  pageName: string | null;
  emptyKind: "none" | "forced-blank" | "terminal-empty";
  tableOccurrences: PagedCollapsedTableOccurrence[];
}

export interface PagedCollapsedPrintEpoch {
  epochId: string;
  documentLoaderId: string;
  browserVersion: string;
  protocolVersion: string;
  printParametersSha256: string;
  lifecycle: "PrintBegin-to-PrintEnd";
  logicalTransport: "blink-private-physical-fragment-tree-v1";
  logicalFactsDerivedFromPdfVectorOrRaster: false;
  sourceRestoredExactly: true;
}

export interface PagedCollapsedTableRecordInput {
  sourceRevision: typeof PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION;
  printEpoch: PagedCollapsedPrintEpoch;
  pages: PagedCollapsedPageRecord[];
}

export interface AuthenticatedPagedCollapsedTableRecord
  extends PagedCollapsedTableRecordInput {
  schemaVersion: typeof PAGED_COLLAPSED_TABLE_RECORD_VERSION;
  status: "authenticated";
  provenance: {
    ownership: "Blink-private-paginated-physical-fragment-tree";
    canonicalization: "Blink-LayoutUnit-1/64-css-px";
    pdfRole: "downstream-integration-evidence-only";
    sourceFiles: readonly [
      typeof PAGED_COLLAPSED_TABLE_SOURCE_PINS.paginatedRoot,
      typeof PAGED_COLLAPSED_TABLE_SOURCE_PINS.sectionRows,
      typeof PAGED_COLLAPSED_TABLE_SOURCE_PINS.repeatedSections,
      typeof PAGED_COLLAPSED_TABLE_SOURCE_PINS.collapsedPaint,
    ];
  };
}

export interface UnavailablePagedCollapsedTableRecord {
  schemaVersion: typeof PAGED_COLLAPSED_TABLE_RECORD_VERSION;
  status: "unavailable";
  sourceRevision: typeof PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION;
  reason: string;
  missingFacts: RequiredPagedCollapsedTableFact[];
  provenance: {
    publicProtocol: "Page.printToPDF-pdf-bytes-or-stream-only";
    screenCssomMayNotSubstitute: true;
    pdfVectorOrRasterMayNotSubstitute: true;
  };
}

export type PagedCollapsedTableRecord =
  | AuthenticatedPagedCollapsedTableRecord
  | UnavailablePagedCollapsedTableRecord;

const LAYOUT_UNIT_SCALE = 64;

function canonicalLayoutUnit(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const canonical = Math.round(value * LAYOUT_UNIT_SCALE) / LAYOUT_UNIT_SCALE;
  return Object.is(canonical, -0) ? 0 : canonical;
}

function expectedProgression(
  writingMode: PagedCollapsedTableWritingMode,
): { axis: PagedCollapsedPhysicalAxis; progression: PagedCollapsedProgression } {
  if (writingMode === "horizontal-tb") {
    return { axis: "physical-y", progression: "positive" };
  }
  if (writingMode === "vertical-rl" || writingMode === "sideways-rl") {
    return { axis: "physical-x", progression: "negative" };
  }
  return { axis: "physical-x", progression: "positive" };
}

function isOmittedEdge(edge: PagedCollapsedEdgeDecision): boolean {
  return edge.disposition.startsWith("omit-") || edge.disposition.startsWith("skip-");
}

function hasExactJointPrecedence(joint: PagedCollapsedJointDecision): boolean {
  return joint.precedence.length === PAGED_COLLAPSED_JOINT_PRECEDENCE.length
    && joint.precedence.every((value, index) => value === PAGED_COLLAPSED_JOINT_PRECEDENCE[index]);
}

function hasCompleteRepeatEligibility(
  eligibility: PagedCollapsedRepeatEligibility,
): boolean {
  return Object.values(eligibility).every((value) => value === true);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validateBreakState(
  state: PagedCollapsedPrintBreakState,
  span: PagedCollapsedGlobalRowSpan,
  edge: "start" | "end",
  errors: string[],
): void {
  if (state.kind === "none") {
    if (state.globalRowIndex != null) errors.push(`${edge} no-break state carries a row index`);
    return;
  }
  if (!Number.isInteger(state.globalRowIndex)) {
    errors.push(`${edge} break state lacks a global row index`);
    return;
  }
  if (state.kind === "continued-row") {
    const expected = edge === "start" ? span.start : span.endExclusive - 1;
    if (state.globalRowIndex !== expected) errors.push(`${edge} continued-row index disagrees with the section span`);
  } else {
    const expected = edge === "start" ? span.start : span.endExclusive;
    if (state.globalRowIndex !== expected) errors.push(`${edge} whole-row index disagrees with the section span`);
  }
}

/** Validate a fully private, source-owned print-fragment record. */
export function validateAuthenticatedPagedCollapsedTableRecord(
  record: AuthenticatedPagedCollapsedTableRecord,
): string[] {
  const errors: string[] = [];
  if (record.schemaVersion !== PAGED_COLLAPSED_TABLE_RECORD_VERSION) errors.push("wrong paged record schema version");
  if (record.sourceRevision !== PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION) errors.push("wrong Chromium source revision");
  if (record.provenance.ownership !== "Blink-private-paginated-physical-fragment-tree"
      || record.provenance.canonicalization !== "Blink-LayoutUnit-1/64-css-px"
      || record.provenance.pdfRole !== "downstream-integration-evidence-only") {
    errors.push("paged record provenance is not the private logical contract");
  }
  const requiredSourceFiles = [
    PAGED_COLLAPSED_TABLE_SOURCE_PINS.paginatedRoot,
    PAGED_COLLAPSED_TABLE_SOURCE_PINS.sectionRows,
    PAGED_COLLAPSED_TABLE_SOURCE_PINS.repeatedSections,
    PAGED_COLLAPSED_TABLE_SOURCE_PINS.collapsedPaint,
  ];
  if (record.provenance.sourceFiles.length !== requiredSourceFiles.length
      || record.provenance.sourceFiles.some((value, index) => value !== requiredSourceFiles[index])) {
    errors.push("paged record source-file provenance changed");
  }
  if (record.printEpoch.lifecycle !== "PrintBegin-to-PrintEnd"
      || record.printEpoch.logicalTransport !== "blink-private-physical-fragment-tree-v1"
      || record.printEpoch.logicalFactsDerivedFromPdfVectorOrRaster !== false
      || record.printEpoch.sourceRestoredExactly !== true) {
    errors.push("print epoch is not the private logical transport contract");
  }
  for (const field of [
    record.printEpoch.epochId,
    record.printEpoch.documentLoaderId,
    record.printEpoch.browserVersion,
    record.printEpoch.protocolVersion,
  ]) {
    if (field.trim() === "") errors.push("print epoch identity is incomplete");
  }
  if (!/^[a-f0-9]{64}$/.test(record.printEpoch.printParametersSha256)) {
    errors.push("print parameter fingerprint is not sha256");
  }
  if (record.pages.length === 0) errors.push("print record has no pages");

  const physicalIds = new Set<string>();
  const occurrencesByTable = new Map<number, PagedCollapsedTableOccurrence[]>();
  const sectionOccurrenceIndices = new Map<string, number[]>();
  const captionOccurrenceIndices = new Map<string, number[]>();
  for (let pageIndex = 0; pageIndex < record.pages.length; pageIndex++) {
    const page = record.pages[pageIndex];
    if (page.pageIndex !== pageIndex) errors.push("page indices are not consecutive");
    if (page.emptyKind === "terminal-empty" && pageIndex !== record.pages.length - 1) {
      errors.push("terminal empty page is not terminal");
    }
    if (page.emptyKind !== "none" && page.tableOccurrences.length !== 0) {
      errors.push("empty page carries table occurrences");
    }
    for (const table of page.tableOccurrences) {
      if (!Number.isInteger(table.tableSourceIndex) || table.tableSourceIndex < 0) {
        errors.push("invalid table source index");
      }
      if (!Number.isInteger(table.occurrenceIndex) || table.occurrenceIndex < 0) {
        errors.push("invalid table occurrence index");
      }
      if (table.physicalTableFragmentId === "") errors.push("empty physical table fragment identity");
      if (table.pageIndex !== pageIndex) errors.push("table occurrence belongs to the wrong page");
      if (physicalIds.has(table.physicalTableFragmentId)) errors.push("duplicate physical table fragment identity");
      physicalIds.add(table.physicalTableFragmentId);
      const tableOccurrences = occurrencesByTable.get(table.tableSourceIndex) ?? [];
      tableOccurrences.push(table);
      occurrencesByTable.set(table.tableSourceIndex, tableOccurrences);

      const expected = expectedProgression(table.writingMode);
      if (table.fragmentationAxis !== expected.axis || table.progression !== expected.progression) {
        errors.push("table page progression disagrees with its writing mode");
      }
      if (!Number.isInteger(table.totalRows) || table.totalRows < 0
          || !Number.isInteger(table.totalColumns) || table.totalColumns <= 0) {
        errors.push("invalid paged table dimensions");
      }
      if (table.globalColumnOffsets.length !== table.totalColumns + 1) {
        errors.push("incomplete paged global column offsets");
      }
      for (let index = 0; index < table.globalColumnOffsets.length; index++) {
        const source = table.globalColumnOffsets[index];
        const current = canonicalLayoutUnit(source);
        if (!Number.isFinite(source)) errors.push("non-finite paged global column offset");
        else if (current !== source) errors.push("paged global column offset is not a Blink LayoutUnit");
        const previous = index > 0
          ? canonicalLayoutUnit(table.globalColumnOffsets[index - 1])
          : null;
        if (previous != null && !(current > previous)) {
          errors.push("paged global column offsets are not strictly increasing");
        }
      }

      const tableChildSlots = new Set<number>();
      const sectionSources = new Set<number>();
      let previousSectionSlot = -1;
      for (const section of table.sectionOccurrences) {
        if (section.physicalSectionFragmentId === "") errors.push("empty physical section fragment identity");
        if (!Number.isInteger(section.sectionSourceIndex) || section.sectionSourceIndex < 0
            || !Number.isInteger(section.occurrenceIndex) || section.occurrenceIndex < 0) {
          errors.push("invalid section source or occurrence index");
        }
        const sectionKey = `${table.tableSourceIndex}:${section.sectionSourceIndex}`;
        const sectionIndices = sectionOccurrenceIndices.get(sectionKey) ?? [];
        sectionIndices.push(section.occurrenceIndex);
        sectionOccurrenceIndices.set(sectionKey, sectionIndices);
        if (sectionSources.has(section.sectionSourceIndex)) {
          errors.push("duplicate section source in one table occurrence");
        }
        sectionSources.add(section.sectionSourceIndex);
        if (physicalIds.has(section.physicalSectionFragmentId)) errors.push("duplicate physical section fragment identity");
        physicalIds.add(section.physicalSectionFragmentId);
        if (!Number.isInteger(section.sectionPaintSlot) || section.sectionPaintSlot < 0
            || !Number.isInteger(section.tableChildPaintSlot) || section.tableChildPaintSlot < 0) {
          errors.push("invalid section paint slot");
        }
        if (section.sectionPaintSlot !== previousSectionSlot + 1) errors.push("section paint slots are not consecutive");
        previousSectionSlot = section.sectionPaintSlot;
        if (tableChildSlots.has(section.tableChildPaintSlot)) errors.push("duplicate table-child paint slot");
        tableChildSlots.add(section.tableChildPaintSlot);
        if (!Number.isInteger(section.globalRows.start)
            || !Number.isInteger(section.globalRows.endExclusive)
            || section.globalRows.start < 0
            || section.globalRows.endExclusive < section.globalRows.start
            || section.globalRows.endExclusive > table.totalRows) {
          errors.push("invalid section global row span");
        }
        if (section.logicalRowOffsets.length !== section.globalRows.endExclusive - section.globalRows.start + 1) {
          errors.push("section row-offset count disagrees with its global row span");
        }
        for (let index = 0; index < section.logicalRowOffsets.length; index++) {
          const source = section.logicalRowOffsets[index];
          const current = canonicalLayoutUnit(source);
          if (!Number.isFinite(source)) errors.push("non-finite section logical row offset");
          else if (current !== source) errors.push("section row offset is not a Blink LayoutUnit");
          const previous = index > 0
            ? canonicalLayoutUnit(section.logicalRowOffsets[index - 1])
            : null;
          if (previous != null && !(current > previous)) {
            errors.push("section logical row offsets are not strictly increasing");
          }
        }
        validateBreakState(section.startBreak, section.globalRows, "start", errors);
        validateBreakState(section.endBreak, section.globalRows, "end", errors);
        const repeatedHeader = section.repeatRole === "repeated-header";
        const repeatedFooter = section.repeatRole === "repeated-footer";
        const header = section.repeatRole === "original-header" || repeatedHeader;
        const footer = section.repeatRole === "original-footer" || repeatedFooter;
        if (header !== (section.sectionTag === "thead")
            || footer !== (section.sectionTag === "tfoot")
            || (section.repeatRole === "body") !== (section.sectionTag === "tbody")) {
          errors.push("section repeat role disagrees with its source tag");
        }
        if ((repeatedHeader || repeatedFooter) && section.repeatEligibility == null) {
          errors.push("repeated occurrence eligibility facts are missing");
        }
        if (section.repeatEligibility != null
            && !hasCompleteRepeatEligibility(section.repeatEligibility)) {
          errors.push("repeated occurrence eligibility facts are not source-complete");
        }
        if (section.sectionTag === "tbody" && section.repeatEligibility != null) {
          errors.push("body section carries repeat eligibility");
        }
        if (section.reservedCollapsedEdgeSpace.blockStart < 0
            || section.reservedCollapsedEdgeSpace.blockEnd < 0) {
          errors.push("negative reserved collapsed-border edge space");
        }
        for (const value of [
          section.reservedCollapsedEdgeSpace.blockStart,
          section.reservedCollapsedEdgeSpace.blockEnd,
        ]) {
          if (!Number.isFinite(value) || canonicalLayoutUnit(value) !== value) {
            errors.push("reserved collapsed-border edge space is not a Blink LayoutUnit");
          }
        }
      }
      for (const caption of table.captionOccurrences) {
        if (caption.physicalCaptionFragmentId === "") errors.push("empty physical caption fragment identity");
        if (!Number.isInteger(caption.captionSourceIndex) || caption.captionSourceIndex < 0
            || !Number.isInteger(caption.occurrenceIndex) || caption.occurrenceIndex < 0) {
          errors.push("invalid caption source or occurrence index");
        }
        const captionKey = `${table.tableSourceIndex}:${caption.captionSourceIndex}`;
        const captionIndices = captionOccurrenceIndices.get(captionKey) ?? [];
        captionIndices.push(caption.occurrenceIndex);
        captionOccurrenceIndices.set(captionKey, captionIndices);
        if (physicalIds.has(caption.physicalCaptionFragmentId)) errors.push("duplicate physical caption fragment identity");
        physicalIds.add(caption.physicalCaptionFragmentId);
        if (!Number.isInteger(caption.tableChildPaintSlot) || caption.tableChildPaintSlot < 0) {
          errors.push("invalid caption paint slot");
        }
        if (tableChildSlots.has(caption.tableChildPaintSlot)) errors.push("duplicate table-child paint slot");
        tableChildSlots.add(caption.tableChildPaintSlot);
      }
      const orderedTableChildSlots = [...tableChildSlots].sort((left, right) => left - right);
      if (orderedTableChildSlots.some((value, index) => value !== index)) {
        errors.push("table-child paint slots are not consecutive");
      }

      const spanInteriorEdges = new Set<number>();
      for (const span of table.spanningCells) {
        if (!Number.isInteger(span.cellSourceIndex) || span.cellSourceIndex < 0
            || !Number.isInteger(span.globalRows.start)
            || !Number.isInteger(span.globalRows.endExclusive)
            || !Number.isInteger(span.globalColumnStart)
            || !Number.isInteger(span.globalColumnEndExclusive)
            || span.globalRows.start < 0 || span.globalRows.endExclusive > table.totalRows
            || span.globalRows.endExclusive <= span.globalRows.start
            || span.globalColumnStart < 0
            || span.globalColumnEndExclusive > table.totalColumns
            || span.globalColumnEndExclusive <= span.globalColumnStart) {
          errors.push("invalid spanning-cell ownership");
        }
        for (const edgeIndex of span.interiorCollapsedEdgeIndices) {
          if (!Number.isInteger(edgeIndex) || edgeIndex < 0) {
            errors.push("invalid spanning-cell interior edge index");
          }
          if (spanInteriorEdges.has(edgeIndex)) {
            errors.push("duplicate spanning-cell interior edge ownership");
          }
          spanInteriorEdges.add(edgeIndex);
        }
      }

      let nextPaintOrder = 0;
      const observedEdgeIndices = new Set<number>();
      if (table.totalRows > 0 && table.collapsedEdges.length === 0) {
        errors.push("non-empty collapsed table has no edge decisions");
      }
      for (let decisionOrder = 0; decisionOrder < table.collapsedEdges.length; decisionOrder++) {
        const edge = table.collapsedEdges[decisionOrder];
        if (!Number.isInteger(edge.sourceEdgeIndex) || edge.sourceEdgeIndex < 0) {
          errors.push("invalid collapsed source edge index");
        }
        if (observedEdgeIndices.has(edge.sourceEdgeIndex)) errors.push("duplicate collapsed source edge decision");
        observedEdgeIndices.add(edge.sourceEdgeIndex);
        if (edge.decisionOrder !== decisionOrder) errors.push("collapsed-edge decision order changed");
        if (!hasExactJointPrecedence(edge.startJoint) || !hasExactJointPrecedence(edge.endJoint)) {
          errors.push("collapsed-joint precedence changed");
        }
        const omitted = isOmittedEdge(edge);
        if (omitted && edge.paintOrder != null) errors.push("omitted collapsed edge has a paint order");
        if (!omitted) {
          if (edge.paintOrder !== nextPaintOrder) errors.push("collapsed-edge paint order changed");
          nextPaintOrder++;
        }
        if (spanInteriorEdges.has(edge.sourceEdgeIndex)
            && edge.disposition !== "skip-span-interior") {
          errors.push("spanning-cell interior edge was not suppressed");
        }
        const matchingBreak = (side: "start" | "end", kind: "whole-row" | "continued-row") =>
          table.sectionOccurrences.some((section) => {
            const state = side === "start" ? section.startBreak : section.endBreak;
            return state.kind === kind && state.globalRowIndex === edge.globalRowBoundary;
          });
        if (edge.disposition === "paint-half-at-whole-row-start"
            && (!matchingBreak("start", "whole-row") || edge.axis !== "inline")) {
          errors.push("whole-row start half-edge lacks its source break");
        }
        if (edge.disposition === "paint-half-at-whole-row-end"
            && (!matchingBreak("end", "whole-row") || edge.axis !== "inline")) {
          errors.push("whole-row end half-edge lacks its source break");
        }
        if (edge.disposition === "omit-at-continued-row-start"
            && (!matchingBreak("start", "continued-row") || edge.axis !== "inline")) {
          errors.push("continued-row start omission lacks its source break");
        }
        if (edge.disposition === "omit-at-continued-row-end"
            && (!matchingBreak("end", "continued-row") || edge.axis !== "inline")) {
          errors.push("continued-row end omission lacks its source break");
        }
        if (edge.globalRowBoundary < 0 || edge.globalRowBoundary > table.totalRows
            || edge.globalColumnBoundary < 0 || edge.globalColumnBoundary > table.totalColumns) {
          errors.push("collapsed edge lies outside the global table graph");
        }
      }
      for (const edgeIndex of spanInteriorEdges) {
        if (!table.collapsedEdges.some((edge) =>
          edge.sourceEdgeIndex === edgeIndex && edge.disposition === "skip-span-interior")) {
          errors.push("spanning-cell interior edge lacks an explicit suppression decision");
        }
      }
    }
  }

  for (const tableOccurrences of occurrencesByTable.values()) {
    tableOccurrences.sort((left, right) => left.occurrenceIndex - right.occurrenceIndex);
    for (let index = 0; index < tableOccurrences.length; index++) {
      const occurrence = tableOccurrences[index];
      if (occurrence.occurrenceIndex !== index) errors.push("table occurrence indices are not consecutive");
      if (occurrence.firstTableBox !== (index === 0)) errors.push("first-table-box state disagrees with occurrence order");
      if (occurrence.lastTableBox !== (index === tableOccurrences.length - 1)) {
        errors.push("last-table-box state disagrees with occurrence order");
      }
      if (index > 0) {
        const previous = tableOccurrences[index - 1];
        if (occurrence.pageIndex < previous.pageIndex) {
          errors.push("table occurrence order moves backwards across pages");
        }
        if (occurrence.totalRows !== previous.totalRows
            || occurrence.totalColumns !== previous.totalColumns
            || occurrence.writingMode !== previous.writingMode
            || occurrence.direction !== previous.direction
            || occurrence.fragmentationAxis !== previous.fragmentationAxis
            || occurrence.progression !== previous.progression
            || !sameNumbers(occurrence.globalColumnOffsets, previous.globalColumnOffsets)) {
          errors.push("table-global facts changed across physical occurrences");
        }
        const previousBreaks = previous.sectionOccurrences
          .map((section) => section.endBreak)
          .filter((state) => state.kind !== "none");
        const currentBreaks = occurrence.sectionOccurrences
          .map((section) => section.startBreak)
          .filter((state) => state.kind !== "none");
        if ((previousBreaks.length > 0 || currentBreaks.length > 0)
            && (previousBreaks.length !== 1 || currentBreaks.length !== 1
              || previousBreaks[0].kind !== currentBreaks[0].kind
              || previousBreaks[0].globalRowIndex !== currentBreaks[0].globalRowIndex)) {
          errors.push("row-break seam disagrees across table occurrences");
        }
      }
    }
  }
  for (const [kind, occurrenceMap] of [
    ["section", sectionOccurrenceIndices],
    ["caption", captionOccurrenceIndices],
  ] as const) {
    for (const indices of occurrenceMap.values()) {
      const ordered = [...indices].sort((left, right) => left - right);
      if (new Set(ordered).size !== ordered.length
          || ordered.some((value, index) => value !== index)) {
        errors.push(`${kind} occurrence indices are not unique and consecutive`);
      }
    }
  }
  return [...new Set(errors)];
}

export function unavailablePagedCollapsedTableRecord(
  reason: string,
  missingFacts: readonly RequiredPagedCollapsedTableFact[] = REQUIRED_PAGED_COLLAPSED_TABLE_FACTS,
): UnavailablePagedCollapsedTableRecord {
  return {
    schemaVersion: PAGED_COLLAPSED_TABLE_RECORD_VERSION,
    status: "unavailable",
    sourceRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
    reason,
    missingFacts: [...missingFacts],
    provenance: {
      publicProtocol: "Page.printToPDF-pdf-bytes-or-stream-only",
      screenCssomMayNotSubstitute: true,
      pdfVectorOrRasterMayNotSubstitute: true,
    },
  };
}

/**
 * Promote only a complete private Blink fragment record. The public protocol
 * producer calls `unavailablePagedCollapsedTableRecord()` instead.
 */
export function buildPagedCollapsedTableRecord(
  input: PagedCollapsedTableRecordInput,
): PagedCollapsedTableRecord {
  const record: AuthenticatedPagedCollapsedTableRecord = {
    schemaVersion: PAGED_COLLAPSED_TABLE_RECORD_VERSION,
    status: "authenticated",
    ...input,
    provenance: {
      ownership: "Blink-private-paginated-physical-fragment-tree",
      canonicalization: "Blink-LayoutUnit-1/64-css-px",
      pdfRole: "downstream-integration-evidence-only",
      sourceFiles: [
        PAGED_COLLAPSED_TABLE_SOURCE_PINS.paginatedRoot,
        PAGED_COLLAPSED_TABLE_SOURCE_PINS.sectionRows,
        PAGED_COLLAPSED_TABLE_SOURCE_PINS.repeatedSections,
        PAGED_COLLAPSED_TABLE_SOURCE_PINS.collapsedPaint,
      ],
    },
  };
  const errors = validateAuthenticatedPagedCollapsedTableRecord(record);
  return errors.length === 0
    ? record
    : unavailablePagedCollapsedTableRecord(errors.join("; "));
}
