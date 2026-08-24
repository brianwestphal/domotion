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
});
