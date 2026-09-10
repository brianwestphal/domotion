import { createHash } from "node:crypto";

import {
  createCollapsedBorderGrid,
  collapsedBorderFragmentLogicalRects,
  type CollapsedBorderSource,
} from "../capture/script/walker/collapsed-border.js";
import {
  isLiveAuthenticatedPagedPageRecord,
  validateAuthenticatedPagedPageRecord,
  type AuthenticatedPagedPage,
  type PagedPageRecord,
} from "../capture/paged-page-record.js";
import type { PagedCollapsedTableOccurrence } from "../capture/paged-collapsed-table-record.js";

export interface RenderedPagedSvgPage {
  selectionIndex: number;
  pageIndex: number;
  pageNumber: number;
  pageName: string | null;
  emptyKind: AuthenticatedPagedPage["emptyKind"];
  widthCssPx: number;
  heightCssPx: number;
  svg: string;
  svgByteLength: number;
  svgSha256: string;
  pageRecordSha256: string;
  collapsedBorderRectCount: number;
  collapsedBorderConsistencySha256: string;
}

export class PagedPageSvgRenderError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`authenticated paged SVG render failed: ${errors.join("; ")}`);
    this.name = "PagedPageSvgRenderError";
    this.errors = errors;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function svgCanvasSize(svg: string): { width: number; height: number } | null {
  const root = /(?:<\?xml[^>]*>\s*)?<svg\b([^>]*)>/i.exec(svg);
  if (!root) return null;
  const dimension = (name: "width" | "height"): number | null => {
    const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([0-9]+(?:\\.[0-9]+)?)(?:px)?\\1`, "i").exec(root[1]);
    if (!match) return null;
    const value = Number(match[2]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const width = dimension("width");
  const height = dimension("height");
  return width == null || height == null ? null : { width, height };
}

interface AuditedBorderSource extends CollapsedBorderSource {
  sourceEdgeIndex: number;
}

export interface CollapsedBorderLogicalAuditRect {
  axis: "row" | "column";
  row: number;
  column: number;
  inlineStart: number;
  blockStart: number;
  inlineSize: number;
  blockSize: number;
  sourceEdgeIndex: number;
  writingMode: PagedCollapsedTableOccurrence["writingMode"];
  direction: PagedCollapsedTableOccurrence["direction"];
  logicalRectRaw: { inlineStart: number; blockStart: number; inlineSize: number; blockSize: number };
}

/** Pure exact-LayoutUnit audit used by the live renderer and fixture tests. */
export function auditCollapsedTableLogicalRects(
  table: PagedCollapsedTableOccurrence,
): CollapsedBorderLogicalAuditRect[] {
  const grid = createCollapsedBorderGrid<AuditedBorderSource>(table.totalRows, table.totalColumns);
  const edgesPerRow = (table.totalColumns + 1) * 2;
  for (const edge of table.resolvedCollapsedEdgeGrid) {
    const sourceRow = Math.floor(edge.sourceEdgeIndex / edgesPerRow);
    const sourceColumn = Math.floor((edge.sourceEdgeIndex % edgesPerRow) / 2);
    const sourceAxis = edge.sourceEdgeIndex % 2 === 1 ? "inline" : "block";
    if (sourceAxis !== edge.axis) {
      throw new PagedPageSvgRenderError([`table ${table.physicalTableFragmentId} edge axis disagrees with its source index`]);
    }
    const target = edge.axis === "inline"
      ? grid.rowAxis[sourceRow]?.[sourceColumn]
      : grid.columnAxis[sourceRow]?.[sourceColumn];
    if (!target) throw new PagedPageSvgRenderError([`table ${table.physicalTableFragmentId} has an out-of-grid edge`]);
    target.doNotFill = edge.doNotFill;
    if (edge.winner != null) {
      target.winner = {
        sourceEdgeIndex: edge.sourceEdgeIndex,
        side: edge.axis === "inline" ? "top" : "left",
        order: edge.winner.boxOrder,
        w: edge.winner.widthCssPx * 64,
        style: edge.winner.style,
      };
    }
  }
  const lastSection = table.sectionOccurrences.length - 1;
  const rects = collapsedBorderFragmentLogicalRects(
    grid,
    table.globalColumnOffsets.map((value) => value * 64),
    table.sectionOccurrences.map((section, index) => ({
      rowStart: section.globalRows.start,
      blockLines: section.logicalRowOffsets.map((value) => value * 64),
      hasContentBefore: index === 0 && section.globalRows.start > 0,
      hasContentAfter: index === lastSection && section.globalRows.endExclusive < table.totalRows,
      startRowFragmented: section.startBreak.kind === "continued-row",
      endRowFragmented: section.endBreak.kind === "continued-row",
    })),
    true,
  );
  const expectedPaintedEdges = table.collapsedEdges
    .filter((edge) => !edge.disposition.startsWith("omit-") && !edge.disposition.startsWith("skip-"))
    .sort((left, right) => (left.paintOrder ?? -1) - (right.paintOrder ?? -1))
    .map((edge) => edge.sourceEdgeIndex);
  const replayedPaintedEdges = rects.map((rect) => rect.winner.sourceEdgeIndex);
  if (replayedPaintedEdges.length !== expectedPaintedEdges.length
      || replayedPaintedEdges.some((edge, index) => edge !== expectedPaintedEdges[index])) {
    throw new PagedPageSvgRenderError([
      `table ${table.physicalTableFragmentId} collapsed-border replay disagrees with native paint order`,
    ]);
  }
  for (const rect of rects) {
    const expected = table.collapsedEdges.find((edge) => edge.sourceEdgeIndex === rect.winner.sourceEdgeIndex);
    if (!expected) throw new PagedPageSvgRenderError([`table ${table.physicalTableFragmentId} replayed an unknown edge`]);
    const actualRaw = {
      inlineStart: rect.inlineStart,
      blockStart: rect.blockStart,
      inlineSize: rect.inlineSize,
      blockSize: rect.blockSize,
    };
    if (expected.logicalRectRaw == null
        || canonicalJson(actualRaw) !== canonicalJson(expected.logicalRectRaw)) {
      throw new PagedPageSvgRenderError([
        `table ${table.physicalTableFragmentId} logical paint rect disagrees for edge ${expected.sourceEdgeIndex}`,
      ]);
    }
    for (const [label, actual, winner] of [
      ["start", rect.startJoint?.wins, expected.startJoint.winner],
      ["end", rect.endJoint?.wins, expected.endJoint.winner],
    ] as const) {
      const replayedWinner = actual ? "self" : "neighbor";
      const suppressed = rect[`${label}Joint`]?.suppressedAtFragmentBoundary ?? false;
      const expectedJoint = expected[`${label}Joint`];
      if (replayedWinner !== winner
          || suppressed !== expectedJoint.suppressedAtFragmentBoundary) {
        throw new PagedPageSvgRenderError([
          `table ${table.physicalTableFragmentId} ${label} joint winner disagrees for edge ${expected.sourceEdgeIndex}`,
        ]);
      }
    }
  }
  return rects.map((rect) => ({
    axis: rect.axis,
    row: rect.row,
    column: rect.column,
    inlineStart: rect.inlineStart / 64,
    blockStart: rect.blockStart / 64,
    inlineSize: rect.inlineSize / 64,
    blockSize: rect.blockSize / 64,
    logicalRectRaw: {
      inlineStart: rect.inlineStart,
      blockStart: rect.blockStart,
      inlineSize: rect.inlineSize,
      blockSize: rect.blockSize,
    },
    sourceEdgeIndex: rect.winner.sourceEdgeIndex,
    writingMode: table.writingMode,
    direction: table.direction,
  }));
}

/**
 * Materialize one SVG asset per authenticated physical page. The exact
 * preflighted Skia SVG remains the paint authority; logical table geometry is
 * independently replayed as an authentication oracle and is never painted a
 * second time over the native result.
 */
export function renderAuthenticatedPagedSvgPages(record: PagedPageRecord): RenderedPagedSvgPage[] {
  if (record.status !== "authenticated") {
    throw new PagedPageSvgRenderError([`page record is unavailable: ${record.reason}`]);
  }
  if (!isLiveAuthenticatedPagedPageRecord(record)) {
    throw new PagedPageSvgRenderError(["page record lacks live helper/process authentication"]);
  }
  const errors = validateAuthenticatedPagedPageRecord(record);
  if (errors.length > 0) throw new PagedPageSvgRenderError(errors);

  return record.pages.map((page) => {
    const size = svgCanvasSize(page.vectorPaint.svg);
    if (!size) throw new PagedPageSvgRenderError([`page ${page.pageIndex} SVG lacks a positive Skia canvas size`]);
    const collapsedPage = record.collapsedTables.pages.find((candidate) => candidate.pageIndex === page.pageIndex);
    if (!collapsedPage) throw new PagedPageSvgRenderError([`page ${page.pageIndex} lacks collapsed-table ownership`]);
    const tableGeometry = collapsedPage.tableOccurrences.flatMap(auditCollapsedTableLogicalRects);
    const collapsedBorderConsistencySha256 = sha256(canonicalJson(tableGeometry));
    return {
      selectionIndex: page.selectionIndex,
      pageIndex: page.pageIndex,
      pageNumber: page.pageIndex + 1,
      pageName: page.pageName,
      emptyKind: page.emptyKind,
      widthCssPx: size.width,
      heightCssPx: size.height,
      svg: page.vectorPaint.svg,
      svgByteLength: page.vectorPaint.svgByteLength,
      svgSha256: page.vectorPaint.svgSha256,
      pageRecordSha256: sha256(canonicalJson({
        auditVersion: "collapsed-border-fragment-consistency-v1",
        schemaVersion: record.schemaVersion,
        helperAbi: record.helperAbi,
        sourceRevision: record.sourceRevision,
        document: record.document,
        page,
        collapsedPage,
        collapsedBorderConsistencySha256,
      })),
      collapsedBorderRectCount: tableGeometry.length,
      collapsedBorderConsistencySha256,
    };
  });
}
