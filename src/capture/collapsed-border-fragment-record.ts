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

export const COLLAPSED_BORDER_FRAGMENT_RECORD_VERSION = 1 as const;
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
  sourceRestoredExactly: boolean;
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
}

export interface CollapsedBorderPhysicalTableFragmentRecord {
  fragmentIndex: number;
  physicalTableFragmentId: string;
  physicalRect: CollapsedBorderPhysicalRect;
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
    sourceRestoredExactly: true;
    sourceFiles: readonly [
      "third_party/blink/renderer/core/layout/table/table_section_layout_algorithm.cc:47-164",
      "third_party/blink/renderer/core/paint/table_painters.cc:490-727",
      "third_party/blink/renderer/core/dom/element.cc:3419-3485",
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

    const sectionPieces = new Map<number, MappedPiece[]>();
    for (const section of input.sections) {
      const pieces = mappedPieces(section.geometry, tableFragments);
      if (new Set(pieces.map((piece) => piece.fragmentIndex)).size !== pieces.length) {
        throw new Error(`section ${section.sourceIndex} exposes aliased/repeated rectangles without occurrence ownership`);
      }
      sectionPieces.set(section.sourceIndex, pieces);
    }
    const rowPieces = new Map<number, MappedPiece[]>();
    for (const row of input.rows) {
      const pieces = mappedPieces(row.geometry, tableFragments);
      if (pieces.length === 0) throw new Error(`row ${row.globalRowIndex} exposes no physical fragment`);
      if (new Set(pieces.map((piece) => piece.fragmentIndex)).size !== pieces.length) {
        throw new Error(`row ${row.globalRowIndex} maps more than once to one table fragment`);
      }
      rowPieces.set(row.sourceIndex, pieces);
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
      for (const piece of mappedPieces(cell.geometry, tableFragments)) {
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

    const physicalFragments: CollapsedBorderPhysicalTableFragmentRecord[] = [];
    for (let fragmentIndex = 0; fragmentIndex < tableFragments.length; fragmentIndex++) {
      const physicalRect = tableFragments[fragmentIndex];
      const children: Array<{
        kind: "section" | "caption";
        sourceIndex: number;
        tableChildIndex: number;
        blockStart: number;
      }> = [];
      for (const section of input.sections) {
        const piece = sectionPieces.get(section.sourceIndex)?.find((candidate) => candidate.fragmentIndex === fragmentIndex);
        if (piece == null) continue;
        children.push({
          kind: "section",
          sourceIndex: section.sourceIndex,
          tableChildIndex: section.tableChildIndex,
          blockStart: logicalRect(piece.rect, physicalRect, input.writingMode, input.direction).blockStart,
        });
      }
      for (const caption of input.captions) {
        for (const piece of captionPieces.get(caption.sourceIndex) ?? []) {
          if (piece.fragmentIndex !== fragmentIndex) continue;
          children.push({
            kind: "caption",
            sourceIndex: caption.sourceIndex,
            tableChildIndex: caption.tableChildIndex,
            blockStart: logicalRect(piece.rect, physicalRect, input.writingMode, input.direction).blockStart,
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
        const sectionPiece = sectionPieces.get(child.sourceIndex)?.find((candidate) => candidate.fragmentIndex === fragmentIndex);
        if (section == null || sectionPiece == null) throw new Error("section source correlation disappeared");
        const rows = input.rows
          .filter((row) => row.sectionSourceIndex === section.sourceIndex)
          .flatMap((row) => {
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
        logicalRowOffsets.push(logicalRect(sectionPiece.rect, physicalRect, input.writingMode, input.direction).blockEnd);
        for (let index = 1; index < logicalRowOffsets.length; index++) {
          if (!(logicalRowOffsets[index] > logicalRowOffsets[index - 1])) {
            throw new Error(`section ${section.sourceIndex} row offsets are not strictly increasing`);
          }
        }
        const first = rows[0];
        const last = rows[rows.length - 1];
        const firstPieces = rowPieces.get(first.row.sourceIndex) ?? [];
        const lastPieces = rowPieces.get(last.row.sourceIndex) ?? [];
        const startContinuedRow = first.piece.pieceIndex > 0;
        const endContinuedRow = last.piece.pieceIndex < lastPieces.length - 1;
        const globalStartRowIndex = first.row.globalRowIndex;
        records.push({
          fragmentIndex,
          physicalSectionFragmentId: `table-fragment:${fragmentIndex}/section:${section.sourceIndex}`,
          sectionSourceIndex: section.sourceIndex,
          sectionTableChildIndex: section.tableChildIndex,
          sectionTag: section.tag,
          sectionPaintSlot,
          tableChildPaintSlot: children.indexOf(child),
          globalStartRowIndex,
          logicalRowOffsets,
          hasContentBefore: sectionPaintSlot === 0 && globalStartRowIndex > 0,
          hasContentAfter: sectionPaintSlot === sectionChildren.length - 1
            && globalStartRowIndex + logicalRowOffsets.length < input.totalRows + 1,
          startContinuedRow,
          endContinuedRow,
          firstGlobalRowIndex: first.row.globalRowIndex,
          lastGlobalRowIndex: last.row.globalRowIndex,
        });
      }
      physicalFragments.push({
        fragmentIndex,
        physicalTableFragmentId: `table-fragment:${fragmentIndex}`,
        physicalRect,
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
        sourceRestoredExactly: true,
        sourceFiles: [
          "third_party/blink/renderer/core/layout/table/table_section_layout_algorithm.cc:47-164",
          "third_party/blink/renderer/core/paint/table_painters.cc:490-727",
          "third_party/blink/renderer/core/dom/element.cc:3419-3485",
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
      || record.provenance.sourceRestoredExactly !== true) {
    errors.push("record provenance is not the authenticated neutral CSSOM/CDP contract");
  }
  const fragmentIds = new Set<string>();
  for (let fragmentIndex = 0; fragmentIndex < record.tableFragments.length; fragmentIndex++) {
    const fragment = record.tableFragments[fragmentIndex];
    if (fragment.fragmentIndex !== fragmentIndex) errors.push("physical table fragment order changed");
    if (fragmentIds.has(fragment.physicalTableFragmentId)) errors.push("duplicate physical table fragment identity");
    fragmentIds.add(fragment.physicalTableFragmentId);
    let priorPaintSlot = -1;
    let priorTableSlot = -1;
    for (const section of fragment.sectionFragments) {
      if (section.fragmentIndex !== fragmentIndex) errors.push("section belongs to the wrong physical table fragment");
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
    }
  }
  return errors;
}
