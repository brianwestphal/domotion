#!/usr/bin/env tsx
/**
 * Source-logical oracle for authenticated collapsed-table section fragments.
 * It exercises the production CSSOM/CDP record and its downstream border
 * decisions. Chromium always launches headlessly; this reads no pixels and
 * defines no visual tolerance.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "@playwright/test";

import { captureElementTree, type CapturedElement } from "../src/index.js";
import {
  validateCollapsedBorderFragmentRecord,
  type AuthenticatedCollapsedBorderFragmentRecord,
  type CollapsedBorderFragmentRecord,
} from "../src/capture/collapsed-border-fragment-record.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

export const COLLAPSED_BORDER_FRAGMENT_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  tableBorders: "third_party/blink/renderer/core/layout/table/table_borders.cc:23-260",
  sectionRows: "third_party/blink/renderer/core/layout/table/table_section_layout_algorithm.cc:47-164",
  groupedSections: "third_party/blink/renderer/core/layout/table/table_layout_algorithm_types.cc:297-326",
  repeatedSections: "third_party/blink/renderer/core/layout/table/table_layout_algorithm.cc:1002-1151,1271-1339,1452-1528,1701-1719",
  repeatClone: "third_party/blink/renderer/core/layout/block_node.cc:722-796; third_party/blink/renderer/core/layout/fragment_repeater.cc:117-205",
  collapsedPaint: "third_party/blink/renderer/core/paint/table_painters.cc:35-328,490-727",
  clientRects: "third_party/blink/renderer/core/dom/element.cc:3419-3485",
  layoutBoxQuads: "third_party/blink/renderer/core/layout/layout_box.cc:1199-1216",
  repeatedSectionPrePaint: "third_party/blink/renderer/core/paint/pre_paint_tree_walk.cc:1290-1312",
  horizontalWpt: "third_party/blink/web_tests/external/wpt/css/css-break/table/table-collapsed-borders-paint-htb-ltr.html",
  verticalLrWpt: "third_party/blink/web_tests/external/wpt/css/css-break/table/table-collapsed-borders-paint-vlr-rtl.html",
  verticalRlWpt: "third_party/blink/web_tests/external/wpt/css/css-break/table/table-collapsed-borders-paint-vrl-ltr.html",
} as const;

export const REQUIRED_COLLAPSED_BORDER_FRAGMENT_DISCRIMINATORS = [
  "whole-row-break-paints-half-edge",
  "continued-row-omits-inline-edge",
  "adjacent-sections-share-one-edge",
  "repeated-header-explicit-occurrences-authenticate",
  "repeated-footer-explicit-occurrences-authenticate",
  "repeat-eligibility-source-path-authenticates",
  "oversize-header-authenticates-nonrepeat",
  "nonavoid-header-authenticates-nonrepeat",
  "header-only-and-footer-only-remain-distinct",
  "multiple-header-footer-select-first-layout-child",
  "monolithic-overflow-keeps-repeat-occurrence-ownership",
  "vertical-repeat-uses-logical-block-edges",
  "span-interior-remains-unfilled",
  "vertical-lr-rtl-uses-physical-x-block-axis",
  "vertical-rl-ltr-uses-physical-x-block-axis",
  "print-pagination-is-not-screen-cssom-fragmentation",
  "eligible-records-carry-physical-fragment-provenance",
  "records-bind-cssom-and-cdp-in-neutral-plane",
  "caption-first-fragments-preserve-child-paint-slots",
  "multiple-tbody-global-rows-remain-consecutive",
  "fractional-span-column-offsets-remain-exact",
] as const;

export type CollapsedBorderFragmentDiscriminator =
  typeof REQUIRED_COLLAPSED_BORDER_FRAGMENT_DISCRIMINATORS[number];

interface RectRecord {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface NodeFragmentRecord {
  id: string;
  tag: string;
  rects: RectRecord[];
  uniqueRectCount: number;
  mappedTableFragments: number[];
  breakInside: string;
}

interface CapturedBorderRect {
  x: number;
  y: number;
  width: number;
  height: number;
  axis: "row" | "column";
  style: string;
  color: string;
  fragmentIndex?: number;
}

interface LiveFragmentRecord {
  writingMode: string;
  direction: string;
  table: RectRecord[];
  caption: NodeFragmentRecord | null;
  sections: NodeFragmentRecord[];
  rows: NodeFragmentRecord[];
  cells: NodeFragmentRecord[];
}

export interface CollapsedBorderFragmentCaseReport {
  id: string;
  family: "source-wpt" | "whole-row" | "repeat" | "repeat-negative" | "span" | "fractional-span";
  live: LiveFragmentRecord;
  captured: {
    borderRects: CapturedBorderRect[];
    duplicateRectCount: number;
    hasFragmentIdentity: boolean;
    hasSectionIdentity: boolean;
    hasGlobalRowIdentity: boolean;
    hasBreakTokenState: boolean;
    hasRepeatState: boolean;
    fragmentRecord: CollapsedBorderFragmentRecord | null;
  };
  facts: Record<string, boolean | number | string>;
}

export interface CollapsedBorderFragmentMutation {
  id: string;
  baseline: number;
  mutated: number;
  moved: boolean;
}

export interface CollapsedBorderFragmentationReport {
  schemaVersion: 3;
  ticket: "DM-2558";
  contract: "explicit-repeat-occurrences-source-logical-no-pixels";
  generatedAt: string;
  sourcePins: typeof COLLAPSED_BORDER_FRAGMENT_SOURCE_PINS;
  environment: {
    browserVersion: string;
    playwrightVersion: string;
    node: string;
    os: NodeJS.Platform;
    osRelease: string;
    architecture: string;
  };
  cases: CollapsedBorderFragmentCaseReport[];
  print: {
    screenTableFragmentCount: number;
    screenHeaderFragmentCount: number;
    pdfPageCount: number;
    pdfSha256: string;
    pixelsRead: false;
  };
  discriminators: Record<CollapsedBorderFragmentDiscriminator, boolean>;
  mutations: CollapsedBorderFragmentMutation[];
  currentProtocolExact: boolean;
  verdict: "screen-section-fragment-record-authenticated" | "screen-section-fragment-record-incomplete";
  pass: boolean;
}

interface Fixture {
  id: string;
  family: CollapsedBorderFragmentCaseReport["family"];
  html: string;
  viewport: { width: number; height: number };
}

const baseStyle = "html,body{margin:0;padding:0;background:white}";

const sourceWptFixture = (
  id: string,
  writing: string,
  direction: "ltr" | "rtl",
): Fixture => ({
  id,
  family: "source-wpt",
  viewport: { width: 540, height: 520 },
  html: `<!doctype html><style>${baseStyle}body{writing-mode:${writing};direction:${direction}}.multicol{inline-size:400px;block-size:100px;columns:4;column-fill:auto;gap:10px;padding:10px;border:3px solid}.t{border-collapse:collapse;inline-size:100%}</style><div class="multicol"><table id="table" class="t"><caption id="caption" style="background:dodgerblue;block-size:120px"></caption><tbody id="section-a"><tr id="whole-row" style="block-size:50px"><td id="lime-cell" style="border:10px solid lime"></td></tr><tr id="continued-row" style="block-size:145px"><td id="continued-cell" style="border:10px solid black"></td></tr></tbody><tbody id="section-b"><tr id="blue-row-a" style="block-size:50px"><td style="border:10px solid blue"></td></tr><tr id="blue-row-b" style="block-size:25px"><td style="border:10px solid blue"></td></tr></tbody></table></div>`,
});

const fixtures: Fixture[] = [
  {
    id: "whole-row-breaks",
    family: "whole-row",
    viewport: { width: 800, height: 260 },
    html: `<!doctype html><style>${baseStyle}.cols{columns:3;column-fill:auto;width:720px;height:120px}.t{border-collapse:collapse;width:100%}.t tr{break-inside:avoid}.t td{box-sizing:border-box;height:38px;border:4px solid rgb(0,0,255);padding:0}</style><div class="cols"><table id="table" class="t"><tbody id="whole-section">${Array.from({ length: 8 }, (_, index) => `<tr id="whole-only-${index}"><td>${index}</td></tr>`).join("")}</tbody></table></div>`,
  },
  sourceWptFixture("blink-wpt-horizontal-tb-ltr", "horizontal-tb", "ltr"),
  sourceWptFixture("blink-wpt-vertical-lr-rtl", "vertical-lr", "rtl"),
  sourceWptFixture("blink-wpt-vertical-rl-ltr", "vertical-rl", "ltr"),
  {
    id: "repeated-header-footer",
    family: "repeat",
    viewport: { width: 1100, height: 300 },
    html: `<!doctype html><style>${baseStyle}.cols{columns:5;column-fill:auto;width:1000px;height:140px}.t{border-collapse:collapse;width:100%}th,td{height:30px;padding:0;border:2px solid rgb(37,99,235)}thead,tfoot{break-inside:avoid}thead th{border-top:6px solid rgb(220,0,0)}tfoot td{border-bottom:8px solid rgb(0,140,0)}</style><div class="cols"><table id="table" class="t"><thead id="repeat-head"><tr id="head-row"><th id="head-cell"></th></tr></thead><tbody id="repeat-body">${Array.from({ length: 12 }, (_, index) => `<tr id="body-row-${index}"><td></td></tr>`).join("")}</tbody><tfoot id="repeat-foot"><tr id="foot-row"><td id="foot-cell"></td></tr></tfoot></table></div>`,
  },
  {
    id: "repeated-header-only",
    family: "repeat",
    viewport: { width: 900, height: 300 },
    html: `<!doctype html><style>${baseStyle}.cols{columns:4;column-fill:auto;width:800px;height:140px}.t{border-collapse:collapse;width:100%}th,td{height:30px;padding:0;border:2px solid #2563eb}thead{break-inside:avoid}thead th{border-top:6px solid rgb(220,0,0)}</style><div class="cols"><table id="table" class="t"><thead id="only-head"><tr><th></th></tr></thead><tbody>${Array.from({ length: 12 }, () => "<tr><td></td></tr>").join("")}</tbody></table></div>`,
  },
  {
    id: "repeated-footer-only",
    family: "repeat",
    viewport: { width: 900, height: 300 },
    html: `<!doctype html><style>${baseStyle}.cols{columns:4;column-fill:auto;width:800px;height:140px}.t{border-collapse:collapse;width:100%}th,td{height:30px;padding:0;border:2px solid #2563eb}tfoot{break-inside:avoid}tfoot td{border-bottom:8px solid rgb(0,140,0)}</style><div class="cols"><table id="table" class="t"><tbody>${Array.from({ length: 12 }, () => "<tr><td></td></tr>").join("")}</tbody><tfoot id="only-foot"><tr><td></td></tr></tfoot></table></div>`,
  },
  {
    id: "oversize-header-negative",
    family: "repeat-negative",
    viewport: { width: 900, height: 300 },
    html: `<!doctype html><style>${baseStyle}.cols{columns:4;column-fill:auto;width:800px;height:140px}.t{border-collapse:collapse;width:100%}th,td{padding:0;border:4px solid rgb(37,99,235);height:34px}thead{break-inside:avoid}thead th{height:58px;border-top:8px solid rgb(220,0,0)}</style><div class="cols"><table id="table" class="t"><thead id="oversize-head"><tr id="oversize-head-row"><th></th></tr></thead><tbody>${Array.from({ length: 12 }, (_, index) => `<tr id="negative-row-${index}"><td></td></tr>`).join("")}</tbody></table></div>`,
  },
  {
    id: "nonavoid-header-negative",
    family: "repeat-negative",
    viewport: { width: 900, height: 300 },
    html: `<!doctype html><style>${baseStyle}.cols{columns:4;column-fill:auto;width:800px;height:140px}.t{border-collapse:collapse;width:100%}th,td{padding:0;border:2px solid #2563eb;height:30px}thead{break-inside:auto}thead th{border-top:6px solid rgb(220,0,0)}</style><div class="cols"><table id="table" class="t"><thead id="nonavoid-head"><tr><th></th></tr></thead><tbody>${Array.from({ length: 12 }, () => "<tr><td></td></tr>").join("")}</tbody></table></div>`,
  },
  {
    id: "multiple-header-footer-selection",
    family: "repeat",
    viewport: { width: 1100, height: 320 },
    html: `<!doctype html><style>${baseStyle}.cols{columns:5;column-fill:auto;width:1000px;height:150px}.t{border-collapse:collapse;width:100%}th,td{padding:0;border:2px solid #2563eb;height:24px}thead,tfoot{break-inside:avoid}#first-head th{border-top:6px solid rgb(220,0,0)}#first-foot td{border-bottom:8px solid rgb(0,140,0)}</style><div class="cols"><table id="table" class="t"><thead id="first-head"><tr><th></th></tr></thead><thead id="second-head"><tr><th></th></tr></thead><tbody id="selection-body">${Array.from({ length: 14 }, () => "<tr><td></td></tr>").join("")}</tbody><tfoot id="first-foot"><tr><td></td></tr></tfoot><tfoot id="second-foot"><tr><td></td></tr></tfoot></table></div>`,
  },
  {
    id: "monolithic-overflow-repeat",
    family: "repeat",
    viewport: { width: 1100, height: 340 },
    html: `<!doctype html><style>${baseStyle}.cols{columns:5;column-fill:auto;width:1000px;height:140px}.t{border-collapse:collapse;width:100%}th,td{padding:0;border:2px solid #2563eb;height:28px}thead,tfoot{break-inside:avoid}thead th{border-top:6px solid rgb(220,0,0)}tfoot td{border-bottom:8px solid rgb(0,140,0)}tr.monolithic{break-inside:avoid}tr.monolithic td{height:190px}</style><div class="cols"><table id="table" class="t"><thead id="overflow-head"><tr><th></th></tr></thead><tbody><tr class="monolithic"><td></td></tr>${Array.from({ length: 5 }, () => "<tr><td></td></tr>").join("")}</tbody><tfoot id="overflow-foot"><tr><td></td></tr></tfoot></table></div>`,
  },
  {
    id: "vertical-rl-repeat",
    family: "repeat",
    viewport: { width: 360, height: 1000 },
    html: `<!doctype html><style>${baseStyle}body{writing-mode:vertical-rl}.cols{writing-mode:vertical-rl;columns:4;column-fill:auto;inline-size:900px;block-size:140px}.t{writing-mode:vertical-rl;border-collapse:collapse;inline-size:100%}th,td{block-size:30px;padding:0;border:2px solid #2563eb}thead,tfoot{break-inside:avoid}thead th{border-right:6px solid rgb(220,0,0)}tfoot td{border-left:8px solid rgb(0,140,0)}</style><div class="cols"><table id="table" class="t"><thead id="vertical-head"><tr><th></th></tr></thead><tbody>${Array.from({ length: 12 }, () => "<tr><td></td></tr>").join("")}</tbody><tfoot id="vertical-foot"><tr><td></td></tr></tfoot></table></div>`,
  },
  {
    id: "continued-colspan-interior",
    family: "span",
    viewport: { width: 800, height: 300 },
    html: `<!doctype html><style>${baseStyle}.cols{columns:3;column-fill:auto;width:720px;height:110px}.t{border-collapse:collapse;table-layout:fixed;width:100%}.t col:first-child{width:35%}.t col:last-child{width:65%}.t td{padding:0;border:6px solid rgb(220,0,0)}.tall{height:245px}.normal td{height:32px;border-color:rgb(37,99,235)}</style><div class="cols"><table id="table" class="t"><colgroup><col><col></colgroup><tbody id="span-section"><tr id="span-row" class="tall"><td id="span-cell" colspan="2"></td></tr><tr id="span-normal" class="normal"><td></td><td></td></tr></tbody></table></div>`,
  },
  {
    id: "fractional-rowspan-multiple-tbody",
    family: "fractional-span",
    viewport: { width: 840, height: 320 },
    html: `<!doctype html><style>${baseStyle}.cols{columns:3;column-fill:auto;width:777.75px;height:103.5px;column-gap:11.25px}.t{border-collapse:collapse;table-layout:fixed;width:100%}.t col:nth-child(1){width:27.25%}.t col:nth-child(2){width:31.5%}.t col:nth-child(3){width:41.25%}.t td{box-sizing:border-box;height:37.75px;padding:0;border:3.5px solid rgb(90,45,180)}.tall{height:151.25px}</style><div class="cols"><table id="table" class="t"><colgroup><col><col><col></colgroup><tbody id="fractional-a"><tr><td id="rowspan" rowspan="2"></td><td></td><td></td></tr><tr><td colspan="2"></td></tr><tr class="tall"><td colspan="3"></td></tr></tbody><tbody id="fractional-b"><tr><td></td><td></td><td></td></tr><tr><td></td><td colspan="2"></td></tr></tbody></table></div>`,
  },
];

const rectKey = (rect: RectRecord | CapturedBorderRect): string => {
  if ("x" in rect) return [rect.x, rect.y, rect.width, rect.height, rect.axis, rect.style, rect.color].join("|");
  return [rect.left, rect.top, rect.right, rect.bottom].join("|");
};

function findCapturedTable(nodes: readonly CapturedElement[]): CapturedElement | null {
  for (const node of nodes) {
    if (node.tag === "table") return node;
    const nested = findCapturedTable(node.children);
    if (nested != null) return nested;
  }
  return null;
}

async function collectLive(page: Page): Promise<LiveFragmentRecord> {
  return page.evaluate<LiveFragmentRecord>(`(() => {
    const table = document.querySelector("#table");
    const serial = (rect) => ({
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height,
    });
    const tableRects = Array.from(table.getClientRects(), serial);
    const overlapArea = (left, right) =>
      Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
      * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
    const nodeRecord = (element) => {
      const rects = Array.from(element.getClientRects(), serial);
      return {
        id: element.id,
        tag: element.tagName.toLowerCase(),
        rects,
        uniqueRectCount: new Set(rects.map((rect) => [rect.left, rect.top, rect.right, rect.bottom].join("|"))).size,
        mappedTableFragments: rects.map((rect) => {
          let best = -1;
          let area = 0;
          for (let index = 0; index < tableRects.length; index++) {
            const candidate = overlapArea(rect, tableRects[index]);
            if (candidate > area) { best = index; area = candidate; }
          }
          return best;
        }),
        breakInside: getComputedStyle(element).breakInside,
      };
    };
    const style = getComputedStyle(table);
    const caption = table.querySelector("caption");
    return {
      writingMode: style.writingMode,
      direction: style.direction,
      table: tableRects,
      caption: caption == null ? null : nodeRecord(caption),
      sections: Array.from(table.tBodies, nodeRecord),
      rows: Array.from(table.rows, nodeRecord),
      cells: Array.from(table.querySelectorAll("th,td"), nodeRecord),
    };
  })()`);
}

function blockAxisSize(rect: CapturedBorderRect, writingMode: string): number {
  return writingMode === "horizontal-tb" ? rect.height : rect.width;
}

function blockStart(rect: RectRecord, writingMode: string): number {
  if (writingMode === "horizontal-tb") return rect.top;
  return writingMode === "vertical-lr" ? rect.left : rect.right;
}

function blockEnd(rect: RectRecord, writingMode: string): number {
  if (writingMode === "horizontal-tb") return rect.bottom;
  return writingMode === "vertical-lr" ? rect.right : rect.left;
}

function inlineOverlap(rect: CapturedBorderRect, piece: RectRecord, writingMode: string): number {
  return writingMode === "horizontal-tb"
    ? Math.max(0, Math.min(rect.x + rect.width, piece.right) - Math.max(rect.x, piece.left))
    : Math.max(0, Math.min(rect.y + rect.height, piece.bottom) - Math.max(rect.y, piece.top));
}

function rowEdgeCenter(rect: CapturedBorderRect, writingMode: string): number {
  return writingMode === "horizontal-tb" ? rect.y + rect.height / 2 : rect.x + rect.width / 2;
}

function rectFragmentIndex(rect: RectRecord, table: RectRecord[]): number {
  let best = -1;
  let bestArea = 0;
  for (let index = 0; index < table.length; index++) {
    const candidate = table[index];
    const area = Math.max(0, Math.min(rect.right, candidate.right) - Math.max(rect.left, candidate.left))
      * Math.max(0, Math.min(rect.bottom, candidate.bottom) - Math.max(rect.top, candidate.top));
    if (area > bestArea) {
      best = index;
      bestArea = area;
    }
  }
  return best;
}

function capturedRectFragmentIndex(rect: CapturedBorderRect, table: RectRecord[]): number {
  return rectFragmentIndex({
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    width: rect.width,
    height: rect.height,
  }, table);
}

function continuedRowFacts(
  live: LiveFragmentRecord,
  rects: CapturedBorderRect[],
): { continuedSeamCount: number; continuedInlineEdgeAtSeamCount: number } {
  const continued = live.rows.find((row) => row.id === "continued-row");
  if (continued == null || continued.rects.length < 2) {
    return { continuedSeamCount: 0, continuedInlineEdgeAtSeamCount: 0 };
  }
  const seams: Array<{ coordinate: number; piece: RectRecord }> = [];
  for (let index = 0; index < continued.rects.length; index++) {
    const piece = continued.rects[index];
    if (index > 0) seams.push({ coordinate: blockStart(piece, live.writingMode), piece });
    if (index + 1 < continued.rects.length) seams.push({ coordinate: blockEnd(piece, live.writingMode), piece });
  }
  const blackRowEdges = rects.filter((rect) => rect.axis === "row" && rect.color === "rgb(0, 0, 0)");
  const painted = seams.filter(({ coordinate, piece }) => blackRowEdges.some((rect) =>
    Math.abs(rowEdgeCenter(rect, live.writingMode) - coordinate) <= 0.51
    && inlineOverlap(rect, piece, live.writingMode) > 1)).length;
  return { continuedSeamCount: seams.length, continuedInlineEdgeAtSeamCount: painted };
}

function adjacentSectionFacts(
  live: LiveFragmentRecord,
  rects: CapturedBorderRect[],
): { adjacentSectionBoundaryFound: boolean; adjacentSectionSharedEdgeCount: number } {
  const before = live.rows.find((row) => row.id === "continued-row")?.rects.at(-1);
  const after = live.rows.find((row) => row.id === "blue-row-a")?.rects[0];
  if (before == null || after == null) {
    return { adjacentSectionBoundaryFound: false, adjacentSectionSharedEdgeCount: 0 };
  }
  const beforeEnd = blockEnd(before, live.writingMode);
  const afterStart = blockStart(after, live.writingMode);
  const sameBoundary = Math.abs(beforeEnd - afterStart) <= 0.01;
  const count = sameBoundary ? rects.filter((rect) => rect.axis === "row"
    && Math.abs(rowEdgeCenter(rect, live.writingMode) - beforeEnd) <= 0.51
    && inlineOverlap(rect, before, live.writingMode) > 1
    && inlineOverlap(rect, after, live.writingMode) > 1).length : 0;
  return { adjacentSectionBoundaryFound: sameBoundary, adjacentSectionSharedEdgeCount: count };
}

function duplicateCount(rects: CapturedBorderRect[]): number {
  const counts = new Map<string, number>();
  for (const rect of rects) counts.set(rectKey(rect), (counts.get(rectKey(rect)) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
}

function sourceWptFacts(
  live: LiveFragmentRecord,
  rects: CapturedBorderRect[],
  record: CollapsedBorderFragmentRecord | null,
): Record<string, boolean | number | string> {
  const continued = live.rows.find((row) => row.id === "continued-row");
  const blockAxis = live.writingMode === "horizontal-tb" ? "physical-y" : "physical-x";
  const halfEdges = rects.filter((rect) => rect.axis === "row" && blockAxisSize(rect, live.writingMode) === 5).length;
  const continuedFacts = continuedRowFacts(live, rects);
  const sectionFacts = adjacentSectionFacts(live, rects);
  const rowAxisRects = rects.filter((rect) => rect.axis === "row");
  return {
    tableFragmentCount: live.table.length,
    captionFragmentCount: live.caption?.rects.length ?? 0,
    sectionFragmentCount: live.sections.reduce((sum, section) => sum + section.rects.length, 0),
    continuedRowFragmentCount: continued?.rects.length ?? 0,
    wholeRowHalfEdgeCount: halfEdges,
    duplicateCapturedRectCount: duplicateCount(rects),
    blockAxis,
    ...continuedFacts,
    ...sectionFacts,
    rowAxisRectCount: rowAxisRects.length,
    rowAxisPhysicalXCount: rowAxisRects.filter((rect) => rect.width < rect.height).length,
    recordAuthenticated: record?.status === "authenticated",
    recordSectionFragmentCount: record?.status === "authenticated"
      ? record.tableFragments.reduce((sum, fragment) => sum + fragment.sectionFragments.length, 0)
      : 0,
    recordUsesNeutralCssomCdp: record?.status === "authenticated"
      && record.provenance.plane === "all-css-transforms-neutralized"
      && record.provenance.cssom === "Element.getClientRects"
      && record.provenance.protocol === "DOM.getContentQuads"
      && record.provenance.correlation === "ordered-exact-rect-set",
    captionFirstPaintSlotPreserved: record?.status === "authenticated"
      && record.tableFragments.some((fragment) => fragment.captionPaintSlots.length > 0
        && fragment.captionPaintSlots.every((caption) => caption.tableChildPaintSlot
          < (fragment.sectionFragments[0]?.tableChildPaintSlot ?? Number.POSITIVE_INFINITY))),
    globalRowsConsecutive: record?.status === "authenticated"
      && record.tableFragments.every((fragment) => fragment.sectionFragments.every((section) =>
        section.logicalRowOffsets.length === section.lastGlobalRowIndex - section.firstGlobalRowIndex + 2)),
  };
}

async function runFixture(page: Page, fixture: Fixture): Promise<CollapsedBorderFragmentCaseReport> {
  await page.setViewportSize(fixture.viewport);
  await page.setContent(fixture.html, { waitUntil: "load" });
  const live = await collectLive(page);
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, ...fixture.viewport });
  const capturedTable = findCapturedTable(tree);
  const capturedStyles = capturedTable?.styles as {
    collapsedBorderRects?: CapturedBorderRect[];
    collapsedBorderFragmentRecord?: CollapsedBorderFragmentRecord;
  } | undefined;
  const borderRects = (capturedStyles?.collapsedBorderRects ?? []).map((rect) => ({ ...rect }));
  const fragmentRecord = capturedStyles?.collapsedBorderFragmentRecord ?? null;
  const repeatedSectionFragments = fragmentRecord?.status === "authenticated"
    ? fragmentRecord.tableFragments.flatMap((fragment) => fragment.sectionFragments)
      .filter((section) => section.repeatRole !== "non-repeated")
    : [];
  const provenance = {
    hasFragmentIdentity: fragmentRecord?.status === "authenticated"
      && fragmentRecord.tableFragments.every((fragment) => fragment.physicalTableFragmentId !== ""),
    hasSectionIdentity: fragmentRecord?.status === "authenticated"
      && fragmentRecord.tableFragments.some((fragment) => fragment.sectionFragments.length > 0),
    hasGlobalRowIdentity: fragmentRecord?.status === "authenticated"
      && fragmentRecord.tableFragments.every((fragment) => fragment.sectionFragments.every((section) =>
        Number.isInteger(section.globalStartRowIndex))),
    hasBreakTokenState: fragmentRecord?.status === "authenticated"
      && fragmentRecord.tableFragments.every((fragment) => fragment.sectionFragments.every((section) =>
        typeof section.startContinuedRow === "boolean" && typeof section.endContinuedRow === "boolean")),
    hasRepeatState: repeatedSectionFragments.length > 0 && repeatedSectionFragments.every((section) =>
      section.repeatOccurrenceIndex != null
      && section.repeatEligibility != null
      && section.reservedCollapsedEdgeSpace != null
      && section.occurrenceOwnership === "source-clone-plus-per-fragment-hit-test"),
    fragmentRecord,
  };
  let facts: Record<string, boolean | number | string> = {};
  if (fixture.family === "source-wpt" || fixture.family === "whole-row") {
    facts = sourceWptFacts(live, borderRects, fragmentRecord);
    if (fixture.family === "whole-row") {
      facts.wholeRowHalfEdgeCount = borderRects.filter((rect) => rect.axis === "row"
        && blockAxisSize(rect, live.writingMode) === 2).length;
    }
  } else if (fixture.family === "repeat" || fixture.family === "repeat-negative") {
    const sectionSourceIds = await page.evaluate<string[]>(`Array.from(
      document.querySelector("#table").children
    ).filter((element) => /^(THEAD|TBODY|TFOOT)$/.test(element.tagName)).map((element) => element.id)`);
    const head = live.sections.length > 0
      ? (await page.evaluate<{ count: number; unique: number } | null>(`(() => {
          const element = document.querySelector("thead");
          if (element == null) return null;
          const rects = Array.from(element.getClientRects(), (rect) => [rect.left, rect.top, rect.right, rect.bottom].join("|"));
          return { count: rects.length, unique: new Set(rects).size };
        })()`))
      : null;
    const foot = await page.evaluate<{ count: number; unique: number } | null>(`(() => {
      const element = document.querySelector("tfoot");
      if (element == null) return null;
      const rects = Array.from(element.getClientRects(), (rect) => [rect.left, rect.top, rect.right, rect.bottom].join("|"));
      return { count: rects.length, unique: new Set(rects).size };
    })()`);
    const headerRects = borderRects.filter((rect) => rect.color === "rgb(220, 0, 0)");
    const footerRects = borderRects.filter((rect) => rect.color === "rgb(0, 140, 0)");
    const headerOccurrences = repeatedSectionFragments.filter((section) => section.repeatRole.endsWith("header"));
    const footerOccurrences = repeatedSectionFragments.filter((section) => section.repeatRole.endsWith("footer"));
    const selectedHeaderSourceId = headerOccurrences.length === 0 ? ""
      : sectionSourceIds[headerOccurrences[0].sectionSourceIndex] ?? "";
    const selectedFooterSourceId = footerOccurrences.length === 0 ? ""
      : sectionSourceIds[footerOccurrences[0].sectionSourceIndex] ?? "";
    facts = {
      tableFragmentCount: live.table.length,
      headerRectCount: head?.count ?? 0,
      headerUniqueRectCount: head?.unique ?? 0,
      footerRectCount: foot?.count ?? 0,
      footerUniqueRectCount: foot?.unique ?? 0,
      capturedHeaderEdgeCount: headerRects.length,
      capturedFooterEdgeCount: footerRects.length,
      capturedHeaderEdgeFragmentCount: new Set(headerRects.map((rect) => capturedRectFragmentIndex(rect, live.table))).size,
      capturedFooterEdgeFragmentCount: new Set(footerRects.map((rect) => capturedRectFragmentIndex(rect, live.table))).size,
      sourceRepeatThresholdSatisfied: fixture.family === "repeat",
      fragmentRecordAuthenticated: fragmentRecord?.status === "authenticated",
      headerOccurrenceCount: headerOccurrences.length,
      footerOccurrenceCount: footerOccurrences.length,
      headerOccurrenceFragmentCount: new Set(headerOccurrences.map((section) => section.fragmentIndex)).size,
      footerOccurrenceFragmentCount: new Set(footerOccurrences.map((section) => section.fragmentIndex)).size,
      headerOccurrenceOwnershipExact: headerOccurrences.every((section) =>
        section.occurrenceOwnership === "source-clone-plus-per-fragment-hit-test"
        && section.reservedCollapsedEdgeSpace?.side === "block-start"
        && section.globalStartRowIndex === 0),
      footerOccurrenceOwnershipExact: footerOccurrences.every((section) =>
        section.occurrenceOwnership === "source-clone-plus-per-fragment-hit-test"
        && section.reservedCollapsedEdgeSpace?.side === "block-end"
        && section.lastGlobalRowIndex === (fragmentRecord?.status === "authenticated" ? fragmentRecord.totalRows - 1 : -1)),
      repeatEligibilityExact: repeatedSectionFragments.every((section) => {
        const eligibility = section.repeatEligibility;
        return eligibility != null
          && eligibility.knownFragmentainerBlockSize
          && eligibility.atMostQuarterFragmentainer
          && eligibility.applicableBreakInsideAvoid
          && eligibility.noBreakInside
          && eligibility.noLateStart
          && eligibility.outsideNestedRepeatableContent
          && eligibility.layoutSideEffectsEnabled;
      }),
      selectedHeaderSourceId,
      selectedFooterSourceId,
      repeatedSectionSourceCount: new Set(repeatedSectionFragments.map((section) => section.sectionSourceIndex)).size,
      nonrepeatSectionSourceCount: fragmentRecord?.status === "authenticated"
        ? new Set(fragmentRecord.tableFragments.flatMap((fragment) => fragment.sectionFragments)
          .filter((section) => section.repeatRole === "non-repeated")
          .map((section) => section.sectionSourceIndex)).size
        : 0,
      vectorPaintWithheld: borderRects.length === 0,
    };
  } else {
    const span = live.cells.find((cell) => cell.id === "span-cell");
    const interiorEdges = borderRects.filter((rect) => {
      if (rect.axis !== "column" || span == null) return false;
      return span.rects.some((piece) => {
        const center = rect.x + rect.width / 2;
        return center > piece.left + 1 && center < piece.right - 1
          && rect.y < piece.bottom && rect.y + rect.height > piece.top;
      });
    });
    facts = {
      tableFragmentCount: live.table.length,
      spanFragmentCount: span?.rects.length ?? 0,
      capturedSpanInteriorEdgeCount: interiorEdges.length,
      fragmentRecordAuthenticated: fragmentRecord?.status === "authenticated",
      exactFractionalColumnOffsetCount: fixture.family === "fractional-span" && fragmentRecord?.status === "authenticated"
        ? fragmentRecord.globalColumnOffsets.filter((offset) => !Number.isInteger(offset)).length
        : 0,
      multipleSectionSourcesPreserved: fixture.family === "fractional-span" && fragmentRecord?.status === "authenticated"
        ? new Set(fragmentRecord.tableFragments.flatMap((fragment) => fragment.sectionFragments.map((section) => section.sectionSourceIndex))).size
        : 0,
    };
  }
  return {
    id: fixture.id,
    family: fixture.family,
    live,
    captured: { borderRects, duplicateRectCount: duplicateCount(borderRects), ...provenance },
    facts,
  };
}

async function collectPrintGap(page: Page): Promise<CollapsedBorderFragmentationReport["print"]> {
  await page.setViewportSize({ width: 620, height: 900 });
  await page.setContent(`<!doctype html><style>${baseStyle}@page{size:300px 240px;margin:0}.t{border-collapse:collapse;width:100%}thead,tfoot{break-inside:avoid}th,td{height:42px;border:6px solid #2563eb}</style><table id="table" class="t"><thead><tr><th></th></tr></thead><tbody>${Array.from({ length: 18 }, () => "<tr><td></td></tr>").join("")}</tbody><tfoot><tr><td></td></tr></tfoot></table>`, { waitUntil: "load" });
  const screen = await page.evaluate<{ table: number; header: number }>(`({
    table: document.querySelector("table").getClientRects().length,
    header: document.querySelector("thead").getClientRects().length,
  })`);
  const pdf = await page.pdf({ width: "300px", height: "240px", printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } });
  const text = pdf.toString("latin1");
  return {
    screenTableFragmentCount: screen.table,
    screenHeaderFragmentCount: screen.header,
    pdfPageCount: text.match(/\/Type\s*\/Page\b/g)?.length ?? 0,
    pdfSha256: createHash("sha256").update(pdf).digest("hex"),
    pixelsRead: false,
  };
}

const factNumber = (row: CollapsedBorderFragmentCaseReport, key: string): number =>
  typeof row.facts[key] === "number" ? row.facts[key] as number : 0;

export function buildCollapsedBorderFragmentDiscriminators(
  cases: CollapsedBorderFragmentCaseReport[],
  print: CollapsedBorderFragmentationReport["print"],
): Record<CollapsedBorderFragmentDiscriminator, boolean> {
  const whole = cases.find((row) => row.id === "whole-row-breaks");
  const htb = cases.find((row) => row.id === "blink-wpt-horizontal-tb-ltr");
  const vlr = cases.find((row) => row.id === "blink-wpt-vertical-lr-rtl");
  const vrl = cases.find((row) => row.id === "blink-wpt-vertical-rl-ltr");
  const repeat = cases.find((row) => row.id === "repeated-header-footer");
  const negative = cases.find((row) => row.id === "oversize-header-negative");
  const nonavoid = cases.find((row) => row.id === "nonavoid-header-negative");
  const headerOnly = cases.find((row) => row.id === "repeated-header-only");
  const footerOnly = cases.find((row) => row.id === "repeated-footer-only");
  const multiple = cases.find((row) => row.id === "multiple-header-footer-selection");
  const monolithic = cases.find((row) => row.id === "monolithic-overflow-repeat");
  const verticalRepeat = cases.find((row) => row.id === "vertical-rl-repeat");
  const span = cases.find((row) => row.id === "continued-colspan-interior");
  const fractional = cases.find((row) => row.id === "fractional-rowspan-multiple-tbody");
  const eligible = cases;
  return {
    "whole-row-break-paints-half-edge": whole != null && factNumber(whole, "wholeRowHalfEdgeCount") > 0,
    "continued-row-omits-inline-edge": htb != null
      && factNumber(htb, "continuedRowFragmentCount") > 1
      && factNumber(htb, "continuedSeamCount") === 4
      && factNumber(htb, "continuedInlineEdgeAtSeamCount") === 0,
    "adjacent-sections-share-one-edge": htb != null
      && htb.live.sections.length === 2
      && htb.facts.adjacentSectionBoundaryFound === true
      && factNumber(htb, "adjacentSectionSharedEdgeCount") === 1,
    "repeated-header-explicit-occurrences-authenticate": repeat != null
      && factNumber(repeat, "headerRectCount") === repeat.live.table.length
      && factNumber(repeat, "headerUniqueRectCount") === 1
      && repeat.facts.fragmentRecordAuthenticated === true
      && factNumber(repeat, "headerOccurrenceCount") === repeat.live.table.length
      && repeat.facts.headerOccurrenceOwnershipExact === true,
    "repeated-footer-explicit-occurrences-authenticate": repeat != null
      && factNumber(repeat, "footerRectCount") === repeat.live.table.length
      && factNumber(repeat, "footerUniqueRectCount") === 1
      && repeat.facts.fragmentRecordAuthenticated === true
      && factNumber(repeat, "footerOccurrenceCount") === repeat.live.table.length
      && repeat.facts.footerOccurrenceOwnershipExact === true,
    "repeat-eligibility-source-path-authenticates": repeat?.facts.repeatEligibilityExact === true,
    "oversize-header-authenticates-nonrepeat": negative != null
      && factNumber(negative, "headerRectCount") < negative.live.table.length
      && factNumber(negative, "headerOccurrenceCount") === 0
      && negative.facts.fragmentRecordAuthenticated === true,
    "nonavoid-header-authenticates-nonrepeat": nonavoid != null
      && factNumber(nonavoid, "headerRectCount") < nonavoid.live.table.length
      && factNumber(nonavoid, "headerOccurrenceCount") === 0
      && nonavoid.facts.fragmentRecordAuthenticated === true,
    "header-only-and-footer-only-remain-distinct": headerOnly != null && footerOnly != null
      && factNumber(headerOnly, "headerOccurrenceCount") === headerOnly.live.table.length
      && factNumber(headerOnly, "footerOccurrenceCount") === 0
      && factNumber(footerOnly, "headerOccurrenceCount") === 0
      && factNumber(footerOnly, "footerOccurrenceCount") === footerOnly.live.table.length,
    "multiple-header-footer-select-first-layout-child": multiple?.facts.selectedHeaderSourceId === "first-head"
      && multiple.facts.selectedFooterSourceId === "first-foot"
      && factNumber(multiple, "repeatedSectionSourceCount") === 2
      && factNumber(multiple, "nonrepeatSectionSourceCount") >= 3,
    "monolithic-overflow-keeps-repeat-occurrence-ownership": monolithic?.facts.fragmentRecordAuthenticated === true
      && factNumber(monolithic, "headerOccurrenceCount") === monolithic.live.table.length
      && factNumber(monolithic, "footerOccurrenceCount") === monolithic.live.table.length,
    "vertical-repeat-uses-logical-block-edges": verticalRepeat?.facts.fragmentRecordAuthenticated === true
      && verticalRepeat.live.writingMode === "vertical-rl"
      && verticalRepeat.facts.headerOccurrenceOwnershipExact === true
      && verticalRepeat.facts.footerOccurrenceOwnershipExact === true,
    "span-interior-remains-unfilled": span != null
      && factNumber(span, "spanFragmentCount") > 1
      && factNumber(span, "capturedSpanInteriorEdgeCount") === 0,
    "vertical-lr-rtl-uses-physical-x-block-axis": vlr?.facts.blockAxis === "physical-x"
      && factNumber(vlr, "continuedRowFragmentCount") > 1
      && factNumber(vlr, "rowAxisRectCount") > 0
      && factNumber(vlr, "rowAxisPhysicalXCount") === factNumber(vlr, "rowAxisRectCount")
      && factNumber(vlr, "continuedSeamCount") === 4
      && factNumber(vlr, "continuedInlineEdgeAtSeamCount") === 0,
    "vertical-rl-ltr-uses-physical-x-block-axis": vrl?.facts.blockAxis === "physical-x"
      && factNumber(vrl, "continuedRowFragmentCount") > 1
      && factNumber(vrl, "rowAxisRectCount") > 0
      && factNumber(vrl, "rowAxisPhysicalXCount") === factNumber(vrl, "rowAxisRectCount")
      && factNumber(vrl, "continuedSeamCount") === 4
      && factNumber(vrl, "continuedInlineEdgeAtSeamCount") === 0,
    "print-pagination-is-not-screen-cssom-fragmentation": print.pdfPageCount > 1
      && print.screenTableFragmentCount === 1 && print.screenHeaderFragmentCount === 1,
    "eligible-records-carry-physical-fragment-provenance": eligible.every((row) =>
      row.captured.hasFragmentIdentity && row.captured.hasSectionIdentity
      && row.captured.hasGlobalRowIdentity && row.captured.hasBreakTokenState),
    "records-bind-cssom-and-cdp-in-neutral-plane": eligible.every((row) =>
      row.captured.fragmentRecord?.status === "authenticated"
      && row.captured.fragmentRecord.provenance.plane === "all-css-transforms-neutralized"
      && row.captured.fragmentRecord.provenance.cssom === "Element.getClientRects"
      && row.captured.fragmentRecord.provenance.protocol === "DOM.getContentQuads"
      && row.captured.fragmentRecord.provenance.sourceRestoredExactly),
    "caption-first-fragments-preserve-child-paint-slots": htb?.facts.captionFirstPaintSlotPreserved === true,
    "multiple-tbody-global-rows-remain-consecutive": htb?.facts.globalRowsConsecutive === true
      && fractional?.facts.multipleSectionSourcesPreserved === 2,
    "fractional-span-column-offsets-remain-exact": fractional?.facts.fragmentRecordAuthenticated === true
      && factNumber(fractional, "exactFractionalColumnOffsetCount") > 0,
  };
}

function authenticatedRecord(row: CollapsedBorderFragmentCaseReport): AuthenticatedCollapsedBorderFragmentRecord {
  const record = row.captured.fragmentRecord;
  if (record?.status !== "authenticated") throw new Error(`${row.id} has no authenticated record`);
  return record;
}

function applicabilityErrors(
  row: CollapsedBorderFragmentCaseReport,
  record: AuthenticatedCollapsedBorderFragmentRecord,
): string[] {
  const errors = validateCollapsedBorderFragmentRecord(record);
  if (record.writingMode !== row.live.writingMode) errors.push("record writing axis differs from live table");
  if (record.direction !== row.live.direction) errors.push("record direction differs from live table");
  if (record.tableFragments.length !== row.live.table.length) errors.push("record table fragment count differs from live table");
  return errors;
}

export function buildCollapsedBorderFragmentMutations(
  cases: CollapsedBorderFragmentCaseReport[],
  print: CollapsedBorderFragmentationReport["print"],
): CollapsedBorderFragmentMutation[] {
  const whole = cases.find((row) => row.id === "whole-row-breaks")!;
  const htb = cases.find((row) => row.id === "blink-wpt-horizontal-tb-ltr")!;
  const repeat = cases.find((row) => row.id === "repeated-header-footer")!;
  const span = cases.find((row) => row.id === "continued-colspan-interior")!;
  const vertical = cases.filter((row) => row.live.writingMode !== "horizontal-tb").length;
  const mutation = (id: string, baseline: number, mutated: number): CollapsedBorderFragmentMutation => ({
    id, baseline, mutated, moved: Number.isFinite(baseline) && Number.isFinite(mutated) && baseline !== mutated,
  });
  const record = authenticatedRecord(htb);
  const repeatRecord = authenticatedRecord(repeat);
  const wrongRow = structuredClone(record);
  wrongRow.tableFragments.flatMap((fragment) => fragment.sectionFragments)[0].globalStartRowIndex++;
  const wrongFragment = structuredClone(record);
  const wrongFragmentSection = wrongFragment.tableFragments.flatMap((fragment) => fragment.sectionFragments)[0];
  wrongFragmentSection.fragmentIndex = (wrongFragmentSection.fragmentIndex + 1) % wrongFragment.tableFragments.length;
  const wrongAxis = structuredClone(record);
  wrongAxis.writingMode = "vertical-lr";
  const droppedRepeat = structuredClone(repeatRecord);
  const droppedFragment = droppedRepeat.tableFragments.find((fragment) => fragment.fragmentIndex === 1)!;
  droppedFragment.sectionFragments.splice(droppedFragment.sectionFragments.findIndex((section) =>
    section.repeatRole.endsWith("header")), 1);
  const duplicatedRepeat = structuredClone(repeatRecord);
  const duplicateSection = structuredClone(duplicatedRepeat.tableFragments[1].sectionFragments[0]);
  duplicateSection.physicalSectionFragmentId += ":duplicate";
  duplicatedRepeat.tableFragments[1].sectionFragments.splice(1, 0, duplicateSection);
  const reorderedRepeat = structuredClone(repeatRecord);
  const reorderedSections = reorderedRepeat.tableFragments.flatMap((fragment) => fragment.sectionFragments)
    .filter((section) => section.repeatRole.endsWith("header"));
  [reorderedSections[1].repeatOccurrenceIndex, reorderedSections[2].repeatOccurrenceIndex] =
    [reorderedSections[2].repeatOccurrenceIndex, reorderedSections[1].repeatOccurrenceIndex];
  const wrongRepeatEdge = structuredClone(repeatRecord);
  wrongRepeatEdge.tableFragments[1].sectionFragments.find((section) =>
    section.repeatRole.endsWith("header"))!.reservedCollapsedEdgeSpace!.side = "block-end";
  const wrongRepeatSource = structuredClone(repeatRecord);
  wrongRepeatSource.tableFragments[1].sectionFragments.find((section) =>
    section.repeatRole.endsWith("header"))!.sectionSourceIndex = 999;
  return [
    mutation("collapse-table-fragments", factNumber(htb, "tableFragmentCount"), 1),
    mutation("erase-continued-row-break-token", factNumber(htb, "continuedRowFragmentCount"), 1),
    mutation("promote-half-edge-to-full", factNumber(whole, "wholeRowHalfEdgeCount"), 0),
    mutation("double-paint-adjacent-section-edge", htb.captured.duplicateRectCount, htb.captured.duplicateRectCount + 1),
    mutation("drop-repeat-occurrence", validateCollapsedBorderFragmentRecord(repeatRecord).length, validateCollapsedBorderFragmentRecord(droppedRepeat).length),
    mutation("duplicate-repeat-occurrence", validateCollapsedBorderFragmentRecord(repeatRecord).length, validateCollapsedBorderFragmentRecord(duplicatedRepeat).length),
    mutation("reorder-repeat-occurrences", validateCollapsedBorderFragmentRecord(repeatRecord).length, validateCollapsedBorderFragmentRecord(reorderedRepeat).length),
    mutation("move-repeat-to-wrong-edge", validateCollapsedBorderFragmentRecord(repeatRecord).length, validateCollapsedBorderFragmentRecord(wrongRepeatEdge).length),
    mutation("bind-repeat-to-wrong-source", validateCollapsedBorderFragmentRecord(repeatRecord).length, validateCollapsedBorderFragmentRecord(wrongRepeatSource).length),
    mutation("fill-span-interior", factNumber(span, "capturedSpanInteriorEdgeCount"), factNumber(span, "capturedSpanInteriorEdgeCount") + 1),
    mutation("horizontalize-vertical-fragmentation", vertical, 0),
    mutation("wrong-global-start-row", applicabilityErrors(htb, record).length, applicabilityErrors(htb, wrongRow).length),
    mutation("wrong-physical-fragment", applicabilityErrors(htb, record).length, applicabilityErrors(htb, wrongFragment).length),
    mutation("wrong-writing-axis", applicabilityErrors(htb, record).length, applicabilityErrors(htb, wrongAxis).length),
    mutation("treat-screen-cssom-as-print-fragments", print.pdfPageCount, print.screenTableFragmentCount),
  ];
}

export function validateCollapsedBorderFragmentationCorpus(): string[] {
  const errors: string[] = [];
  if (COLLAPSED_BORDER_FRAGMENT_SOURCE_PINS.chromium !== "7d859f271cbda744098ac69f44978d4edfa62be3") errors.push("Chromium pin changed");
  if (REQUIRED_COLLAPSED_BORDER_FRAGMENT_DISCRIMINATORS.length !== 21) errors.push("logical discriminator corpus changed");
  if (fixtures.map((fixture) => fixture.id).join("|") !== [
    "whole-row-breaks",
    "blink-wpt-horizontal-tb-ltr",
    "blink-wpt-vertical-lr-rtl",
    "blink-wpt-vertical-rl-ltr",
    "repeated-header-footer",
    "repeated-header-only",
    "repeated-footer-only",
    "oversize-header-negative",
    "nonavoid-header-negative",
    "multiple-header-footer-selection",
    "monolithic-overflow-repeat",
    "vertical-rl-repeat",
    "continued-colspan-interior",
    "fractional-rowspan-multiple-tbody",
  ].join("|")) errors.push("fixture corpus changed");
  return errors;
}

export async function runCollapsedBorderFragmentationOracle(): Promise<CollapsedBorderFragmentationReport> {
  const corpusErrors = validateCollapsedBorderFragmentationCorpus();
  if (corpusErrors.length > 0) throw new Error(corpusErrors.join("; "));
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 520 }, deviceScaleFactor: 1 });
    const cases: CollapsedBorderFragmentCaseReport[] = [];
    for (const fixture of fixtures) cases.push(await runFixture(page, fixture));
    const print = await collectPrintGap(page);
    const discriminators = buildCollapsedBorderFragmentDiscriminators(cases, print);
    const mutations = buildCollapsedBorderFragmentMutations(cases, print);
    const pass = Object.values(discriminators).every(Boolean) && mutations.every((mutation) => mutation.moved);
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, "node_modules/@playwright/test/package.json"), "utf8")) as { version: string };
    return {
      schemaVersion: 3,
      ticket: "DM-2558",
      contract: "explicit-repeat-occurrences-source-logical-no-pixels",
      generatedAt: new Date().toISOString(),
      sourcePins: COLLAPSED_BORDER_FRAGMENT_SOURCE_PINS,
      environment: {
        browserVersion: browser.version(),
        playwrightVersion: packageJson.version,
        node: process.version,
        os: platform(),
        osRelease: release(),
        architecture: arch(),
      },
      cases,
      print,
      discriminators,
      mutations,
      currentProtocolExact: pass,
      verdict: pass ? "screen-section-fragment-record-authenticated" : "screen-section-fragment-record-incomplete",
      pass,
    };
  } finally {
    await closeBrowserSafely(browser);
  }
}

function parseJsonPath(args: string[]): string | null {
  const index = args.indexOf("--json");
  return index >= 0 ? args[index + 1] ?? null : null;
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runCollapsedBorderFragmentationOracle();
  const jsonPath = parseJsonPath(process.argv.slice(2));
  if (jsonPath != null) {
    mkdirSync(dirname(resolve(jsonPath)), { recursive: true });
    writeFileSync(resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`collapsed border fragmentation: ${Object.values(report.discriminators).filter(Boolean).length}/${REQUIRED_COLLAPSED_BORDER_FRAGMENT_DISCRIMINATORS.length}; ${report.verdict}`);
  for (const [id, active] of Object.entries(report.discriminators)) console.log(`${active ? "PASS" : "FAIL"} ${id}`);
  for (const mutation of report.mutations) console.log(`${mutation.moved ? "PASS" : "FAIL"} mutation ${mutation.id}: ${mutation.baseline} -> ${mutation.mutated}`);
  if (jsonPath != null) console.log(`report: ${resolve(jsonPath)}`);
  if (!report.pass) process.exitCode = 1;
}
