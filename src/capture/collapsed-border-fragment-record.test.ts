import { describe, expect, it } from "vitest";

import {
  buildCollapsedBorderFragmentRecord,
  validateCollapsedBorderFragmentRecord,
  type CollapsedBorderFragmentGeometryEvidence,
  type CollapsedBorderFragmentRecordInput,
  type CollapsedBorderPhysicalRect,
} from "./collapsed-border-fragment-record.js";

function quad(rect: CollapsedBorderPhysicalRect): number[] {
  return [
    rect.x, rect.y,
    rect.x + rect.width, rect.y,
    rect.x + rect.width, rect.y + rect.height,
    rect.x, rect.y + rect.height,
  ];
}

function geometry(...rects: CollapsedBorderPhysicalRect[]): CollapsedBorderFragmentGeometryEvidence {
  return { cssomRects: rects, cdpQuads: rects.map(quad) };
}

function input(): CollapsedBorderFragmentRecordInput {
  const first = { x: 0, y: 0, width: 100.25, height: 50.5 };
  const second = { x: 110.5, y: 0, width: 100.25, height: 50.5 };
  return {
    writingMode: "horizontal-tb",
    direction: "ltr",
    totalRows: 2,
    totalColumns: 2,
    table: geometry(first, second),
    sections: [{
      sourceIndex: 0,
      tableChildIndex: 0,
      tag: "tbody",
      globalStartRowIndex: 0,
      globalRowCount: 2,
      geometry: geometry(first, second),
    }],
    rows: [
      { sourceIndex: 0, sectionSourceIndex: 0, globalRowIndex: 0, geometry: geometry(first) },
      { sourceIndex: 1, sectionSourceIndex: 0, globalRowIndex: 1, geometry: geometry(second) },
    ],
    cells: [
      { sourceIndex: 0, globalRowIndex: 0, globalColumnIndex: 0, rowSpan: 1, columnSpan: 1, geometry: geometry({ x: 0, y: 0, width: 40.125, height: 50.5 }) },
      { sourceIndex: 1, globalRowIndex: 0, globalColumnIndex: 1, rowSpan: 1, columnSpan: 1, geometry: geometry({ x: 40.125, y: 0, width: 60.125, height: 50.5 }) },
      { sourceIndex: 2, globalRowIndex: 1, globalColumnIndex: 0, rowSpan: 1, columnSpan: 1, geometry: geometry({ x: 110.5, y: 0, width: 40.125, height: 50.5 }) },
      { sourceIndex: 3, globalRowIndex: 1, globalColumnIndex: 1, rowSpan: 1, columnSpan: 1, geometry: geometry({ x: 150.625, y: 0, width: 60.125, height: 50.5 }) },
    ],
    captions: [],
    sourceRestoredExactly: true,
  };
}

function repeatedInput(prefixFragments = 0, trailingFragments = 0): CollapsedBorderFragmentRecordInput {
  const tableFragments = Array.from({ length: prefixFragments + 3 + trailingFragments }, (_, index) => ({
    x: index * 110,
    y: 0,
    width: 100,
    height: 100,
  }));
  const active = [prefixFragments, prefixFragments + 1, prefixFragments + 2];
  const prototypeTable = tableFragments[active[0]];
  const header = { x: prototypeTable.x, y: 2, width: 100, height: 20 };
  const footer = { x: prototypeTable.x, y: 78, width: 100, height: 20 };
  const bodyRects = active.map((fragmentIndex) => ({
    x: tableFragments[fragmentIndex].x,
    y: 22,
    width: 100,
    height: 56,
  }));
  const eligibility = (sectionBlockSize: number) => ({
    fragmentationType: "column" as const,
    fragmentainerBlockSize: 100,
    sectionBlockSize,
    knownFragmentainerBlockSize: true,
    atMostQuarterFragmentainer: true,
    applicableBreakInsideAvoid: true,
    noBreakInside: true,
    noLateStart: true,
    outsideNestedRepeatableContent: true,
    layoutSideEffectsEnabled: true,
  });
  return {
    writingMode: "horizontal-tb",
    direction: "ltr",
    totalRows: 5,
    totalColumns: 1,
    table: geometry(...tableFragments),
    sections: [
      { sourceIndex: 0, tableChildIndex: 1, tag: "thead", globalStartRowIndex: 0, globalRowCount: 1, geometry: geometry(header, header, header) },
      { sourceIndex: 1, tableChildIndex: 2, tag: "tbody", globalStartRowIndex: 1, globalRowCount: 3, geometry: geometry(...bodyRects) },
      { sourceIndex: 2, tableChildIndex: 3, tag: "tfoot", globalStartRowIndex: 4, globalRowCount: 1, geometry: geometry(footer, footer, footer) },
    ],
    rows: [
      { sourceIndex: 0, sectionSourceIndex: 0, globalRowIndex: 0, geometry: geometry(header, header, header) },
      ...bodyRects.map((rect, index) => ({
        sourceIndex: index + 1,
        sectionSourceIndex: 1,
        globalRowIndex: index + 1,
        geometry: geometry(rect),
      })),
      { sourceIndex: 4, sectionSourceIndex: 2, globalRowIndex: 4, geometry: geometry(footer, footer, footer) },
    ],
    cells: [
      { sourceIndex: 0, globalRowIndex: 0, globalColumnIndex: 0, rowSpan: 1, columnSpan: 1, geometry: geometry(header, header, header) },
      ...bodyRects.map((rect, index) => ({
        sourceIndex: index + 1,
        globalRowIndex: index + 1,
        globalColumnIndex: 0,
        rowSpan: 1,
        columnSpan: 1,
        geometry: geometry(rect),
      })),
      { sourceIndex: 4, globalRowIndex: 4, globalColumnIndex: 0, rowSpan: 1, columnSpan: 1, geometry: geometry(footer, footer, footer) },
    ],
    captions: prefixFragments === 0 ? [] : [{
      sourceIndex: 0,
      tableChildIndex: 0,
      geometry: geometry({ x: tableFragments[0].x, y: 0, width: 100, height: 20 }),
    }],
    repeatSections: [
      {
        sectionSourceIndex: 0,
        repeatKind: "header",
        eligibility: eligibility(20),
        occurrences: active.map((fragmentIndex, occurrenceIndex) => ({
          occurrenceIndex,
          fragmentIndex,
          physicalRect: { x: tableFragments[fragmentIndex].x, y: 2, width: 100, height: 20 },
          expectedCellSourceIndices: [0],
          witnessedCellSourceIndices: [0],
          hitTest: "Document.elementsFromPoint-intrinsic-source-cell-membership",
        })),
      },
      {
        sectionSourceIndex: 2,
        repeatKind: "footer",
        eligibility: eligibility(20),
        occurrences: active.map((fragmentIndex, occurrenceIndex) => ({
          occurrenceIndex,
          fragmentIndex,
          physicalRect: { x: tableFragments[fragmentIndex].x, y: 78, width: 100, height: 20 },
          expectedCellSourceIndices: [4],
          witnessedCellSourceIndices: [4],
          hitTest: "Document.elementsFromPoint-intrinsic-source-cell-membership",
        })),
      },
    ],
    sourceRestoredExactly: true,
  };
}

describe("collapsed-border physical section-fragment records", () => {
  it("retains exact fractional columns, global rows, and half-edge ownership inputs", () => {
    const record = buildCollapsedBorderFragmentRecord(input());
    expect(record.status).toBe("authenticated");
    if (record.status !== "authenticated") return;
    expect(validateCollapsedBorderFragmentRecord(record)).toEqual([]);
    expect(record.globalColumnOffsets).toEqual([0, 40.125, 100.25]);
    expect(record.tableFragments.map((fragment) => fragment.physicalTableFragmentId)).toEqual([
      "table-fragment:0",
      "table-fragment:1",
    ]);
    expect(record.tableFragments[0].sectionFragments[0]).toMatchObject({
      globalStartRowIndex: 0,
      logicalRowOffsets: [0, 50.5],
      hasContentBefore: false,
      hasContentAfter: true,
      startContinuedRow: false,
      endContinuedRow: false,
    });
    expect(record.tableFragments[1].sectionFragments[0]).toMatchObject({
      globalStartRowIndex: 1,
      hasContentBefore: true,
      hasContentAfter: false,
    });
  });

  it("rejects CSSOM/CDP drift before any private-equivalent state is promoted", () => {
    const candidate = input();
    candidate.rows[0].geometry.cdpQuads[0][2] += 1 / 64;
    candidate.rows[0].geometry.cdpQuads[0][4] += 1 / 64;
    const record = buildCollapsedBorderFragmentRecord(candidate);
    expect(record).toMatchObject({ status: "unavailable" });
    if (record.status === "unavailable") expect(record.reason).toContain("CSSOM/CDP fragment 0 differs");
  });

  it("rejects aliased repeat rectangles without explicit occurrence ownership", () => {
    const candidate = input();
    const alias = candidate.sections[0].geometry.cssomRects[0];
    candidate.sections[0].geometry = geometry(alias, alias);
    const record = buildCollapsedBorderFragmentRecord(candidate);
    expect(record).toMatchObject({ status: "unavailable" });
    if (record.status === "unavailable") expect(record.reason).toContain("occurrence ownership");
  });

  it("kills hostile wrong-row and wrong-fragment mutations", () => {
    const record = buildCollapsedBorderFragmentRecord(input());
    expect(record.status).toBe("authenticated");
    if (record.status !== "authenticated") return;
    const wrongRow = structuredClone(record);
    wrongRow.tableFragments[0].sectionFragments[0].globalStartRowIndex = 1;
    expect(validateCollapsedBorderFragmentRecord(wrongRow)).toContain(
      "section global start row disagrees with its first row",
    );
    const wrongFragment = structuredClone(record);
    wrongFragment.tableFragments[0].sectionFragments[0].fragmentIndex = 1;
    expect(validateCollapsedBorderFragmentRecord(wrongFragment)).toContain(
      "section belongs to the wrong physical table fragment",
    );
  });

  it("records exact header/footer clones, rows, roles, edge reservations, and paint slots", () => {
    const record = buildCollapsedBorderFragmentRecord(repeatedInput());
    expect(record.status).toBe("authenticated");
    if (record.status !== "authenticated") return;
    expect(validateCollapsedBorderFragmentRecord(record)).toEqual([]);
    expect(record.tableFragments.map((fragment) => fragment.tableBoxState)).toEqual([
      "first-table-box",
      "middle-table-box",
      "last-table-box",
    ]);
    const sections = record.tableFragments.flatMap((fragment) => fragment.sectionFragments);
    expect(sections.filter((section) => section.repeatRole.endsWith("header"))).toMatchObject([
      { repeatRole: "original-header", repeatOccurrenceIndex: 0, sectionPaintSlot: 0, logicalRowOffsets: [2, 22] },
      { repeatRole: "repeated-header", repeatOccurrenceIndex: 1, sectionPaintSlot: 0, logicalRowOffsets: [2, 22] },
      { repeatRole: "repeated-header", repeatOccurrenceIndex: 2, sectionPaintSlot: 0, logicalRowOffsets: [2, 22] },
    ]);
    expect(sections.filter((section) => section.repeatRole.endsWith("footer"))).toMatchObject([
      { repeatRole: "original-footer", repeatOccurrenceIndex: 0, sectionPaintSlot: 2, logicalRowOffsets: [78, 98] },
      { repeatRole: "repeated-footer", repeatOccurrenceIndex: 1, sectionPaintSlot: 2, logicalRowOffsets: [78, 98] },
      { repeatRole: "repeated-footer", repeatOccurrenceIndex: 2, sectionPaintSlot: 2, logicalRowOffsets: [78, 98] },
    ]);
    expect(sections.filter((section) => section.repeatRole.endsWith("header"))
      .map((section) => section.reservedCollapsedEdgeSpace)).toEqual([
      { side: "block-start", amount: 2, globalRowEdgeIndex: 0, tableEdgeIncludedInThisFragment: true },
      { side: "block-start", amount: 2, globalRowEdgeIndex: 0, tableEdgeIncludedInThisFragment: false },
      { side: "block-start", amount: 2, globalRowEdgeIndex: 0, tableEdgeIncludedInThisFragment: false },
    ]);
  });

  it("distinguishes caption-only before-table-box and empty trailing physical fragments", () => {
    const record = buildCollapsedBorderFragmentRecord(repeatedInput(1, 1));
    expect(record.status).toBe("authenticated");
    if (record.status !== "authenticated") return;
    expect(record.tableFragments.map((fragment) => fragment.tableBoxState)).toEqual([
      "caption-only-before-table-box",
      "first-table-box",
      "middle-table-box",
      "last-table-box",
      "empty-after-table-box",
    ]);
    expect(record.tableFragments[0].captionPaintSlots).toHaveLength(1);
    expect(record.tableFragments[4].sectionFragments).toEqual([]);
  });

  it("rejects every repeat eligibility negative without synthesizing an occurrence", () => {
    const keys = [
      "knownFragmentainerBlockSize",
      "atMostQuarterFragmentainer",
      "applicableBreakInsideAvoid",
      "noBreakInside",
      "noLateStart",
      "outsideNestedRepeatableContent",
      "layoutSideEffectsEnabled",
    ] as const;
    for (const key of keys) {
      const candidate = repeatedInput();
      candidate.repeatSections![0].eligibility[key] = false;
      if (key === "atMostQuarterFragmentainer") {
        candidate.repeatSections![0].eligibility.sectionBlockSize = 26;
        candidate.sections[0].geometry = geometry(
          { x: 0, y: 2, width: 100, height: 26 },
          { x: 0, y: 2, width: 100, height: 26 },
          { x: 0, y: 2, width: 100, height: 26 },
        );
      }
      const record = buildCollapsedBorderFragmentRecord(candidate);
      expect(record.status, key).toBe("unavailable");
      if (record.status === "unavailable") expect(record.reason, key).toContain("eligibility");
    }
  });

  it("kills occurrence drop, duplication, reorder, wrong-source, wrong-role, wrong-row, and wrong-edge mutations", () => {
    const dropped = repeatedInput();
    dropped.repeatSections![0].occurrences.splice(1, 1);
    expect(buildCollapsedBorderFragmentRecord(dropped)).toMatchObject({ status: "unavailable" });

    const duplicated = repeatedInput();
    duplicated.repeatSections![0].occurrences.push(structuredClone(duplicated.repeatSections![0].occurrences[2]));
    expect(buildCollapsedBorderFragmentRecord(duplicated)).toMatchObject({ status: "unavailable" });

    const reordered = repeatedInput();
    [reordered.repeatSections![0].occurrences[1], reordered.repeatSections![0].occurrences[2]] =
      [reordered.repeatSections![0].occurrences[2], reordered.repeatSections![0].occurrences[1]];
    expect(buildCollapsedBorderFragmentRecord(reordered)).toMatchObject({ status: "unavailable" });

    const record = buildCollapsedBorderFragmentRecord(repeatedInput());
    expect(record.status).toBe("authenticated");
    if (record.status !== "authenticated") return;
    const repeat = record.tableFragments[1].sectionFragments[0];

    const wrongSource = structuredClone(record);
    wrongSource.tableFragments[1].sectionFragments[0].sectionSourceIndex = 99;
    expect(validateCollapsedBorderFragmentRecord(wrongSource).join("; ")).toContain("series");

    const wrongRole = structuredClone(record);
    wrongRole.tableFragments[1].sectionFragments[0].repeatRole = "original-header";
    expect(validateCollapsedBorderFragmentRecord(wrongRole)).toContain(
      "repeat occurrence role disagrees with its sequence index",
    );

    const wrongRow = structuredClone(record);
    wrongRow.tableFragments[1].sectionFragments[0].globalStartRowIndex = 1;
    expect(validateCollapsedBorderFragmentRecord(wrongRow)).toContain(
      "selected repeat header does not own global row start zero",
    );

    const wrongEdge = structuredClone(record);
    wrongEdge.tableFragments[1].sectionFragments[0].reservedCollapsedEdgeSpace!.side = "block-end";
    expect(validateCollapsedBorderFragmentRecord(wrongEdge)).toContain(
      "repeat reserved collapsed-edge ownership is wrong",
    );

    const wrongAmount = structuredClone(record);
    wrongAmount.tableFragments[1].sectionFragments[0].reservedCollapsedEdgeSpace!.amount += 1 / 64;
    expect(validateCollapsedBorderFragmentRecord(wrongAmount)).toContain(
      "repeat reserved collapsed-edge amount changed",
    );
    expect(repeat.repeatEligibility).not.toBeNull();
  });
});
