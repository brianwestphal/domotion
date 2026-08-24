import { afterAll, describe, expect, it } from "vitest";

import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { launchChromium } from "./index.js";
import { collectPublicPagedCollapsedTableOwnership } from "./paged-collapsed-table-cdp.js";
import { REQUIRED_PAGED_COLLAPSED_TABLE_FACTS } from "./paged-collapsed-table-record.js";

const env = await (async () => {
  try { return { browser: await launchChromium({ headless: true }) }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

describeBrowser("paged collapsed-table public protocol boundary", () => {
  it("runs real print layout headlessly but withholds every private logical fact", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 620, height: 900 } });
    try {
      await page.setContent(`<!doctype html><style>
        @page{size:300px 240px;margin:0}html,body{margin:0}
        table{border-collapse:collapse;width:280px}thead,tfoot{break-inside:avoid}
        th,td{box-sizing:border-box;height:42px;padding:0;border:6px solid #2563eb}
      </style><table><thead><tr><th></th></tr></thead><tbody>
        ${Array.from({ length: 18 }, () => "<tr><td></td></tr>").join("")}
      </tbody><tfoot><tr><td></td></tr></tfoot></table>`);

      const result = await collectPublicPagedCollapsedTableOwnership(page, "body");
      expect(result.record).toMatchObject({
        schemaVersion: 1,
        status: "unavailable",
        missingFacts: REQUIRED_PAGED_COLLAPSED_TABLE_FACTS,
      });
      expect(result.print).toMatchObject({
        returnedPayload: "pdf-bytes",
        logicalFactsDerivedFromPdf: false,
        pixelsRead: false,
      });
      expect(result.print.pdfPageCount).toBeGreaterThan(1);
      expect(result.screenBefore.tableRectCounts).toEqual([1]);
      expect(result.screenAfter).toEqual(result.screenBefore);
      expect(result.sourceRestoredExactly).toBe(true);
      expect(result.protocolSupportsLogicalPrintFragments).toBe(false);
    } finally {
      await page.close();
    }
  });
});
