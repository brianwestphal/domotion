import { afterAll, describe, expect, it } from "vitest";

import { captureElementTreeWithWarnings, launchChromium } from "./index.js";
import type { CapturedElement } from "./types.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

const env = await (async () => {
  try { return { browser: await launchChromium({ headless: true }) }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

function walk(nodes: readonly CapturedElement[]): CapturedElement[] {
  return nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

function capturedTable(tree: readonly CapturedElement[]): CapturedElement {
  const table = walk(tree).find((node) => node.tag === "table");
  if (table == null) throw new Error("captured table not found");
  return table;
}

describeBrowser("DM-2558 source-authenticated collapsed-table fragment records", () => {
  it("consumes one exact transform-neutral physical record and restores the source", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 920, height: 360 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}
        #owner{transform:translate(17.5px,11.25px) scale(.9);transform-origin:0 0}
        .cols{columns:3;column-fill:auto;width:840px;height:126px}
        table{border-collapse:collapse;width:100%}
        td{box-sizing:border-box;width:33.3125%;height:38.125px;padding:0;border:3px solid rgb(21,72,190)}
      </style><div id="owner"><div class="cols"><table><tbody>
        ${Array.from({ length: 10 }, (_, row) => `<tr><td>${row}a</td><td>${row}b</td><td>${row}c</td></tr>`).join("")}
      </tbody></table></div></div>`);
      const before = await page.locator("#owner").evaluate((owner) => ({
        inline: owner.getAttribute("style"),
        computed: getComputedStyle(owner).transform,
      }));

      const capture = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, width: 920, height: 360 },
      );
      const table = capturedTable(capture.tree);
      const record = table.styles.collapsedBorderFragmentRecord;
      if (record?.status === "unavailable") throw new Error(record.reason);
      expect(record).toMatchObject({
        schemaVersion: 2,
        status: "authenticated",
        sourceRevision: "7d859f271cbda744098ac69f44978d4edfa62be3",
        consumedBy: "collapsed-border-fragment-logical-rects-v1",
        provenance: {
          plane: "all-css-transforms-neutralized",
          correlation: "ordered-exact-rect-set",
          canonicalization: "Blink-LayoutUnit-1/64-css-px",
          sourceRestoredExactly: true,
        },
      });
      if (record?.status !== "authenticated") throw new Error("fragment record was not authenticated");
      expect(record.tableFragments.length).toBeGreaterThan(1);
      expect(record.globalColumnOffsets).toHaveLength(4);
      expect(record.tableFragments.every((fragment, index) => fragment.fragmentIndex === index)).toBe(true);

      const rects = table.styles.collapsedBorderRects ?? [];
      expect(rects.length).toBeGreaterThan(0);
      expect(new Set(rects.map((rect) => rect.fragmentIndex))).toEqual(
        new Set(record.tableFragments.map((fragment) => fragment.fragmentIndex)),
      );
      expect(capture.warnings.some((warning) => warning.feature === "fragmented collapsed-table ownership")).toBe(false);

      expect(await page.locator("#owner").evaluate((owner) => ({
        inline: owner.getAttribute("style"),
        computed: getComputedStyle(owner).transform,
      }))).toEqual(before);
    } finally {
      await page.close();
    }
  });

  it("authenticates explicit repeated header/footer occurrences without alias inference", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 1100, height: 280 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<!doctype html><style>
        html,body{margin:0}.cols{columns:5;column-fill:auto;width:1000px;height:140px}
        table{border-collapse:collapse;width:100%}th,td{height:30px;padding:0;border:2px solid #2563eb}
        thead,tfoot{break-inside:avoid}thead th{border-top:6px solid #dc0000}tfoot td{border-bottom:8px solid #008c00}
      </style><div class="cols"><table><thead><tr><th></th></tr></thead><tbody>
        ${Array.from({ length: 12 }, () => "<tr><td></td></tr>").join("")}
      </tbody><tfoot><tr><td></td></tr></tfoot></table></div>`);
      const capture = await captureElementTreeWithWarnings(
        page,
        "body",
        { x: 0, y: 0, width: 1100, height: 280 },
      );
      const table = capturedTable(capture.tree);
      const record = table.styles.collapsedBorderFragmentRecord;
      if (record?.status === "unavailable") throw new Error(record.reason);
      expect(record).toMatchObject({
        schemaVersion: 2,
        status: "authenticated",
        provenance: {
          repeatOccurrence: "prototype-deep-clone-plus-intrinsic-source-cell-hit-test",
        },
      });
      if (record?.status !== "authenticated") throw new Error("repeat record was not authenticated");
      const headerOccurrences = record.tableFragments.flatMap((fragment) => fragment.sectionFragments)
        .filter((section) => section.repeatRole.endsWith("header"));
      const footerOccurrences = record.tableFragments.flatMap((fragment) => fragment.sectionFragments)
        .filter((section) => section.repeatRole.endsWith("footer"));
      expect(headerOccurrences).toHaveLength(record.tableFragments.length);
      expect(footerOccurrences).toHaveLength(record.tableFragments.length);
      expect(headerOccurrences.map((section) => section.repeatOccurrenceIndex)).toEqual(
        record.tableFragments.map((_, index) => index),
      );
      expect(footerOccurrences.map((section) => section.repeatOccurrenceIndex)).toEqual(
        record.tableFragments.map((_, index) => index),
      );
      expect(headerOccurrences.every((section) => section.globalStartRowIndex === 0
        && section.reservedCollapsedEdgeSpace?.side === "block-start")).toBe(true);
      expect(footerOccurrences.every((section) => section.lastGlobalRowIndex === record.totalRows - 1
        && section.reservedCollapsedEdgeSpace?.side === "block-end")).toBe(true);
      expect(table.styles.collapsedBorderRects?.length).toBeGreaterThan(0);
      expect(capture.warnings.some((warning) =>
        warning.feature === "fragmented collapsed-table ownership",
      )).toBe(false);
    } finally {
      await page.close();
    }
  });
});
