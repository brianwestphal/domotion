import { createHash } from "node:crypto";

import { z } from "zod";
import type { Page } from "@playwright/test";

import {
  PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
  buildPagedCollapsedTableRecord,
  validateAuthenticatedPagedCollapsedTableRecord,
  type AuthenticatedPagedCollapsedTableRecord,
  type PagedCollapsedPageRecord,
} from "./paged-collapsed-table-record.js";
import {
  PAGED_CAPTURE_HELPER_PATCH_SHA256,
  PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256,
} from "./paged-capture-bundle.js";
import {
  PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY,
  PAGED_CAPTURE_HELPER_MAX_TABLE_SIDECAR_BYTES,
  PAGED_CAPTURE_HELPER_TABLE_TRANSPORT_ABI,
  launchedPagedCaptureHelperAuthority,
  pagedNativePrintParametersSchema,
  type LaunchedPagedCaptureHelper,
} from "./paged-capture-helper.js";

export const PAGED_PAGE_RECORD_VERSION = 1 as const;
export const PAGED_PAGE_RECORD_ABI = "domotion-paged-page-record-v1" as const;
export const PAGED_PAGE_RECORD_MAX_BYTES = 64 * 1024 * 1024;
export const PAGED_PAGE_RECORD_CHROMIUM_REVISION = PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION;
export const PAGED_PAGE_RECORD_SOURCE_PINS = {
  printSpool: "third_party/blink/renderer/core/frame/web_local_frame_impl.cc:359-501",
  printPage: "third_party/blink/renderer/core/frame/local_frame_view.cc:4243-4285",
  pageGeometry: "third_party/blink/renderer/core/layout/pagination_utils.h:32-101",
  fragments: "third_party/blink/renderer/core/layout/physical_box_fragment.h:118-591",
  fragmentItems: "third_party/blink/renderer/core/layout/inline/fragment_items.h:54-258",
  skiaPaintRecord: "cc/paint/paint_record.h:24-111",
  skiaSvgCanvas: "third_party/skia/include/svg/SkSVGCanvas.h",
} as const;

export type PagedWritingMode = "horizontal-tb" | "vertical-rl" | "vertical-lr" | "sideways-rl" | "sideways-lr";
export type PagedDirection = "ltr" | "rtl";
export type PagedFragmentKind = "table" | "section" | "row" | "cell" | "caption" | "page-container" | "page-border-box" | "page-margin" | "page-area" | "box";
export interface PagedRect { x: number; y: number; width: number; height: number }
export interface PagedPoint { x: number; y: number }
export interface PagedSize { width: number; height: number }
export interface PagedBreakTokenRecord { consumedBlockSize: number; atBlockEnd: boolean; forcedBreak: boolean; breakInside: boolean; breakBefore: boolean; repeated: boolean }
export interface PagedInlineItemRecord { sequence: number; type: number; generated: boolean; offsetInContainerFragment: PagedPoint; size: PagedSize; backendNodeId: number | null }
export interface PagedFragmentRecord {
  occurrenceId: string;
  parentOccurrenceId: string | null;
  sequence: number;
  kind: PagedFragmentKind;
  offsetInParentPhysical: PagedPoint;
  size: PagedSize;
  scrollableOverflowLocal: PagedRect;
  parentCoordinateDomain: "page-container-target" | "page-border-box-layout";
  localCoordinateDomain: "page-container-target" | "page-border-box-layout";
  writingMode: PagedWritingMode;
  direction: PagedDirection;
  effectiveZoom: number;
  breakBefore: number;
  breakAfter: number;
  backendNodeId: number | null;
  sourceIndex: number | null;
  sourceOccurrenceIndex: number | null;
  breakToken: PagedBreakTokenRecord | null;
  inlineItems: PagedInlineItemRecord[];
}
export interface PagedVectorPaintRecord {
  kind: "preflighted-skia-svg-v1";
  svg: string;
  svgByteLength: number;
  svgSha256: string;
  sourcePaintOpCount: number;
  sourcePaintOpTypes: string[];
  unsupportedPaintOps: string[];
  recursivePreflightComplete: true;
  textConvertedToPaths: true;
  externalReferences: false;
}
export interface AuthenticatedPagedPage {
  selectionIndex: number;
  pageIndex: number;
  pageName: string | null;
  emptyKind: "none" | "forced-blank" | "terminal-empty";
  pageRect: PagedRect;
  pageContainer: PagedRect;
  pageBorderBox: PagedRect;
  pageArea: PagedRect;
  stitchedContentRect: PagedRect;
  targetScale: number;
  geometrySpaces: {
    pageRect: "paint-cull-layout-css-px";
    pageContainer: "page-container-target-css-px";
    pageBorderBox: "page-container-target-css-px";
    pageArea: "page-container-target-css-px";
    fragments: "native-local-explicit-per-fragment";
    stitchedContentRect: "layout-stitched-css-px";
  };
  fragments: PagedFragmentRecord[];
  vectorPaint: PagedVectorPaintRecord;
}
export interface AuthenticatedPagedPageRecord {
  schemaVersion: typeof PAGED_PAGE_RECORD_VERSION;
  helperAbi: typeof PAGED_PAGE_RECORD_ABI;
  status: "authenticated";
  sourceRevision: typeof PAGED_PAGE_RECORD_CHROMIUM_REVISION;
  capturePhase: "per-page-after-paint-before-record-consumption";
  coordinateUnit: "css-px-with-explicit-native-coordinate-spaces";
  paintSource: "finalized-cc-PaintRecord-replayed-by-pinned-SkSVGCanvas";
  pdfOrScreenshotUsedAsInput: false;
  transportByteLength: number;
  document: { frameId: string; frameToken: string; documentToken: string; loaderId: string; url: string; printEpochId: string; printParametersSha256: string; pageTransportByteLength: number; tableTransportByteLength: number; pageTransportSha256: string; tableTransportSha256: string; captureAuthoritySha256: string; browserProcessId: number; rendererProcessId: number; browserVersion: string; protocolVersion: string };
  pages: AuthenticatedPagedPage[];
  collapsedTables: AuthenticatedPagedCollapsedTableRecord;
}
export interface UnavailablePagedPageRecord {
  schemaVersion: typeof PAGED_PAGE_RECORD_VERSION;
  helperAbi: typeof PAGED_PAGE_RECORD_ABI;
  status: "unavailable";
  sourceRevision: typeof PAGED_PAGE_RECORD_CHROMIUM_REVISION;
  reason: "helper-not-enabled" | "unsupported-paint" | "payload-too-large" | "page-svg-too-large" | "svg-canvas-unavailable" | "record-budget-exceeded" | "pdf-input-not-supported" | "incomplete-geometry" | "invalid-record";
  detail: string;
  pageIndex: number | null;
  unsupportedPaintOps: string[];
  maximumBytes: typeof PAGED_PAGE_RECORD_MAX_BYTES;
  pdfOrScreenshotUsedAsInput: false;
}
export type PagedPageRecord = AuthenticatedPagedPageRecord | UnavailablePagedPageRecord;

const liveAuthenticatedPagedPageRecords = new WeakMap<AuthenticatedPagedPageRecord, string>();

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value == null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** True only for records produced by the live helper-owned capture transaction. */
export function isLiveAuthenticatedPagedPageRecord(
  value: unknown,
): value is AuthenticatedPagedPageRecord {
  if (typeof value !== "object" || value == null) return false;
  const expected = liveAuthenticatedPagedPageRecords.get(
    value as AuthenticatedPagedPageRecord,
  );
  if (expected == null) return false;
  try {
    return expected === sha256(canonicalJson(value));
  } catch {
    return false;
  }
}

interface PagedPageTargetPrintAuthentication {
  helper: {
    manifestSha256: string;
    patchSha256: string;
    skiaPatchSha256: string;
    capabilities: readonly string[];
    executableSha256: string;
  };
  process: {
    browserProcessId: number;
    rendererProcessIds: readonly number[];
    executableSha256: string;
    product: string;
    protocolVersion: string;
  };
  response: {
    browserProcessId: number;
    rendererProcessId: number;
    observedPrintLayoutStateRestoredExactly: true;
  };
  epoch: {
    frameId: string;
    loaderIdBefore: string;
    loaderIdAfter: string;
    urlBefore: string;
    urlAfter: string;
    normalizedPrintParameters: unknown;
    tableTransportByteLength: number;
    requestedPageIndices: readonly number[];
    displayHeaderFooter: false;
  };
}

interface NativePagedPageEnvelope {
  helperAbi: typeof PAGED_PAGE_RECORD_ABI;
  sourceRevision: typeof PAGED_PAGE_RECORD_CHROMIUM_REVISION;
  capturePhase: AuthenticatedPagedPageRecord["capturePhase"];
  pdfOrScreenshotUsedAsInput: false;
  frameToken: string;
  documentToken: string;
  documentUrl: string;
  printCaptureId: string;
  pages: Array<{
    selectionIndex: number; pageIndex: number; status: "authenticated" | "unavailable"; reason?: string; unsupportedPaintOps?: string[];
    pageRect: PagedRect; pageContainer: PagedRect; pageBorderBox: PagedRect; pageArea: PagedRect; stitchedContentRect: PagedRect;
    targetScale: number; pageName: string | null; fragments: PagedFragmentRecord[]; paintOpTypes: string[];
    geometrySpaces: AuthenticatedPagedPage["geometrySpaces"];
    collapsedTablePage: PagedCollapsedPageRecord;
    vectorPaintSvg?: string; vectorPaintByteLength?: number; textConvertedToPaths?: boolean; pdfOrScreenshotUsedAsInput?: false;
  }>;
}

const nonnegativeInteger = z.number().int().safe().nonnegative();
const nullableSourceInteger = z.number().int().safe().min(-1);
const layoutNumber = z.number().finite();
const collapsedBreakSchema = z.strictObject({
  kind: z.enum(["none", "whole-row", "continued-row"]),
  globalRowIndex: nonnegativeInteger.nullable(),
});
const collapsedSpanSchema = z.strictObject({ start: nonnegativeInteger, endExclusive: nonnegativeInteger });
const collapsedEligibilitySchema = z.strictObject({
  knownFragmentainerBlockSize: z.literal(true), atMostQuarterFragmentainer: z.literal(true),
  applicableBreakInsideAvoid: z.literal(true), noBreakInside: z.literal(true), noLateStart: z.literal(true),
  outsideNestedRepeatableContent: z.literal(true), layoutSideEffectsEnabled: z.literal(true),
});
const collapsedJointSchema = z.strictObject({
  precedence: z.tuple([z.literal("after"), z.literal("under"), z.literal("before"), z.literal("over")]),
  winner: z.enum(["self", "neighbor"]),
  suppressedAtFragmentBoundary: z.boolean(),
});
const rawLogicalRectSchema = z.strictObject({
  inlineStart: z.number().int().safe(), blockStart: z.number().int().safe(),
  inlineSize: nonnegativeInteger, blockSize: nonnegativeInteger,
});
const collapsedEdgeSchema = z.strictObject({
  sourceEdgeIndex: nonnegativeInteger, decisionOrder: nonnegativeInteger, paintOrder: nonnegativeInteger.nullable(),
  axis: z.enum(["inline", "block"]), globalRowBoundary: nonnegativeInteger, globalColumnBoundary: nonnegativeInteger,
  winner: z.strictObject({
    widthCssPx: layoutNumber.positive(),
    style: z.enum(["none", "hidden", "inset", "groove", "outset", "ridge", "dotted", "dashed", "solid", "double"]),
    boxOrder: nonnegativeInteger,
  }).nullable(),
  disposition: z.enum(["paint-full", "paint-half-at-whole-row-start", "paint-half-at-whole-row-end", "omit-at-continued-row-start", "omit-at-continued-row-end", "skip-shared-section-edge", "skip-span-interior"]),
  logicalRectRaw: rawLogicalRectSchema.nullable(), startJoint: collapsedJointSchema, endJoint: collapsedJointSchema,
});
const resolvedCollapsedEdgeSchema = z.strictObject({
  sourceEdgeIndex: nonnegativeInteger,
  axis: z.enum(["inline", "block"]),
  globalRowBoundary: nonnegativeInteger,
  globalColumnBoundary: nonnegativeInteger,
  doNotFill: z.boolean(),
  winner: z.strictObject({
    widthCssPx: layoutNumber.positive(),
    style: z.enum(["none", "hidden", "inset", "groove", "outset", "ridge", "dotted", "dashed", "solid", "double"]),
    boxOrder: nonnegativeInteger,
  }).nullable(),
});
const collapsedSectionSchema = z.strictObject({
  physicalSectionFragmentId: z.string().min(1), sectionSourceIndex: nullableSourceInteger,
  sectionTag: z.enum(["thead", "tbody", "tfoot"]), occurrenceIndex: nullableSourceInteger,
  repeatRole: z.enum(["body", "original-header", "repeated-header", "original-footer", "repeated-footer"]),
  sectionPaintSlot: nonnegativeInteger, tableChildPaintSlot: nonnegativeInteger,
  globalRows: collapsedSpanSchema, logicalRowOffsets: z.array(layoutNumber),
  startBreak: collapsedBreakSchema, endBreak: collapsedBreakSchema,
  repeatEligibility: collapsedEligibilitySchema.nullable(),
  reservedCollapsedEdgeSpace: z.strictObject({ blockStart: layoutNumber.nonnegative(), blockEnd: layoutNumber.nonnegative() }),
});
const collapsedCaptionSchema = z.strictObject({
  physicalCaptionFragmentId: z.string().min(1), captionSourceIndex: nullableSourceInteger,
  occurrenceIndex: nullableSourceInteger, tableChildPaintSlot: nonnegativeInteger,
  side: z.enum(["block-start", "block-end"]),
});
const collapsedTableSchema = z.strictObject({
  physicalTableFragmentId: z.string().min(1), tableSourceIndex: nullableSourceInteger,
  occurrenceIndex: nullableSourceInteger, pageIndex: nonnegativeInteger, firstTableBox: z.boolean(), lastTableBox: z.boolean(),
  writingMode: z.enum(["horizontal-tb", "vertical-rl", "vertical-lr", "sideways-rl", "sideways-lr"]),
  direction: z.enum(["ltr", "rtl"]), fragmentationAxis: z.enum(["physical-x", "physical-y"]),
  progression: z.enum(["positive", "negative"]), totalRows: nonnegativeInteger, totalColumns: nonnegativeInteger.positive(),
  globalColumnOffsets: z.array(layoutNumber), sectionOccurrences: z.array(collapsedSectionSchema),
  captionOccurrences: z.array(collapsedCaptionSchema),
  spanningCells: z.array(z.strictObject({
    cellSourceIndex: nullableSourceInteger, globalRows: collapsedSpanSchema,
    globalColumnStart: nonnegativeInteger, globalColumnEndExclusive: nonnegativeInteger,
    interiorCollapsedEdgeIndices: z.array(nonnegativeInteger),
  })),
  resolvedCollapsedEdgeGrid: z.array(resolvedCollapsedEdgeSchema),
  collapsedEdges: z.array(collapsedEdgeSchema),
});
const collapsedPageSchema = z.strictObject({
  pageIndex: nonnegativeInteger, pageName: z.string().nullable(),
  emptyKind: z.enum(["none", "forced-blank", "terminal-empty"]),
  tableOccurrences: z.array(collapsedTableSchema),
});
const authenticatedCollapsedRecordSchema = z.strictObject({
  schemaVersion: z.literal(1), status: z.literal("authenticated"),
  sourceRevision: z.literal(PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION),
  printEpoch: z.strictObject({
    epochId: z.string().min(1), documentLoaderId: z.string().min(1), frameToken: z.string().min(1),
    documentToken: z.string().min(1), documentUrl: z.string().min(1), printCaptureId: z.string().uuid(),
    browserVersion: z.string().min(1), protocolVersion: z.string().min(1), printParametersSha256: z.string(),
    lifecycle: z.literal("PrintBegin-to-PrintEnd"), logicalTransport: z.literal("blink-private-physical-fragment-tree-v1"),
    logicalFactsDerivedFromPdfVectorOrRaster: z.literal(false), sourceRestoredExactly: z.literal(true),
  }),
  pages: z.array(collapsedPageSchema).min(1),
  provenance: z.strictObject({
    ownership: z.literal("Blink-private-paginated-physical-fragment-tree"),
    canonicalization: z.literal("Blink-LayoutUnit-1/64-css-px"),
    pdfRole: z.literal("downstream-integration-evidence-only"),
    sourceFiles: z.tuple([
      z.literal("third_party/blink/renderer/core/layout/paginated_root_layout_algorithm.cc:28-155"),
      z.literal("third_party/blink/renderer/core/layout/table/table_section_layout_algorithm.cc:47-164"),
      z.literal("third_party/blink/renderer/core/layout/table/table_layout_algorithm.cc:1002-1151,1271-1339,1452-1528,1701-1719"),
      z.literal("third_party/blink/renderer/core/paint/table_painters.cc:35-328,490-727"),
    ]),
  }),
});

const rectSchema = z.strictObject({
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
});
const pointSchema = z.strictObject({ x: z.number(), y: z.number() });
const sizeSchema = z.strictObject({ width: z.number(), height: z.number() });
const breakTokenSchema = z.strictObject({
  consumedBlockSize: z.number(), atBlockEnd: z.boolean(), forcedBreak: z.boolean(), breakInside: z.boolean(),
  breakBefore: z.boolean(), repeated: z.boolean(),
});
const inlineItemSchema = z.strictObject({
  sequence: z.number().int(), type: z.number().int(), generated: z.boolean(),
  offsetInContainerFragment: pointSchema, size: sizeSchema,
  backendNodeId: z.number().int().positive().nullable(),
});
const fragmentSchema = z.strictObject({
  occurrenceId: z.string(), parentOccurrenceId: z.string().nullable(), sequence: z.number().int(),
  kind: z.enum(["table", "section", "row", "cell", "caption", "page-container", "page-border-box", "page-margin", "page-area", "box"]),
  offsetInParentPhysical: pointSchema, size: sizeSchema, scrollableOverflowLocal: rectSchema,
  parentCoordinateDomain: z.enum(["page-container-target", "page-border-box-layout"]),
  localCoordinateDomain: z.enum(["page-container-target", "page-border-box-layout"]),
  writingMode: z.enum(["horizontal-tb", "vertical-rl", "vertical-lr", "sideways-rl", "sideways-lr"]),
  direction: z.enum(["ltr", "rtl"]), effectiveZoom: z.number(),
  breakBefore: z.number().int().nonnegative(), breakAfter: z.number().int().nonnegative(),
  backendNodeId: z.number().int().positive().nullable(), sourceIndex: z.number().int().min(-1).nullable(),
  sourceOccurrenceIndex: z.number().int().min(-1).nullable(), breakToken: breakTokenSchema.nullable(),
  inlineItems: z.array(inlineItemSchema),
});
const nativeGeometrySpacesSchema = z.strictObject({
  pageRect: z.literal("paint-cull-layout-css-px"), pageContainer: z.literal("page-container-target-css-px"),
  pageBorderBox: z.literal("page-container-target-css-px"), pageArea: z.literal("page-container-target-css-px"),
  fragments: z.literal("native-local-explicit-per-fragment"), stitchedContentRect: z.literal("layout-stitched-css-px"),
});
const nativePageBaseShape = {
  selectionIndex: z.number().int().nonnegative(), pageIndex: z.number().int().nonnegative(),
  pageRect: rectSchema, pageContainer: rectSchema,
  pageBorderBox: rectSchema, pageArea: rectSchema, stitchedContentRect: rectSchema,
  targetScale: z.number(), pageName: z.string().nullable(), fragments: z.array(fragmentSchema),
  geometrySpaces: nativeGeometrySpacesSchema,
  paintOpTypes: z.array(z.string()), collapsedTablePage: collapsedPageSchema,
};
const nativePageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...nativePageBaseShape,
    status: z.literal("authenticated"),
    vectorPaintSvg: z.string(), vectorPaintByteLength: z.number().int().nonnegative(),
    textConvertedToPaths: z.literal(true), pdfOrScreenshotUsedAsInput: z.literal(false),
  }),
  z.strictObject({
    ...nativePageBaseShape,
    status: z.literal("unavailable"),
    reason: z.enum(["unsupported-paint", "record-budget-exceeded", "svg-canvas-unavailable", "page-svg-too-large"]),
    unsupportedPaintOps: z.array(z.string()).optional(),
  maximumPageSvgBytes: z.number().int().positive().optional(),
  }),
]);
const nativeEnvelopeSchema = z.strictObject({
  helperAbi: z.literal(PAGED_PAGE_RECORD_ABI), sourceRevision: z.literal(PAGED_PAGE_RECORD_CHROMIUM_REVISION),
  capturePhase: z.literal("per-page-after-paint-before-record-consumption"), pdfOrScreenshotUsedAsInput: z.literal(false),
  frameToken: z.string().min(1), documentToken: z.string().min(1), documentUrl: z.string().min(1),
  printCaptureId: z.string().uuid(), pages: z.array(nativePageSchema).min(1),
});
const nativeCollapsedEnvelopeSchema = z.strictObject({
  helperAbi: z.literal(PAGED_CAPTURE_HELPER_TABLE_TRANSPORT_ABI),
  sourceRevision: z.literal(PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION),
  capturePhase: z.literal("after-PrintBegin-before-PrintEnd"),
  logicalFactsDerivedFromPdfVectorOrRaster: z.literal(false),
  frameToken: z.string().min(1), documentToken: z.string().min(1), documentUrl: z.string().min(1),
  printCaptureId: z.string().uuid(), printParameters: pagedNativePrintParametersSchema, pages: z.array(collapsedPageSchema).min(1),
});
const targetPrintOptionsSchema = z.strictObject({
  landscape: z.boolean().optional(), printBackground: z.boolean().optional(), scale: z.number().finite().positive().optional(),
  paperWidth: z.number().finite().positive().optional(), paperHeight: z.number().finite().positive().optional(),
  marginTop: z.number().finite().nonnegative().optional(), marginBottom: z.number().finite().nonnegative().optional(),
  marginLeft: z.number().finite().nonnegative().optional(), marginRight: z.number().finite().nonnegative().optional(),
  pageRanges: z.string().max(4_096).optional(),
  preferCSSPageSize: z.boolean().optional(), generateTaggedPDF: z.boolean().optional(),
  generateDocumentOutline: z.boolean().optional(),
});
export type PagedPagePrintOptions = z.infer<typeof targetPrintOptionsSchema>;
const vectorPaintSchema = z.strictObject({
  kind: z.literal("preflighted-skia-svg-v1"), svg: z.string(), svgByteLength: z.number().int().nonnegative(),
  svgSha256: z.string(), sourcePaintOpCount: z.number().int().nonnegative(), sourcePaintOpTypes: z.array(z.string()),
  unsupportedPaintOps: z.array(z.string()), recursivePreflightComplete: z.literal(true), textConvertedToPaths: z.literal(true),
  externalReferences: z.literal(false),
});
const promotedPageSchema = z.strictObject({
  selectionIndex: z.number().int().nonnegative(), pageIndex: z.number().int().nonnegative(), pageName: z.string().nullable(),
  emptyKind: z.enum(["none", "forced-blank", "terminal-empty"]), pageRect: rectSchema, pageContainer: rectSchema,
  pageBorderBox: rectSchema, pageArea: rectSchema, stitchedContentRect: rectSchema, targetScale: z.number(),
  geometrySpaces: nativeGeometrySpacesSchema,
  fragments: z.array(fragmentSchema), vectorPaint: vectorPaintSchema,
});
const promotedRecordShapeSchema = z.strictObject({
  schemaVersion: z.literal(PAGED_PAGE_RECORD_VERSION), helperAbi: z.literal(PAGED_PAGE_RECORD_ABI), status: z.literal("authenticated"),
  sourceRevision: z.literal(PAGED_PAGE_RECORD_CHROMIUM_REVISION), capturePhase: z.literal("per-page-after-paint-before-record-consumption"),
  coordinateUnit: z.literal("css-px-with-explicit-native-coordinate-spaces"), paintSource: z.literal("finalized-cc-PaintRecord-replayed-by-pinned-SkSVGCanvas"),
  pdfOrScreenshotUsedAsInput: z.literal(false), transportByteLength: z.number().int().positive(),
  document: z.strictObject({ frameId: z.string().min(1), frameToken: z.string().min(1), documentToken: z.string().min(1), loaderId: z.string().min(1),
    url: z.string().min(1), printEpochId: z.string().min(1), printParametersSha256: z.string(),
    pageTransportByteLength: z.number().int().positive(), tableTransportByteLength: z.number().int().positive(),
    pageTransportSha256: z.string(), tableTransportSha256: z.string(), captureAuthoritySha256: z.string(),
    browserProcessId: z.number().int().positive(), rendererProcessId: z.number().int().positive(),
    browserVersion: z.string().min(1), protocolVersion: z.string().min(1) }),
  pages: z.array(promotedPageSchema).min(1), collapsedTables: authenticatedCollapsedRecordSchema,
});
const unavailableRecordSchema = z.strictObject({
  schemaVersion: z.literal(PAGED_PAGE_RECORD_VERSION), helperAbi: z.literal(PAGED_PAGE_RECORD_ABI), status: z.literal("unavailable"),
  sourceRevision: z.literal(PAGED_PAGE_RECORD_CHROMIUM_REVISION),
  reason: z.enum(["helper-not-enabled", "unsupported-paint", "payload-too-large", "page-svg-too-large", "svg-canvas-unavailable", "record-budget-exceeded", "pdf-input-not-supported", "incomplete-geometry", "invalid-record"]),
  detail: z.string(), pageIndex: z.number().int().nonnegative().nullable(), unsupportedPaintOps: z.array(z.string()),
  maximumBytes: z.literal(PAGED_PAGE_RECORD_MAX_BYTES), pdfOrScreenshotUsedAsInput: z.literal(false),
});

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value != null && !Array.isArray(value); }
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function validSha256(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function validateRect(rect: PagedRect, label: string, errors: string[]): void {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) errors.push(`${label} is not finite native geometry`);
  if (rect.width < 0 || rect.height < 0) errors.push(`${label} has negative dimensions`);
}
function externalSvgReference(svg: string): boolean {
  return /<(?:script|foreignObject)\b/i.test(svg) || /\son[a-z]+\s*=/i.test(svg)
    || /(?:href|src)\s*=\s*["'](?!#)/i.test(svg) || /\burl\(\s*["']?(?!#)/i.test(svg) || /@import\b/i.test(svg);
}

export function validateAuthenticatedPagedPageRecord(record: AuthenticatedPagedPageRecord): string[] {
  const shape = promotedRecordShapeSchema.safeParse(record);
  if (!shape.success) return shape.error.issues.map((issue) => `invalid page-record shape at ${issue.path.join(".") || "root"}: ${issue.message}`);
  const errors: string[] = [];
  if (record.schemaVersion !== PAGED_PAGE_RECORD_VERSION) errors.push("wrong page-record schema version");
  if (record.helperAbi !== PAGED_PAGE_RECORD_ABI) errors.push("wrong page-record helper ABI");
  if (record.sourceRevision !== PAGED_PAGE_RECORD_CHROMIUM_REVISION) errors.push("wrong Chromium revision");
  if (record.capturePhase !== "per-page-after-paint-before-record-consumption") errors.push("page record was captured at the wrong lifecycle boundary");
  if (record.coordinateUnit !== "css-px-with-explicit-native-coordinate-spaces") errors.push("page record has an unsupported coordinate-space contract");
  if (record.paintSource !== "finalized-cc-PaintRecord-replayed-by-pinned-SkSVGCanvas") errors.push("page record lacks source-owned paint");
  if (record.pdfOrScreenshotUsedAsInput !== false) errors.push("PDF or screenshot input is forbidden");
  if (!Number.isSafeInteger(record.transportByteLength) || record.transportByteLength <= 0 || record.transportByteLength > PAGED_PAGE_RECORD_MAX_BYTES) errors.push("page record exceeds its hard byte bound");
  if (!Number.isSafeInteger(record.document.pageTransportByteLength)
      || record.document.pageTransportByteLength <= 0
      || record.document.pageTransportByteLength > PAGED_PAGE_RECORD_MAX_BYTES
      || !Number.isSafeInteger(record.document.tableTransportByteLength)
      || record.document.tableTransportByteLength <= 0
      || record.document.tableTransportByteLength > PAGED_CAPTURE_HELPER_MAX_TABLE_SIDECAR_BYTES) {
    errors.push("raw native transport byte lengths exceed their hard bounds");
  }
  if ([record.document.frameId, record.document.frameToken, record.document.documentToken, record.document.loaderId, record.document.url, record.document.printEpochId, record.document.browserVersion, record.document.protocolVersion].some((value) => value.trim() === "")) errors.push("document, process, or print-epoch identity is incomplete");
  if (!validSha256(record.document.printParametersSha256)) errors.push("print parameters are not bound by sha256");
  if (!validSha256(record.document.pageTransportSha256)
      || !validSha256(record.document.tableTransportSha256)
      || record.document.tableTransportSha256 !== record.document.printEpochId) {
    errors.push("raw native transports are not bound by sha256");
  }
  if (!validSha256(record.document.captureAuthoritySha256)) errors.push("capture authority is not bound by sha256");
  if (record.pages.length === 0) errors.push("page record has no pages");
  for (const [selectionIndex, page] of record.pages.entries()) {
    if (page.selectionIndex !== selectionIndex) errors.push("selected page indices are not consecutive");
    if (!Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0) errors.push("invalid page index");
    for (const [name, rect] of [["page rect", page.pageRect], ["page container", page.pageContainer], ["page border box", page.pageBorderBox], ["page area", page.pageArea], ["stitched content rect", page.stitchedContentRect]] as const) validateRect(rect, name, errors);
    if (!(page.targetScale > 0) || !Number.isFinite(page.targetScale)) errors.push("page target scale must be positive and finite");
    const ids = new Set<string>();
    page.fragments.forEach((fragment, sequence) => {
      if (fragment.sequence !== sequence || fragment.occurrenceId === "" || ids.has(fragment.occurrenceId)) errors.push("fragment occurrence order or identity is invalid");
      if (fragment.parentOccurrenceId != null && !ids.has(fragment.parentOccurrenceId)) errors.push("fragment parent is missing or ordered after its child");
      ids.add(fragment.occurrenceId);
      validateRect({ ...fragment.offsetInParentPhysical, ...fragment.size }, "fragment local box", errors);
      validateRect(fragment.scrollableOverflowLocal, "fragment scrollable overflow", errors);
      if (!(fragment.effectiveZoom > 0) || !Number.isFinite(fragment.effectiveZoom)) errors.push("fragment effective zoom must be positive and finite");
      if (fragment.backendNodeId != null && (!Number.isSafeInteger(fragment.backendNodeId) || fragment.backendNodeId <= 0)) errors.push("fragment backend DOM node id is invalid");
      const tablePart = ["table", "section", "row", "cell", "caption"].includes(fragment.kind);
      if (tablePart && (!Number.isSafeInteger(fragment.sourceIndex) || (fragment.sourceIndex ?? -1) < 0 || !Number.isSafeInteger(fragment.sourceOccurrenceIndex) || (fragment.sourceOccurrenceIndex ?? -1) < 0)) errors.push("table-part fragment lacks source occurrence identity");
      if (!tablePart && (fragment.sourceIndex != null || fragment.sourceOccurrenceIndex != null)) errors.push("non-table fragment carries invented source occurrence identity");
      fragment.inlineItems.forEach((item, itemIndex) => {
        if (item.sequence !== itemIndex) errors.push("inline item sequence is not consecutive");
        validateRect({ ...item.offsetInContainerFragment, ...item.size }, "inline item local box", errors);
      });
    });
    const vector = page.vectorPaint;
    const bytes = Buffer.from(vector.svg, "utf8");
    if (vector.kind !== "preflighted-skia-svg-v1" || !vector.recursivePreflightComplete || !vector.textConvertedToPaths || vector.externalReferences !== false || vector.unsupportedPaintOps.length !== 0) errors.push("vector paint did not pass the closed recursive preflight");
    if (vector.svgByteLength !== bytes.byteLength || vector.svgSha256 !== sha256(bytes)) errors.push("vector paint bytes are not authenticated");
    if (!/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/.test(vector.svg)
        || externalSvgReference(vector.svg)
        || /(?:nan|[-+]?inf(?:inity)?)/i.test(vector.svg)) {
      errors.push("vector paint is not a self-contained inert SVG");
    }
    const root = /<svg\b([^>]*)>/i.exec(vector.svg)?.[1] ?? "";
    const dimension = (name: "width" | "height"): number => Number(
      new RegExp(`\\b${name}\\s*=\\s*["']([0-9]+(?:\\.[0-9]+)?)(?:px)?["']`, "i").exec(root)?.[1],
    );
    const width = dimension("width");
    const height = dimension("height");
    const viewBox = /\bviewBox\s*=\s*["']0 0 ([0-9]+(?:\.[0-9]+)?) ([0-9]+(?:\.[0-9]+)?)["']/i.exec(root);
    if (width !== Math.ceil(page.pageContainer.width) || height !== Math.ceil(page.pageContainer.height)
        || Number(viewBox?.[1]) !== width || Number(viewBox?.[2]) !== height) {
      errors.push("vector paint canvas does not match the native page container");
    }
    if (vector.sourcePaintOpCount <= 0 || vector.sourcePaintOpTypes.length !== vector.sourcePaintOpCount || vector.sourcePaintOpTypes.some((type) => type === "")) errors.push("vector paint operation ledger is incomplete");
    const logicalPage = record.collapsedTables.pages.find((candidate) => candidate.pageIndex === page.pageIndex);
    if (!logicalPage || logicalPage.pageName !== page.pageName || logicalPage.emptyKind !== page.emptyKind) errors.push("page and collapsed-table identities disagree");
    for (const table of logicalPage?.tableOccurrences ?? []) {
      const has = (kind: PagedFragmentKind, sourceIndex: number, occurrenceIndex: number) => page.fragments.some((fragment) => fragment.kind === kind && fragment.sourceIndex === sourceIndex && fragment.sourceOccurrenceIndex === occurrenceIndex);
      if (table.tableSourceIndex >= 0 && !has("table", table.tableSourceIndex, table.occurrenceIndex)) errors.push("collapsed table lacks its physical table fragment");
      for (const section of table.sectionOccurrences) if (section.sectionSourceIndex >= 0 && !has("section", section.sectionSourceIndex, section.occurrenceIndex)) errors.push("collapsed section lacks its physical section fragment");
      for (const caption of table.captionOccurrences) if (caption.captionSourceIndex >= 0 && !has("caption", caption.captionSourceIndex, caption.occurrenceIndex)) errors.push("collapsed caption lacks its physical caption fragment");
      for (const span of table.spanningCells) if (!page.fragments.some((fragment) => fragment.kind === "cell" && fragment.sourceIndex === span.cellSourceIndex)) errors.push("collapsed spanning cell lacks a physical cell fragment");
    }
  }
  if (new Set(record.pages.map((page) => page.pageIndex)).size !== record.pages.length || record.pages.some((page, index) => index > 0 && page.pageIndex <= record.pages[index - 1].pageIndex)) errors.push("source document page indices are not unique and increasing");
  errors.push(...validateAuthenticatedPagedCollapsedTableRecord(record.collapsedTables).map((error) => `collapsed table record: ${error}`));
  if (record.document.loaderId !== record.collapsedTables.printEpoch.documentLoaderId || record.document.printEpochId !== record.collapsedTables.printEpoch.epochId || record.document.printParametersSha256 !== record.collapsedTables.printEpoch.printParametersSha256) errors.push("page and collapsed-table print epochs disagree");
  return [...new Set(errors)];
}

export function unavailablePagedPageRecord(reason: UnavailablePagedPageRecord["reason"], detail: string, options: { pageIndex?: number | null; unsupportedPaintOps?: string[] } = {}): UnavailablePagedPageRecord {
  return { schemaVersion: PAGED_PAGE_RECORD_VERSION, helperAbi: PAGED_PAGE_RECORD_ABI, status: "unavailable", sourceRevision: PAGED_PAGE_RECORD_CHROMIUM_REVISION, reason, detail, pageIndex: options.pageIndex ?? null, unsupportedPaintOps: [...new Set(options.unsupportedPaintOps ?? [])].sort(), maximumBytes: PAGED_PAGE_RECORD_MAX_BYTES, pdfOrScreenshotUsedAsInput: false };
}

type RawCdp = {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

async function capturePageState(cdp: RawCdp): Promise<{
  frameId: string;
  loaderId: string;
  url: string;
  layoutSha256: string;
}> {
  const frameTree = await cdp.send("Page.getFrameTree") as {
    frameTree?: {
      frame?: { id?: unknown; loaderId?: unknown; url?: unknown };
      childFrames?: unknown[];
    };
  };
  const frame = frameTree.frameTree?.frame;
  if (typeof frame?.id !== "string" || frame.id === ""
      || typeof frame.loaderId !== "string" || frame.loaderId === ""
      || typeof frame.url !== "string" || frame.url === "") {
    throw new Error("target page frame/loader identity is unavailable");
  }
  if ((frameTree.frameTree?.childFrames?.length ?? 0) > 0) {
    throw new Error("paged capture v1 rejects child frames because every painted document must be independently bound");
  }
  const fingerprint = () => {
    const maximumNodes = 20_000;
    const maximumRules = 20_000;
    const maximumUtf8Bytes = 4 * 1024 * 1024;
    const encoder = new TextEncoder();
    let nodeCount = 0;
    let ruleCount = 0;
    let utf8Bytes = 0;
    let budgetExceeded = false;
    const tokens: string[] = [];
    const append = (value: string) => {
      if (budgetExceeded) return;
      if (value.length > maximumUtf8Bytes - utf8Bytes) {
        budgetExceeded = true;
        return;
      }
      const bytes = encoder.encode(value).byteLength;
      if (utf8Bytes + bytes > maximumUtf8Bytes) {
        budgetExceeded = true;
        return;
      }
      utf8Bytes += bytes;
      tokens.push(value);
    };
    const roots: Array<{ root: Document | ShadowRoot; ownerIndex: number }> = [
      { root: document, ownerIndex: -1 },
    ];
    const nodeIndexes = new WeakMap<Node, number>();
    for (let rootIndex = 0; rootIndex < roots.length && !budgetExceeded;
      rootIndex += 1) {
      const { root, ownerIndex } = roots[rootIndex];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
      for (let node = walker.nextNode(); node && !budgetExceeded;
        node = walker.nextNode()) {
        nodeCount += 1;
        if (nodeCount > maximumNodes) {
          budgetExceeded = true;
          break;
        }
        const nodeIndex = nodeCount - 1;
        nodeIndexes.set(node, nodeIndex);
        const parentIndex = node.parentNode === root
          ? ownerIndex : (nodeIndexes.get(node.parentNode!) ?? -2);
        if (node instanceof Element) {
          append(`node:${nodeIndex}:parent:${parentIndex}:<${node.tagName.toLowerCase()} ${Array.from(node.attributes)
            .map((attribute) => [attribute.name, attribute.value] as const)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(" ")}>`);
          if (node instanceof HTMLInputElement) {
            append(`input:${node.value}:${node.checked}:${node.indeterminate}`);
          } else if (node instanceof HTMLTextAreaElement) {
            append(`textarea:${node.value}`);
          } else if (node instanceof HTMLSelectElement) {
            append(`select:${node.selectedIndex}:${node.value}`);
          }
          if (node.shadowRoot) {
            append(`#shadow-root:${nodeIndex}`);
            roots.push({ root: node.shadowRoot, ownerIndex: nodeIndex });
          }
        } else {
          append(`node:${nodeIndex}:parent:${parentIndex}:${node.nodeType}:${node.nodeName}:${node.nodeValue ?? ""}`);
        }
      }
    }
    const sheetState = (sheet: CSSStyleSheet) => {
      append(`sheet:${sheet.href ?? ""}:${sheet.media.mediaText}:${sheet.disabled}`);
      try {
        for (const rule of sheet.cssRules) {
          ruleCount += 1;
          if (ruleCount > maximumRules) {
            budgetExceeded = true;
            break;
          }
          append(`rule:${rule.cssText}`);
        }
      } catch {
        append("sheet:rules-inaccessible");
      }
    };
    for (const { root } of roots) {
      if (budgetExceeded) break;
      for (const sheet of root.adoptedStyleSheets) sheetState(sheet);
      for (const element of root.querySelectorAll("style,link[rel~='stylesheet']")) {
        const sheet = (element as HTMLStyleElement | HTMLLinkElement).sheet;
        if (sheet instanceof CSSStyleSheet) sheetState(sheet);
        else append(`sheet:unavailable:${element.tagName}:${element.getAttribute("href") ?? ""}`);
      }
    }
    return {
      budgetExceeded,
      nodeCount,
      ruleCount,
      utf8Bytes,
      tokens,
      url: document.URL,
      scroll: [window.scrollX, window.scrollY],
      viewport: [window.innerWidth, window.innerHeight, window.devicePixelRatio],
      printMediaMatches: window.matchMedia("print").matches,
    };
  };
  const isolatedWorld = await cdp.send("Page.createIsolatedWorld", {
    frameId: frame.id,
    worldName: "__domotion_paged_capture_state__",
    grantUniveralAccess: false,
  }) as { executionContextId?: unknown };
  if (!Number.isSafeInteger(isolatedWorld.executionContextId)) {
    throw new Error("target page isolated source-state world is unavailable");
  }
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(${fingerprint.toString()})()`,
    contextId: isolatedWorld.executionContextId,
    returnByValue: true,
    awaitPromise: true,
  }) as {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
  if (evaluation.exceptionDetails || !isObject(evaluation.result?.value)) {
    throw new Error("target page isolated source-state fingerprint failed");
  }
  const layout = evaluation.result.value as {
    budgetExceeded?: unknown;
    [key: string]: unknown;
  };
  if (layout.budgetExceeded) {
    throw new Error("target page source-state fingerprint exceeded its bounded DOM/CSS budget");
  }
  return { frameId: frame.id, loaderId: frame.loaderId, url: frame.url, layoutSha256: sha256(canonicalJson(layout)) };
}

async function closeUnopenedPdfStream(cdp: RawCdp, response: Record<string, unknown>): Promise<void> {
  if (typeof response.stream !== "string" || response.stream === "") {
    throw new Error("paged capture omitted its unopened downstream PDF stream");
  }
  if (typeof response.data === "string" && response.data !== "") {
    throw new Error("paged capture unexpectedly materialized downstream PDF bytes");
  }
  await cdp.send("IO.close", { handle: response.stream });
}

/**
 * Capture and authenticate one stable HTML print transaction. The caller can
 * choose ordinary print geometry, but cannot inject raw sidecars, process
 * claims, page selection, helper identity, or an authenticated record.
 */
export async function captureAuthenticatedPagedPageRecord(
  launched: LaunchedPagedCaptureHelper,
  page: Page,
  options: PagedPagePrintOptions = {},
): Promise<PagedPageRecord> {
  const authority = launchedPagedCaptureHelperAuthority(launched);
  if (!authority) {
    return unavailablePagedPageRecord("invalid-record", "paged capture requires a live verified helper handle");
  }
  const actualContext = authority.browser.contexts().find((context) =>
    context.pages().includes(page));
  if (!actualContext || page.context() !== actualContext
      || actualContext.browser() !== authority.browser) {
    return unavailablePagedPageRecord("invalid-record", "target page does not belong to the authenticated helper browser");
  }
  const parsedOptions = targetPrintOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    return unavailablePagedPageRecord("invalid-record", `invalid print options: ${parsedOptions.error.message}`);
  }
  const cdpSession = await actualContext.newCDPSession(page);
  const cdp = cdpSession as unknown as RawCdp;
  try {
    const before = await capturePageState(cdp);
    const processBefore = await authority.authenticateLiveProcesses();
    const response = await cdp.send("Page.printToPDF", {
      ...parsedOptions.data,
      displayHeaderFooter: false,
      transferMode: "ReturnAsStream",
      domotionPagedTableEvidence: true,
    });
    const pageJson = typeof response.domotionPagedPageRecord === "string"
      ? response.domotionPagedPageRecord : "";
    const tableJson = typeof response.domotionPagedTableEvidence === "string"
      ? response.domotionPagedTableEvidence : "";
    await closeUnopenedPdfStream(cdp, response);
    const after = await capturePageState(cdp);
    const processAfter = await authority.authenticateLiveProcesses();
    if (!authority.browser.contexts().includes(actualContext)
        || !actualContext.pages().includes(page)
        || page.context() !== actualContext) {
      return unavailablePagedPageRecord("invalid-record", "target page left the authenticated helper browser during print");
    }
    if (before.frameId !== after.frameId || before.loaderId !== after.loaderId
        || before.url !== after.url || before.layoutSha256 !== after.layoutSha256
        || response.domotionSourceRestoredExactly !== true) {
      return unavailablePagedPageRecord("invalid-record", "target frame, loader, URL, or layout changed across print");
    }
    try {
      const nativePage = JSON.parse(pageJson) as unknown;
      if (isObject(nativePage) && nativePage.status === "unavailable") {
        if (nativePage.reason === "pdf-input-not-supported") {
          return unavailablePagedPageRecord("pdf-input-not-supported", "PDF/plugin documents are not source-owned HTML page paint");
        }
        if (nativePage.reason === "payload-too-large") {
          return unavailablePagedPageRecord("payload-too-large", "native page-record accumulator exceeded its hard bound");
        }
        if (nativePage.reason === "record-budget-exceeded") {
          return unavailablePagedPageRecord("record-budget-exceeded", "native page extraction exceeded its bounded producer work budget");
        }
      }
    } catch {
      // The authenticated transport parser below returns the specific invalid JSON result.
    }
    if (Buffer.byteLength(tableJson) > PAGED_CAPTURE_HELPER_MAX_TABLE_SIDECAR_BYTES) {
      return unavailablePagedPageRecord("payload-too-large", "native table sidecar exceeded its hard transport bound");
    }
    const parsedTableJson = JSON.parse(tableJson) as unknown;
    if (isObject(parsedTableJson) && parsedTableJson.error === "sidecar-too-large") {
      return unavailablePagedPageRecord("payload-too-large", "native table sidecar exceeded its hard transport bound");
    }
    if (isObject(parsedTableJson) && parsedTableJson.status === "unavailable"
        && parsedTableJson.reason === "record-budget-exceeded") {
      return unavailablePagedPageRecord("record-budget-exceeded", "native table extraction exceeded its bounded producer work budget");
    }
    const nativeTables = nativeCollapsedEnvelopeSchema.safeParse(parsedTableJson);
    if (!nativeTables.success) {
      return unavailablePagedPageRecord("invalid-record", `native table transport shape: ${nativeTables.error.message}`);
    }
    const payload = nativeTables.data;
    if (payload.printParameters.shouldPrintBackgrounds !== (parsedOptions.data.printBackground ?? false)) {
      return unavailablePagedPageRecord("invalid-record", "native print-background parameter differs from the requested print policy");
    }
    const collapsedTables = buildPagedCollapsedTableRecord({
      sourceRevision: payload.sourceRevision,
      printEpoch: {
        epochId: sha256(tableJson), documentLoaderId: before.loaderId,
        frameToken: payload.frameToken, documentToken: payload.documentToken,
        documentUrl: payload.documentUrl, printCaptureId: payload.printCaptureId,
        browserVersion: processAfter.product, protocolVersion: processAfter.protocolVersion,
        printParametersSha256: sha256(canonicalJson(payload.printParameters)),
        lifecycle: "PrintBegin-to-PrintEnd", logicalTransport: "blink-private-physical-fragment-tree-v1",
        logicalFactsDerivedFromPdfVectorOrRaster: false, sourceRestoredExactly: true,
      },
      pages: payload.pages as PagedCollapsedPageRecord[],
    });
    if (collapsedTables.status !== "authenticated") {
      return unavailablePagedPageRecord("invalid-record", `native table transport: ${collapsedTables.reason}`);
    }
    const browserProcessId = Number(response.domotionBrowserProcessId);
    const rendererProcessId = Number(response.domotionRendererProcessId);
    const processStable = processBefore.browserProcessId === processAfter.browserProcessId
      && processBefore.executableSha256 === processAfter.executableSha256
      && processBefore.product === processAfter.product
      && processBefore.protocolVersion === processAfter.protocolVersion
      && processBefore.rendererProcessIds.includes(rendererProcessId)
      && processAfter.rendererProcessIds.includes(rendererProcessId);
    if (!Number.isSafeInteger(browserProcessId) || browserProcessId <= 0
        || !Number.isSafeInteger(rendererProcessId) || rendererProcessId <= 0
        || browserProcessId !== processAfter.browserProcessId || !processStable) {
      return unavailablePagedPageRecord("invalid-record", "print response process identity is not live-helper authenticated");
    }
    const executableMember = authority.helper.manifest.members.find((member) =>
      member.path === authority.helper.manifest.runtime.executablePath && member.role === "executable");
    if (!executableMember) {
      return unavailablePagedPageRecord("invalid-record", "verified helper executable member is absent");
    }
    return authenticatePagedPageTransport(pageJson, collapsedTables, {
      helper: {
        manifestSha256: authority.helper.manifestSha256,
        patchSha256: authority.helper.manifest.source.patchSha256,
        skiaPatchSha256: authority.helper.manifest.source.skiaPatchSha256,
        capabilities: authority.helper.manifest.capabilities,
        executableSha256: executableMember.sha256,
      },
      process: processAfter,
      response: { browserProcessId, rendererProcessId, observedPrintLayoutStateRestoredExactly: true },
      epoch: {
        frameId: before.frameId, loaderIdBefore: before.loaderId, loaderIdAfter: after.loaderId,
        urlBefore: before.url, urlAfter: after.url, normalizedPrintParameters: payload.printParameters,
        tableTransportByteLength: Buffer.byteLength(tableJson),
        requestedPageIndices: collapsedTables.pages.map((candidate) => candidate.pageIndex),
        displayHeaderFooter: false,
      },
    });
  } catch (error) {
    return unavailablePagedPageRecord("invalid-record", error instanceof Error ? error.message : String(error));
  } finally {
    await cdpSession.detach().catch(() => undefined);
  }
}

/** Promote the exact live helper envelope only when its paired logical sidecar is authenticated. */
function authenticatePagedPageTransport(
  pageJson: string,
  collapsedTables: AuthenticatedPagedCollapsedTableRecord,
  authentication: PagedPageTargetPrintAuthentication,
): PagedPageRecord {
  const transportByteLength = Buffer.byteLength(pageJson);
  if (transportByteLength > PAGED_PAGE_RECORD_MAX_BYTES) return unavailablePagedPageRecord("payload-too-large", `page record is ${transportByteLength} bytes; maximum is ${PAGED_PAGE_RECORD_MAX_BYTES}`);
  let raw: NativePagedPageEnvelope;
  try {
    const parsed = JSON.parse(pageJson) as unknown;
    if (isObject(parsed) && parsed.status === "unavailable") {
      if (parsed.reason === "payload-too-large") {
        return unavailablePagedPageRecord("payload-too-large", "native page-record accumulator exceeded its hard bound");
      }
      if (parsed.reason === "pdf-input-not-supported") {
        return unavailablePagedPageRecord("pdf-input-not-supported", "PDF/plugin documents are not source-owned HTML page paint");
      }
      if (parsed.reason === "record-budget-exceeded") {
        return unavailablePagedPageRecord("record-budget-exceeded", "native page extraction exceeded its bounded producer work budget");
      }
      return unavailablePagedPageRecord("invalid-record", "native unavailable envelope has an unknown reason");
    }
    const native = nativeEnvelopeSchema.safeParse(parsed);
    if (!native.success) {
      return unavailablePagedPageRecord("invalid-record", `native page transport shape: ${native.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`);
    }
    raw = native.data;
  } catch (error) { return unavailablePagedPageRecord("invalid-record", `page transport is not JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const collapsedErrors = validateAuthenticatedPagedCollapsedTableRecord(collapsedTables);
  if (collapsedErrors.length > 0) return unavailablePagedPageRecord("invalid-record", `collapsed table record: ${collapsedErrors.join("; ")}`);
  const requestedPageIndices = [...authentication.epoch.requestedPageIndices];
  const rawPageIndices = raw.pages.map((page) => page.pageIndex);
  const executableMatches = authentication.helper.executableSha256 === authentication.process.executableSha256;
  const authorityValid = validSha256(authentication.helper.manifestSha256)
    && authentication.helper.patchSha256 === PAGED_CAPTURE_HELPER_PATCH_SHA256
    && authentication.helper.skiaPatchSha256 === PAGED_CAPTURE_HELPER_SKIA_PATCH_SHA256
    && authentication.helper.capabilities.includes(PAGED_CAPTURE_HELPER_PAGE_SVG_CAPABILITY)
    && validSha256(authentication.helper.executableSha256)
    && executableMatches
    && authentication.process.browserProcessId === authentication.response.browserProcessId
    && authentication.process.rendererProcessIds.includes(authentication.response.rendererProcessId)
    && authentication.response.observedPrintLayoutStateRestoredExactly === true
    && authentication.epoch.displayHeaderFooter === false
    && authentication.epoch.frameId.trim() !== ""
    && authentication.epoch.loaderIdBefore === authentication.epoch.loaderIdAfter
    && authentication.epoch.loaderIdBefore === collapsedTables.printEpoch.documentLoaderId
    && authentication.epoch.urlBefore === authentication.epoch.urlAfter
    && authentication.epoch.urlBefore === raw.documentUrl
    && raw.frameToken === collapsedTables.printEpoch.frameToken
    && raw.documentToken === collapsedTables.printEpoch.documentToken
    && raw.documentUrl === collapsedTables.printEpoch.documentUrl
    && raw.printCaptureId === collapsedTables.printEpoch.printCaptureId
    && authentication.process.product === collapsedTables.printEpoch.browserVersion
    && authentication.process.protocolVersion === collapsedTables.printEpoch.protocolVersion
    && sha256(canonicalJson(authentication.epoch.normalizedPrintParameters)) === collapsedTables.printEpoch.printParametersSha256
    && requestedPageIndices.length === rawPageIndices.length
    && requestedPageIndices.every((pageIndex, index) => pageIndex === rawPageIndices[index]);
  if (!authorityValid) return unavailablePagedPageRecord("invalid-record", "target print was not authenticated by the pinned page-SVG helper and stable document epoch");
  const selectedLogicalPages = new Map<number, PagedCollapsedPageRecord>();
  for (const page of raw.pages) {
    const pairedPage = collapsedTables.pages.find((candidate) =>
      candidate.pageIndex === page.pageIndex);
    if (!isObject(page.collapsedTablePage)
        || page.collapsedTablePage.pageIndex !== page.pageIndex
        || page.collapsedTablePage.pageName !== page.pageName
        || !pairedPage
        || canonicalJson(page.collapsedTablePage) !== canonicalJson(pairedPage)) {
      return unavailablePagedPageRecord("invalid-record", `page ${page.pageIndex} same-hook and full collapsed-table facts disagree`);
    }
    selectedLogicalPages.set(page.pageIndex, page.collapsedTablePage);
  }
  const sameHookCollapsedTables = buildPagedCollapsedTableRecord({
    sourceRevision: collapsedTables.sourceRevision,
    printEpoch: collapsedTables.printEpoch,
    pages: collapsedTables.pages.map((page) => selectedLogicalPages.get(page.pageIndex) ?? page),
  });
  if (sameHookCollapsedTables.status !== "authenticated") {
    return unavailablePagedPageRecord("invalid-record", `same-hook collapsed table record: ${sameHookCollapsedTables.reason}`);
  }
  const failed = raw.pages.find((page) => page.status !== "authenticated");
  if (failed) {
    const reason = failed.reason === "page-svg-too-large" || failed.reason === "svg-canvas-unavailable" || failed.reason === "record-budget-exceeded"
      ? failed.reason
      : "unsupported-paint";
    return unavailablePagedPageRecord(reason, failed.reason ?? "native page paint was unavailable", { pageIndex: failed.pageIndex, unsupportedPaintOps: failed.unsupportedPaintOps });
  }
  try {
    const record: AuthenticatedPagedPageRecord = {
      schemaVersion: PAGED_PAGE_RECORD_VERSION,
      helperAbi: PAGED_PAGE_RECORD_ABI,
      status: "authenticated",
      sourceRevision: PAGED_PAGE_RECORD_CHROMIUM_REVISION,
      capturePhase: raw.capturePhase,
      coordinateUnit: "css-px-with-explicit-native-coordinate-spaces",
      paintSource: "finalized-cc-PaintRecord-replayed-by-pinned-SkSVGCanvas",
      pdfOrScreenshotUsedAsInput: false,
      transportByteLength: 1,
      document: { frameId: authentication.epoch.frameId, frameToken: raw.frameToken, documentToken: raw.documentToken, loaderId: collapsedTables.printEpoch.documentLoaderId, url: raw.documentUrl, printEpochId: collapsedTables.printEpoch.epochId, printParametersSha256: collapsedTables.printEpoch.printParametersSha256, pageTransportByteLength: transportByteLength, tableTransportByteLength: authentication.epoch.tableTransportByteLength, pageTransportSha256: sha256(pageJson), tableTransportSha256: collapsedTables.printEpoch.epochId, captureAuthoritySha256: sha256(canonicalJson(authentication)), browserProcessId: authentication.response.browserProcessId, rendererProcessId: authentication.response.rendererProcessId, browserVersion: authentication.process.product, protocolVersion: authentication.process.protocolVersion },
      pages: raw.pages.map((page) => {
        if (typeof page.vectorPaintSvg !== "string" || typeof page.vectorPaintByteLength !== "number" || page.textConvertedToPaths !== true || page.pdfOrScreenshotUsedAsInput !== false) throw new Error(`page ${page.pageIndex} vector paint is incomplete`);
        const logicalPage = collapsedTables.pages.find((candidate) => candidate.pageIndex === page.pageIndex);
        if (!logicalPage) throw new Error(`page ${page.pageIndex} is missing from collapsed-table evidence`);
        return {
          selectionIndex: page.selectionIndex, pageIndex: page.pageIndex, pageName: page.pageName, emptyKind: logicalPage.emptyKind,
          pageRect: page.pageRect, pageContainer: page.pageContainer, pageBorderBox: page.pageBorderBox, pageArea: page.pageArea,
          stitchedContentRect: page.stitchedContentRect, targetScale: page.targetScale, fragments: page.fragments,
          geometrySpaces: page.geometrySpaces,
          vectorPaint: { kind: "preflighted-skia-svg-v1", svg: page.vectorPaintSvg, svgByteLength: page.vectorPaintByteLength, svgSha256: sha256(page.vectorPaintSvg), sourcePaintOpCount: page.paintOpTypes.length, sourcePaintOpTypes: page.paintOpTypes, unsupportedPaintOps: [], recursivePreflightComplete: true, textConvertedToPaths: true, externalReferences: false },
        };
      }),
      collapsedTables: sameHookCollapsedTables,
    };
    for (let previous = 0; previous !== record.transportByteLength;) {
      previous = record.transportByteLength;
      record.transportByteLength = Buffer.byteLength(canonicalJson(record));
    }
    if (record.transportByteLength > PAGED_PAGE_RECORD_MAX_BYTES) {
      return unavailablePagedPageRecord("payload-too-large", "promoted page record exceeds its combined hard bound");
    }
    const errors = validateAuthenticatedPagedPageRecord(record);
    if (errors.length > 0) return unavailablePagedPageRecord("invalid-record", errors.join("; "));
    deepFreeze(record);
    liveAuthenticatedPagedPageRecords.set(record, sha256(canonicalJson(record)));
    return record;
  } catch (error) {
    return unavailablePagedPageRecord("incomplete-geometry", error instanceof Error ? error.message : String(error));
  }
}

/** Parse persisted unavailable records; live authentication is intentionally non-serializable. */
export function parsePagedPageRecord(json: string): PagedPageRecord {
  if (Buffer.byteLength(json) > PAGED_PAGE_RECORD_MAX_BYTES * 2) return unavailablePagedPageRecord("payload-too-large", "persisted page record exceeds the combined hard bound");
  try {
    const value = JSON.parse(json) as unknown;
    if (isObject(value) && value.status === "unavailable") {
      const unavailable = unavailableRecordSchema.safeParse(value);
      return unavailable.success
        ? unavailable.data
        : unavailablePagedPageRecord("invalid-record", `unavailable record shape: ${unavailable.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`);
    }
    return unavailablePagedPageRecord(
      "invalid-record",
      "persisted JSON cannot carry live helper/process authentication",
    );
  } catch (error) {
    return unavailablePagedPageRecord("invalid-record", `page record is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
