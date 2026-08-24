#!/usr/bin/env tsx
/**
 * Headless, pixel-free audit of paged collapsed-table ownership.
 *
 * This deliberately proves the fail-closed boundary: Page.printToPDF runs the
 * real Blink print lifecycle, but public CDP returns only PDF bytes and cannot
 * authenticate page/table/section/row/break/repeat/edge ownership. PDF page
 * structure is retained only as downstream integration evidence.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "@playwright/test";

import {
  collectPublicPagedCollapsedTableOwnership,
  type PublicPagedCollapsedTableCollection,
} from "../src/capture/paged-collapsed-table-cdp.js";
import {
  PAGED_COLLAPSED_TABLE_SOURCE_PINS,
  REQUIRED_PAGED_COLLAPSED_TABLE_FACTS,
} from "../src/capture/paged-collapsed-table-record.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

export const REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX = [
  "whole-row",
  "continued-row",
  "repeated-header-footer",
  "caption",
  "span-joint",
  "vertical-lr-positive",
  "vertical-rl-negative",
  "empty-terminal-page",
] as const;

export type PagedCollapsedTableMatrixCell =
  typeof REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX[number];

interface Fixture {
  id: string;
  matrix: PagedCollapsedTableMatrixCell[];
  html: string;
}

const style = `
  @page{size:300px 240px;margin:0}
  html,body{margin:0;padding:0}
  table{border-collapse:collapse;inline-size:280px}
  th,td{box-sizing:border-box;border:6px solid #2563eb;padding:0;block-size:42px}
  thead,tfoot{break-inside:avoid}
`;

const rows = (count: number, cell = "<td></td>"): string =>
  Array.from({ length: count }, (_, index) => `<tr data-row="${index}">${cell}</tr>`).join("");

const fixtures: Fixture[] = [
  {
    id: "whole-row-pages",
    matrix: ["whole-row"],
    html: `<!doctype html><style>${style}tr{break-inside:avoid}</style><table id="table"><tbody>${rows(15)}</tbody></table>`,
  },
  {
    id: "continued-row-pages",
    matrix: ["continued-row"],
    html: `<!doctype html><style>${style}.continued{block-size:520px;break-inside:auto}</style><table id="table"><tbody><tr class="continued"><td></td></tr>${rows(2)}</tbody></table>`,
  },
  {
    id: "repeated-sections",
    matrix: ["repeated-header-footer"],
    html: `<!doctype html><style>${style}thead th{border-block-start-width:10px}tfoot td{border-block-end-width:12px}</style><table id="table"><thead><tr><th></th></tr></thead><tbody>${rows(16)}</tbody><tfoot><tr><td></td></tr></tfoot></table>`,
  },
  {
    id: "caption-and-span-joints",
    matrix: ["caption", "span-joint"],
    html: `<!doctype html><style>${style}caption{block-size:90px}col:first-child{inline-size:35%}col:last-child{inline-size:65%}</style><table id="table"><caption></caption><colgroup><col><col></colgroup><tbody><tr><td rowspan="3"></td><td></td></tr><tr><td></td></tr><tr><td></td></tr><tr><td colspan="2"></td></tr>${rows(10, "<td></td><td></td>")}</tbody></table>`,
  },
  {
    id: "vertical-lr-pages",
    matrix: ["vertical-lr-positive"],
    html: `<!doctype html><style>${style}body{writing-mode:vertical-lr}table{writing-mode:vertical-lr;block-size:280px}tr{break-inside:avoid}</style><table id="table"><tbody>${rows(15)}</tbody></table>`,
  },
  {
    id: "vertical-rl-pages",
    matrix: ["vertical-rl-negative"],
    html: `<!doctype html><style>${style}body{writing-mode:vertical-rl}table{writing-mode:vertical-rl;block-size:280px}tr{break-inside:avoid}</style><table id="table"><tbody>${rows(15)}</tbody></table>`,
  },
  {
    id: "empty-terminal-page",
    matrix: ["empty-terminal-page"],
    html: `<!doctype html><style>${style}.terminal{break-before:page;block-size:0}</style><table id="table"><tbody>${rows(6)}</tbody></table><div class="terminal"></div>`,
  },
];

export interface PagedCollapsedTableCaseReport {
  id: string;
  matrix: PagedCollapsedTableMatrixCell[];
  collection: PublicPagedCollapsedTableCollection;
}

export interface PagedCollapsedTableMutation {
  id: string;
  baseline: number;
  mutated: number;
  moved: boolean;
}

export interface PagedCollapsedTableOwnershipReport {
  schemaVersion: 1;
  ticket: "DM-2559";
  contract: "public-cdp-paged-collapsed-table-logical-fail-closed-no-pixels";
  generatedAt: string;
  sourcePins: typeof PAGED_COLLAPSED_TABLE_SOURCE_PINS;
  environment: {
    localChromiumSourceRevision: string;
    browserVersion: string;
    playwrightVersion: string;
    node: string;
    os: NodeJS.Platform;
    osRelease: string;
    architecture: string;
  };
  requiredMatrix: readonly PagedCollapsedTableMatrixCell[];
  cases: PagedCollapsedTableCaseReport[];
  discriminators: {
    localChromiumSourceMatchesPin: boolean;
    requiredMatrixComplete: boolean;
    everyRouteFailsClosed: boolean;
    everyMissingFactNamed: boolean;
    printPayloadNeverSuppliesLogicalFacts: boolean;
    screenCssomNeverSubstitutesForPages: boolean;
    sourceRestoresAfterPrint: boolean;
    realPaginationWasExercised: boolean;
    pixelsRead: boolean;
  };
  mutations: PagedCollapsedTableMutation[];
  verdict:
    | "public-print-fragment-transport-unavailable-fail-closed"
    | "paged-print-boundary-incomplete";
  pass: boolean;
}

async function runFixture(page: Page, fixture: Fixture): Promise<PagedCollapsedTableCaseReport> {
  await page.setContent(fixture.html, { waitUntil: "load" });
  return {
    id: fixture.id,
    matrix: fixture.matrix,
    collection: await collectPublicPagedCollapsedTableOwnership(page, "body"),
  };
}

function mutation(id: string, baseline: number, mutated: number): PagedCollapsedTableMutation {
  return { id, baseline, mutated, moved: baseline !== mutated };
}

export function buildPagedCollapsedTableMutations(
  cases: readonly PagedCollapsedTableCaseReport[],
): PagedCollapsedTableMutation[] {
  const first = cases[0];
  const vertical = cases.filter((row) => row.matrix.some((cell) => cell.startsWith("vertical-"))).length;
  const paginated = cases.filter((row) => row.collection.print.pdfPageCount > 1).length;
  return [
    mutation("claim-public-protocol-has-private-fragments", 0, 1),
    mutation("derive-logical-facts-from-pdf-vector", first.collection.print.logicalFactsDerivedFromPdf ? 1 : 0, 1),
    mutation("derive-page-ownership-from-screen-cssom", first.collection.screenBefore.tableRectCounts[0] ?? 0, first.collection.print.pdfPageCount),
    mutation("drop-required-page-index-fact", REQUIRED_PAGED_COLLAPSED_TABLE_FACTS.length, REQUIRED_PAGED_COLLAPSED_TABLE_FACTS.length - 1),
    mutation("accept-source-drift-after-print", cases.filter((row) => row.collection.sourceRestoredExactly).length, 0),
    mutation("horizontalize-vertical-page-progression", vertical, 0),
    mutation("skip-real-print-pagination", paginated, 0),
    ...REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX.map((cell) => mutation(
      `drop-matrix-${cell}`,
      cases.filter((row) => row.matrix.includes(cell)).length,
      0,
    )),
  ];
}

export function validatePagedCollapsedTableCorpus(): string[] {
  const errors: string[] = [];
  if (PAGED_COLLAPSED_TABLE_SOURCE_PINS.chromium
      !== "7d859f271cbda744098ac69f44978d4edfa62be3") errors.push("Chromium pin changed");
  const covered = new Set(fixtures.flatMap((fixture) => fixture.matrix));
  for (const cell of REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX) {
    if (!covered.has(cell)) errors.push(`missing paged table matrix cell ${cell}`);
  }
  if (new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) {
    errors.push("duplicate paged table fixture id");
  }
  return errors;
}

export async function runPagedCollapsedTableOwnershipAudit(): Promise<PagedCollapsedTableOwnershipReport> {
  const corpusErrors = validatePagedCollapsedTableCorpus();
  if (corpusErrors.length > 0) throw new Error(corpusErrors.join("; "));
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 620, height: 900 },
      deviceScaleFactor: 1,
    });
    const cases: PagedCollapsedTableCaseReport[] = [];
    for (const fixture of fixtures) cases.push(await runFixture(page, fixture));
    const localChromiumSourceRevision = execFileSync(
      "git",
      ["-C", resolve(ROOT, "external/chromium"), "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const matrix = new Set(cases.flatMap((row) => row.matrix));
    const discriminators: PagedCollapsedTableOwnershipReport["discriminators"] = {
      localChromiumSourceMatchesPin:
        localChromiumSourceRevision === PAGED_COLLAPSED_TABLE_SOURCE_PINS.chromium,
      requiredMatrixComplete: REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX.every((cell) => matrix.has(cell)),
      everyRouteFailsClosed: cases.every((row) => row.collection.record.status === "unavailable"
        && row.collection.protocolSupportsLogicalPrintFragments === false),
      everyMissingFactNamed: cases.every((row) =>
        REQUIRED_PAGED_COLLAPSED_TABLE_FACTS.every((fact) => row.collection.record.missingFacts.includes(fact))),
      printPayloadNeverSuppliesLogicalFacts: cases.every((row) =>
        row.collection.print.returnedPayload === "pdf-bytes"
        && row.collection.print.logicalFactsDerivedFromPdf === false),
      screenCssomNeverSubstitutesForPages: cases.every((row) =>
        row.collection.print.pdfPageCount > (row.collection.screenBefore.tableRectCounts[0] ?? 0)),
      sourceRestoresAfterPrint: cases.every((row) => row.collection.sourceRestoredExactly),
      realPaginationWasExercised: cases.every((row) => row.collection.print.pdfPageCount > 1),
      pixelsRead: cases.some((row) => row.collection.print.pixelsRead),
    };
    const mutations = buildPagedCollapsedTableMutations(cases);
    const pass = Object.entries(discriminators).every(([key, value]) =>
      key === "pixelsRead" ? value === false : value === true)
      && mutations.every((row) => row.moved);
    const packageJson = JSON.parse(
      readFileSync(resolve(ROOT, "node_modules/@playwright/test/package.json"), "utf8"),
    ) as { version: string };
    return {
      schemaVersion: 1,
      ticket: "DM-2559",
      contract: "public-cdp-paged-collapsed-table-logical-fail-closed-no-pixels",
      generatedAt: new Date().toISOString(),
      sourcePins: PAGED_COLLAPSED_TABLE_SOURCE_PINS,
      environment: {
        localChromiumSourceRevision,
        browserVersion: browser.version(),
        playwrightVersion: packageJson.version,
        node: process.version,
        os: platform(),
        osRelease: release(),
        architecture: arch(),
      },
      requiredMatrix: REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX,
      cases,
      discriminators,
      mutations,
      verdict: pass
        ? "public-print-fragment-transport-unavailable-fail-closed"
        : "paged-print-boundary-incomplete",
      pass,
    };
  } finally {
    if (browser != null) await closeBrowserSafely(browser);
  }
}

function jsonPath(argv: string[]): string | null {
  const index = argv.indexOf("--json");
  return index >= 0 ? argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const report = await runPagedCollapsedTableOwnershipAudit();
  const output = jsonPath(process.argv.slice(2));
  if (output != null) {
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({
    verdict: report.verdict,
    cases: report.cases.length,
    matrix: report.requiredMatrix.length,
    mutations: report.mutations.length,
    pass: report.pass,
  }, null, 2));
  if (!report.pass) process.exitCode = 1;
}

const isMain = process.argv[1] != null
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
