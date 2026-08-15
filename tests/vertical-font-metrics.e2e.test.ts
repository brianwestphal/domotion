import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/index.js";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import type { CapturedElement } from "../src/capture/types.js";

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function collectVerticalSegments(nodes: CapturedElement[]): NonNullable<CapturedElement["textSegments"]> {
  const out: NonNullable<CapturedElement["textSegments"]> = [];
  for (const node of nodes) {
    out.push(...(node.textSegments?.filter((s) => s.verticalWritingMode != null) ?? []));
    out.push(...collectVerticalSegments(node.children ?? []));
  }
  return out;
}

describeBrowser("vertical segments carry captured FontMetrics (DM-2193)", () => {
  it("stamps mixed CJK/Latin columns and text-combine cells with run ascent", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 320, height: 180 } });
    try {
      await page.setContent(`<style>
        body{margin:0;font:20px/1.2 sans-serif}
        .v{writing-mode:vertical-rl;height:120px;display:inline-block}
        #combine{text-combine-upright:all}
      </style><div id="mixed" class="v">漢Aかな</div><div class="v"><span id="combine">31</span></div>`);
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 320, height: 180 });
      const vertical = collectVerticalSegments(tree);
      expect(vertical.some((s) => s.verticalOrientations?.includes("rotated") && s.verticalOrientations.includes("upright")))
        .toBe(true);
      expect(vertical.some((s) => s.verticalCombineUpright === true)).toBe(true);
      for (const segment of vertical) {
        expect(segment.fontAscent, "segment ascent").toBeTypeOf("number");
        expect(segment.fontAscent!, "positive ascent").toBeGreaterThan(0);
      }
    } finally {
      await page.close();
    }
  }, 60_000);
});
