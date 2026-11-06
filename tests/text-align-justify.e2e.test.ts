import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

const TEXT =
  "The quick brown fox jumps over the lazy dog and keeps running across the wide green field until the sun goes down. Short end.";

// Justified lines are reproduced from Chromium's own laid-out character
// ranges, so capture must neither warn that justification is unsupported nor
// lose the expansion: every captured glyph origin equals Chromium's, and an
// interior line is wider than its words laid out unjustified.
describe("text-align: justify", () => {
  it("captures stretched interior lines without a degradation warning", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 200 } });
    try {
      await page.setContent(
        `<!doctype html><style>body{margin:0}#p{margin:0;width:300px;font:16px/22px Helvetica,Arial,sans-serif;text-align:justify}</style><main id="scene"><p id="p">${TEXT}</p></main>`,
      );
      // Chromium's own per-character left edges, the oracle for the capture.
      const chromeLefts = await page.evaluate(() => {
        const node = document.getElementById("p")!.firstChild!;
        const range = document.createRange();
        const lefts: number[] = [];
        for (let i = 0; i < node.textContent!.length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          lefts.push(range.getBoundingClientRect().left);
        }
        return lefts;
      });
      const result = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, width: 360, height: 200 });
      expect(result.warnings.filter((warning) => warning.feature === "text-align:justify")).toEqual([]);

      const paragraph = flatten(result.tree).find((element) => element.tag === "p");
      const segments = (paragraph?.textSegments ?? []).filter((segment) => segment.text.trim() !== "");
      expect(segments.length).toBeGreaterThanOrEqual(3);
      let cursor = 0;
      let compared = 0;
      for (const segment of segments) {
        const start = TEXT.indexOf(segment.text, cursor);
        expect(start).toBeGreaterThanOrEqual(0);
        segment.xOffsets?.forEach((x, i) => {
          if (segment.text[i] === " ") return;
          expect(Math.abs(x - chromeLefts[start + i])).toBeLessThan(0.02);
          compared++;
        });
        cursor = start + segment.text.length;
      }
      expect(compared).toBeGreaterThan(TEXT.length / 2);

      const first = segments[0];
      const unstretched = await page.evaluate((words) => {
        const probe = document.createElement("span");
        probe.style.font = "16px Helvetica, Arial, sans-serif";
        probe.style.whiteSpace = "pre";
        probe.textContent = words;
        document.body.appendChild(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      }, first.text.trimEnd());
      expect(first.width).toBeGreaterThan(unstretched + 2);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
