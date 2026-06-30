import { chromium, type Browser } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { rasterizeMaskSources } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import type { CapturedElement } from "../src/capture/types.js";

/**
 * DM-1447 — `rasterizeMaskSources` must be able to screenshot a
 * `mask-image: element(#id)` paint-ref target that lives INSIDE a recursed
 * same-origin `<iframe>`, isolating it through the enclosing `<iframe>` chain
 * (hide-everything CSS in both the top document and the frame; the iframe stays
 * visible so the target shows through).
 *
 * NOTE: `mask-image: element()` is currently DORMANT in the toolchain's
 * Playwright Chromium — it computes to `none` and paints unmasked (the existing
 * `mask-element-ref` feature fixture therefore passes vacuously). So this test
 * exercises the node-side frame-aware rasterize DIRECTLY via a synthetic
 * `maskRasters` entry (the mechanism DM-1447 changed) rather than relying on
 * `element()` resolving — and asserts the isolation holds: a top-document
 * overlay and an in-frame sibling that sit over the target's screen rect must
 * NOT leak into the captured PNG.
 */

const env = await (async () => {
  try { return { browser: await chromium.launch() }; } catch { return null; }
})();

afterAll(async () => {
  await closeBrowserSafely(env?.browser as Browser | null | undefined);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

// A minimal captured root carrying one mask raster pointing at the rid'd inner
// element. Only the fields rasterizeMaskSources reads are populated.
function rootWithMaskRaster(rid: string, rect: { x: number; y: number; w: number; h: number }): CapturedElement[] {
  const root = {
    tag: "body", x: 0, y: 0, width: 300, height: 220, styles: {}, children: [],
    maskRasters: [{ id: "t", rid, width: rect.w, height: rect.h, rect: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } }],
  } as unknown as CapturedElement;
  return [root];
}

describeBrowser("frame-aware mask-source rasterize (DM-1447)", () => {
  it("screenshots an inner-iframe target, isolated from top-doc + in-frame overlays", async () => {
    const ctx = await env!.browser.newContext({ deviceScaleFactor: 1, viewport: { width: 300, height: 220 } });
    const page = await ctx.newPage();
    try {
      // Top doc: a full-page BLUE overlay (would leak if top-doc isolation failed).
      // The iframe sits at (10,10); inside it the rid'd RED target is at (0,0),
      // with a GREEN sibling painted on top of it (would leak if in-frame
      // isolation failed). Target maps to top-doc rect (10,10,120,80).
      const inner = `<body style="margin:0;background:#fff">
        <div data-domotion-rid="mrT" style="position:absolute;left:0;top:0;width:120px;height:80px;background:#ff0000"></div>
        <div style="position:absolute;left:0;top:0;width:120px;height:80px;background:#00cc00;z-index:5"></div>
      </body>`;
      await page.setContent(
        `<body style="margin:0">
           <div style="position:fixed;inset:0;background:#0000ff;z-index:99"></div>
           <iframe srcdoc="${inner.replace(/"/g, "&quot;")}" width="160" height="120" style="position:absolute;left:10px;top:10px;border:0;"></iframe>
         </body>`,
      );
      await page.waitForLoadState("networkidle");

      const tree = rootWithMaskRaster("mrT", { x: 10, y: 10, w: 120, h: 80 });
      await rasterizeMaskSources(page, tree, { x: 0, y: 0, width: 300, height: 220 });

      const raster = (tree[0] as CapturedElement & { maskRasters?: { dataUri?: string }[] }).maskRasters![0];
      expect(raster.dataUri, "the inner target must be screenshotted").toMatch(/^data:image\/png;base64,/);

      // Decode + sample the center: it must be the RED target — not the GREEN
      // in-frame overlay and not the BLUE top-doc overlay.
      const png = Buffer.from(raster.dataUri!.split(",")[1], "base64");
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      const cx = Math.floor(info.width / 2), cy = Math.floor(info.height / 2);
      const i = (cy * info.width + cx) * info.channels;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      expect(r, `center should be red (got rgb(${r},${g},${b}))`).toBeGreaterThan(180);
      expect(g).toBeLessThan(90);
      expect(b).toBeLessThan(90);
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
