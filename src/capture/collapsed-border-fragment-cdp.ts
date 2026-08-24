/**
 * Same-epoch CSSOM/CDP collector for fragmented collapsed-table ownership.
 * Browser-backed geometry is collected only after every CSS transform in the
 * candidate table subtrees/ancestor chains is neutralized, then the original
 * frame is restored and reauthenticated before facts are exposed to
 * CAPTURE_SCRIPT through a private page-global registry.
 */

import type { CDPSession, Frame, Page } from "@playwright/test";

import {
  buildCollapsedBorderFragmentRecord,
  canonicalCollapsedBorderLayoutUnit,
  type CollapsedBorderCaptionSourceEvidence,
  type CollapsedBorderCellSourceEvidence,
  type CollapsedBorderFragmentDirection,
  type CollapsedBorderFragmentGeometryEvidence,
  type CollapsedBorderFragmentRecord,
  type CollapsedBorderFragmentRecordInput,
  type CollapsedBorderFragmentWritingMode,
  type CollapsedBorderPhysicalRect,
  type CollapsedBorderRowSourceEvidence,
  type CollapsedBorderSectionSourceEvidence,
} from "./collapsed-border-fragment-record.js";
import type { CaptureWarning } from "./types.js";

interface SourceNodeMetadata {
  nodeIndex: number;
}

interface SectionMetadata extends SourceNodeMetadata {
  sourceIndex: number;
  tableChildIndex: number;
  tag: "thead" | "tbody" | "tfoot";
  globalStartRowIndex: number;
  globalRowCount: number;
}

interface RowMetadata extends SourceNodeMetadata {
  sourceIndex: number;
  sectionSourceIndex: number;
  globalRowIndex: number;
}

interface CellMetadata extends SourceNodeMetadata {
  sourceIndex: number;
  globalRowIndex: number;
  globalColumnIndex: number;
  rowSpan: number;
  columnSpan: number;
}

interface CaptionMetadata extends SourceNodeMetadata {
  sourceIndex: number;
  tableChildIndex: number;
}

interface TableMetadata extends SourceNodeMetadata {
  tableIndex: number;
  selector: string;
  writingMode: string;
  direction: string;
  totalRows: number;
  totalColumns: number;
  sections: SectionMetadata[];
  rows: RowMetadata[];
  cells: CellMetadata[];
  captions: CaptionMetadata[];
}

interface PreparedFrame {
  frame: Frame;
  token: string;
  tables: TableMetadata[];
  nodeCount: number;
}

export interface CollapsedBorderFragmentProbe {
  key: string;
  warnings: CaptureWarning[];
  dispose(): Promise<void>;
}

type QuadMap = Map<string, number[][]>;
type CssomMap = Map<string, CollapsedBorderPhysicalRect[]>;

const FEATURE = "fragmented collapsed-table ownership";

function normalizeWritingMode(value: string): CollapsedBorderFragmentWritingMode {
  if (value === "vertical-rl" || value === "vertical-lr" || value === "sideways-rl" || value === "sideways-lr") return value;
  return "horizontal-tb";
}

function normalizeDirection(value: string): CollapsedBorderFragmentDirection {
  return value === "rtl" ? "rtl" : "ltr";
}

async function installEvaluateNameShim(frames: readonly Frame[]): Promise<Frame[]> {
  const installed: Frame[] = [];
  for (const frame of frames) {
    const didInstall = await frame.evaluate(`(() => {
      if (typeof globalThis.__name === "function") return false;
      globalThis.__name = function(value) { return value; };
      return true;
    })()`).catch(() => false);
    if (didInstall) installed.push(frame);
  }
  return installed;
}

async function removeEvaluateNameShim(frames: readonly Frame[]): Promise<void> {
  await Promise.all(frames.map((frame) => frame.evaluate(`delete globalThis.__name`).catch(() => undefined)));
}

async function setupFrame(
  frame: Frame,
  selector: string,
  key: string,
  token: string,
  top: boolean,
): Promise<PreparedFrame | null> {
  try {
    const raw = await frame.evaluate(({ selector, key, token, top }) => {
      const root = top ? document.querySelector(selector) : document.documentElement;
      if (root == null) return { tables: [], nodeCount: 0 };
      const nodes: Element[] = [];
      const nodeIndex = new WeakMap<Element, number>();
      const addNode = (element: Element): number => {
        const hit = nodeIndex.get(element);
        if (hit != null) return hit;
        const index = nodes.length;
        nodes.push(element);
        nodeIndex.set(element, index);
        return index;
      };
      const shortSelector = (element: Element): string => {
        if (element.id !== "") return `#${CSS.escape(element.id)}`;
        return element.localName;
      };
      const candidates = [
        ...(root.localName === "table" ? [root] : []),
        ...Array.from(root.querySelectorAll("table")),
      ];
      const tables: TableMetadata[] = [];
      const transformOwners = new Set<Element>();
      for (const table of candidates) {
        const style = getComputedStyle(table);
        if (style.borderCollapse !== "collapse") continue;
        const tableRects = Array.from(table.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
        if (tableRects.length <= 1) continue;

        const sectionElements = Array.from(table.children).filter((child) =>
          child.tagName === "THEAD" || child.tagName === "TBODY" || child.tagName === "TFOOT");
        const rows: RowMetadata[] = [];
        const sections: SectionMetadata[] = [];
        const cells: CellMetadata[] = [];
        let globalRowIndex = 0;
        let totalColumns = 0;
        for (let sectionSourceIndex = 0; sectionSourceIndex < sectionElements.length; sectionSourceIndex++) {
          const section = sectionElements[sectionSourceIndex] as HTMLTableSectionElement;
          const sectionStart = globalRowIndex;
          const occupancy: boolean[][] = [];
          for (const row of Array.from(section.rows)) {
            const rowIndex = globalRowIndex++;
            rows.push({
              nodeIndex: addNode(row),
              sourceIndex: rows.length,
              sectionSourceIndex,
              globalRowIndex: rowIndex,
            });
            occupancy[rowIndex] ??= [];
            let column = 0;
            for (const cell of Array.from(row.cells)) {
              while (occupancy[rowIndex][column]) column++;
              const rowSpan = Math.max(1, cell.rowSpan || 1);
              const columnSpan = Math.max(1, cell.colSpan || 1);
              cells.push({
                nodeIndex: addNode(cell),
                sourceIndex: cells.length,
                globalRowIndex: rowIndex,
                globalColumnIndex: column,
                rowSpan,
                columnSpan,
              });
              for (let rowOffset = 0; rowOffset < rowSpan; rowOffset++) {
                occupancy[rowIndex + rowOffset] ??= [];
                for (let columnOffset = 0; columnOffset < columnSpan; columnOffset++) {
                  occupancy[rowIndex + rowOffset][column + columnOffset] = true;
                }
              }
              column += columnSpan;
              totalColumns = Math.max(totalColumns, column);
            }
          }
          sections.push({
            nodeIndex: addNode(section),
            sourceIndex: sectionSourceIndex,
            tableChildIndex: Array.from(table.children).indexOf(section),
            tag: section.localName as "thead" | "tbody" | "tfoot",
            globalStartRowIndex: sectionStart,
            globalRowCount: globalRowIndex - sectionStart,
          });
        }
        const captions = Array.from(table.children)
          .filter((child): child is HTMLTableCaptionElement => child.tagName === "CAPTION")
          .map((caption, sourceIndex) => ({
            nodeIndex: addNode(caption),
            sourceIndex,
            tableChildIndex: Array.from(table.children).indexOf(caption),
          }));
        const tableIndex = tables.length;
        tables.push({
          nodeIndex: addNode(table),
          tableIndex,
          selector: shortSelector(table),
          writingMode: style.writingMode,
          direction: style.direction,
          totalRows: globalRowIndex,
          totalColumns,
          sections,
          rows,
          cells,
          captions,
        });
        for (const descendant of [table, ...Array.from(table.querySelectorAll("*"))]) {
          const descendantStyle = getComputedStyle(descendant);
          if (descendantStyle.transform !== "none"
            || descendantStyle.translate !== "none"
            || descendantStyle.rotate !== "none"
            || descendantStyle.scale !== "none"
            || descendantStyle.perspective !== "none"
            || descendantStyle.transformStyle === "preserve-3d") transformOwners.add(descendant);
        }
        for (let ancestor = table.parentElement; ancestor != null; ancestor = ancestor.parentElement) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (ancestorStyle.transform !== "none"
            || ancestorStyle.translate !== "none"
            || ancestorStyle.rotate !== "none"
            || ancestorStyle.scale !== "none"
            || ancestorStyle.perspective !== "none"
            || ancestorStyle.transformStyle === "preserve-3d") transformOwners.add(ancestor);
          if (ancestor === root) break;
        }
      }
      (globalThis as typeof globalThis & Record<string, unknown>)[key] = {
        token,
        nodes,
        tables: tables.map((table) => nodes[table.nodeIndex]),
        records: [],
        transformOwners: [...transformOwners],
        snapshots: null,
      };
      return { tables, nodeCount: nodes.length };
    }, { selector, key, token, top });
    return { frame, token, tables: raw.tables, nodeCount: raw.nodeCount };
  } catch {
    return null;
  }
}

async function mutateTransforms(frames: readonly PreparedFrame[], key: string, neutral: boolean): Promise<boolean> {
  const results = await Promise.all(frames.map(({ frame }) => frame.evaluate(({ key, neutral }) => {
    const registry = (globalThis as typeof globalThis & Record<string, {
      transformOwners: HTMLElement[];
      snapshots: Array<{ owner: HTMLElement; styleAttribute: string | null }> | null;
    }>)[key];
    if (registry == null) return false;
    if (neutral) {
      registry.snapshots = [];
      for (const owner of registry.transformOwners) {
        registry.snapshots.push({ owner, styleAttribute: owner.getAttribute("style") });
        owner.style.setProperty("transform", "matrix(1, 0, 0, 1, 0, 0)", "important");
        owner.style.setProperty("translate", "none", "important");
        owner.style.setProperty("rotate", "none", "important");
        owner.style.setProperty("scale", "none", "important");
        owner.style.setProperty("perspective", "none", "important");
        owner.style.setProperty("transform-style", "flat", "important");
      }
    } else {
      for (const snapshot of registry.snapshots ?? []) {
        if (snapshot.styleAttribute == null) {
          snapshot.owner.style.cssText = "";
          const styleAttribute = snapshot.owner.getAttributeNode("style");
          if (styleAttribute != null) snapshot.owner.removeAttributeNode(styleAttribute);
        }
        else snapshot.owner.setAttribute("style", snapshot.styleAttribute);
      }
      const exact = (registry.snapshots ?? []).every(({ owner, styleAttribute }) =>
        owner.getAttribute("style") === styleAttribute);
      registry.snapshots = null;
      return exact;
    }
    return true;
  }, { key, neutral }).catch(() => false)));
  return results.every((result) => result === true);
}

async function settleFrames(frames: readonly PreparedFrame[]): Promise<void> {
  await Promise.all(frames.map(({ frame }) => frame.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  })).catch(() => undefined)));
}

async function defaultRuntimeContexts(session: CDPSession, key: string): Promise<Map<string, number>> {
  const contextIds: number[] = [];
  session.on("Runtime.executionContextCreated", (event) => {
    if (event.context.auxData?.isDefault) contextIds.push(event.context.id);
  });
  await Promise.all([session.send("Runtime.enable"), session.send("DOM.enable")]);
  const result = new Map<string, number>();
  for (const contextId of contextIds) {
    const evaluated = await session.send("Runtime.evaluate", {
      expression: `globalThis[${JSON.stringify(key)}]?.token ?? ""`,
      contextId,
      returnByValue: true,
      silent: true,
    }).catch(() => null);
    const token = evaluated?.result.value;
    if (typeof token === "string" && token !== "") result.set(token, contextId);
  }
  return result;
}

async function measureProtocol(
  session: CDPSession,
  key: string,
  frames: readonly PreparedFrame[],
  contexts: ReadonlyMap<string, number>,
): Promise<QuadMap> {
  const result: QuadMap = new Map();
  for (const prepared of frames) {
    const contextId = contexts.get(prepared.token);
    if (contextId == null) continue;
    for (let nodeIndex = 0; nodeIndex < prepared.nodeCount; nodeIndex++) {
      let objectId: string | undefined;
      try {
        const evaluated = await session.send("Runtime.evaluate", {
          expression: `globalThis[${JSON.stringify(key)}]?.nodes?.[${nodeIndex}]`,
          contextId,
          returnByValue: false,
          silent: true,
        });
        objectId = evaluated.result.objectId;
        if (objectId == null) continue;
        const described = await session.send("DOM.describeNode", { objectId });
        const measured = await session.send("DOM.getContentQuads", { backendNodeId: described.node.backendNodeId });
        result.set(`${prepared.token}:${nodeIndex}`, measured.quads);
      } catch {
        result.set(`${prepared.token}:${nodeIndex}`, []);
      } finally {
        if (objectId != null) await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  }
  return result;
}

async function measureCssom(frames: readonly PreparedFrame[], key: string): Promise<CssomMap> {
  const result: CssomMap = new Map();
  await Promise.all(frames.map(async ({ frame, token }) => {
    const rows = await frame.evaluate((registryKey) => {
      const registry = (globalThis as typeof globalThis & Record<string, { nodes: Element[] }>)[registryKey];
      if (registry == null) return [];
      return registry.nodes.map((node) => Array.from(node.getClientRects(), (rect) => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })).filter((rect) => rect.width > 0 && rect.height > 0));
    }, key).catch(() => [] as CollapsedBorderPhysicalRect[][]);
    for (let nodeIndex = 0; nodeIndex < rows.length; nodeIndex++) {
      result.set(`${token}:${nodeIndex}`, rows[nodeIndex]);
    }
  }));
  return result;
}

function quadToken(quads: readonly number[][]): string {
  return quads.map((quad) => quad.map(canonicalCollapsedBorderLayoutUnit).join(",")).join(";");
}

function sourceRestoredExactly(
  frame: PreparedFrame,
  live: QuadMap,
  restored: QuadMap,
): boolean {
  for (let nodeIndex = 0; nodeIndex < frame.nodeCount; nodeIndex++) {
    const key = `${frame.token}:${nodeIndex}`;
    if (quadToken(live.get(key) ?? []) !== quadToken(restored.get(key) ?? [])) return false;
  }
  return true;
}

function geometry(
  frame: PreparedFrame,
  node: SourceNodeMetadata,
  cssom: CssomMap,
  protocol: QuadMap,
): CollapsedBorderFragmentGeometryEvidence {
  const key = `${frame.token}:${node.nodeIndex}`;
  return { cssomRects: cssom.get(key) ?? [], cdpQuads: protocol.get(key) ?? [] };
}

function buildRecord(
  frame: PreparedFrame,
  table: TableMetadata,
  cssom: CssomMap,
  protocol: QuadMap,
  restored: boolean,
): CollapsedBorderFragmentRecord {
  const sections: CollapsedBorderSectionSourceEvidence[] = table.sections.map((section) => ({
    ...section,
    geometry: geometry(frame, section, cssom, protocol),
  }));
  const rows: CollapsedBorderRowSourceEvidence[] = table.rows.map((row) => ({
    ...row,
    geometry: geometry(frame, row, cssom, protocol),
  }));
  const cells: CollapsedBorderCellSourceEvidence[] = table.cells.map((cell) => ({
    ...cell,
    geometry: geometry(frame, cell, cssom, protocol),
  }));
  const captions: CollapsedBorderCaptionSourceEvidence[] = table.captions.map((caption) => ({
    ...caption,
    geometry: geometry(frame, caption, cssom, protocol),
  }));
  const input: CollapsedBorderFragmentRecordInput = {
    writingMode: normalizeWritingMode(table.writingMode),
    direction: normalizeDirection(table.direction),
    totalRows: table.totalRows,
    totalColumns: table.totalColumns,
    table: geometry(frame, table, cssom, protocol),
    sections,
    rows,
    cells,
    captions,
    sourceRestoredExactly: restored,
  };
  return buildCollapsedBorderFragmentRecord(input);
}

export async function prepareCollapsedBorderFragmentRecords(
  page: Page,
  selector: string,
): Promise<CollapsedBorderFragmentProbe> {
  const key = `__domotionCollapsedBorderFragments_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const shimmedFrames = await installEvaluateNameShim(page.frames());
  const prepared = (await Promise.all(page.frames().map((frame, index) =>
    setupFrame(frame, selector, key, `f${index}`, frame === page.mainFrame()))))
    .filter((frame): frame is PreparedFrame => frame != null);
  const warnings: CaptureWarning[] = [];
  let session: CDPSession | undefined;
  let playbackRate: number | undefined;
  let neutral = false;
  try {
    if (prepared.every((frame) => frame.tables.length === 0)) {
      return {
        key,
        warnings,
        dispose: async () => {
          await removeEvaluateNameShim(shimmedFrames);
          await Promise.all(prepared.map(({ frame }) => frame.evaluate((probeKey) => {
            delete (globalThis as typeof globalThis & Record<string, unknown>)[probeKey];
          }, key).catch(() => undefined)));
        },
      };
    }
    session = await page.context().newCDPSession(page);
    const contexts = await defaultRuntimeContexts(session, key);
    try {
      await session.send("Animation.enable");
      playbackRate = (await session.send("Animation.getPlaybackRate")).playbackRate;
      await session.send("Animation.setPlaybackRate", { playbackRate: 0 });
    } catch {
      playbackRate = undefined;
    }
    const live = await measureProtocol(session, key, prepared, contexts);
    await mutateTransforms(prepared, key, true);
    neutral = true;
    await settleFrames(prepared);
    const [cssom, protocol] = await Promise.all([
      measureCssom(prepared, key),
      measureProtocol(session, key, prepared, contexts),
    ]);
    const stylesRestoredExactly = await mutateTransforms(prepared, key, false);
    neutral = false;
    await settleFrames(prepared);
    const restored = await measureProtocol(session, key, prepared, contexts);

    await Promise.all(prepared.map(async (frame) => {
      const restoredExactly = stylesRestoredExactly && sourceRestoredExactly(frame, live, restored);
      const records = frame.tables.map((table) => buildRecord(frame, table, cssom, protocol, restoredExactly));
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (record.status === "unavailable") {
          warnings.push({
            selector: frame.tables[index].selector,
            feature: FEATURE,
            detail: `authoritative physical section-fragment record unavailable: ${record.reason}; collapsed-border vector ownership withheld`,
            status: "partial",
          });
        }
      }
      await frame.frame.evaluate(({ key, records }) => {
        const registry = (globalThis as typeof globalThis & Record<string, { records: CollapsedBorderFragmentRecord[] }>)[key];
        if (registry != null) registry.records = records;
      }, { key, records });
    }));
  } catch (error) {
    warnings.push({
      selector,
      feature: FEATURE,
      detail: `authoritative physical section-fragment probe failed closed: ${error instanceof Error ? error.message : String(error)}`,
      status: "partial",
    });
  } finally {
    if (neutral) await mutateTransforms(prepared, key, false).catch(() => undefined);
    if (session != null && playbackRate != null) {
      await session.send("Animation.setPlaybackRate", { playbackRate }).catch(() => undefined);
    }
    await session?.send("Animation.disable").catch(() => undefined);
    await session?.detach().catch(() => undefined);
    await removeEvaluateNameShim(shimmedFrames);
  }
  return {
    key,
    warnings,
    dispose: async () => {
      await Promise.all(prepared.map(({ frame }) => frame.evaluate((probeKey) => {
        delete (globalThis as typeof globalThis & Record<string, unknown>)[probeKey];
      }, key).catch(() => undefined)));
    },
  };
}
