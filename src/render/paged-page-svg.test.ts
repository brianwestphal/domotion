import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PAGED_COLLAPSED_JOINT_PRECEDENCE,
  type PagedCollapsedTableOccurrence,
} from "../capture/paged-collapsed-table-record.js";
import {
  PAGED_PAGE_RECORD_ABI,
  PAGED_PAGE_RECORD_CHROMIUM_REVISION,
  unavailablePagedPageRecord,
  type AuthenticatedPagedPageRecord,
} from "../capture/paged-page-record.js";
import {
  PagedPageSvgRenderError,
  auditCollapsedTableLogicalRects,
  renderAuthenticatedPagedSvgPages,
} from "./paged-page-svg.js";

const joint = { precedence: PAGED_COLLAPSED_JOINT_PRECEDENCE, winner: "self" as const,
  suppressedAtFragmentBoundary: false };

function table(): PagedCollapsedTableOccurrence {
  return {
    physicalTableFragmentId: "table:0:0", tableSourceIndex: 0, occurrenceIndex: 0, pageIndex: 0,
    firstTableBox: true, lastTableBox: true, writingMode: "vertical-rl", direction: "rtl",
    fragmentationAxis: "physical-x", progression: "negative", totalRows: 1, totalColumns: 1,
    globalColumnOffsets: [0, 40],
    sectionOccurrences: [{
      physicalSectionFragmentId: "section:0:0", sectionSourceIndex: 0, sectionTag: "tbody",
      occurrenceIndex: 0, repeatRole: "body", sectionPaintSlot: 0, tableChildPaintSlot: 0,
      globalRows: { start: 0, endExclusive: 1 }, logicalRowOffsets: [0, 30],
      startBreak: { kind: "none", globalRowIndex: null }, endBreak: { kind: "none", globalRowIndex: null },
      repeatEligibility: null, reservedCollapsedEdgeSpace: { blockStart: 1, blockEnd: 1 },
    }],
    captionOccurrences: [], spanningCells: [],
    resolvedCollapsedEdgeGrid: [{
      sourceEdgeIndex: 0, axis: "block", globalRowBoundary: 0, globalColumnBoundary: 0,
      doNotFill: false, winner: { widthCssPx: 2, style: "solid", boxOrder: 0 },
    }, {
      sourceEdgeIndex: 1, axis: "inline", globalRowBoundary: 0, globalColumnBoundary: 0,
      doNotFill: false, winner: { widthCssPx: 2, style: "solid", boxOrder: 0 },
    }, {
      sourceEdgeIndex: 2, axis: "block", globalRowBoundary: 0, globalColumnBoundary: 1,
      doNotFill: false, winner: null,
    }, {
      sourceEdgeIndex: 5, axis: "inline", globalRowBoundary: 1, globalColumnBoundary: 0,
      doNotFill: false, winner: null,
    }],
    collapsedEdges: [{
      sourceEdgeIndex: 0, decisionOrder: 0, paintOrder: 0, axis: "block",
      globalRowBoundary: 0, globalColumnBoundary: 0,
      winner: { widthCssPx: 2, style: "solid", boxOrder: 0 }, disposition: "paint-full",
      logicalRectRaw: { inlineStart: -64, blockStart: -64, inlineSize: 128, blockSize: 1984 },
      startJoint: joint, endJoint: joint,
    }, {
      sourceEdgeIndex: 1, decisionOrder: 1, paintOrder: 1, axis: "inline",
      globalRowBoundary: 0, globalColumnBoundary: 0,
      winner: { widthCssPx: 2, style: "solid", boxOrder: 0 }, disposition: "paint-full",
      logicalRectRaw: { inlineStart: -64, blockStart: -64, inlineSize: 2624, blockSize: 128 },
      startJoint: joint, endJoint: joint,
    }],
  };
}

describe("authenticated paged SVG renderer", () => {
  it("exactly matches native raw LayoutUnit collapsed-border rectangles", () => {
    expect(auditCollapsedTableLogicalRects(table())).toEqual([{
      axis: "column", row: 0, column: 0, inlineStart: -1, blockStart: -1,
      inlineSize: 2, blockSize: 31, sourceEdgeIndex: 0,
      writingMode: "vertical-rl", direction: "rtl",
      logicalRectRaw: { inlineStart: -64, blockStart: -64, inlineSize: 128, blockSize: 1984 },
    }, {
      axis: "row", row: 0, column: 0, inlineStart: -1, blockStart: -1,
      inlineSize: 41, blockSize: 2, sourceEdgeIndex: 1,
      writingMode: "vertical-rl", direction: "rtl",
      logicalRectRaw: { inlineStart: -64, blockStart: -64, inlineSize: 2624, blockSize: 128 },
    }]);
  });

  it("rejects a one-raw-unit native-vs-replay drift", () => {
    const drifted = table();
    drifted.collapsedEdges[0].logicalRectRaw!.blockSize += 1;
    expect(() => auditCollapsedTableLogicalRects(drifted)).toThrow(PagedPageSvgRenderError);
  });

  it("replays every collapsed-table occurrence in the committed native ledger", () => {
    const ledger = JSON.parse(readFileSync(
      new URL("../../docs/evidence/dm2711-paged-page-logical-ledger.json", import.meta.url),
      "utf8",
    )) as { pages: Array<{ tableOccurrences: PagedCollapsedTableOccurrence[] }> };
    const tables = ledger.pages.flatMap((page) => page.tableOccurrences);
    expect(tables).toHaveLength(8);
    for (const occurrence of tables) {
      expect(auditCollapsedTableLogicalRects(occurrence).length).toBeGreaterThan(0);
    }
  });

  it("refuses unavailable and structurally forged authenticated records", () => {
    expect(() => renderAuthenticatedPagedSvgPages(
      unavailablePagedPageRecord("unsupported-paint", "DrawVertices"),
    )).toThrow(PagedPageSvgRenderError);
    const forged = { status: "authenticated", helperAbi: PAGED_PAGE_RECORD_ABI,
      sourceRevision: PAGED_PAGE_RECORD_CHROMIUM_REVISION } as AuthenticatedPagedPageRecord;
    expect(() => renderAuthenticatedPagedSvgPages(forged)).toThrow(
      "page record lacks live helper/process authentication",
    );
    const cyclic = { status: "authenticated" } as unknown as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(() => renderAuthenticatedPagedSvgPages(
      cyclic as unknown as AuthenticatedPagedPageRecord,
    )).toThrow("page record lacks live helper/process authentication");
  });
});
