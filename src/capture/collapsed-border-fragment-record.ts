/**
 * Source-authenticated physical section-fragment records for fragmented
 * collapsed tables.
 *
 * Blink 7d859f271c stores `actual_start_row_index` plus exact row offsets on
 * every physical section fragment before TablePainter consumes them.  Public
 * CSSOM does not expose those private fields directly, so this module accepts
 * two independent views of the same neutral layout epoch (`getClientRects`
 * and CDP `DOM.getContentQuads`) and reconstructs a private-equivalent record
 * only when their ordered LayoutUnit-canonical geometry agrees exactly.
 */

export const COLLAPSED_BORDER_FRAGMENT_RECORD_VERSION = 2 as const;
export const COLLAPSED_BORDER_FRAGMENT_CHROMIUM_REVISION =
  "7d859f271cbda744098ac69f44978d4edfa62be3" as const;

export type CollapsedBorderFragmentWritingMode =
  | "horizontal-tb"
  | "vertical-rl"
  | "vertical-lr"
  | "sideways-rl"
  | "sideways-lr";
export type CollapsedBorderFragmentDirection = "ltr" | "rtl";

export interface CollapsedBorderPhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CollapsedBorderFragmentGeometryEvidence {
  cssomRects: CollapsedBorderPhysicalRect[];
  cdpQuads: number[][];
}

export interface CollapsedBorderSectionSourceEvidence {
  sourceIndex: number;
  tableChildIndex: number;
  tag: "thead" | "tbody" | "tfoot";
  globalStartRowIndex: number;
  globalRowCount: number;
  geometry: CollapsedBorderFragmentGeometryEvidence;
}

export interface CollapsedBorderRowSourceEvidence {
  sourceIndex: number;
  sectionSourceIndex: number;
  globalRowIndex: number;
  geometry: CollapsedBorderFragmentGeometryEvidence;
}

export interface CollapsedBorderCellSourceEvidence {
  sourceIndex: number;
  globalRowIndex: number;
  globalColumnIndex: number;
  rowSpan: number;
  columnSpan: number;
  geometry: CollapsedBorderFragmentGeometryEvidence;
}

export interface CollapsedBorderCaptionSourceEvidence {
  sourceIndex: number;
  tableChildIndex: number;
  geometry: CollapsedBorderFragmentGeometryEvidence;
}

export type CollapsedBorderRepeatKind = "header" | "footer";

/**
 * Inputs to Blink's repeat decision, transcribed from
 * `table_layout_algorithm.cc:1076-1151`. An authenticated occurrence record
 * requires every boolean to remain true; a false value is a fail-closed
 * negative, never a reason to synthesize a clone.
 */
export interface CollapsedBorderRepeatEligibilityEvidence {
  fragmentationType: "column";
  fragmentainerBlockSize: number;
  sectionBlockSize: number;
  knownFragmentainerBlockSize: boolean;
  atMostQuarterFragmentainer: boolean;
  applicableBreakInsideAvoid: boolean;
  noBreakInside: boolean;
  noLateStart: boolean;
  outsideNestedRepeatableContent: boolean;
  layoutSideEffectsEnabled: boolean;
}

/** One distinct physical occurrence authenticated by source-node hit tests. */
export interface CollapsedBorderRepeatOccurrenceEvidence {
  occurrenceIndex: number;
  fragmentIndex: number;
  physicalRect: CollapsedBorderPhysicalRect;
  expectedCellSourceIndices: number[];
  witnessedCellSourceIndices: number[];
  hitTest: "Document.elementsFromPoint-intrinsic-source-cell-membership";
}

export interface CollapsedBorderRepeatSectionEvidence {
  sectionSourceIndex: number;
  repeatKind: CollapsedBorderRepeatKind;
  eligibility: CollapsedBorderRepeatEligibilityEvidence;
  occurrences: CollapsedBorderRepeatOccurrenceEvidence[];
}

export interface CollapsedBorderFragmentRecordInput {
  writingMode: CollapsedBorderFragmentWritingMode;
  direction: CollapsedBorderFragmentDirection;
  totalRows: number;
  totalColumns: number;
  table: CollapsedBorderFragmentGeometryEvidence;
  sections: CollapsedBorderSectionSourceEvidence[];
  rows: CollapsedBorderRowSourceEvidence[];
  cells: CollapsedBorderCellSourceEvidence[];
  captions: CollapsedBorderCaptionSourceEvidence[];
  repeatSections?: CollapsedBorderRepeatSectionEvidence[];
  sourceRestoredExactly: boolean;
}

export type CollapsedBorderSectionRepeatRole =
  | "non-repeated"
  | "original-header"
  | "repeated-header"
  | "original-footer"
  | "repeated-footer";

export interface CollapsedBorderReservedEdgeSpace {
  side: "block-start" | "block-end";
  amount: number;
  globalRowEdgeIndex: number;
  tableEdgeIncludedInThisFragment: boolean;
}

export interface CollapsedBorderSectionFragmentRecord {
  fragmentIndex: number;
  physicalSectionFragmentId: string;
  sectionSourceIndex: number;
  sectionTableChildIndex: number;
  sectionTag: "thead" | "tbody" | "tfoot";
  sectionPaintSlot: number;
  tableChildPaintSlot: number;
  globalStartRowIndex: number;
  logicalRowOffsets: number[];
  hasContentBefore: boolean;
  hasContentAfter: boolean;
  startContinuedRow: boolean;
  endContinuedRow: boolean;
  firstGlobalRowIndex: number;
  lastGlobalRowIndex: number;
  physicalRect: CollapsedBorderPhysicalRect;
  repeatRole: CollapsedBorderSectionRepeatRole;
  repeatOccurrenceIndex: number | null;
  firstTableBox: boolean;
  lastTableBox: boolean;
  repeatEligibility: CollapsedBorderRepeatEligibilityEvidence | null;
  reservedCollapsedEdgeSpace: CollapsedBorderReservedEdgeSpace | null;
  occurrenceOwnership:
    | "ordered-neutral-cssom-cdp"
    | "source-clone-plus-per-fragment-hit-test";
}

export interface CollapsedBorderPhysicalTableFragmentRecord {
  fragmentIndex: number;
  physicalTableFragmentId: string;
  physicalRect: CollapsedBorderPhysicalRect;
  tableBoxState:
    | "caption-only-before-table-box"
    | "only-table-box"
    | "first-table-box"
    | "middle-table-box"
    | "last-table-box"
    | "empty-after-table-box";
  sectionFragments: CollapsedBorderSectionFragmentRecord[];
  captionPaintSlots: Array<{
    captionSourceIndex: number;
    captionTableChildIndex: number;
    tableChildPaintSlot: number;
  }>;
}

export interface AuthenticatedCollapsedBorderFragmentRecord {
  schemaVersion: typeof COLLAPSED_BORDER_FRAGMENT_RECORD_VERSION;
  status: "authenticated";
  sourceRevision: typeof COLLAPSED_BORDER_FRAGMENT_CHROMIUM_REVISION;
  writingMode: CollapsedBorderFragmentWritingMode;
  direction: CollapsedBorderFragmentDirection;
  totalRows: number;
  totalColumns: number;
  globalColumnOffsets: number[];
  tableFragments: CollapsedBorderPhysicalTableFragmentRecord[];
  provenance: {
    plane: "all-css-transforms-neutralized";
    cssom: "Element.getClientRects";
    protocol: "DOM.getContentQuads";
    canonicalization: "Blink-LayoutUnit-1/64-css-px";
    correlation: "ordered-exact-rect-set";
    repeatOccurrence: "prototype-deep-clone-plus-intrinsic-source-cell-hit-test";
    sourceRestoredExactly: true;
    sourceFiles: readonly [
      "third_party/blink/renderer/core/layout/table/table_layout_algorithm_types.cc:297-326",
      "third_party/blink/renderer/core/layout/table/table_layout_algorithm.cc:1076-1151",
      "third_party/blink/renderer/core/layout/block_node.cc:722-796",
      "third_party/blink/renderer/core/layout/fragment_repeater.cc:117-205",
      "third_party/blink/renderer/core/paint/pre_paint_tree_walk.cc:1290-1348",
      "third_party/blink/renderer/core/layout/table/table_section_layout_algorithm.cc:47-164",
      "third_party/blink/renderer/core/paint/table_painters.cc:490-727",
    ];
  };
  consumedBy?: "collapsed-border-fragment-logical-rects-v1";
}

export interface UnavailableCollapsedBorderFragmentRecord {
  schemaVersion: typeof COLLAPSED_BORDER_FRAGMENT_RECORD_VERSION;
  status: "unavailable";
  sourceRevision: typeof COLLAPSED_BORDER_FRAGMENT_CHROMIUM_REVISION;
  reason: string;
}

export type CollapsedBorderFragmentRecord =
  | AuthenticatedCollapsedBorderFragmentRecord
  | UnavailableCollapsedBorderFragmentRecord;

const LAYOUT_UNIT_SCALE = 64;

/** Canonical Blink LayoutUnit serialization, not a fitted visual tolerance. */
export function canonicalCollapsedBorderLayoutUnit(value: number): number {
  if (!Number.isFinite(value)) throw new Error("non-finite fragment coordinate");
  const canonical = Math.round(value * LAYOUT_UNIT_SCALE) / LAYOUT_UNIT_SCALE;
  return Object.is(canonical, -0) ? 0 : canonical;
}

function canonicalRect(rect: CollapsedBorderPhysicalRect): CollapsedBorderPhysicalRect {
  const x = canonicalCollapsedBorderLayoutUnit(rect.x);
  const y = canonicalCollapsedBorderLayoutUnit(rect.y);
  const right = canonicalCollapsedBorderLayoutUnit(rect.x + rect.width);
  const bottom = canonicalCollapsedBorderLayoutUnit(rect.y + rect.height);
  if (!(right > x) || !(bottom > y)) throw new Error("empty physical fragment rectangle");
  return { x, y, width: right - x, height: bottom - y };
}

function rectToken(rect: CollapsedBorderPhysicalRect): string {
  return `${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
}

function quadRect(values: readonly number[]): CollapsedBorderPhysicalRect {
  if (values.length !== 8) throw new Error("CDP fragment quad does not have four points");
  const q = values.map(canonicalCollapsedBorderLayoutUnit);
  if (q[1] !== q[3] || q[2] !== q[4] || q[5] !== q[7] || q[6] !== q[0]) {
    throw new Error("CDP fragment quad is not axis-aligned in the neutral plane");
  }
  return canonicalRect({ x: q[0], y: q[1], width: q[2] - q[0], height: q[5] - q[1] });
}

/** Require ordered CSSOM and protocol fragment sets to agree exactly. */
export function authenticateCollapsedBorderGeometry(
  evidence: CollapsedBorderFragmentGeometryEvidence,
): CollapsedBorderPhysicalRect[] {
  const cssom = evidence.cssomRects.map(canonicalRect);
  const protocol = evidence.cdpQuads.map(quadRect);
  if (cssom.length !== protocol.length) {
    throw new Error(`CSSOM/CDP fragment count mismatch (${cssom.length} != ${protocol.length})`);
  }
  for (let index = 0; index < cssom.length; index++) {
    if (rectToken(cssom[index]) !== rectToken(protocol[index])) {
      throw new Error(`CSSOM/CDP fragment ${index} differs after LayoutUnit canonicalization`);
    }
  }
  return cssom;
}

function overlapArea(left: CollapsedBorderPhysicalRect, right: CollapsedBorderPhysicalRect): number {
  return Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
    * Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
}

function fragmentIndexFor(
  rect: CollapsedBorderPhysicalRect,
  fragments: readonly CollapsedBorderPhysicalRect[],
): number {
  let best = -1;
  let bestArea = 0;
  let tied = false;
  for (let index = 0; index < fragments.length; index++) {
    const area = overlapArea(rect, fragments[index]);
    if (area > bestArea) {
      best = index;
      bestArea = area;
      tied = false;
    } else if (area > 0 && area === bestArea) {
      tied = true;
    }
  }
  if (best < 0 || bestArea <= 0 || tied) throw new Error("fragment cannot be assigned to one physical table fragment");
  return best;
}

function logicalRect(
  rect: CollapsedBorderPhysicalRect,
  tableFragment: CollapsedBorderPhysicalRect,
  writingMode: CollapsedBorderFragmentWritingMode,
  direction: CollapsedBorderFragmentDirection,
): { inlineStart: number; inlineEnd: number; blockStart: number; blockEnd: number } {
  const horizontal = writingMode === "horizontal-tb";
  const inlineReverse = direction === "rtl";
  const blockReverse = writingMode === "vertical-rl" || writingMode === "sideways-rl";
  const rectRight = rect.x + rect.width;
  const rectBottom = rect.y + rect.height;
  const fragmentRight = tableFragment.x + tableFragment.width;
  const fragmentBottom = tableFragment.y + tableFragment.height;
  return {
    inlineStart: canonicalCollapsedBorderLayoutUnit(horizontal
      ? (inlineReverse ? fragmentRight - rectRight : rect.x - tableFragment.x)
      : (inlineReverse ? fragmentBottom - rectBottom : rect.y - tableFragment.y)),
    inlineEnd: canonicalCollapsedBorderLayoutUnit(horizontal
      ? (inlineReverse ? fragmentRight - rect.x : rectRight - tableFragment.x)
      : (inlineReverse ? fragmentBottom - rect.y : rectBottom - tableFragment.y)),
    blockStart: canonicalCollapsedBorderLayoutUnit(horizontal
      ? rect.y - tableFragment.y
      : (blockReverse ? fragmentRight - rectRight : rect.x - tableFragment.x)),
    blockEnd: canonicalCollapsedBorderLayoutUnit(horizontal
      ? rectBottom - tableFragment.y
      : (blockReverse ? fragmentRight - rect.x : rectRight - tableFragment.x)),
  };
}

interface MappedPiece {
  fragmentIndex: number;
  rect: CollapsedBorderPhysicalRect;
  pieceIndex: number;
}

interface SectionOccurrence {
  fragmentIndex: number;
  rect: CollapsedBorderPhysicalRect;
  repeat: CollapsedBorderRepeatSectionEvidence | null;
  occurrenceIndex: number | null;
}

function mappedPieces(
  evidence: CollapsedBorderFragmentGeometryEvidence,
  tableFragments: readonly CollapsedBorderPhysicalRect[],
): MappedPiece[] {
  return authenticateCollapsedBorderGeometry(evidence).map((rect, pieceIndex) => ({
    rect,
    pieceIndex,
    fragmentIndex: fragmentIndexFor(rect, tableFragments),
  }));
}

function unavailable(reason: string): UnavailableCollapsedBorderFragmentRecord {
  return {
    schemaVersion: COLLAPSED_BORDER_FRAGMENT_RECORD_VERSION,
    status: "unavailable",
    sourceRevision: COLLAPSED_BORDER_FRAGMENT_CHROMIUM_REVISION,
    reason,
  };
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function blockSize(
  rect: CollapsedBorderPhysicalRect,
  writingMode: CollapsedBorderFragmentWritingMode,
): number {
  return writingMode === "horizontal-tb" ? rect.height : rect.width;
}

function physicalRectFromLogical(
  logical: { inlineStart: number; inlineEnd: number; blockStart: number; blockEnd: number },
  owner: CollapsedBorderPhysicalRect,
  writingMode: CollapsedBorderFragmentWritingMode,
  direction: CollapsedBorderFragmentDirection,
): CollapsedBorderPhysicalRect {
  const horizontal = writingMode === "horizontal-tb";
  const inlineReverse = direction === "rtl";
  const blockReverse = writingMode === "vertical-rl" || writingMode === "sideways-rl";
  if (horizontal) {
    return canonicalRect({
      x: inlineReverse ? owner.x + owner.width - logical.inlineEnd : owner.x + logical.inlineStart,
      y: owner.y + logical.blockStart,
      width: logical.inlineEnd - logical.inlineStart,
      height: logical.blockEnd - logical.blockStart,
    });
  }
  return canonicalRect({
    x: blockReverse ? owner.x + owner.width - logical.blockEnd : owner.x + logical.blockStart,
    y: inlineReverse ? owner.y + owner.height - logical.inlineEnd : owner.y + logical.inlineStart,
    width: logical.blockEnd - logical.blockStart,
    height: logical.inlineEnd - logical.inlineStart,
  });
}

function cloneIntoOccurrence(
  rect: CollapsedBorderPhysicalRect,
  sourceSection: CollapsedBorderPhysicalRect,
  occurrence: CollapsedBorderPhysicalRect,
  writingMode: CollapsedBorderFragmentWritingMode,
  direction: CollapsedBorderFragmentDirection,
): CollapsedBorderPhysicalRect {
  return physicalRectFromLogical(
    logicalRect(rect, sourceSection, writingMode, direction),
    occurrence,
    writingMode,
    direction,
  );
}

function expectedRepeatOccurrenceRect(
  prototype: CollapsedBorderPhysicalRect,
  prototypeTable: CollapsedBorderPhysicalRect,
  targetTable: CollapsedBorderPhysicalRect,
  kind: CollapsedBorderRepeatKind,
  writingMode: CollapsedBorderFragmentWritingMode,
  direction: CollapsedBorderFragmentDirection,
): CollapsedBorderPhysicalRect {
  const logical = logicalRect(prototype, prototypeTable, writingMode, direction);
  const extent = logical.blockEnd - logical.blockStart;
  if (kind === "footer") {
    const endInset = blockSize(prototypeTable, writingMode) - logical.blockEnd;
    logical.blockEnd = blockSize(targetTable, writingMode) - endInset;
    logical.blockStart = logical.blockEnd - extent;
  }
  return physicalRectFromLogical(logical, targetTable, writingMode, direction);
}

function requireRepeatEligibility(evidence: CollapsedBorderRepeatEligibilityEvidence): void {
  if (evidence.fragmentationType !== "column") throw new Error("repeat evidence has the wrong fragmentation type");
  if (!(evidence.fragmentainerBlockSize > 0) || !(evidence.sectionBlockSize > 0)) {
    throw new Error("repeat evidence has an unknown fragmentainer or section block size");
  }
  const arithmeticQuarter = canonicalCollapsedBorderLayoutUnit(evidence.sectionBlockSize * 4)
    <= canonicalCollapsedBorderLayoutUnit(evidence.fragmentainerBlockSize);
  if (evidence.atMostQuarterFragmentainer !== arithmeticQuarter) {
    throw new Error("repeat quarter-fragmentainer evidence disagrees with exact LayoutUnit arithmetic");
  }
  if (!evidence.knownFragmentainerBlockSize
      || !evidence.atMostQuarterFragmentainer
      || !evidence.applicableBreakInsideAvoid
      || !evidence.noBreakInside
      || !evidence.noLateStart
      || !evidence.outsideNestedRepeatableContent
      || !evidence.layoutSideEffectsEnabled) {
    throw new Error("repeat source eligibility is not completely authenticated");
  }
}

/**
 * Build the exact record consumed by the fragmented collapsed-border painter.
 * Any ambiguity is an explicit unavailable result; callers must not fall back
 * to CSSOM-only inference.
 */
export function buildCollapsedBorderFragmentRecord(
  input: CollapsedBorderFragmentRecordInput,
): CollapsedBorderFragmentRecord {
  try {
    if (!input.sourceRestoredExactly) throw new Error("neutral probe did not restore the source frame exactly");
    if (!Number.isInteger(input.totalRows) || input.totalRows <= 0) throw new Error("invalid global row count");
    if (!Number.isInteger(input.totalColumns) || input.totalColumns <= 0) throw new Error("invalid global column count");
    const tableFragments = authenticateCollapsedBorderGeometry(input.table);
    if (tableFragments.length <= 1) throw new Error("table is not physically fragmented");
    if (new Set(tableFragments.map(rectToken)).size !== tableFragments.length) {
      throw new Error("physical table fragment identities are not unique");
    }

    const sectionBySource = new Map(input.sections.map((section) => [section.sourceIndex, section]));
    if (sectionBySource.size !== input.sections.length) throw new Error("duplicate section source identity");
    const repeatBySection = new Map<number, CollapsedBorderRepeatSectionEvidence>();
    const repeatPrototype = new Map<number, CollapsedBorderPhysicalRect>();
    for (const repeat of input.repeatSections ?? []) {
      const section = sectionBySource.get(repeat.sectionSourceIndex);
      if (section == null) throw new Error(`repeat section ${repeat.sectionSourceIndex} has no source section`);
      if (repeatBySection.has(repeat.sectionSourceIndex)) throw new Error("duplicate repeat source ownership");
      if ([...repeatBySection.values()].some((candidate) => candidate.repeatKind === repeat.repeatKind)) {
        throw new Error(`more than one selected repeat ${repeat.repeatKind}`);
      }
      requireRepeatEligibility(repeat.eligibility);
      const aliases = authenticateCollapsedBorderGeometry(section.geometry);
      if (aliases.length <= 1 || aliases.some((rect) => rectToken(rect) !== rectToken(aliases[0]))) {
        throw new Error(`repeat section ${section.sourceIndex} is not one exact CSSOM/CDP prototype alias set`);
      }
      if (repeat.occurrences.length !== aliases.length) {
        throw new Error(`repeat section ${section.sourceIndex} alias/occurrence count differs (${aliases.length} != ${repeat.occurrences.length}; fragments ${repeat.occurrences.map((occurrence) => occurrence.fragmentIndex).join(",")})`);
      }
      const prototype = aliases[0];
      const prototypeFragmentIndex = fragmentIndexFor(prototype, tableFragments);
      if (canonicalCollapsedBorderLayoutUnit(blockSize(prototype, input.writingMode))
          !== canonicalCollapsedBorderLayoutUnit(repeat.eligibility.sectionBlockSize)) {
        throw new Error(`repeat section ${section.sourceIndex} block size disagrees with its prototype`);
      }
      const expectedCellSources = input.cells
        .filter((cell) => cell.globalRowIndex >= section.globalStartRowIndex
          && cell.globalRowIndex < section.globalStartRowIndex + section.globalRowCount)
        .map((cell) => cell.sourceIndex);
      if (expectedCellSources.length === 0) throw new Error(`repeat section ${section.sourceIndex} has no source cells`);
      const seenFragments = new Set<number>();
      for (let occurrenceIndex = 0; occurrenceIndex < repeat.occurrences.length; occurrenceIndex++) {
        const occurrence = repeat.occurrences[occurrenceIndex];
        if (occurrence.occurrenceIndex !== occurrenceIndex) throw new Error("repeat occurrence order changed");
        if (!Number.isInteger(occurrence.fragmentIndex)
            || occurrence.fragmentIndex < 0
            || occurrence.fragmentIndex >= tableFragments.length) {
          throw new Error("repeat occurrence points at an invalid physical fragment");
        }
        if (seenFragments.has(occurrence.fragmentIndex)) throw new Error("duplicate repeat occurrence fragment");
        seenFragments.add(occurrence.fragmentIndex);
        if (occurrenceIndex > 0
            && occurrence.fragmentIndex !== repeat.occurrences[occurrenceIndex - 1].fragmentIndex + 1) {
          throw new Error("repeat occurrences do not cover consecutive table-box fragments");
        }
        if (!sameNumbers(occurrence.expectedCellSourceIndices, expectedCellSources)
            || !sameNumbers(occurrence.witnessedCellSourceIndices, expectedCellSources)) {
          throw new Error("repeat occurrence source-cell witness set is incomplete or reordered");
        }
        if (occurrence.hitTest !== "Document.elementsFromPoint-intrinsic-source-cell-membership") {
          throw new Error("repeat occurrence does not use the intrinsic source-cell hit-test contract");
        }
        const expectedRect = expectedRepeatOccurrenceRect(
          prototype,
          tableFragments[prototypeFragmentIndex],
          tableFragments[occurrence.fragmentIndex],
          repeat.repeatKind,
          input.writingMode,
          input.direction,
        );
        if (rectToken(canonicalRect(occurrence.physicalRect)) !== rectToken(expectedRect)) {
          throw new Error("repeat occurrence does not occupy its exact source-derived fragment slot");
        }
      }
      if (repeat.occurrences[0]?.fragmentIndex !== prototypeFragmentIndex) {
        throw new Error("repeat prototype is not the first authenticated occurrence");
      }
      repeatBySection.set(repeat.sectionSourceIndex, repeat);
      repeatPrototype.set(repeat.sectionSourceIndex, prototype);
    }

    const sectionOccurrences = new Map<number, SectionOccurrence[]>();
    for (const section of input.sections) {
      const repeat = repeatBySection.get(section.sourceIndex);
      if (repeat != null) {
        const occurrences = repeat.occurrences.map((occurrence) => ({
          fragmentIndex: occurrence.fragmentIndex,
          rect: canonicalRect(occurrence.physicalRect),
          repeat,
          occurrenceIndex: occurrence.occurrenceIndex,
        }));
        sectionOccurrences.set(section.sourceIndex, occurrences);
        continue;
      }
      const pieces = mappedPieces(section.geometry, tableFragments);
      if (new Set(pieces.map((piece) => piece.fragmentIndex)).size !== pieces.length) {
        throw new Error(`section ${section.sourceIndex} exposes aliased/repeated rectangles without occurrence ownership`);
      }
      sectionOccurrences.set(section.sourceIndex, pieces.map((piece) => ({
        fragmentIndex: piece.fragmentIndex,
        rect: piece.rect,
        repeat: null,
        occurrenceIndex: null,
      })));
    }

    const rowPieces = new Map<number, MappedPiece[]>();
    const repeatRowPrototype = new Map<number, CollapsedBorderPhysicalRect>();
    for (const row of input.rows) {
      const repeat = repeatBySection.get(row.sectionSourceIndex);
      if (repeat != null) {
        const aliases = authenticateCollapsedBorderGeometry(row.geometry);
        if (aliases.length !== repeat.occurrences.length
            || aliases.some((rect) => rectToken(rect) !== rectToken(aliases[0]))) {
          throw new Error(`repeat row ${row.globalRowIndex} is not one exact prototype alias set`);
        }
        repeatRowPrototype.set(row.sourceIndex, aliases[0]);
        continue;
      }
      const pieces = mappedPieces(row.geometry, tableFragments);
      if (pieces.length === 0) throw new Error(`row ${row.globalRowIndex} exposes no physical fragment`);
      if (new Set(pieces.map((piece) => piece.fragmentIndex)).size !== pieces.length) {
        throw new Error(`row ${row.globalRowIndex} maps more than once to one table fragment`);
      }
      rowPieces.set(row.sourceIndex, pieces);
    }

    const repeatCellPrototype = new Map<number, CollapsedBorderPhysicalRect>();
    for (const cell of input.cells) {
      const section = input.sections.find((candidate) => cell.globalRowIndex >= candidate.globalStartRowIndex
        && cell.globalRowIndex < candidate.globalStartRowIndex + candidate.globalRowCount);
      const repeat = section == null ? undefined : repeatBySection.get(section.sourceIndex);
      if (repeat == null) continue;
      const aliases = authenticateCollapsedBorderGeometry(cell.geometry);
      if (aliases.length !== repeat.occurrences.length
          || aliases.some((rect) => rectToken(rect) !== rectToken(aliases[0]))) {
        throw new Error(`repeat cell ${cell.sourceIndex} is not one exact prototype alias set`);
      }
      repeatCellPrototype.set(cell.sourceIndex, aliases[0]);
    }

    const captionPieces = new Map<number, MappedPiece[]>();
    for (const caption of input.captions) {
      captionPieces.set(caption.sourceIndex, mappedPieces(caption.geometry, tableFragments));
    }

    const columnCandidates = Array.from({ length: input.totalColumns + 1 }, () => new Set<number>());
    for (const cell of input.cells) {
      if (cell.globalColumnIndex < 0 || cell.globalColumnIndex + cell.columnSpan > input.totalColumns) {
        throw new Error(`cell ${cell.sourceIndex} has an invalid global column span`);
      }
      const repeatRect = repeatCellPrototype.get(cell.sourceIndex);
      const repeatSection = repeatRect == null ? undefined : input.sections.find((candidate) =>
        cell.globalRowIndex >= candidate.globalStartRowIndex
        && cell.globalRowIndex < candidate.globalStartRowIndex + candidate.globalRowCount);
      const repeat = repeatSection == null ? undefined : repeatBySection.get(repeatSection.sourceIndex);
      const pieces = repeatRect == null || repeat == null
        ? mappedPieces(cell.geometry, tableFragments)
        : [{
          rect: repeatRect,
          pieceIndex: 0,
          fragmentIndex: repeat.occurrences[0].fragmentIndex,
        }];
      for (const piece of pieces) {
        const logical = logicalRect(piece.rect, tableFragments[piece.fragmentIndex], input.writingMode, input.direction);
        columnCandidates[cell.globalColumnIndex].add(logical.inlineStart);
        columnCandidates[cell.globalColumnIndex + cell.columnSpan].add(logical.inlineEnd);
      }
    }
    const globalColumnOffsets = columnCandidates.map((values, column) => {
      if (values.size !== 1) {
        throw new Error(`global column offset ${column} is ${values.size === 0 ? "unobserved" : "inconsistent"}`);
      }
      return [...values][0];
    });
    for (let index = 1; index < globalColumnOffsets.length; index++) {
      if (!(globalColumnOffsets[index] > globalColumnOffsets[index - 1])) {
        throw new Error("global column offsets are not strictly increasing");
      }
    }

    const tableBoxFragmentIndexes = new Set<number>();
    for (const occurrences of sectionOccurrences.values()) {
      for (const occurrence of occurrences) tableBoxFragmentIndexes.add(occurrence.fragmentIndex);
    }
    if (tableBoxFragmentIndexes.size === 0) throw new Error("no physical table-box fragment contains a section");
    const firstTableBoxIndex = Math.min(...tableBoxFragmentIndexes);
    const lastTableBoxIndex = Math.max(...tableBoxFragmentIndexes);
    for (let index = firstTableBoxIndex; index <= lastTableBoxIndex; index++) {
      if (!tableBoxFragmentIndexes.has(index)) throw new Error("table-box fragment sequence has an unexplained hole");
    }
    for (const repeat of repeatBySection.values()) {
      if (repeat.occurrences[0]?.fragmentIndex !== firstTableBoxIndex
          || repeat.occurrences.at(-1)?.fragmentIndex !== lastTableBoxIndex) {
        throw new Error("repeat occurrence sequence does not cover every table-box fragment");
      }
    }

    const physicalFragments: CollapsedBorderPhysicalTableFragmentRecord[] = [];
    for (let fragmentIndex = 0; fragmentIndex < tableFragments.length; fragmentIndex++) {
      const physicalRect = tableFragments[fragmentIndex];
      const children: Array<{
        kind: "section" | "caption";
        sourceIndex: number;
        tableChildIndex: number;
        blockStart: number;
        blockEnd: number;
        occurrence?: SectionOccurrence;
      }> = [];
      for (const section of input.sections) {
        const occurrence = sectionOccurrences.get(section.sourceIndex)?.find((candidate) =>
          candidate.fragmentIndex === fragmentIndex);
        if (occurrence == null) continue;
        const logical = logicalRect(occurrence.rect, physicalRect, input.writingMode, input.direction);
        children.push({
          kind: "section",
          sourceIndex: section.sourceIndex,
          tableChildIndex: section.tableChildIndex,
          blockStart: logical.blockStart,
          blockEnd: logical.blockEnd,
          occurrence,
        });
      }
      for (const caption of input.captions) {
        for (const piece of captionPieces.get(caption.sourceIndex) ?? []) {
          if (piece.fragmentIndex !== fragmentIndex) continue;
          const logical = logicalRect(piece.rect, physicalRect, input.writingMode, input.direction);
          children.push({
            kind: "caption",
            sourceIndex: caption.sourceIndex,
            tableChildIndex: caption.tableChildIndex,
            blockStart: logical.blockStart,
            blockEnd: logical.blockEnd,
          });
        }
      }
      children.sort((left, right) => left.blockStart - right.blockStart
        || left.tableChildIndex - right.tableChildIndex || left.sourceIndex - right.sourceIndex);

      const sectionChildren = children.filter((child) => child.kind === "section");
      const records: CollapsedBorderSectionFragmentRecord[] = [];
      for (let sectionPaintSlot = 0; sectionPaintSlot < sectionChildren.length; sectionPaintSlot++) {
        const child = sectionChildren[sectionPaintSlot];
        const section = input.sections.find((candidate) => candidate.sourceIndex === child.sourceIndex);
        const occurrence = child.occurrence;
        if (section == null || occurrence == null) throw new Error("section source correlation disappeared");
        const repeat = occurrence.repeat;
        const prototypeSection = repeat == null ? null : repeatPrototype.get(section.sourceIndex);
        const rows = input.rows
          .filter((row) => row.sectionSourceIndex === section.sourceIndex)
          .flatMap((row) => {
            if (repeat != null) {
              const prototype = repeatRowPrototype.get(row.sourceIndex);
              if (prototype == null || prototypeSection == null) return [];
              return [{ row, piece: {
                fragmentIndex,
                pieceIndex: 0,
                rect: cloneIntoOccurrence(
                  prototype,
                  prototypeSection,
                  occurrence.rect,
                  input.writingMode,
                  input.direction,
                ),
              } }];
            }
            const piece = rowPieces.get(row.sourceIndex)?.find((candidate) => candidate.fragmentIndex === fragmentIndex);
            return piece == null ? [] : [{ row, piece }];
          })
          .sort((left, right) => {
            const leftBlock = logicalRect(left.piece.rect, physicalRect, input.writingMode, input.direction).blockStart;
            const rightBlock = logicalRect(right.piece.rect, physicalRect, input.writingMode, input.direction).blockStart;
            return leftBlock - rightBlock || left.row.globalRowIndex - right.row.globalRowIndex;
          });
        if (rows.length === 0) throw new Error(`section ${section.sourceIndex} fragment has no row fragments`);
        for (let index = 1; index < rows.length; index++) {
          if (rows[index].row.globalRowIndex !== rows[index - 1].row.globalRowIndex + 1) {
            throw new Error(`section ${section.sourceIndex} fragment rows are not globally consecutive`);
          }
        }
        const logicalRowOffsets = rows.map(({ piece }) =>
          logicalRect(piece.rect, physicalRect, input.writingMode, input.direction).blockStart);
        logicalRowOffsets.push(logicalRect(occurrence.rect, physicalRect, input.writingMode, input.direction).blockEnd);
        for (let index = 1; index < logicalRowOffsets.length; index++) {
          if (!(logicalRowOffsets[index] > logicalRowOffsets[index - 1])) {
            throw new Error(`section ${section.sourceIndex} row offsets are not strictly increasing`);
          }
        }
        const first = rows[0];
        const last = rows[rows.length - 1];
        const lastPieces = rowPieces.get(last.row.sourceIndex) ?? [];
        const startContinuedRow = repeat == null && first.piece.pieceIndex > 0;
        const endContinuedRow = repeat == null && last.piece.pieceIndex < lastPieces.length - 1;
        const globalStartRowIndex = first.row.globalRowIndex;
        const repeatRole: CollapsedBorderSectionRepeatRole = repeat == null
          ? "non-repeated"
          : `${occurrence.occurrenceIndex === 0 ? "original" : "repeated"}-${repeat.repeatKind}`;
        const tableChildPaintSlot = children.indexOf(child);
        const previousChild = tableChildPaintSlot > 0 ? children[tableChildPaintSlot - 1] : null;
        const nextChild = tableChildPaintSlot + 1 < children.length ? children[tableChildPaintSlot + 1] : null;
        const reservedCollapsedEdgeSpace: CollapsedBorderReservedEdgeSpace | null = repeat == null ? null : {
          side: repeat.repeatKind === "header" ? "block-start" : "block-end",
          amount: canonicalCollapsedBorderLayoutUnit(repeat.repeatKind === "header"
            ? child.blockStart - (previousChild?.blockEnd ?? 0)
            : (nextChild?.blockStart ?? blockSize(physicalRect, input.writingMode)) - child.blockEnd),
          globalRowEdgeIndex: repeat.repeatKind === "header" ? 0 : input.totalRows,
          tableEdgeIncludedInThisFragment: repeat.repeatKind === "header"
            ? fragmentIndex === firstTableBoxIndex
            : fragmentIndex === lastTableBoxIndex,
        };
        if (reservedCollapsedEdgeSpace != null && reservedCollapsedEdgeSpace.amount < 0) {
          throw new Error("repeat section has negative reserved collapsed-edge space");
        }
        records.push({
          fragmentIndex,
          physicalSectionFragmentId: `table-fragment:${fragmentIndex}/section:${section.sourceIndex}`,
          sectionSourceIndex: section.sourceIndex,
          sectionTableChildIndex: section.tableChildIndex,
          sectionTag: section.tag,
          sectionPaintSlot,
          tableChildPaintSlot,
          globalStartRowIndex,
          logicalRowOffsets,
          hasContentBefore: sectionPaintSlot === 0 && globalStartRowIndex > 0,
          hasContentAfter: sectionPaintSlot === sectionChildren.length - 1
            && globalStartRowIndex + logicalRowOffsets.length < input.totalRows + 1,
          startContinuedRow,
          endContinuedRow,
          firstGlobalRowIndex: first.row.globalRowIndex,
          lastGlobalRowIndex: last.row.globalRowIndex,
          physicalRect: occurrence.rect,
          repeatRole,
          repeatOccurrenceIndex: occurrence.occurrenceIndex,
          firstTableBox: fragmentIndex === firstTableBoxIndex,
          lastTableBox: fragmentIndex === lastTableBoxIndex,
          repeatEligibility: repeat?.eligibility ?? null,
          reservedCollapsedEdgeSpace,
          occurrenceOwnership: repeat == null
            ? "ordered-neutral-cssom-cdp"
            : "source-clone-plus-per-fragment-hit-test",
        });
      }
      const tableBoxState: CollapsedBorderPhysicalTableFragmentRecord["tableBoxState"] = fragmentIndex < firstTableBoxIndex
        ? "caption-only-before-table-box"
        : fragmentIndex > lastTableBoxIndex
          ? "empty-after-table-box"
          : firstTableBoxIndex === lastTableBoxIndex
            ? "only-table-box"
            : fragmentIndex === firstTableBoxIndex
              ? "first-table-box"
              : fragmentIndex === lastTableBoxIndex
                ? "last-table-box"
                : "middle-table-box";
      physicalFragments.push({
        fragmentIndex,
        physicalTableFragmentId: `table-fragment:${fragmentIndex}`,
        physicalRect,
        tableBoxState,
        sectionFragments: records,
        captionPaintSlots: children.flatMap((child, tableChildPaintSlot) => child.kind === "caption" ? [{
          captionSourceIndex: child.sourceIndex,
          captionTableChildIndex: child.tableChildIndex,
          tableChildPaintSlot,
        }] : []),
      });
    }

    const record: AuthenticatedCollapsedBorderFragmentRecord = {
      schemaVersion: COLLAPSED_BORDER_FRAGMENT_RECORD_VERSION,
      status: "authenticated",
      sourceRevision: COLLAPSED_BORDER_FRAGMENT_CHROMIUM_REVISION,
      writingMode: input.writingMode,
      direction: input.direction,
      totalRows: input.totalRows,
      totalColumns: input.totalColumns,
      globalColumnOffsets,
      tableFragments: physicalFragments,
      provenance: {
        plane: "all-css-transforms-neutralized",
        cssom: "Element.getClientRects",
        protocol: "DOM.getContentQuads",
        canonicalization: "Blink-LayoutUnit-1/64-css-px",
        correlation: "ordered-exact-rect-set",
        repeatOccurrence: "prototype-deep-clone-plus-intrinsic-source-cell-hit-test",
        sourceRestoredExactly: true,
        sourceFiles: [
          "third_party/blink/renderer/core/layout/table/table_layout_algorithm_types.cc:297-326",
          "third_party/blink/renderer/core/layout/table/table_layout_algorithm.cc:1076-1151",
          "third_party/blink/renderer/core/layout/block_node.cc:722-796",
          "third_party/blink/renderer/core/layout/fragment_repeater.cc:117-205",
          "third_party/blink/renderer/core/paint/pre_paint_tree_walk.cc:1290-1348",
          "third_party/blink/renderer/core/layout/table/table_section_layout_algorithm.cc:47-164",
          "third_party/blink/renderer/core/paint/table_painters.cc:490-727",
        ],
      },
    };
    const errors = validateCollapsedBorderFragmentRecord(record);
    if (errors.length > 0) throw new Error(errors.join("; "));
    return record;
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

export function validateCollapsedBorderFragmentRecord(
  record: AuthenticatedCollapsedBorderFragmentRecord,
): string[] {
  const errors: string[] = [];
  if (record.schemaVersion !== COLLAPSED_BORDER_FRAGMENT_RECORD_VERSION) errors.push("wrong record schema version");
  if (record.sourceRevision !== COLLAPSED_BORDER_FRAGMENT_CHROMIUM_REVISION) errors.push("wrong Chromium source revision");
  if (record.globalColumnOffsets.length !== record.totalColumns + 1) errors.push("incomplete global column offsets");
  for (let index = 1; index < record.globalColumnOffsets.length; index++) {
    if (!(record.globalColumnOffsets[index] > record.globalColumnOffsets[index - 1])) {
      errors.push("global column offsets are not strictly increasing");
    }
  }
  if (record.tableFragments.length <= 1) errors.push("record has no physical fragmentation");
  if (record.provenance.plane !== "all-css-transforms-neutralized"
      || record.provenance.cssom !== "Element.getClientRects"
      || record.provenance.protocol !== "DOM.getContentQuads"
      || record.provenance.correlation !== "ordered-exact-rect-set"
      || record.provenance.repeatOccurrence !== "prototype-deep-clone-plus-intrinsic-source-cell-hit-test"
      || record.provenance.sourceRestoredExactly !== true) {
    errors.push("record provenance is not the authenticated neutral CSSOM/CDP contract");
  }
  const fragmentIds = new Set<string>();
  const sectionFragmentIds = new Set<string>();
  const repeatSeries = new Map<number, CollapsedBorderSectionFragmentRecord[]>();
  const tableBoxIndexes = record.tableFragments
    .filter((fragment) => fragment.sectionFragments.length > 0)
    .map((fragment) => fragment.fragmentIndex);
  const firstTableBoxIndex = tableBoxIndexes.length === 0 ? -1 : Math.min(...tableBoxIndexes);
  const lastTableBoxIndex = tableBoxIndexes.length === 0 ? -1 : Math.max(...tableBoxIndexes);
  for (let fragmentIndex = 0; fragmentIndex < record.tableFragments.length; fragmentIndex++) {
    const fragment = record.tableFragments[fragmentIndex];
    if (fragment.fragmentIndex !== fragmentIndex) errors.push("physical table fragment order changed");
    if (fragmentIds.has(fragment.physicalTableFragmentId)) errors.push("duplicate physical table fragment identity");
    fragmentIds.add(fragment.physicalTableFragmentId);
    const expectedState: CollapsedBorderPhysicalTableFragmentRecord["tableBoxState"] = fragmentIndex < firstTableBoxIndex
      ? "caption-only-before-table-box"
      : fragmentIndex > lastTableBoxIndex
        ? "empty-after-table-box"
        : firstTableBoxIndex === lastTableBoxIndex
          ? "only-table-box"
          : fragmentIndex === firstTableBoxIndex
            ? "first-table-box"
            : fragmentIndex === lastTableBoxIndex
              ? "last-table-box"
              : "middle-table-box";
    if (fragment.tableBoxState !== expectedState) errors.push("physical table-box state disagrees with section occurrence ownership");
    let priorPaintSlot = -1;
    let priorTableSlot = -1;
    for (const section of fragment.sectionFragments) {
      if (section.fragmentIndex !== fragmentIndex) errors.push("section belongs to the wrong physical table fragment");
      if (sectionFragmentIds.has(section.physicalSectionFragmentId)) errors.push("duplicate physical section fragment identity");
      sectionFragmentIds.add(section.physicalSectionFragmentId);
      if (section.sectionPaintSlot !== priorPaintSlot + 1) errors.push("section paint slots are not consecutive");
      if (section.tableChildPaintSlot <= priorTableSlot) errors.push("table child paint slots are not increasing");
      priorPaintSlot = section.sectionPaintSlot;
      priorTableSlot = section.tableChildPaintSlot;
      if (section.globalStartRowIndex !== section.firstGlobalRowIndex) errors.push("section global start row disagrees with its first row");
      if (section.lastGlobalRowIndex < section.firstGlobalRowIndex) errors.push("section global row interval is reversed");
      if (section.logicalRowOffsets.length !== section.lastGlobalRowIndex - section.firstGlobalRowIndex + 2) {
        errors.push("section row-offset count does not match its global row interval");
      }
      for (let index = 1; index < section.logicalRowOffsets.length; index++) {
        if (!(section.logicalRowOffsets[index] > section.logicalRowOffsets[index - 1])) {
          errors.push("section row offsets are not strictly increasing");
        }
      }
      try {
        canonicalRect(section.physicalRect);
        if (overlapArea(section.physicalRect, fragment.physicalRect) <= 0) {
          errors.push("section physical rectangle does not belong to its table fragment");
        }
      } catch {
        errors.push("section physical rectangle is invalid");
      }
      if (section.firstTableBox !== (fragmentIndex === firstTableBoxIndex)
          || section.lastTableBox !== (fragmentIndex === lastTableBoxIndex)) {
        errors.push("section first/last table-box ownership is wrong");
      }
      if (section.repeatRole === "non-repeated") {
        if (section.repeatOccurrenceIndex !== null
            || section.repeatEligibility !== null
            || section.reservedCollapsedEdgeSpace !== null
            || section.occurrenceOwnership !== "ordered-neutral-cssom-cdp") {
          errors.push("ordinary section carries repeat occurrence state");
        }
      } else {
        if (!Number.isInteger(section.repeatOccurrenceIndex) || section.repeatOccurrenceIndex! < 0) {
          errors.push("repeat occurrence index is invalid");
        }
        if (section.repeatEligibility == null) {
          errors.push("repeat occurrence has no source eligibility evidence");
        } else {
          try { requireRepeatEligibility(section.repeatEligibility); }
          catch { errors.push("repeat occurrence source eligibility is invalid"); }
        }
        if (section.occurrenceOwnership !== "source-clone-plus-per-fragment-hit-test") {
          errors.push("repeat occurrence has the wrong ownership route");
        }
        const header = section.repeatRole.endsWith("header");
        const expectedOriginal = section.repeatOccurrenceIndex === 0;
        if (section.repeatRole !== `${expectedOriginal ? "original" : "repeated"}-${header ? "header" : "footer"}`) {
          errors.push("repeat occurrence role disagrees with its sequence index");
        }
        if (header) {
          if (section.globalStartRowIndex !== 0) errors.push("selected repeat header does not own global row start zero");
          if (section.sectionPaintSlot !== 0) errors.push("selected repeat header is not in the first section paint slot");
        } else {
          if (section.lastGlobalRowIndex !== record.totalRows - 1) errors.push("selected repeat footer does not own the global final row");
          if (section.sectionPaintSlot !== fragment.sectionFragments.length - 1) {
            errors.push("selected repeat footer is not in the final section paint slot");
          }
        }
        const reserved = section.reservedCollapsedEdgeSpace;
        if (reserved == null
            || reserved.side !== (header ? "block-start" : "block-end")
            || reserved.globalRowEdgeIndex !== (header ? 0 : record.totalRows)
            || reserved.tableEdgeIncludedInThisFragment !== (header ? section.firstTableBox : section.lastTableBox)
            || !Number.isFinite(reserved.amount)
            || reserved.amount < 0) {
          errors.push("repeat reserved collapsed-edge ownership is wrong");
        } else {
          const logical = logicalRect(section.physicalRect, fragment.physicalRect, record.writingMode, record.direction);
          const adjacentCaption = fragment.captionPaintSlots.some((caption) => header
            ? caption.tableChildPaintSlot < section.tableChildPaintSlot
            : caption.tableChildPaintSlot > section.tableChildPaintSlot);
          if (!adjacentCaption) {
            const expectedAmount = canonicalCollapsedBorderLayoutUnit(header
              ? logical.blockStart
              : blockSize(fragment.physicalRect, record.writingMode) - logical.blockEnd);
            if (reserved.amount !== expectedAmount) errors.push("repeat reserved collapsed-edge amount changed");
          }
        }
        const series = repeatSeries.get(section.sectionSourceIndex) ?? [];
        series.push(section);
        repeatSeries.set(section.sectionSourceIndex, series);
      }
    }
  }
  if (firstTableBoxIndex < 0) errors.push("record contains no table-box section occurrence");
  for (let index = firstTableBoxIndex; index <= lastTableBoxIndex; index++) {
    if (!tableBoxIndexes.includes(index)) errors.push("table-box section occurrence sequence has a hole");
  }
  const repeatKinds = new Map<"header" | "footer", number>();
  for (const [sourceIndex, series] of repeatSeries) {
    series.sort((left, right) => (left.repeatOccurrenceIndex ?? -1) - (right.repeatOccurrenceIndex ?? -1));
    const kind = series[0].repeatRole.endsWith("header") ? "header" : "footer";
    if (repeatKinds.has(kind) && repeatKinds.get(kind) !== sourceIndex) errors.push(`more than one selected repeat ${kind}`);
    repeatKinds.set(kind, sourceIndex);
    const prototypeOffsets = series[0].logicalRowOffsets.map((value) =>
      canonicalCollapsedBorderLayoutUnit(value - series[0].logicalRowOffsets[0]));
    for (let index = 0; index < series.length; index++) {
      const section = series[index];
      if (section.repeatOccurrenceIndex !== index) errors.push("repeat occurrence indexes are not consecutive");
      if (section.fragmentIndex !== firstTableBoxIndex + index) errors.push("repeat occurrence physical fragments are dropped or reordered");
      if (!section.repeatRole.endsWith(kind)) errors.push("repeat occurrence kind changed within one source series");
      const normalized = section.logicalRowOffsets.map((value) =>
        canonicalCollapsedBorderLayoutUnit(value - section.logicalRowOffsets[0]));
      if (!sameNumbers(normalized, prototypeOffsets)) errors.push("repeat occurrence row geometry is not an exact prototype clone");
    }
    if (series.length !== lastTableBoxIndex - firstTableBoxIndex + 1) {
      errors.push("repeat occurrence series does not cover every table-box fragment");
    }
  }
  return errors;
}
