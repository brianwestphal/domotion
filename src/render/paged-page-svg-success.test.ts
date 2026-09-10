import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("../capture/paged-page-record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../capture/paged-page-record.js")>();
  return {
    ...actual,
    isLiveAuthenticatedPagedPageRecord: (value: unknown) =>
      typeof value === "object" && value != null
      && (value as { status?: unknown }).status === "authenticated",
  };
});

import {
  buildPagedCollapsedTableRecord,
  PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
} from "../capture/paged-collapsed-table-record.js";
import {
  PAGED_PAGE_RECORD_ABI,
  PAGED_PAGE_RECORD_CHROMIUM_REVISION,
  type AuthenticatedPagedPageRecord,
} from "../capture/paged-page-record.js";
import { renderAuthenticatedPagedSvgPages } from "./paged-page-svg.js";

const svg = '<?xml version="1.0" encoding="UTF-8"?><svg width="120" height="90" viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>';
const printParametersSha256 = "a".repeat(64);
const tableTransportSha256 = "d".repeat(64);

function structurallyAuthenticatedRecord(): AuthenticatedPagedPageRecord {
  const collapsedTables = buildPagedCollapsedTableRecord({
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
  if (collapsedTables.status !== "authenticated") throw new Error(collapsedTables.reason);
  const rect = { x: 0, y: 0, width: 120, height: 90 };
  return {
    schemaVersion: 1, helperAbi: PAGED_PAGE_RECORD_ABI, status: "authenticated",
    sourceRevision: PAGED_PAGE_RECORD_CHROMIUM_REVISION,
    capturePhase: "per-page-after-paint-before-record-consumption",
    coordinateUnit: "css-px-with-explicit-native-coordinate-spaces",
    paintSource: "finalized-cc-PaintRecord-replayed-by-pinned-SkSVGCanvas",
    pdfOrScreenshotUsedAsInput: false, transportByteLength: 1_000,
    document: {
      frameToken: "frame-1", documentToken: "document-1", loaderId: "loader-1",
      url: "https://example.test/", printEpochId: tableTransportSha256, printParametersSha256,
      pageTransportByteLength: 500, tableTransportByteLength: 500,
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
        occurrenceId: "page:0", parentOccurrenceId: null, sequence: 0, kind: "page-container",
        offsetInParentPhysical: { x: 0, y: 0 }, size: { width: 120, height: 90 },
        scrollableOverflowLocal: rect, parentCoordinateDomain: "page-container-target",
        localCoordinateDomain: "page-container-target", writingMode: "horizontal-tb", direction: "ltr",
        effectiveZoom: 1, breakBefore: 0, breakAfter: 0, backendNodeId: null,
        sourceIndex: null, sourceOccurrenceIndex: null, breakToken: null, inlineItems: [],
      }],
      vectorPaint: {
        kind: "preflighted-skia-svg-v1", svg, svgByteLength: Buffer.byteLength(svg),
        svgSha256: createHash("sha256").update(svg).digest("hex"), sourcePaintOpCount: 1,
        sourcePaintOpTypes: ["DrawPath"], unsupportedPaintOps: [], recursivePreflightComplete: true,
        textConvertedToPaths: true, externalReferences: false,
      },
    }],
    collapsedTables,
  };
}

describe("authenticated paged SVG renderer success path", () => {
  it("passes through exact native SVG bytes after the live-brand gate", () => {
    const record = structurallyAuthenticatedRecord();
    const pages = renderAuthenticatedPagedSvgPages(record);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      selectionIndex: 0, pageIndex: 0, pageNumber: 1, emptyKind: "terminal-empty",
      widthCssPx: 120, heightCssPx: 90, svg,
      svgByteLength: Buffer.byteLength(svg), collapsedBorderRectCount: 0,
    });
    expect(pages[0].svgSha256).toBe(record.pages[0].vectorPaint.svgSha256);
  });
});
