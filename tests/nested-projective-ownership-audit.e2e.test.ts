import { describe, expect, it } from "vitest";

import { launchChromium } from "../src/capture/index.js";
import {
  NESTED_PROJECTIVE_CASES,
  NESTED_PROJECTIVE_REQUIRED_FAMILIES,
  NESTED_PROJECTIVE_SCROLL_OFFSET,
  NESTED_PROJECTIVE_VIEWPORT,
  nestedProjectiveAuditFixtureHtml,
  runNestedProjectiveOwnershipAudit,
} from "../tools/nested-projective-ownership-audit.js";

describe("DM-2356 live nested projective ownership audit", () => {
  it("proves every Blink used-context root is the minimal production owner", async () => {
    const report = await runNestedProjectiveOwnershipAudit({ dprs: [1] });
    expect(report.verdict).toBe("investigation-complete");
    expect(report.blockers).toEqual([]);
    expect(report.rows).toHaveLength(NESTED_PROJECTIVE_CASES.length);
    expect(new Set(report.rows.map((row) => row.family))).toEqual(new Set(NESTED_PROJECTIVE_REQUIRED_FAMILIES));
    expect(report.rows.every((row) => row.sourceModelMatchesDesign)).toBe(true);
    expect(report.rows.every((row) => row.atomicOneApplication)).toBe(true);
    expect(report.restorationExact).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.mutations).toHaveLength(9);
    expect(report.mutations.every((mutation) => mutation.killed)).toBe(true);

    expect(
      report.rows.every(
        (row) =>
          row.ownerMinimal && row.vectorSentinelRetained && !row.sentinelBakedIntoRaster && row.atomicOneApplication,
      ),
    ).toBe(true);
    expect(report.productionGaps).toEqual([]);
    expect(report.sourceVsSvgChangedFraction.dpr1).toBeGreaterThan(0);
    expect(report.sourceVsSvgChangedFraction.dpr1).toBeLessThan(1);
  }, 90_000);

  it("materializes one atomic raster per owner under the vertical/RTL fractional-zoom profile", async () => {
    // Regression: at zoom:1.25 the `ordinary` and `independent` planes lay
    // entirely outside the capture viewport, so their owners rasterized as
    // empty and the release gate saw zero images on every platform.
    const report = await runNestedProjectiveOwnershipAudit({
      dprs: [1],
      profile: "vertical-rtl-fractional-zoom-scroll",
    });
    expect(report.blockers).toEqual([]);
    expect(report.productionGaps).toEqual([]);
    expect(report.rows).toHaveLength(NESTED_PROJECTIVE_CASES.length);
    for (const family of ["ordinary-dom-break", "independent-projective-planes"] as const) {
      const row = report.rows.find((candidate) => candidate.family === family);
      expect(row?.ownerMinimal).toBe(true);
      expect(row?.atomicRasterOccurrences).toBe(row?.expectedOwnerIds.length);
      expect(row?.staticTransformApplications).toBe(row?.expectedOwnerIds.length);
    }
    expect(report.rows.every((row) => row.atomicOneApplication && row.vectorSentinelRetained)).toBe(true);
    // DM-6NS46P: the profile must really be scrolled, and capture must not
    // disturb the scroll offset.
    expect(report.scrollOffsets.dpr1).toEqual({
      before: NESTED_PROJECTIVE_SCROLL_OFFSET,
      after: NESTED_PROJECTIVE_SCROLL_OFFSET,
    });
  }, 90_000);

  it("moves every owner by exactly the scroll offset, and off canvas without it", async () => {
    // Disable-and-require-movement: the scroll offset is what brings the
    // owners on canvas. Resetting it to 0 must move each content quad by the
    // offset and push owners outside the viewport, where the audit's guard
    // would block the rows.
    const browser = await launchChromium();
    try {
      const page = await browser.newPage({ viewport: NESTED_PROJECTIVE_VIEWPORT });
      await page.setContent(nestedProjectiveAuditFixtureHtml("vertical-rtl-fractional-zoom-scroll"), {
        waitUntil: "load",
      });
      const rects = (): Promise<Array<{ id: string; x: number; y: number; right: number; bottom: number }>> =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-projective-node]")).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              id: element.dataset.projectiveNode!,
              x: rect.x,
              y: rect.y,
              right: rect.right,
              bottom: rect.bottom,
            };
          }),
        );
      const scrolled = await rects();
      const within = (rect: { x: number; y: number; right: number; bottom: number }): boolean =>
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.right <= NESTED_PROJECTIVE_VIEWPORT.width &&
        rect.bottom <= NESTED_PROJECTIVE_VIEWPORT.height;
      expect(scrolled.length).toBeGreaterThan(0);
      expect(scrolled.every(within)).toBe(true);
      await page.evaluate(() => {
        const scroller = document.getElementById("scroller")!;
        scroller.scrollLeft = 0;
        scroller.scrollTop = 0;
      });
      const unscrolled = await rects();
      expect(unscrolled.map((rect) => rect.id)).toEqual(scrolled.map((rect) => rect.id));
      for (const [index, rect] of unscrolled.entries()) {
        expect(rect.x - scrolled[index].x).toBeCloseTo(NESTED_PROJECTIVE_SCROLL_OFFSET.left, 3);
        expect(rect.y - scrolled[index].y).toBeCloseTo(NESTED_PROJECTIVE_SCROLL_OFFSET.top, 3);
      }
      expect(unscrolled.some((rect) => !within(rect))).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
