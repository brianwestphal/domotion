// Mirrors Blink table_borders.cc:IsSourceMoreSpecificThanEdge. Candidates
// must be supplied in Blink merge order: cells, rows, row groups, columns,
// column groups, then table. Exact ties retain the first candidate.
export interface CollapsedBorderCandidate {
  w: number;
  style: string;
  color?: string;
  order?: number;
  [key: string]: unknown;
}

export type CollapsedBorderPhysicalSide = "top" | "right" | "bottom" | "left";
export type CollapsedBorderWritingMode = "horizontal-tb" | "vertical-rl" | "vertical-lr" | "sideways-rl" | "sideways-lr";
export type CollapsedBorderDirection = "ltr" | "rtl";

export interface CollapsedBorderSource extends CollapsedBorderCandidate {
  side: CollapsedBorderPhysicalSide;
  order: number;
}

export interface CollapsedBorderEdge<T extends CollapsedBorderSource = CollapsedBorderSource> {
  winner: T | null;
  doNotFill: boolean;
}

/** Logical edge grid matching Blink's TableBorders storage model. Row-axis
 * edges run in the inline direction; column-axis edges run in the block
 * direction. */
export interface CollapsedBorderGrid<T extends CollapsedBorderSource = CollapsedBorderSource> {
  rows: number;
  columns: number;
  rowAxis: Array<Array<CollapsedBorderEdge<T>>>;
  columnAxis: Array<Array<CollapsedBorderEdge<T>>>;
}

export interface LogicalBorderSides {
  blockStart: CollapsedBorderPhysicalSide;
  blockEnd: CollapsedBorderPhysicalSide;
  inlineStart: CollapsedBorderPhysicalSide;
  inlineEnd: CollapsedBorderPhysicalSide;
}

export interface CollapsedBorderLogicalRect<T extends CollapsedBorderSource = CollapsedBorderSource> {
  axis: "row" | "column";
  row: number;
  column: number;
  inlineStart: number;
  blockStart: number;
  inlineSize: number;
  blockSize: number;
  winner: T;
}

export interface CollapsedBorderSectionFragment {
  /** Global table-row edge represented by blockLines[0]. */
  rowStart: number;
  /** Fragment-local logical block offsets for consecutive row edges. */
  blockLines: number[];
  hasContentBefore?: boolean;
  hasContentAfter?: boolean;
  startRowFragmented?: boolean;
  endRowFragmented?: boolean;
}

export const COLLAPSED_BORDER_STYLE_RANK: Record<string, number> = {
  none: 0, inset: 2, groove: 3, outset: 4, ridge: 5,
  dotted: 6, dashed: 7, solid: 8, double: 9,
};

/** CSS collapsed-border normalization used by ComputedStyle::CollapsedBorderStyle. */
export function collapsedBorderStyle(style: string): string {
  if (style === "inset") return "ridge";
  if (style === "outset") return "groove";
  return style;
}

export function resolveCollapsedBorderWinner<T extends CollapsedBorderCandidate>(candidates: Array<T | null>): T | { hidden: true } | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (candidate.style === "hidden") return { hidden: true };
    if (candidate.style === "none" || candidate.w === 0) continue;
    if (best == null || candidate.w > best.w) { best = candidate; continue; }
    if (candidate.w < best.w) continue;
    if ((COLLAPSED_BORDER_STYLE_RANK[candidate.style] ?? 0) > (COLLAPSED_BORDER_STYLE_RANK[best.style] ?? 0)) best = candidate;
  }
  return best;
}

export function physicalSidesForTable(
  writingMode: CollapsedBorderWritingMode,
  direction: CollapsedBorderDirection,
): LogicalBorderSides {
  if (writingMode === "horizontal-tb") {
    return {
      blockStart: "top", blockEnd: "bottom",
      inlineStart: direction === "ltr" ? "left" : "right",
      inlineEnd: direction === "ltr" ? "right" : "left",
    };
  }
  const blockStart = writingMode === "vertical-rl" || writingMode === "sideways-rl" ? "right" : "left";
  return {
    blockStart,
    blockEnd: blockStart === "right" ? "left" : "right",
    inlineStart: direction === "ltr" ? "top" : "bottom",
    inlineEnd: direction === "ltr" ? "bottom" : "top",
  };
}

const emptyEdge = <T extends CollapsedBorderSource>(): CollapsedBorderEdge<T> => ({ winner: null, doNotFill: false });

export function createCollapsedBorderGrid<T extends CollapsedBorderSource>(rows: number, columns: number): CollapsedBorderGrid<T> {
  return {
    rows,
    columns,
    rowAxis: Array.from({ length: rows + 1 }, () => Array.from({ length: columns }, () => emptyEdge<T>())),
    columnAxis: Array.from({ length: rows }, () => Array.from({ length: columns + 1 }, () => emptyEdge<T>())),
  };
}

function shouldReplaceCollapsedEdge<T extends CollapsedBorderSource>(source: T, edge: CollapsedBorderEdge<T>): boolean {
  if (edge.doNotFill) return false;
  const current = edge.winner;
  if (current == null || source.style === "hidden") return true;
  if (current.style === "hidden") return false;
  if (source.w !== current.w) return source.w > current.w;
  return (COLLAPSED_BORDER_STYLE_RANK[source.style] ?? 0) > (COLLAPSED_BORDER_STYLE_RANK[current.style] ?? 0);
}

function mergeCollapsedEdge<T extends CollapsedBorderSource>(edge: CollapsedBorderEdge<T>, source: T | null): void {
  if (source == null || source.style === "none") return;
  if (shouldReplaceCollapsedEdge(source, edge)) edge.winner = source;
}

/** Transcribes TableBorders::MergeBorders for one table part. Callers invoke
 * this in Blink traversal order: cells, rows, sections, columns, column
 * groups, then table. Exact ties deliberately retain the existing edge. */
export function mergeCollapsedBorderBox<T extends CollapsedBorderSource>(
  grid: CollapsedBorderGrid<T>,
  row: number,
  column: number,
  rowspan: number,
  colspan: number,
  physical: Partial<Record<CollapsedBorderPhysicalSide, T>>,
  writingMode: CollapsedBorderWritingMode,
  direction: CollapsedBorderDirection,
  markSpanInteriors = false,
): void {
  const rowEnd = Math.min(grid.rows, row + rowspan);
  const columnEnd = Math.min(grid.columns, column + colspan);
  if (row < 0 || column < 0 || row >= rowEnd || column >= columnEnd) return;
  const logical = physicalSidesForTable(writingMode, direction);
  for (let c = column; c < columnEnd; c++) {
    mergeCollapsedEdge(grid.rowAxis[row][c], physical[logical.blockStart] ?? null);
    mergeCollapsedEdge(grid.rowAxis[rowEnd][c], physical[logical.blockEnd] ?? null);
  }
  for (let r = row; r < rowEnd; r++) {
    mergeCollapsedEdge(grid.columnAxis[r][column], physical[logical.inlineStart] ?? null);
    mergeCollapsedEdge(grid.columnAxis[r][columnEnd], physical[logical.inlineEnd] ?? null);
  }
  if (!markSpanInteriors || (rowEnd - row <= 1 && columnEnd - column <= 1)) return;
  for (let r = row; r < rowEnd; r++) {
    for (let c = column + 1; c < columnEnd; c++) {
      const edge = grid.columnAxis[r][c];
      if (edge.winner == null) edge.doNotFill = true;
    }
  }
  for (let r = row + 1; r < rowEnd; r++) {
    for (let c = column; c < columnEnd; c++) {
      const edge = grid.rowAxis[r][c];
      if (edge.winner == null) edge.doNotFill = true;
    }
  }
}

const canPaintCollapsedEdge = <T extends CollapsedBorderSource>(edge: CollapsedBorderEdge<T> | null): edge is CollapsedBorderEdge<T> & { winner: T } =>
  edge?.winner != null && edge.winner.style !== "none" && edge.winner.style !== "hidden" && edge.winner.w > 0;

/** Mirrors TableCollapsedEdge::CompareForPaint: 1 means lhs wins, -1 means
 * rhs wins, and 0 is an exact tie. Hidden participates differently here than
 * in merge precedence because hidden edges do not paint a joint. */
export function compareCollapsedEdgesForPaint<T extends CollapsedBorderSource>(
  lhs: CollapsedBorderEdge<T> | null,
  rhs: CollapsedBorderEdge<T> | null,
): -1 | 0 | 1 {
  const lp = canPaintCollapsedEdge(lhs), rp = canPaintCollapsedEdge(rhs);
  if (lp && rp) {
    if (lhs.winner.w !== rhs.winner.w) return lhs.winner.w > rhs.winner.w ? 1 : -1;
    if (lhs.winner.style === rhs.winner.style) {
      if (lhs.winner.order === rhs.winner.order) return 0;
      return lhs.winner.order < rhs.winner.order ? 1 : -1;
    }
    return (COLLAPSED_BORDER_STYLE_RANK[lhs.winner.style] ?? 0) > (COLLAPSED_BORDER_STYLE_RANK[rhs.winner.style] ?? 0) ? 1 : -1;
  }
  if (!lp && !rp) return 0;
  return lp ? 1 : -1;
}

const winnerWidth = <T extends CollapsedBorderSource>(edge: CollapsedBorderEdge<T> | null): number =>
  canPaintCollapsedEdge(edge) ? edge.winner.w : 0;

const edgeAt = <T extends CollapsedBorderSource>(rows: Array<Array<CollapsedBorderEdge<T>>>, row: number, column: number): CollapsedBorderEdge<T> | null =>
  row >= 0 && row < rows.length && column >= 0 && column < rows[row].length ? rows[row][column] : null;

// TableBorders stores each block-axis edge immediately before the row-axis
// edge to its right. TablePainter walks that single array directly, so this
// order is observable when equally ranked edges both paint a joint.
const collapsedBorderPaintIndex = <T extends CollapsedBorderSource>(
  rect: CollapsedBorderLogicalRect<T>,
  columns: number,
): number => rect.row * (columns + 1) * 2 + rect.column * 2 + (rect.axis === "row" ? 1 : 0);

function jointDecision<T extends CollapsedBorderSource>(
  before: CollapsedBorderEdge<T> | null,
  after: CollapsedBorderEdge<T> | null,
  over: CollapsedBorderEdge<T> | null,
  under: CollapsedBorderEdge<T> | null,
  axis: "row" | "column",
  end: boolean,
  overFragmentBoundary = false,
  underFragmentBoundary = false,
): { inlineWidth: number; blockWidth: number; wins: boolean } {
  if (!end) {
    if (overFragmentBoundary) over = null;
    if (underFragmentBoundary && axis === "row") under = null;
  } else {
    if (overFragmentBoundary && axis === "row") over = null;
    if (underFragmentBoundary) under = null;
  }
  const inlineCompare = compareCollapsedEdgesForPaint(before, after);
  const inlineWinner = inlineCompare === 1 ? before : after;
  const blockCompare = compareCollapsedEdgesForPaint(over, under);
  const blockWinner = blockCompare === 1 ? over : under;
  const inlineVsBlock = compareCollapsedEdgesForPaint(inlineWinner, blockWinner);
  const wins = axis === "row"
    ? inlineVsBlock !== -1 && inlineCompare !== (end ? -1 : 1)
    : inlineVsBlock !== 1 && blockCompare !== (end ? -1 : 1);
  const blockWidthSuppressed = !end
    ? overFragmentBoundary || (underFragmentBoundary && axis === "row")
    : (overFragmentBoundary && axis === "row") || underFragmentBoundary;
  return {
    inlineWidth: winnerWidth(blockWinner),
    blockWidth: blockWidthSuppressed ? 0 : winnerWidth(inlineWinner),
    wins,
  };
}

/** Fragmented counterpart of `collapsedBorderLogicalRects`, transcribed from
 * TablePainter::PaintCollapsedBorders. Each entry is one table-section
 * fragment in paint order; coordinates are local to the containing table
 * fragment and may therefore include repeated header/footer sections. */
export function collapsedBorderFragmentLogicalRects<T extends CollapsedBorderSource>(
  grid: CollapsedBorderGrid<T>,
  inlineLines: number[],
  sections: CollapsedBorderSectionFragment[],
): Array<CollapsedBorderLogicalRect<T>> {
  if (inlineLines.length !== grid.columns + 1)
    throw new Error("collapsed-border inline tracks do not match the edge grid");
  const rects: Array<CollapsedBorderLogicalRect<T>> = [];
  let previousPaintedRow: number | null = null;
  for (const section of sections) {
    const sectionRectStart = rects.length;
    const lines = section.blockLines;
    if (lines.length < 2) continue;
    const finalRowEdge = section.rowStart + lines.length - 1;
    for (let tableRow = section.rowStart; tableRow <= finalRowEdge; tableRow++) {
      const localRow = tableRow - section.rowStart;
      const startRow = localRow === 0;
      const endRow = localRow === lines.length - 1;
      const startFragmented = startRow && section.startRowFragmented === true;
      const endFragmented = endRow && section.endRowFragmented === true;
      const overBoundary = startRow && section.hasContentBefore === true;
      const underBoundary = endRow && section.hasContentAfter === true;

      if (!startFragmented && !endFragmented && previousPaintedRow !== tableRow) {
        for (let column = 0; column < grid.columns; column++) {
          const edge = edgeAt(grid.rowAxis, tableRow, column);
          if (!canPaintCollapsedEdge(edge)) continue;
          const start = jointDecision(
            edgeAt(grid.rowAxis, tableRow, column - 1), edge,
            edgeAt(grid.columnAxis, tableRow - 1, column), edgeAt(grid.columnAxis, tableRow, column),
            "row", false, overBoundary, underBoundary,
          );
          const end = jointDecision(
            edge, edgeAt(grid.rowAxis, tableRow, column + 1),
            edgeAt(grid.columnAxis, tableRow - 1, column + 1), edgeAt(grid.columnAxis, tableRow, column + 1),
            "row", true, overBoundary, underBoundary,
          );
          let inlineStart = inlineLines[column];
          let inlineSize = inlineLines[column + 1] - inlineStart;
          const startDelta = start.inlineWidth / 2;
          inlineStart += start.wins ? -startDelta : startDelta;
          inlineSize += start.wins ? startDelta : -startDelta;
          const endDelta = end.inlineWidth / 2;
          inlineSize += end.wins ? endDelta : -endDelta;
          const width = edge.winner.w;
          rects.push({
            axis: "row", row: tableRow, column,
            inlineStart,
            blockStart: overBoundary ? lines[localRow] : lines[localRow] - width / 2,
            inlineSize,
            blockSize: overBoundary || underBoundary ? width / 2 : width,
            winner: edge.winner,
          });
        }
      }

      if (localRow + 1 >= lines.length) continue;
      const endSegmentRow = localRow + 1 === lines.length - 1;
      const endSegmentFragmented = endSegmentRow && section.endRowFragmented === true;
      const underSegmentBoundary = endSegmentRow && section.hasContentAfter === true;
      for (let column = 0; column <= grid.columns; column++) {
        const edge = edgeAt(grid.columnAxis, tableRow, column);
        if (!canPaintCollapsedEdge(edge)) continue;
        const start = jointDecision(
          edgeAt(grid.rowAxis, tableRow, column - 1), edgeAt(grid.rowAxis, tableRow, column),
          edgeAt(grid.columnAxis, tableRow - 1, column), edge,
          "column", false, overBoundary, underSegmentBoundary,
        );
        const end = jointDecision(
          edgeAt(grid.rowAxis, tableRow + 1, column - 1), edgeAt(grid.rowAxis, tableRow + 1, column),
          edge, edgeAt(grid.columnAxis, tableRow + 1, column),
          "column", true, overBoundary, underSegmentBoundary,
        );
        let blockStart = lines[localRow];
        let blockSize = lines[localRow + 1] - blockStart;
        if (!startFragmented) {
          const delta = start.blockWidth / 2;
          blockStart += start.wins ? -delta : delta;
          blockSize += start.wins ? delta : -delta;
        }
        if (!endSegmentFragmented) {
          const delta = end.blockWidth / 2;
          blockSize += end.wins ? delta : -delta;
        }
        rects.push({
          axis: "column", row: tableRow, column,
          inlineStart: inlineLines[column] - edge.winner.w / 2,
          blockStart, inlineSize: edge.winner.w, blockSize, winner: edge.winner,
        });
      }
    }
    const sectionRects = rects.splice(sectionRectStart);
    sectionRects.sort((a, b) => collapsedBorderPaintIndex(a, grid.columns) - collapsedBorderPaintIndex(b, grid.columns));
    rects.push(...sectionRects);
    previousPaintedRow = section.endRowFragmented ? null : finalRowEdge;
  }
  return rects;
}

/** Transcribes the non-fragmented geometry portion of
 * TablePainter::PaintCollapsedBorders. Track coordinates are logical and must
 * be in increasing inline/block order; conversion to physical coordinates is
 * deliberately a separate capture concern. */
export function collapsedBorderLogicalRects<T extends CollapsedBorderSource>(
  grid: CollapsedBorderGrid<T>,
  inlineLines: number[],
  blockLines: number[],
): Array<CollapsedBorderLogicalRect<T>> {
  if (inlineLines.length !== grid.columns + 1 || blockLines.length !== grid.rows + 1)
    throw new Error("collapsed-border track coordinates do not match the edge grid");
  const rects: Array<CollapsedBorderLogicalRect<T>> = [];
  for (let row = 0; row <= grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const edge = grid.rowAxis[row][column];
      if (!canPaintCollapsedEdge(edge)) continue;
      const start = jointDecision(
        edgeAt(grid.rowAxis, row, column - 1), edge,
        edgeAt(grid.columnAxis, row - 1, column), edgeAt(grid.columnAxis, row, column), "row", false,
      );
      const end = jointDecision(
        edge, edgeAt(grid.rowAxis, row, column + 1),
        edgeAt(grid.columnAxis, row - 1, column + 1), edgeAt(grid.columnAxis, row, column + 1), "row", true,
      );
      let inlineStart = inlineLines[column];
      let inlineSize = inlineLines[column + 1] - inlineStart;
      const startDelta = start.inlineWidth / 2;
      inlineStart += start.wins ? -startDelta : startDelta;
      inlineSize += start.wins ? startDelta : -startDelta;
      const endDelta = end.inlineWidth / 2;
      inlineSize += end.wins ? endDelta : -endDelta;
      rects.push({ axis: "row", row, column, inlineStart, blockStart: blockLines[row] - edge.winner.w / 2, inlineSize, blockSize: edge.winner.w, winner: edge.winner });
    }
  }
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column <= grid.columns; column++) {
      const edge = grid.columnAxis[row][column];
      if (!canPaintCollapsedEdge(edge)) continue;
      const start = jointDecision(
        edgeAt(grid.rowAxis, row, column - 1), edgeAt(grid.rowAxis, row, column),
        edgeAt(grid.columnAxis, row - 1, column), edge, "column", false,
      );
      const end = jointDecision(
        edgeAt(grid.rowAxis, row + 1, column - 1), edgeAt(grid.rowAxis, row + 1, column),
        edge, edgeAt(grid.columnAxis, row + 1, column), "column", true,
      );
      let blockStart = blockLines[row];
      let blockSize = blockLines[row + 1] - blockStart;
      const startDelta = start.blockWidth / 2;
      blockStart += start.wins ? -startDelta : startDelta;
      blockSize += start.wins ? startDelta : -startDelta;
      const endDelta = end.blockWidth / 2;
      blockSize += end.wins ? endDelta : -endDelta;
      rects.push({ axis: "column", row, column, inlineStart: inlineLines[column] - edge.winner.w / 2, blockStart, inlineSize: edge.winner.w, blockSize, winner: edge.winner });
    }
  }
  rects.sort((a, b) => collapsedBorderPaintIndex(a, grid.columns) - collapsedBorderPaintIndex(b, grid.columns));
  return rects;
}
