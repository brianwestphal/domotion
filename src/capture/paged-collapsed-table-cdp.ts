/**
 * Public-CDP producer for paged collapsed-table ownership.
 *
 * Chromium 7d859f271c keeps the paginated PhysicalBoxFragment tree alive only
 * between PrintBegin and PrintEnd. Page.printToPDF returns PDF bytes/stream,
 * not the table/section fragments, row offsets, break tokens, or repeat state.
 * This producer records that capability boundary and returns the explicit
 * unavailable record. It never reconstructs logical facts from the PDF.
 */

import { createHash } from "node:crypto";

import type { Page } from "@playwright/test";

import {
  PAGED_COLLAPSED_TABLE_SOURCE_PINS,
  unavailablePagedCollapsedTableRecord,
  type UnavailablePagedCollapsedTableRecord,
} from "./paged-collapsed-table-record.js";

export interface PagedCollapsedTablePrintParameters {
  width: string;
  height: string;
  margin: { top: string; right: string; bottom: string; left: string };
  printBackground: true;
  preferCSSPageSize: true;
}

export interface PagedCollapsedTableScreenObservation {
  tableCount: number;
  tableRectCounts: number[];
  sectionRectCounts: number[][];
  captionRectCounts: number[][];
  writingModes: string[];
  directions: string[];
  printMediaMatches: boolean;
}

export interface PublicPagedCollapsedTableCollection {
  record: UnavailablePagedCollapsedTableRecord;
  sourcePins: typeof PAGED_COLLAPSED_TABLE_SOURCE_PINS;
  runtime: {
    product: string;
    revision: string;
    protocolVersion: string;
    userAgent: string;
    jsVersion: string;
    loaderId: string;
    protocolDomains: Array<{ name: string; version: string }>;
  };
  screenBefore: PagedCollapsedTableScreenObservation;
  screenAfter: PagedCollapsedTableScreenObservation;
  sourceRestoredExactly: boolean;
  print: {
    parameters: PagedCollapsedTablePrintParameters;
    parametersSha256: string;
    pdfSha256: string;
    pdfPageCount: number;
    returnedPayload: "pdf-bytes";
    logicalFactsDerivedFromPdf: false;
    pixelsRead: false;
  };
  protocolSupportsLogicalPrintFragments: false;
}

const PRINT_PARAMETERS: PagedCollapsedTablePrintParameters = {
  width: "300px",
  height: "240px",
  margin: { top: "0", right: "0", bottom: "0", left: "0" },
  printBackground: true,
  preferCSSPageSize: true,
};

async function observeScreen(
  page: Page,
  selector: string,
): Promise<PagedCollapsedTableScreenObservation> {
  return page.locator(selector).evaluate((root) => {
    const tables = root.matches("table")
      ? [root as HTMLTableElement]
      : Array.from(root.querySelectorAll("table"));
    return {
      tableCount: tables.length,
      tableRectCounts: tables.map((table) => table.getClientRects().length),
      sectionRectCounts: tables.map((table) =>
        Array.from(table.querySelectorAll("thead,tbody,tfoot"), (section) => section.getClientRects().length)),
      captionRectCounts: tables.map((table) =>
        Array.from(table.querySelectorAll("caption"), (caption) => caption.getClientRects().length)),
      writingModes: tables.map((table) => getComputedStyle(table).writingMode),
      directions: tables.map((table) => getComputedStyle(table).direction),
      printMediaMatches: matchMedia("print").matches,
    };
  });
}

/**
 * Exercise Chromium's real print lifecycle, retain the PDF only as downstream
 * integration evidence, and fail closed because public CDP carries no exact
 * paginated table-fragment transport.
 */
export async function collectPublicPagedCollapsedTableOwnership(
  page: Page,
  selector: string,
): Promise<PublicPagedCollapsedTableCollection> {
  const session = await page.context().newCDPSession(page);
  try {
    const [version, schema, frameTree, screenBefore] = await Promise.all([
      session.send("Browser.getVersion"),
      session.send("Schema.getDomains"),
      session.send("Page.getFrameTree"),
      observeScreen(page, selector),
    ]);
    const pdf = await page.pdf(PRINT_PARAMETERS);
    const screenAfter = await observeScreen(page, selector);
    const pdfText = pdf.toString("latin1");
    const parametersSha256 = createHash("sha256")
      .update(JSON.stringify(PRINT_PARAMETERS))
      .digest("hex");
    return {
      record: unavailablePagedCollapsedTableRecord(
        "public CDP exposes Page.printToPDF bytes/stream but not Blink's transient paginated PhysicalBoxFragment table facts",
      ),
      sourcePins: PAGED_COLLAPSED_TABLE_SOURCE_PINS,
      runtime: {
        product: version.product,
        revision: version.revision,
        protocolVersion: version.protocolVersion,
        userAgent: version.userAgent,
        jsVersion: version.jsVersion,
        loaderId: frameTree.frameTree.frame.loaderId,
        protocolDomains: schema.domains.map((domain) => ({
          name: domain.name,
          version: domain.version,
        })),
      },
      screenBefore,
      screenAfter,
      sourceRestoredExactly: JSON.stringify(screenBefore) === JSON.stringify(screenAfter),
      print: {
        parameters: PRINT_PARAMETERS,
        parametersSha256,
        pdfSha256: createHash("sha256").update(pdf).digest("hex"),
        pdfPageCount: pdfText.match(/\/Type\s*\/Page\b/g)?.length ?? 0,
        returnedPayload: "pdf-bytes",
        logicalFactsDerivedFromPdf: false,
        pixelsRead: false,
      },
      protocolSupportsLogicalPrintFragments: false,
    };
  } finally {
    await session.detach().catch(() => undefined);
  }
}
