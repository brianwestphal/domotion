import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const env = await (async () => {
  try { return { browser: await launchChromium() }; } catch { return null; }
})();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

function findText(nodes: CapturedElement[], text: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.text === text) return node;
    const child = findText(node.children ?? [], text);
    if (child != null) return child;
  }
  return null;
}

describeBrowser("DM-2446: logical, computed, and paint font sizes", () => {
  it("keeps zoom and transform in their correct size spaces", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 500, height: 300 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(`<style>
        .sample { font: 400 13px Arial, sans-serif; position:absolute; left:20px }
        #zoom { top:20px; zoom:2 }
        #transform { top:100px; transform:scale(2); transform-origin:0 0 }
        #cancel { top:190px; zoom:2; transform:scale(.5); transform-origin:0 0 }
      </style><div id="zoom" class="sample">zoom</div><div id="transform" class="sample">transform</div><div id="cancel" class="sample">cancel</div>`, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 500, height: 300 });
      const zoom = findText(tree, "zoom")!;
      const transform = findText(tree, "transform")!;
      const cancel = findText(tree, "cancel")!;

      expect([zoom.styles.fontLogicalSize, zoom.styles.fontComputedSize, zoom.styles.fontSize]).toEqual(["13px", "26.0000px", "26.0000px"]);
      expect([transform.styles.fontLogicalSize, transform.styles.fontComputedSize, transform.styles.fontSize]).toEqual(["13px", "13.0000px", "26.0000px"]);
      expect([cancel.styles.fontLogicalSize, cancel.styles.fontComputedSize, cancel.styles.fontSize]).toEqual(["13px", "26.0000px", "13px"]);

      const metrics = await page.evaluate(() => {
        const at = (size: number) => {
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.font = `400 ${size}px Arial, sans-serif`;
          const m = ctx.measureText("Mxgp");
          return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
        };
        return { logical: at(13), computed: at(26) };
      });
      expect(zoom.fontAscent).toBe(metrics.computed.ascent);
      expect(zoom.fontDescent).toBe(metrics.computed.descent);
      expect(transform.fontAscent).toBe(metrics.logical.ascent * 2);
      expect(transform.fontDescent).toBe(metrics.logical.descent * 2);
      expect(cancel.fontAscent).toBe(metrics.computed.ascent * 0.5);
      expect(cancel.fontDescent).toBe(metrics.computed.descent * 0.5);
    } finally {
      await page.close();
    }
  }, 60_000);
});
