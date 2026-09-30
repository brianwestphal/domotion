import { expect, it } from "vitest";
import {
  collectPaintOrderEvidence,
  comparePaintOrderEvidence,
  formatPaintOrderReport,
} from "../tools/paint-order-oracle.js";

it("collects live Chromium paint order before grading and reporting", async () => {
  const evidence = await collectPaintOrderEvidence();
  const browserRows = evidence.rows.filter((row) => row.id.startsWith("browser."));
  expect(browserRows.length).toBeGreaterThan(0);
  expect(browserRows.every((row) => row.pass)).toBe(true);
  expect(comparePaintOrderEvidence(evidence)).toMatchObject({ failures: [], exitCode: 0 });
  expect(formatPaintOrderReport(evidence)[0]).toMatch(/^paint-order oracle: \d+\/\d+; mutation control moved$/);
});
