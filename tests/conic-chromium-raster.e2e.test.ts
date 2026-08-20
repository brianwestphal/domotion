import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTree, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { rasterizeConicGradients } from "../src/render/conic-raster.js";
import { _conicTileCache } from "../src/render/element-tree-to-svg.js";

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("Chromium-owned conic raster boundary (DM-2327)", () => {
  it("captures an advanced conic tile at the physical zoomed size before the CPU fallback", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 300, height: 220 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    try {
      _conicTileCache.clear();
      await page.setContent(`<div id="tile" style="width:80px;height:60px;zoom:1.25;background-image:conic-gradient(from 30deg at 40% 60% in oklch longer hue,red,blue);background-size:40px 30px;background-repeat:repeat"></div>`);
      const layer = await page.locator("#tile").evaluate((element) => getComputedStyle(element).backgroundImage);
      // A process-global cache can contain a direct-tree fallback or pixels
      // from a previous browser context. Supported capture must overwrite it.
      _conicTileCache.set(layer, new Map([["50x38", "data:image/png;base64,c3RhbGU="]]));
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 300, height: 220 });
      expect(tree[0].styles.backgroundSize).toBe("50px 37.5px");

      const cached = _conicTileCache.get(layer)?.get("50x38");
      expect(cached).toMatch(/^data:image\/png;base64,/);
      expect(cached).not.toBe("data:image/png;base64,c3RhbGU=");
      const bytes = Buffer.from(cached!.slice(cached!.indexOf(",") + 1), "base64");
      expect(await sharp(bytes).metadata()).toMatchObject({ width: 50, height: 38 });

      // The best-effort parser does not implement the Oklch hue clause. Its
      // later pre-pass must preserve the already-captured Chromium tile rather
      // than replacing or dropping it.
      await rasterizeConicGradients(tree);
      expect(_conicTileCache.get(layer)?.get("50x38")).toBe(cached);
    } finally {
      await context.close();
      _conicTileCache.clear();
    }
  }, 60_000);
});
