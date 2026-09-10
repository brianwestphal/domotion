import { createHash } from "node:crypto";

import {
  PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION,
  validateAuthenticatedPagedCollapsedTableRecord,
  type AuthenticatedPagedCollapsedTableRecord,
} from "./paged-collapsed-table-record.js";

/**
 * Source-owned page-local geometry and ordered paint captured while Blink's
 * paginated fragment tree and transient PaintArtifact are both alive.
 */
export const PAGED_PAGE_RECORD_VERSION = 1 as const;
export const PAGED_PAGE_RECORD_ABI = "domotion-paged-page-record-v1" as const;
export const PAGED_PAGE_RECORD_MAX_BYTES = 64 * 1024 * 1024;
export const PAGED_PAGE_RECORD_CHROMIUM_REVISION =
  PAGED_COLLAPSED_TABLE_CHROMIUM_REVISION;

export const PAGED_PAGE_RECORD_SOURCE_PINS = {
  printSpool:
    "third_party/blink/renderer/core/frame/web_local_frame_impl.cc:359-501",
  printPage:
    "third_party/blink/renderer/core/frame/local_frame_view.cc:4243-4285",
  pageGeometry:
    "third_party/blink/renderer/core/layout/pagination_utils.h:32-101",
  fragments:
    "third_party/blink/renderer/core/layout/physical_box_fragment.h:118-591",
  fragmentItems:
    "third_party/blink/renderer/core/layout/inline/fragment_items.h:54-258",
  paintArtifact:
    "third_party/blink/renderer/platform/graphics/paint/paint_artifact.h:34-151",
  displayItems:
    "third_party/blink/renderer/platform/graphics/paint/display_item.h:43-363",
  skiaPaintRecord: "cc/paint/paint_record.h:24-111",
} as const;

export type PagedWritingMode =
  | "horizontal-tb"
  | "vertical-rl"
  | "vertical-lr"
  | "sideways-rl"
  | "sideways-lr";
export type PagedDirection = "ltr" | "rtl";

export interface PagedPoint {
  x: number;
  y: number;
}

export interface PagedRect extends PagedPoint {
  width: number;
  height: number;
}

export interface PagedMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface PagedSourceIdentity {
  frameToken: string;
  documentToken: string;
  backendNodeId: number | null;
  pseudo: "none" | "before" | "after" | "marker" | "first-letter";
  syntheticRole: null | "page-container" | "page-border-box" | "page-area" | "margin-box";
}

export interface PagedBreakTokenRecord {
  sequence: number;
  consumedBlockSize: number;
  atBlockEnd: boolean;
  forcedBreak: boolean;
  breakInside: boolean;
}

export interface PagedFragmentRecord {
  occurrenceId: string;
  parentOccurrenceId: string | null;
  source: PagedSourceIdentity;
  fragmentKind: "box" | "line-box" | "text" | "generated" | "page-margin";
  childPaintOrder: number;
  relativeOffset: PagedPoint;
  pageTransform: PagedMatrix;
  borderBox: PagedRect;
  overflowClip: PagedRect | null;
  writingMode: PagedWritingMode;
  direction: PagedDirection;
  effectiveZoom: number;
  breakToken: PagedBreakTokenRecord | null;
  paintClientIds: string[];
}

export interface PagedTransformNode {
  id: string;
  parentId: string | null;
  matrix: PagedMatrix;
  flattensInheritedTransform: boolean;
}

export interface PagedClipNode {
  id: string;
  parentId: string | null;
  transformId: string;
  rect: PagedRect;
  radii: readonly [number, number, number, number, number, number, number, number];
}

export interface PagedEffectNode {
  id: string;
  parentId: string | null;
  transformId: string;
  clipId: string;
  opacity: number;
  blendMode: "normal";
  filter: "none";
}

export interface PagedDisplayItemRecord {
  id: string;
  sequence: number;
  clientId: string;
  fragmentOccurrenceId: string | null;
  displayItemType: string;
  visualRect: PagedRect;
  flattenedPaintOpStart: number;
  flattenedPaintOpEndExclusive: number;
}

export interface PagedPaintChunkRecord {
  id: string;
  sequence: number;
  transformId: string;
  clipId: string;
  effectId: string;
  displayItems: PagedDisplayItemRecord[];
}

export interface PagedTableFragmentGeometry {
  physicalFragmentId: string;
  pageIndex: number;
  kind: "table" | "section" | "row" | "cell" | "caption";
  sourceIndex: number;
  occurrenceIndex: number;
  borderBox: PagedRect;
  overflowClip: PagedRect | null;
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
  embeddedImagesOnly: true;
  externalReferences: false;
}

export interface AuthenticatedPagedPage {
  /** Consecutive index within the caller's selected page range. */
  selectionIndex: number;
  /** Zero-based physical page index in the source document. */
  pageIndex: number;
  pageName: string | null;
  emptyKind: "none" | "forced-blank" | "terminal-empty";
  pageArea: PagedRect;
  pageBorderBox: PagedRect;
  contentArea: PagedRect;
  stitchedContentRect: PagedRect;
  contentClip: PagedRect;
  contentTransform: PagedMatrix;
  targetScale: number;
  deviceScaleFactor: number;
  writingMode: PagedWritingMode;
  direction: PagedDirection;
  fragments: PagedFragmentRecord[];
  propertyTrees: {
    transforms: PagedTransformNode[];
    clips: PagedClipNode[];
    effects: PagedEffectNode[];
  };
  paintChunks: PagedPaintChunkRecord[];
  vectorPaint: PagedVectorPaintRecord;
  tableFragments: PagedTableFragmentGeometry[];
}

export interface AuthenticatedPagedPageRecord {
  schemaVersion: typeof PAGED_PAGE_RECORD_VERSION;
  helperAbi: typeof PAGED_PAGE_RECORD_ABI;
  status: "authenticated";
  sourceRevision: typeof PAGED_PAGE_RECORD_CHROMIUM_REVISION;
  capturePhase: "per-page-after-paint-before-record-consumption";
  coordinateUnit: "Blink-LayoutUnit-1/64-css-px";
  paintSource: "Blink-PaintArtifact-and-cc-PaintRecord";
  pdfOrScreenshotUsedAsInput: false;
  serializedByteLength: number;
  document: {
    frameToken: string;
    documentToken: string;
    loaderId: string;
    url: string;
    printEpochId: string;
    printParametersSha256: string;
    layoutGeneration: number;
  };
  pages: AuthenticatedPagedPage[];
  collapsedTables: AuthenticatedPagedCollapsedTableRecord;
}

export interface UnavailablePagedPageRecord {
  schemaVersion: typeof PAGED_PAGE_RECORD_VERSION;
  helperAbi: typeof PAGED_PAGE_RECORD_ABI;
  status: "unavailable";
  sourceRevision: typeof PAGED_PAGE_RECORD_CHROMIUM_REVISION;
  reason:
    | "helper-not-enabled"
    | "unsupported-paint"
    | "unsupported-foreign-content"
    | "payload-too-large"
    | "layout-epoch-changed"
    | "incomplete-geometry"
    | "invalid-record";
  detail: string;
  pageIndex: number | null;
  unsupportedPaintOps: string[];
  maximumBytes: typeof PAGED_PAGE_RECORD_MAX_BYTES;
  pdfOrScreenshotUsedAsInput: false;
}

export type PagedPageRecord = AuthenticatedPagedPageRecord | UnavailablePagedPageRecord;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function finite(values: number[]): boolean {
  return values.every(Number.isFinite);
}

function validLayoutUnit(value: number): boolean {
  return Number.isFinite(value) && Math.round(value * 64) / 64 === value;
}

function validateRect(rect: PagedRect, name: string, errors: string[]): void {
  if (!finite([rect.x, rect.y, rect.width, rect.height])) errors.push(`${name} is not finite`);
  if (![rect.x, rect.y, rect.width, rect.height].every(validLayoutUnit)) {
    errors.push(`${name} is not canonical Blink LayoutUnit geometry`);
  }
  if (rect.width < 0 || rect.height < 0) errors.push(`${name} has negative dimensions`);
}

function validateMatrix(matrix: PagedMatrix, name: string, errors: string[]): void {
  if (!finite([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f])) {
    errors.push(`${name} is not finite`);
  }
}

function validateSequence<T>(values: T[], sequence: (value: T) => number, name: string, errors: string[]): void {
  values.forEach((value, index) => {
    if (sequence(value) !== index) errors.push(`${name} sequence is not consecutive`);
  });
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function hasParentCycle<T extends { id: string; parentId: string | null }>(nodes: T[]): boolean {
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  for (const node of nodes) {
    const seen = new Set<string>();
    let current: string | null = node.id;
    while (current != null) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = parentById.get(current) ?? null;
    }
  }
  return false;
}

/** Rejects any record that cannot be replayed without inference. */
export function validateAuthenticatedPagedPageRecord(record: AuthenticatedPagedPageRecord): string[] {
  const errors: string[] = [];
  if (record.schemaVersion !== PAGED_PAGE_RECORD_VERSION) errors.push("wrong page-record schema version");
  if (record.helperAbi !== PAGED_PAGE_RECORD_ABI) errors.push("wrong page-record helper ABI");
  if (record.sourceRevision !== PAGED_PAGE_RECORD_CHROMIUM_REVISION) errors.push("wrong Chromium revision");
  if (record.capturePhase !== "per-page-after-paint-before-record-consumption") errors.push("page record was captured at the wrong lifecycle boundary");
  if (record.coordinateUnit !== "Blink-LayoutUnit-1/64-css-px") errors.push("page record has an unsupported coordinate unit");
  if (record.paintSource !== "Blink-PaintArtifact-and-cc-PaintRecord") errors.push("page record lacks source-owned paint");
  if (record.pdfOrScreenshotUsedAsInput !== false) errors.push("PDF or screenshot input is forbidden");
  if (!Number.isSafeInteger(record.serializedByteLength) || record.serializedByteLength <= 0
      || record.serializedByteLength > PAGED_PAGE_RECORD_MAX_BYTES) errors.push("page record exceeds its hard byte bound");
  if ([record.document.frameToken, record.document.documentToken, record.document.loaderId,
    record.document.url, record.document.printEpochId].some((value) => value.trim() === "")) {
    errors.push("document or print-epoch identity is incomplete");
  }
  if (!validSha256(record.document.printParametersSha256)) errors.push("print parameters are not bound by sha256");
  if (!Number.isSafeInteger(record.document.layoutGeneration) || record.document.layoutGeneration < 0) {
    errors.push("invalid layout generation");
  }
  if (record.pages.length === 0) errors.push("page record has no pages");

  const allFragmentIds = new Set<string>();
  const allPaintClientIds = new Set<string>();
  for (const [selectionIndex, page] of record.pages.entries()) {
    if (page.selectionIndex !== selectionIndex) errors.push("selected page indices are not consecutive");
    if (page.pageIndex < 0 || !Number.isInteger(page.pageIndex)) errors.push("invalid page index");
    validateRect(page.pageArea, "page area", errors);
    validateRect(page.pageBorderBox, "page border box", errors);
    validateRect(page.contentArea, "page content area", errors);
    validateRect(page.stitchedContentRect, "stitched content rect", errors);
    validateRect(page.contentClip, "page content clip", errors);
    validateMatrix(page.contentTransform, "page content transform", errors);
    if (!(page.targetScale > 0) || !(page.deviceScaleFactor > 0)) errors.push("page scales must be positive");

    const pageFragmentIds = new Set<string>();
    page.fragments.forEach((fragment, index) => {
      if (!fragment.occurrenceId || allFragmentIds.has(fragment.occurrenceId)) errors.push("duplicate or empty physical fragment occurrence identity");
      allFragmentIds.add(fragment.occurrenceId);
      pageFragmentIds.add(fragment.occurrenceId);
      if (fragment.parentOccurrenceId != null && !pageFragmentIds.has(fragment.parentOccurrenceId)) {
        errors.push("fragment parent is absent or ordered after its child");
      }
      if (fragment.childPaintOrder !== index) errors.push("fragment paint order is not consecutive");
      if (!fragment.source.frameToken || !fragment.source.documentToken) errors.push("fragment source epoch is incomplete");
      if (fragment.source.backendNodeId != null
          && (!Number.isSafeInteger(fragment.source.backendNodeId) || fragment.source.backendNodeId <= 0)) {
        errors.push("fragment backend DOM node id is invalid");
      }
      if (fragment.source.backendNodeId == null && fragment.source.syntheticRole == null) errors.push("fragment lacks DOM or synthetic source identity");
      validateRect(fragment.borderBox, "fragment border box", errors);
      if (fragment.overflowClip) validateRect(fragment.overflowClip, "fragment overflow clip", errors);
      validateMatrix(fragment.pageTransform, "fragment page transform", errors);
      if (!(fragment.effectiveZoom > 0)) errors.push("fragment effective zoom must be positive");
      if (fragment.breakToken != null
          && (!Number.isSafeInteger(fragment.breakToken.sequence) || fragment.breakToken.sequence < 0
            || !validLayoutUnit(fragment.breakToken.consumedBlockSize))) {
        errors.push("fragment break token is invalid");
      }
      fragment.paintClientIds.forEach((clientId) => allPaintClientIds.add(clientId));
    });

    const transforms = new Set(page.propertyTrees.transforms.map((node) => node.id));
    const clips = new Set(page.propertyTrees.clips.map((node) => node.id));
    const effects = new Set(page.propertyTrees.effects.map((node) => node.id));
    if (transforms.size !== page.propertyTrees.transforms.length
        || clips.size !== page.propertyTrees.clips.length
        || effects.size !== page.propertyTrees.effects.length) errors.push("duplicate paint property node identity");
    if (hasParentCycle(page.propertyTrees.transforms)
        || hasParentCycle(page.propertyTrees.clips)
        || hasParentCycle(page.propertyTrees.effects)) errors.push("paint property tree contains a cycle");
    for (const node of page.propertyTrees.transforms) {
      if (node.parentId != null && !transforms.has(node.parentId)) errors.push("transform property parent is missing");
      validateMatrix(node.matrix, "paint transform", errors);
    }
    for (const node of page.propertyTrees.clips) {
      if (node.parentId != null && !clips.has(node.parentId)) errors.push("clip property parent is missing");
      if (!transforms.has(node.transformId)) errors.push("clip transform is missing");
      validateRect(node.rect, "paint clip", errors);
      if (!finite([...node.radii]) || node.radii.some((radius) => radius < 0)) errors.push("invalid clip radii");
    }
    for (const node of page.propertyTrees.effects) {
      if (node.parentId != null && !effects.has(node.parentId)) errors.push("effect property parent is missing");
      if (!transforms.has(node.transformId) || !clips.has(node.clipId)) errors.push("effect property reference is missing");
      if (node.opacity < 0 || node.opacity > 1) errors.push("effect opacity is outside [0,1]");
      if (node.blendMode !== "normal" || node.filter !== "none") errors.push("unsupported effect escaped fail-closed capture");
    }

    validateSequence(page.paintChunks, (chunk) => chunk.sequence, "paint chunk", errors);
    let expectedDisplaySequence = 0;
    const observedPaintClients = new Set<string>();
    const chunkIds = new Set<string>();
    const itemIds = new Set<string>();
    for (const chunk of page.paintChunks) {
      if (!chunk.id || chunkIds.has(chunk.id)) errors.push("duplicate or empty paint chunk identity");
      chunkIds.add(chunk.id);
      if (!transforms.has(chunk.transformId) || !clips.has(chunk.clipId) || !effects.has(chunk.effectId)) {
        errors.push("paint chunk property state is incomplete");
      }
      for (const item of chunk.displayItems) {
        if (!item.id || itemIds.has(item.id)) errors.push("duplicate or empty display-item identity");
        itemIds.add(item.id);
        if (item.sequence !== expectedDisplaySequence++) errors.push("display-item sequence is not consecutive");
        if (!item.id || !item.clientId
            || !Number.isSafeInteger(item.flattenedPaintOpStart)
            || !Number.isSafeInteger(item.flattenedPaintOpEndExclusive)
            || item.flattenedPaintOpStart < 0
            || item.flattenedPaintOpEndExclusive <= item.flattenedPaintOpStart
            || item.flattenedPaintOpEndExclusive > page.vectorPaint.sourcePaintOpCount) {
          errors.push("display item paint-op range is incomplete");
        }
        observedPaintClients.add(item.clientId);
        if (item.fragmentOccurrenceId != null && !pageFragmentIds.has(item.fragmentOccurrenceId)) {
          errors.push("display item references a missing fragment occurrence");
        }
        if (item.fragmentOccurrenceId != null) {
          const fragment = page.fragments.find((candidate) => candidate.occurrenceId === item.fragmentOccurrenceId);
          if (fragment != null && !fragment.paintClientIds.includes(item.clientId)) {
            errors.push("display item client disagrees with its fragment occurrence");
          }
        }
        validateRect(item.visualRect, "display-item visual rect", errors);
      }
    }
    const vector = page.vectorPaint;
    const vectorBytes = Buffer.from(vector.svg, "utf8");
    if (vector.kind !== "preflighted-skia-svg-v1"
        || !vector.recursivePreflightComplete || !vector.textConvertedToPaths
        || !vector.embeddedImagesOnly || vector.externalReferences !== false
        || vector.unsupportedPaintOps.length !== 0) errors.push("vector paint did not pass the closed recursive preflight");
    if (!Number.isSafeInteger(vector.svgByteLength) || vector.svgByteLength !== vectorBytes.byteLength
        || !validSha256(vector.svgSha256)
        || createHash("sha256").update(vectorBytes).digest("hex") !== vector.svgSha256) {
      errors.push("vector paint bytes are not authenticated");
    }
    if (!/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/.test(vector.svg)
        || /<(?:script|foreignObject)\b/i.test(vector.svg)
        || /\son[a-z]+\s*=/i.test(vector.svg)
        || /(?:href|src)\s*=\s*["'](?!data:|#)/i.test(vector.svg)) {
      errors.push("vector paint is not a self-contained inert SVG");
    }
    if (!Number.isSafeInteger(vector.sourcePaintOpCount) || vector.sourcePaintOpCount <= 0
        || vector.sourcePaintOpTypes.length !== vector.sourcePaintOpCount
        || vector.sourcePaintOpTypes.some((type) => !type)) errors.push("vector paint operation ledger is incomplete");
    for (const fragment of page.fragments) {
      for (const clientId of fragment.paintClientIds) {
        if (!observedPaintClients.has(clientId)) errors.push("fragment paint client has no display item");
      }
    }
    for (const geometry of page.tableFragments) {
      if (geometry.pageIndex !== page.pageIndex) errors.push("table fragment belongs to the wrong page");
      if (!pageFragmentIds.has(geometry.physicalFragmentId)) errors.push("table geometry lacks a physical fragment occurrence");
      validateRect(geometry.borderBox, "table fragment border box", errors);
      if (geometry.overflowClip) validateRect(geometry.overflowClip, "table fragment overflow clip", errors);
    }
  }
  if (new Set(record.pages.map((page) => page.pageIndex)).size !== record.pages.length
      || record.pages.some((page, index) => index > 0
        && page.pageIndex <= record.pages[index - 1].pageIndex)) {
    errors.push("source document page indices are not unique and increasing");
  }
  for (const clientId of allPaintClientIds) {
    if (!record.pages.some((page) => page.paintChunks.some((chunk) =>
      chunk.displayItems.some((item) => item.clientId === clientId)))) {
      errors.push("paint client is absent from all page paint streams");
    }
  }

  errors.push(...validateAuthenticatedPagedCollapsedTableRecord(record.collapsedTables)
    .map((error) => `collapsed table record: ${error}`));
  record.pages.forEach((page) => {
    const tablePage = record.collapsedTables.pages.find((candidate) => candidate.pageIndex === page.pageIndex);
    if (!tablePage) errors.push("selected page is missing from the collapsed-table stream");
    if (tablePage && (tablePage.pageIndex !== page.pageIndex || tablePage.pageName !== page.pageName
      || tablePage.emptyKind !== page.emptyKind)) errors.push("page and collapsed-table identities disagree");
  });
  return [...new Set(errors)];
}

export function unavailablePagedPageRecord(
  reason: UnavailablePagedPageRecord["reason"],
  detail: string,
  options: { pageIndex?: number | null; unsupportedPaintOps?: string[] } = {},
): UnavailablePagedPageRecord {
  return {
    schemaVersion: PAGED_PAGE_RECORD_VERSION,
    helperAbi: PAGED_PAGE_RECORD_ABI,
    status: "unavailable",
    sourceRevision: PAGED_PAGE_RECORD_CHROMIUM_REVISION,
    reason,
    detail,
    pageIndex: options.pageIndex ?? null,
    unsupportedPaintOps: [...new Set(options.unsupportedPaintOps ?? [])].sort(),
    maximumBytes: PAGED_PAGE_RECORD_MAX_BYTES,
    pdfOrScreenshotUsedAsInput: false,
  };
}

/** Parse untrusted helper output without ever promoting a partial record. */
export function parsePagedPageRecord(json: string): PagedPageRecord {
  const byteLength = new TextEncoder().encode(json).byteLength;
  if (byteLength > PAGED_PAGE_RECORD_MAX_BYTES) {
    return unavailablePagedPageRecord(
      "payload-too-large",
      `page record is ${byteLength} bytes; maximum is ${PAGED_PAGE_RECORD_MAX_BYTES}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return unavailablePagedPageRecord(
      "invalid-record",
      `page record is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(value) || value.schemaVersion !== PAGED_PAGE_RECORD_VERSION
      || value.helperAbi !== PAGED_PAGE_RECORD_ABI
      || value.sourceRevision !== PAGED_PAGE_RECORD_CHROMIUM_REVISION) {
    return unavailablePagedPageRecord("invalid-record", "page record identity is missing or incompatible");
  }
  if (value.status === "unavailable") {
    const allowedReasons = new Set<UnavailablePagedPageRecord["reason"]>([
      "helper-not-enabled",
      "unsupported-paint",
      "unsupported-foreign-content",
      "payload-too-large",
      "layout-epoch-changed",
      "incomplete-geometry",
      "invalid-record",
    ]);
    if (typeof value.reason === "string" && allowedReasons.has(value.reason as UnavailablePagedPageRecord["reason"])
        && typeof value.detail === "string" && (value.pageIndex == null || Number.isInteger(value.pageIndex))
        && Array.isArray(value.unsupportedPaintOps)
        && value.unsupportedPaintOps.every((op) => typeof op === "string")
        && value.maximumBytes === PAGED_PAGE_RECORD_MAX_BYTES
        && value.pdfOrScreenshotUsedAsInput === false) {
      return value as unknown as UnavailablePagedPageRecord;
    }
    return unavailablePagedPageRecord("invalid-record", "helper unavailable record is malformed");
  }
  if (value.status !== "authenticated") {
    return unavailablePagedPageRecord("invalid-record", "page record status is missing or incompatible");
  }
  try {
    const candidate = value as unknown as AuthenticatedPagedPageRecord;
    const errors = validateAuthenticatedPagedPageRecord(candidate);
    return errors.length === 0
      ? candidate
      : unavailablePagedPageRecord("invalid-record", errors.join("; "));
  } catch (error) {
    return unavailablePagedPageRecord(
      "invalid-record",
      `page record structure is incomplete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
