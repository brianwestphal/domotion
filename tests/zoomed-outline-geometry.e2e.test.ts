import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, elementTreeToSvgInner, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function findTag(nodes: CapturedElement[], tag: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.tag === tag) return node;
    const child = findTag(node.children ?? [], tag);
    if (child) return child;
  }
  return null;
}

describeBrowser("DM-2323: effective zoom border/outline capture", () => {
  for (const sample of [
    { zoom: 0.8, outlineWidth: 4, outlineOffset: 2, borderWidth: 4, radius: 5.6 },
    { zoom: 1.25, outlineWidth: 6, outlineOffset: 3, borderWidth: 6, radius: 8.75 },
  ]) {
    it(`captures Blink paint-space lengths at zoom ${sample.zoom}`, async () => {
      const page = await env!.browser.newPage({ viewport: { width: 420, height: 240 }, deviceScaleFactor: 1 });
      try {
        await page.setContent(`<style>body{zoom:${sample.zoom}}#probe{position:absolute;left:40.75px;top:40.75px;width:132px;height:34px;box-sizing:border-box;border:5px solid blue;border-radius:7px;outline:5px solid red;outline-offset:3px}</style><div id="probe"></div>`, { waitUntil: "load" });
        const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 420, height: 240 });
        const probe = findTag(tree, "div");
        expect(probe).toBeTruthy();
        expect(parseFloat(probe!.styles.outlineWidth!)).toBe(sample.outlineWidth);
        expect(parseFloat(probe!.styles.outlineOffset!)).toBe(sample.outlineOffset);
        expect(parseFloat(probe!.styles.borderTopWidth!)).toBe(sample.borderWidth);
        expect(parseFloat(probe!.styles.borderTopLeftRadius!)).toBeCloseTo(sample.radius, 6);
        const svg = elementTreeToSvgInner(tree, 420, 240);
        expect(svg).toContain(`stroke-width="${sample.outlineWidth}"`);
      } finally { await page.close(); }
    });
  }
});
