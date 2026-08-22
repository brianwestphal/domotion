import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";

function flatten(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

describe("DM-2467 capture contract", () => {
  it("serializes source-owned pseudo records without repopulating legacy heuristic fields", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 520, height: 300 } });
    try {
      await page.setContent(`<!doctype html><style>
        body{margin:0;font:16px/24px Arial,sans-serif}#scene{padding:20px}
        #host::before{content:"prefix😀 ";color:rgb(9,80,140);font-weight:700}
        #host::after{content:" suffix";border:1px solid;padding:2px}
      </style><main id="scene"><div id="host">host</div><iframe id="frame"></iframe></main>`);
      await page.locator("#frame").evaluate((frame) => {
        (frame as HTMLIFrameElement).srcdoc = `<!doctype html><style>body{margin:0}.inner::before{content:"frame"}</style><div class="inner">body</div>`;
      });
      await page.locator("#frame").contentFrame().locator(".inner").waitFor();
      const result = await captureElementTreeWithWarnings(page, "#scene", { x: 0, y: 0, width: 520, height: 300 });
      const elements = flatten(result.tree);
      const host = elements.find((element) => element.text.includes("host"));
      expect(host?.pseudoFragments?.map((record) => [record.pseudo, record.status])).toEqual([
        ["::before", "exact"], ["::after", "exact"],
      ]);
      expect(host?.pseudoFragments?.[0].fragments.some((fragment) => fragment.kind === "text" && fragment.text.includes("😀"))).toBe(true);
      expect(host?.textSegments?.some((segment) => segment.text.includes("prefix😀"))).not.toBe(true);
      expect(host?.pseudoBoxes?.some((box) => box.pseudo === "::after")).not.toBe(true);
      expect(host?.pseudoImages ?? []).toHaveLength(0);
      expect(elements.some((element) => element.pseudoFragments?.some((record) =>
        record.status === "exact" && record.contentItems.some((item) => item.text === "frame")))).toBe(true);
      expect(result.warnings.filter((warning) => warning.feature === "generated-pseudo-fragment-geometry")).toEqual([]);
      expect(await page.locator("[data-domotion-pseudo-target],[data-domotion-pseudo-ancestor]").count()).toBe(0);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
