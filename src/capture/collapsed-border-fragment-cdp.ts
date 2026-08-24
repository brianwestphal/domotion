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
  type CollapsedBorderRepeatKind,
  type CollapsedBorderRepeatSectionEvidence,
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
  repeatKind: CollapsedBorderRepeatKind | null;
  breakInside: string;
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
  fragmentainerBlockSize: number | null;
  outsideNestedRepeatableContent: boolean;
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
type RepeatMap = Map<string, {
  repeatSections: CollapsedBorderRepeatSectionEvidence[];
  scrollRestoredExactly: boolean;
}>;

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

        const sectionElements = Array.from(table.children).filter((child): child is HTMLTableSectionElement =>
          child.tagName === "THEAD" || child.tagName === "TBODY" || child.tagName === "TFOOT");
        const sectionDisplays = new Map(sectionElements.map((section) =>
          [section, getComputedStyle(section).display]));
        const selectedHeader = sectionElements.find((section) => sectionDisplays.get(section) === "table-header-group");
        const selectedFooter = sectionElements.find((section) => sectionDisplays.get(section) === "table-footer-group");
        const groupedSections = [
          ...(selectedHeader == null ? [] : [selectedHeader]),
          ...sectionElements.filter((section) => section !== selectedHeader && section !== selectedFooter),
          ...(selectedFooter == null ? [] : [selectedFooter]),
        ];
        let columnOwner: Element | null = table.parentElement;
        while (columnOwner != null) {
          const ownerStyle = getComputedStyle(columnOwner);
          if (ownerStyle.columnCount !== "auto" || ownerStyle.columnWidth !== "auto") break;
          columnOwner = columnOwner.parentElement;
        }
        const columnOwnerStyle = columnOwner == null ? null : getComputedStyle(columnOwner);
        const parsedFragmentainerBlockSize = columnOwnerStyle == null
          ? Number.NaN
          : Number.parseFloat(columnOwnerStyle.blockSize);
        const fragmentainerBlockSize = Number.isFinite(parsedFragmentainerBlockSize)
          && parsedFragmentainerBlockSize > 0 ? parsedFragmentainerBlockSize : null;
        const nestedSection = table.parentElement?.closest("thead,tbody,tfoot") ?? null;
        const nestedStyle = nestedSection == null ? null : getComputedStyle(nestedSection);
        const outsideNestedRepeatableContent = nestedStyle == null
          || !((nestedStyle.display === "table-header-group" || nestedStyle.display === "table-footer-group")
            && (nestedStyle.breakInside === "avoid" || nestedStyle.breakInside === "avoid-column"));
        const rows: RowMetadata[] = [];
        const sectionMetadata = new Map<HTMLTableSectionElement, SectionMetadata>();
        const cells: CellMetadata[] = [];
        let globalRowIndex = 0;
        let totalColumns = 0;
        for (const section of groupedSections) {
          const sectionSourceIndex = sectionElements.indexOf(section);
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
          sectionMetadata.set(section, {
            nodeIndex: addNode(section),
            sourceIndex: sectionSourceIndex,
            tableChildIndex: Array.from(table.children).indexOf(section),
            tag: section.localName as "thead" | "tbody" | "tfoot",
            globalStartRowIndex: sectionStart,
            globalRowCount: globalRowIndex - sectionStart,
            repeatKind: section === selectedHeader ? "header" : section === selectedFooter ? "footer" : null,
            breakInside: getComputedStyle(section).breakInside,
          });
        }
        const sections = sectionElements.map((section) => sectionMetadata.get(section)!);
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
          fragmentainerBlockSize,
          outsideNestedRepeatableContent,
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

/**
 * CSSOM aliases expose only the repeat prototype. Blink's FragmentRepeater
 * deep-clones that prototype, so candidate geometry is source-derived while
 * each physical occurrence is independently admitted by intrinsic source-cell
 * membership at its exact cloned cell centers. No screenshot or fitted visual
 * threshold participates in this contract.
 */
async function measureRepeatOccurrences(
  frames: readonly PreparedFrame[],
  key: string,
): Promise<RepeatMap> {
  const result: RepeatMap = new Map();
  await Promise.all(frames.map(async (prepared) => {
    const measured = await prepared.frame.evaluate(({ key, tables }) => {
      type Rect = { x: number; y: number; width: number; height: number };
      const registry = (globalThis as typeof globalThis & Record<string, { nodes: Element[] }>)[key];
      if (registry == null) return { tables: [], scrollRestoredExactly: false };
      const nativeElementsFromPoint = Document.prototype.elementsFromPoint;
      const intrinsicHitTest = document.elementsFromPoint === nativeElementsFromPoint
        && Function.prototype.toString.call(nativeElementsFromPoint).includes("[native code]");
      const nativeScrollTo = window.scrollTo;
      const intrinsicScroll = typeof nativeScrollTo === "function"
        && Function.prototype.toString.call(nativeScrollTo).includes("[native code]");
      const scrollInstant = nativeScrollTo as unknown as (options: {
        left: number;
        top: number;
        behavior: "instant";
      }) => void;
      const savedScrollX = window.scrollX;
      const savedScrollY = window.scrollY;
      const rects = (element: Element): Rect[] => Array.from(element.getClientRects(), (rect) => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })).filter((rect) => rect.width > 0 && rect.height > 0);
      const token = (rect: Rect): string => `${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
      const overlap = (left: Rect, right: Rect): number => Math.max(0,
        Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
        * Math.max(0,
          Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
      const fragmentFor = (rect: Rect, fragments: Rect[]): number => {
        let best = -1;
        let bestArea = 0;
        let tied = false;
        for (let index = 0; index < fragments.length; index++) {
          const area = overlap(rect, fragments[index]);
          if (area > bestArea) {
            best = index;
            bestArea = area;
            tied = false;
          } else if (area > 0 && area === bestArea) tied = true;
        }
        return bestArea > 0 && !tied ? best : -1;
      };
      const logicalRect = (rect: Rect, owner: Rect, writingMode: string, direction: string) => {
        const horizontal = writingMode === "horizontal-tb";
        const inlineReverse = direction === "rtl";
        const blockReverse = writingMode === "vertical-rl" || writingMode === "sideways-rl";
        const right = rect.x + rect.width;
        const bottom = rect.y + rect.height;
        const ownerRight = owner.x + owner.width;
        const ownerBottom = owner.y + owner.height;
        return {
          inlineStart: horizontal
            ? (inlineReverse ? ownerRight - right : rect.x - owner.x)
            : (inlineReverse ? ownerBottom - bottom : rect.y - owner.y),
          inlineEnd: horizontal
            ? (inlineReverse ? ownerRight - rect.x : right - owner.x)
            : (inlineReverse ? ownerBottom - rect.y : bottom - owner.y),
          blockStart: horizontal ? rect.y - owner.y
            : (blockReverse ? ownerRight - right : rect.x - owner.x),
          blockEnd: horizontal ? bottom - owner.y
            : (blockReverse ? ownerRight - rect.x : right - owner.x),
        };
      };
      const physicalRect = (
        logical: { inlineStart: number; inlineEnd: number; blockStart: number; blockEnd: number },
        owner: Rect,
        writingMode: string,
        direction: string,
      ): Rect => {
        const horizontal = writingMode === "horizontal-tb";
        const inlineReverse = direction === "rtl";
        const blockReverse = writingMode === "vertical-rl" || writingMode === "sideways-rl";
        if (horizontal) return {
          x: inlineReverse ? owner.x + owner.width - logical.inlineEnd : owner.x + logical.inlineStart,
          y: owner.y + logical.blockStart,
          width: logical.inlineEnd - logical.inlineStart,
          height: logical.blockEnd - logical.blockStart,
        };
        return {
          x: blockReverse ? owner.x + owner.width - logical.blockEnd : owner.x + logical.blockStart,
          y: inlineReverse ? owner.y + owner.height - logical.inlineEnd : owner.y + logical.inlineStart,
          width: logical.blockEnd - logical.blockStart,
          height: logical.inlineEnd - logical.inlineStart,
        };
      };
      const blockSize = (rect: Rect, writingMode: string): number =>
        writingMode === "horizontal-tb" ? rect.height : rect.width;
      const occurrenceRect = (
        prototype: Rect,
        prototypeTable: Rect,
        targetTable: Rect,
        kind: CollapsedBorderRepeatKind,
        writingMode: string,
        direction: string,
      ): Rect => {
        const logical = logicalRect(prototype, prototypeTable, writingMode, direction);
        const extent = logical.blockEnd - logical.blockStart;
        if (kind === "footer") {
          const endInset = blockSize(prototypeTable, writingMode) - logical.blockEnd;
          logical.blockEnd = blockSize(targetTable, writingMode) - endInset;
          logical.blockStart = logical.blockEnd - extent;
        }
        return physicalRect(logical, targetTable, writingMode, direction);
      };
      const hit = (point: { x: number; y: number }, source: Element): boolean => {
        if (!intrinsicHitTest || !intrinsicScroll) return false;
        const desiredX = savedScrollX + point.x - document.documentElement.clientWidth / 2;
        const desiredY = savedScrollY + point.y - document.documentElement.clientHeight / 2;
        scrollInstant.call(window, { left: desiredX, top: desiredY, behavior: "instant" });
        const x = point.x - (window.scrollX - savedScrollX);
        const y = point.y - (window.scrollY - savedScrollY);
        const witnessed = x >= 0 && x < document.documentElement.clientWidth
          && y >= 0 && y < document.documentElement.clientHeight
          && nativeElementsFromPoint.call(document, x, y).includes(source);
        scrollInstant.call(window, { left: savedScrollX, top: savedScrollY, behavior: "instant" });
        return witnessed;
      };

      const reports = tables.map((table) => {
        const tableNode = registry.nodes[table.nodeIndex];
        const tableRects = tableNode == null ? [] : rects(tableNode);
        const repeats: CollapsedBorderRepeatSectionEvidence[] = [];
        for (const section of table.sections) {
          if (section.repeatKind == null) continue;
          const sectionNode = registry.nodes[section.nodeIndex];
          if (sectionNode == null) continue;
          const aliases = rects(sectionNode);
          if (aliases.length <= 1 || aliases.some((rect) => token(rect) !== token(aliases[0]))) continue;
          const prototype = aliases[0];
          const prototypeFragmentIndex = fragmentFor(prototype, tableRects);
          const expectedCells = table.cells.filter((cell) =>
            cell.globalRowIndex >= section.globalStartRowIndex
            && cell.globalRowIndex < section.globalStartRowIndex + section.globalRowCount);
          const sourceRows = table.rows.filter((row) => row.sectionSourceIndex === section.sourceIndex);
          const exactAliasSet = (nodeIndex: number): boolean => {
            const node = registry.nodes[nodeIndex];
            if (node == null) return false;
            const nodeAliases = rects(node);
            return nodeAliases.length === aliases.length
              && nodeAliases.length > 0
              && nodeAliases.every((rect) => token(rect) === token(nodeAliases[0]));
          };
          const noBreakInside = sourceRows.length > 0
            && expectedCells.length > 0
            && sourceRows.every((row) => exactAliasSet(row.nodeIndex))
            && expectedCells.every((cell) => exactAliasSet(cell.nodeIndex));
          const occurrences: CollapsedBorderRepeatSectionEvidence["occurrences"] = [];
          if (prototypeFragmentIndex >= 0 && expectedCells.length > 0) {
            for (let fragmentIndex = 0; fragmentIndex < tableRects.length; fragmentIndex++) {
              const targetSection = occurrenceRect(
                prototype,
                tableRects[prototypeFragmentIndex],
                tableRects[fragmentIndex],
                section.repeatKind,
                table.writingMode,
                table.direction,
              );
              const witnessed: number[] = [];
              for (const cell of expectedCells) {
                const cellNode = registry.nodes[cell.nodeIndex];
                const prototypeCell = cellNode == null ? undefined : rects(cellNode)[0];
                if (prototypeCell == null) continue;
                const cellInSection = logicalRect(
                  prototypeCell,
                  prototype,
                  table.writingMode,
                  table.direction,
                );
                const targetCell = physicalRect(
                  cellInSection,
                  targetSection,
                  table.writingMode,
                  table.direction,
                );
                if (hit({
                  x: targetCell.x + targetCell.width / 2,
                  y: targetCell.y + targetCell.height / 2,
                }, cellNode)) witnessed.push(cell.sourceIndex);
              }
              const expected = expectedCells.map((cell) => cell.sourceIndex);
              if (witnessed.length === expected.length
                  && witnessed.every((sourceIndex, index) => sourceIndex === expected[index])) {
                occurrences.push({
                  occurrenceIndex: occurrences.length,
                  fragmentIndex,
                  physicalRect: targetSection,
                  expectedCellSourceIndices: expected,
                  witnessedCellSourceIndices: witnessed,
                  hitTest: "Document.elementsFromPoint-intrinsic-source-cell-membership",
                });
              }
            }
          }
          const sectionBlockSize = blockSize(prototype, table.writingMode);
          const knownFragmentainerBlockSize = table.fragmentainerBlockSize != null
            && table.fragmentainerBlockSize > 0;
          repeats.push({
            sectionSourceIndex: section.sourceIndex,
            repeatKind: section.repeatKind,
            eligibility: {
              fragmentationType: "column",
              fragmentainerBlockSize: table.fragmentainerBlockSize ?? 0,
              sectionBlockSize,
              knownFragmentainerBlockSize,
              atMostQuarterFragmentainer: knownFragmentainerBlockSize
                && sectionBlockSize * 4 <= table.fragmentainerBlockSize!,
              applicableBreakInsideAvoid: section.breakInside === "avoid"
                || section.breakInside === "avoid-column",
              noBreakInside,
              noLateStart: occurrences[0]?.fragmentIndex === prototypeFragmentIndex,
              outsideNestedRepeatableContent: table.outsideNestedRepeatableContent,
              layoutSideEffectsEnabled: true,
            },
            occurrences,
          });
        }
        return { tableIndex: table.tableIndex, repeats };
      });
      if (intrinsicScroll) scrollInstant.call(window, {
        left: savedScrollX,
        top: savedScrollY,
        behavior: "instant",
      });
      return {
        tables: reports,
        scrollRestoredExactly: window.scrollX === savedScrollX && window.scrollY === savedScrollY,
      };
    }, { key, tables: prepared.tables }).catch(() => {
      return {
        tables: [] as Array<{ tableIndex: number; repeats: CollapsedBorderRepeatSectionEvidence[] }>,
        scrollRestoredExactly: false,
      };
    });
    for (const table of measured.tables) {
      result.set(`${prepared.token}:${table.tableIndex}`, {
        repeatSections: table.repeats,
        scrollRestoredExactly: measured.scrollRestoredExactly,
      });
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
  repeatSections: CollapsedBorderRepeatSectionEvidence[],
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
    repeatSections,
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
    const repeats = await measureRepeatOccurrences(prepared, key);
    const stylesRestoredExactly = await mutateTransforms(prepared, key, false);
    neutral = false;
    await settleFrames(prepared);
    const restored = await measureProtocol(session, key, prepared, contexts);

    await Promise.all(prepared.map(async (frame) => {
      const records = frame.tables.map((table) => {
        const repeat = repeats.get(`${frame.token}:${table.tableIndex}`);
        const restoredExactly = stylesRestoredExactly
          && repeat?.scrollRestoredExactly !== false
          && sourceRestoredExactly(frame, live, restored);
        return buildRecord(frame, table, cssom, protocol, restoredExactly, repeat?.repeatSections ?? []);
      });
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
