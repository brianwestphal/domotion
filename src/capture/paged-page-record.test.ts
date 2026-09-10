import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildPagedCollapsedTableRecord,
  PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
  type AuthenticatedPagedCollapsedTableRecord,
} from "./paged-collapsed-table-record.js";
import {
  PAGED_PAGE_RECORD_ABI,
  PAGED_PAGE_RECORD_CHROMIUM_REVISION,
  parsePagedPageRecord,
  unavailablePagedPageRecord,
  validateAuthenticatedPagedPageRecord,
  type AuthenticatedPagedPageRecord,
} from "./paged-page-record.js";

const rect = { x: 0, y: 0, width: 420, height: 320 };
const svg = '<?xml version="1.0" encoding="UTF-8"?><svg width="420" height="320" viewBox="0 0 420 320" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>';
const printParametersSha256 = "a".repeat(64);
const tableTransportSha256 = "d".repeat(64);

function collapsed(): AuthenticatedPagedCollapsedTableRecord {
  const result = buildPagedCollapsedTableRecord({
    sourceRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
    printEpoch: {
      epochId: tableTransportSha256, documentLoaderId: "loader-1", frameToken: "frame-1",
      documentToken: "document-1", documentUrl: "https://example.test/",
      printCaptureId: "11111111-1111-4111-8111-111111111111",
      browserVersion: "HeadlessChrome/140.0.0.0", protocolVersion: "1.3",
      printParametersSha256, lifecycle: "PrintBegin-to-PrintEnd",
      logicalTransport: "blink-private-physical-fragment-tree-v1",
      logicalFactsDerivedFromPdfVectorOrRaster: false, sourceRestoredExactly: true,
    },
    pages: [{ pageIndex: 0, pageName: null, emptyKind: "terminal-empty", tableOccurrences: [] }],
  });
  if (result.status !== "authenticated") throw new Error(result.reason);
  return result;
}

function validatedShape(): AuthenticatedPagedPageRecord {
  return {
    schemaVersion: 1, helperAbi: PAGED_PAGE_RECORD_ABI, status: "authenticated",
    sourceRevision: PAGED_PAGE_RECORD_CHROMIUM_REVISION,
    capturePhase: "per-page-after-paint-before-record-consumption",
    coordinateUnit: "css-px-with-explicit-native-coordinate-spaces",
    paintSource: "finalized-cc-PaintRecord-replayed-by-pinned-SkSVGCanvas",
    pdfOrScreenshotUsedAsInput: false, transportByteLength: Buffer.byteLength(svg),
    document: {
      frameToken: "frame-1", documentToken: "document-1", loaderId: "loader-1",
      url: "https://example.test/", printEpochId: tableTransportSha256, printParametersSha256,
      pageTransportByteLength: 100, tableTransportByteLength: 100,
      pageTransportSha256: "c".repeat(64), tableTransportSha256,
      captureAuthoritySha256: "b".repeat(64),
    },
    pages: [{
      selectionIndex: 0, pageIndex: 0, pageName: null, emptyKind: "terminal-empty",
      pageRect: rect, pageContainer: rect, pageBorderBox: rect, pageArea: rect,
      stitchedContentRect: rect, targetScale: 1,
      geometrySpaces: {
        pageRect: "paint-cull-layout-css-px", pageContainer: "page-container-target-css-px",
        pageBorderBox: "page-container-target-css-px", pageArea: "page-container-target-css-px",
        fragments: "native-local-explicit-per-fragment", stitchedContentRect: "layout-stitched-css-px",
      },
      fragments: [{
        occurrenceId: "page:0/fragment:0", parentOccurrenceId: null, sequence: 0,
        kind: "page-container", offsetInParentPhysical: { x: 0, y: 0 },
        size: { width: 420, height: 320 }, scrollableOverflowLocal: rect,
        parentCoordinateDomain: "page-container-target", localCoordinateDomain: "page-container-target",
        writingMode: "horizontal-tb", direction: "ltr", effectiveZoom: 1,
        breakBefore: 0, breakAfter: 0,
        backendNodeId: null, sourceIndex: null, sourceOccurrenceIndex: null,
        breakToken: null, inlineItems: [],
      }],
      vectorPaint: {
        kind: "preflighted-skia-svg-v1", svg, svgByteLength: Buffer.byteLength(svg),
        svgSha256: createHash("sha256").update(svg).digest("hex"), sourcePaintOpCount: 1,
        sourcePaintOpTypes: ["DrawPath"], unsupportedPaintOps: [],
        recursivePreflightComplete: true, textConvertedToPaths: true, externalReferences: false,
      },
    }],
    collapsedTables: collapsed(),
  };
}

describe("authenticated paged page records", () => {
  it("validates the native-fact-only promoted shape without granting live authority", () => {
    expect(validateAuthenticatedPagedPageRecord(validatedShape())).toEqual([]);
  });

  it("does not upgrade self-consistent persisted JSON to live authentication", () => {
    expect(parsePagedPageRecord(JSON.stringify(validatedShape()))).toMatchObject({
      status: "unavailable", reason: "invalid-record",
      detail: "persisted JSON cannot carry live helper/process authentication",
    });
  });

  it("rejects external SVG references in a promoted shape", () => {
    const record = validatedShape();
    record.pages[0].vectorPaint.svg = '<svg width="420" height="320"><image href="https://example.test/x.png"/></svg>';
    record.pages[0].vectorPaint.svgByteLength = Buffer.byteLength(record.pages[0].vectorPaint.svg);
    record.pages[0].vectorPaint.svgSha256 = createHash("sha256").update(record.pages[0].vectorPaint.svg).digest("hex");
    expect(validateAuthenticatedPagedPageRecord(record)).toContain("vector paint is not a self-contained inert SVG");
  });

  it("rejects script-bearing data references in a promoted shape", () => {
    const record = validatedShape();
    record.pages[0].vectorPaint.svg = '<svg width="420" height="320"><image href="data:image/svg+xml,&lt;svg onload=alert(1)/&gt;"/></svg>';
    record.pages[0].vectorPaint.svgByteLength = Buffer.byteLength(record.pages[0].vectorPaint.svg);
    record.pages[0].vectorPaint.svgSha256 = createHash("sha256").update(record.pages[0].vectorPaint.svg).digest("hex");
    expect(validateAuthenticatedPagedPageRecord(record)).toContain("vector paint is not a self-contained inert SVG");
  });

  it("rejects non-finite SVG geometry in a promoted shape", () => {
    const record = validatedShape();
    record.pages[0].vectorPaint.svg = '<svg width="420" height="320" viewBox="0 0 420 320"><path d="MNaN 0L1 1"/></svg>';
    record.pages[0].vectorPaint.svgByteLength = Buffer.byteLength(record.pages[0].vectorPaint.svg);
    record.pages[0].vectorPaint.svgSha256 = createHash("sha256").update(record.pages[0].vectorPaint.svg).digest("hex");
    expect(validateAuthenticatedPagedPageRecord(record)).toContain("vector paint is not a self-contained inert SVG");
  });

  it("is total for malformed nested collapsed-table values", () => {
    const record = validatedShape() as unknown as Record<string, unknown>;
    record.collapsedTables = { status: "authenticated" };
    expect(() => validateAuthenticatedPagedPageRecord(
      record as unknown as AuthenticatedPagedPageRecord,
    )).not.toThrow();
    expect(validateAuthenticatedPagedPageRecord(
      record as unknown as AuthenticatedPagedPageRecord,
    )[0]).toMatch(/^invalid page-record shape/);
  });

  it("constructs deterministic typed unavailable records", () => {
    expect(unavailablePagedPageRecord("unsupported-paint", "mesh", {
      pageIndex: 2, unsupportedPaintOps: ["z", "a", "z"],
    })).toMatchObject({
      status: "unavailable", pageIndex: 2, unsupportedPaintOps: ["a", "z"],
      pdfOrScreenshotUsedAsInput: false,
    });
  });
});
