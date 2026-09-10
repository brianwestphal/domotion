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
  PAGED_PAGE_RECORD_MAX_BYTES,
  PAGED_PAGE_RECORD_VERSION,
  parsePagedPageRecord,
  unavailablePagedPageRecord,
  validateAuthenticatedPagedPageRecord,
  type AuthenticatedPagedPageRecord,
} from "./paged-page-record.js";

const sha = "a".repeat(64);
const rect = { x: 0, y: 0, width: 600, height: 800 };
const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function collapsedTables(): AuthenticatedPagedCollapsedTableRecord {
  const record = buildPagedCollapsedTableRecord({
    sourceRevision: PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
    printEpoch: {
      epochId: "epoch-1",
      documentLoaderId: "loader-1",
      browserVersion: "Chrome/140.0.0.0",
      protocolVersion: "1.3",
      printParametersSha256: sha,
      lifecycle: "PrintBegin-to-PrintEnd",
      logicalTransport: "blink-private-physical-fragment-tree-v1",
      logicalFactsDerivedFromPdfVectorOrRaster: false,
      sourceRestoredExactly: true,
    },
    pages: [{ pageIndex: 0, pageName: null, emptyKind: "terminal-empty", tableOccurrences: [] }],
  });
  if (record.status !== "authenticated") throw new Error(record.reason);
  return record;
}

function record(): AuthenticatedPagedPageRecord {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800"><path d="M0 0h600v800H0z" fill="#fff"/></svg>';
  return {
    schemaVersion: PAGED_PAGE_RECORD_VERSION,
    helperAbi: PAGED_PAGE_RECORD_ABI,
    status: "authenticated",
    sourceRevision: PAGED_PAGE_RECORD_CHROMIUM_REVISION,
    capturePhase: "per-page-after-paint-before-record-consumption",
    coordinateUnit: "Blink-LayoutUnit-1/64-css-px",
    paintSource: "Blink-PaintArtifact-and-cc-PaintRecord",
    pdfOrScreenshotUsedAsInput: false,
    serializedByteLength: 2048,
    document: {
      frameToken: "frame-1",
      documentToken: "document-1",
      loaderId: "loader-1",
      url: "https://example.test/report",
      printEpochId: "epoch-1",
      printParametersSha256: sha,
      layoutGeneration: 7,
    },
    pages: [{
      selectionIndex: 0,
      pageIndex: 0,
      pageName: null,
      emptyKind: "terminal-empty",
      pageArea: rect,
      pageBorderBox: rect,
      contentArea: rect,
      stitchedContentRect: rect,
      contentClip: rect,
      contentTransform: identity,
      targetScale: 1,
      deviceScaleFactor: 1,
      writingMode: "horizontal-tb",
      direction: "ltr",
      fragments: [{
        occurrenceId: "fragment:page-area:0",
        parentOccurrenceId: null,
        source: {
          frameToken: "frame-1",
          documentToken: "document-1",
          backendNodeId: null,
          pseudo: "none",
          syntheticRole: "page-area",
        },
        fragmentKind: "box",
        childPaintOrder: 0,
        relativeOffset: { x: 0, y: 0 },
        pageTransform: identity,
        borderBox: rect,
        overflowClip: rect,
        writingMode: "horizontal-tb",
        direction: "ltr",
        effectiveZoom: 1,
        breakToken: null,
        paintClientIds: ["client:page-background"],
      }],
      propertyTrees: {
        transforms: [{ id: "transform:root", parentId: null, matrix: identity, flattensInheritedTransform: false }],
        clips: [{
          id: "clip:root",
          parentId: null,
          transformId: "transform:root",
          rect,
          radii: [0, 0, 0, 0, 0, 0, 0, 0],
        }],
        effects: [{
          id: "effect:root",
          parentId: null,
          transformId: "transform:root",
          clipId: "clip:root",
          opacity: 1,
          blendMode: "normal",
          filter: "none",
        }],
      },
      paintChunks: [{
        id: "chunk:0",
        sequence: 0,
        transformId: "transform:root",
        clipId: "clip:root",
        effectId: "effect:root",
        displayItems: [{
          id: "display-item:0",
          sequence: 0,
          clientId: "client:page-background",
          fragmentOccurrenceId: "fragment:page-area:0",
          displayItemType: "document-background",
          visualRect: rect,
          flattenedPaintOpStart: 0,
          flattenedPaintOpEndExclusive: 1,
        }],
      }],
      vectorPaint: {
        kind: "preflighted-skia-svg-v1",
        svg,
        svgByteLength: Buffer.byteLength(svg),
        svgSha256: createHash("sha256").update(svg).digest("hex"),
        sourcePaintOpCount: 1,
        sourcePaintOpTypes: ["DrawRectOp"],
        unsupportedPaintOps: [],
        recursivePreflightComplete: true,
        textConvertedToPaths: true,
        embeddedImagesOnly: true,
        externalReferences: false,
      },
      tableFragments: [],
    }],
    collapsedTables: collapsedTables(),
  };
}

describe("paged page record", () => {
  it("accepts a complete source-owned fragment and paint stream", () => {
    expect(validateAuthenticatedPagedPageRecord(record())).toEqual([]);
  });

  it("accepts the XML declaration emitted by the pinned Skia SVG canvas", () => {
    const candidate = record();
    candidate.pages[0].vectorPaint.svg = `<?xml version="1.0" encoding="UTF-8"?>${candidate.pages[0].vectorPaint.svg}`;
    candidate.pages[0].vectorPaint.svgByteLength = Buffer.byteLength(candidate.pages[0].vectorPaint.svg);
    candidate.pages[0].vectorPaint.svgSha256 = createHash("sha256")
      .update(candidate.pages[0].vectorPaint.svg)
      .digest("hex");
    expect(validateAuthenticatedPagedPageRecord(candidate)).toEqual([]);
  });

  it("rejects capture before the page-specific paint lifecycle boundary", () => {
    const candidate = record();
    candidate.capturePhase = "after-PrintBegin" as typeof candidate.capturePhase;
    expect(validateAuthenticatedPagedPageRecord(candidate)).toContain(
      "page record was captured at the wrong lifecycle boundary",
    );
  });

  it("rejects a vector payload that did not pass recursive Skia preflight", () => {
    const candidate = record();
    candidate.pages[0].vectorPaint.unsupportedPaintOps = ["DrawVerticesOp"];
    expect(validateAuthenticatedPagedPageRecord(candidate)).toContain(
      "vector paint did not pass the closed recursive preflight",
    );
  });

  it("rejects non-self-contained Skia SVG output", () => {
    const candidate = record();
    candidate.pages[0].vectorPaint.svg = '<svg><image href="https://example.test/image.png"/></svg>';
    candidate.pages[0].vectorPaint.svgByteLength = Buffer.byteLength(candidate.pages[0].vectorPaint.svg);
    candidate.pages[0].vectorPaint.svgSha256 = createHash("sha256")
      .update(candidate.pages[0].vectorPaint.svg).digest("hex");
    expect(validateAuthenticatedPagedPageRecord(candidate)).toContain(
      "vector paint is not a self-contained inert SVG",
    );
  });

  it("cross-checks fragment and display-item ownership", () => {
    const candidate = record();
    candidate.pages[0].paintChunks[0].displayItems[0].fragmentOccurrenceId = "fragment:other";
    expect(validateAuthenticatedPagedPageRecord(candidate)).toContain(
      "display item references a missing fragment occurrence",
    );
  });

  it("preserves sparse selected ranges without relabeling document pages", () => {
    const candidate = record();
    candidate.pages[0].pageIndex = 2;
    candidate.collapsedTables.pages = [
      { pageIndex: 0, pageName: null, emptyKind: "none", tableOccurrences: [] },
      { pageIndex: 1, pageName: null, emptyKind: "none", tableOccurrences: [] },
      { pageIndex: 2, pageName: null, emptyKind: "terminal-empty", tableOccurrences: [] },
    ];
    expect(validateAuthenticatedPagedPageRecord(candidate)).toEqual([]);
  });

  it("rejects over-bound payloads and non-LayoutUnit geometry", () => {
    const candidate = structuredClone(record());
    candidate.serializedByteLength = PAGED_PAGE_RECORD_MAX_BYTES + 1;
    candidate.pages[0].contentArea.x = 1 / 3;
    expect(validateAuthenticatedPagedPageRecord(candidate)).toEqual(expect.arrayContaining([
      "page record exceeds its hard byte bound",
      "page content area is not canonical Blink LayoutUnit geometry",
    ]));
  });

  it("produces deterministic fail-closed unavailable records", () => {
    expect(unavailablePagedPageRecord("unsupported-paint", "saveLayer is unsupported", {
      pageIndex: 2,
      unsupportedPaintOps: ["saveLayer", "drawVertices", "saveLayer"],
    })).toEqual({
      schemaVersion: 1,
      helperAbi: PAGED_PAGE_RECORD_ABI,
      status: "unavailable",
      sourceRevision: PAGED_PAGE_RECORD_CHROMIUM_REVISION,
      reason: "unsupported-paint",
      detail: "saveLayer is unsupported",
      pageIndex: 2,
      unsupportedPaintOps: ["drawVertices", "saveLayer"],
      maximumBytes: PAGED_PAGE_RECORD_MAX_BYTES,
      pdfOrScreenshotUsedAsInput: false,
    });
  });

  it("parses authenticated records and demotes malformed helper output", () => {
    const parsed = parsePagedPageRecord(JSON.stringify(record()));
    expect(parsed, parsed.status === "unavailable" ? parsed.detail : "").toMatchObject({ status: "authenticated" });
    const malformed = JSON.parse(JSON.stringify(record())) as AuthenticatedPagedPageRecord;
    malformed.pages[0].propertyTrees.effects[0].filter = "blur(4px)" as "none";
    expect(parsePagedPageRecord(JSON.stringify(malformed))).toMatchObject({
      status: "unavailable",
      reason: "invalid-record",
      detail: "unsupported effect escaped fail-closed capture",
    });
    expect(parsePagedPageRecord("not-json")).toMatchObject({
      status: "unavailable",
      reason: "invalid-record",
    });
  });
});
