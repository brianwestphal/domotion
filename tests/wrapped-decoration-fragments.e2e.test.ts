import { afterAll, describe, expect, it } from "vitest";
import type { CapturedElement } from "../src/capture/types.js";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import { launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

function flatten(elements: readonly CapturedElement[]): CapturedElement[] {
  return elements.flatMap((element) => [element, ...flatten(element.children ?? [])]);
}

const env = await (async () => {
  try { return { browser: await launchChromium({ headless: true }) }; } catch { return null; }
})();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env == null ? describe.skip : describe;

describeBrowser("wrapped decoration FragmentItem capture", () => {
  for (const dpr of [1, 4]) for (const writingMode of ["horizontal-tb", "vertical-rl"] as const) {
    it(`retains ordered ${writingMode} decorating boxes at DPR ${dpr}`, async () => {
      const context = await env!.browser.newContext({
        viewport: { width: 360, height: 300 }, deviceScaleFactor: dpr,
      });
      const page = await context.newPage();
      try {
        await page.setContent(`<body style="margin:0"><div style="width:150px;height:170px;
          writing-mode:${writingMode};font:20px/1.4 sans-serif">
          <span id="decorator" style="text-decoration:underline wavy red">
            Latin אבג 中文 continuation fragment ownership
          </span></div></body>`);
        const native = await page.locator("#decorator").evaluate((element) =>
          Array.from(element.getClientRects(), (rect) => ({
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          })).filter((rect) => rect.width > 0 && rect.height > 0));
        expect(native.length).toBeGreaterThan(1);
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 360, height: 300 });
        const captured = flatten(tree).find((element) => element.styles.textDecorationLine.includes("underline"));
        expect(captured?.inlineFragments).toEqual(native);
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
