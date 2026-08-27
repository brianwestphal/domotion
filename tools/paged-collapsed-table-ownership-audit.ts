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
import {
  PAGED_TABLE_EVIDENCE_FIXTURES,
  REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX,
  validatePagedTableEvidenceFixtures,
  type PagedCollapsedTableMatrixCell,
  type PagedTableEvidenceFixture,
} from "./paged-table-evidence-fixtures.js";

export {
  REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX,
  type PagedCollapsedTableMatrixCell,
} from "./paged-table-evidence-fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

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

async function runFixture(
  page: Page,
  fixture: PagedTableEvidenceFixture,
): Promise<PagedCollapsedTableCaseReport> {
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
  errors.push(...validatePagedTableEvidenceFixtures());
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
    for (const fixture of PAGED_TABLE_EVIDENCE_FIXTURES) {
      cases.push(await runFixture(page, fixture));
    }
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
