import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/index.js";
import { captureElementTreeWithWarnings, elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import sharp from "sharp";

// DM-1268: a pseudo-element's standalone `scale` / `rotate` / `translate`
// properties (CSS Transforms 2) must compose into the captured pseudoBox
// transform, not just the `transform` property. Apple's
// `media-gallery-dotnav-link::before` carousel dots shrink toward the edges via
// the `scale` property (scale: 0.75 / 0.5), a separate computed entry from
// `transform`; without composing it the dots rendered full-size. Render a
// `::before { scale: 0.5 }` circle and assert it paints at HALF its layout size.

const W = 200, H = 120;
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}` +
  `.dot{position:relative;display:inline-block;width:40px;height:40px;margin:20px}` +
  `.dot::before{content:"";position:absolute;inset:0;background:#333;border-radius:999px;scale:0.5}` +
  `</style></head><body><span class="dot"></span></body></html>`;

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeBrowser = env ? describe : describe.skip;

describeBrowser("DM-1268: pseudo `scale` property shrinks the rendered ::before", () => {
  it("renders `::before { scale: 0.5 }` at half its 40px layout size (~20px)", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const raster = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const cap = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: W, height: H });
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${elementTreeToSvgInner(cap.tree, W, H)}</svg>`;
      await raster.setContent(`<body style="margin:0">${svg}</body>`, { waitUntil: "load" });
      const buf = await raster.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
      let minx = 1e9, maxx = -1;
      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
        if (data[y * info.width + x] < 100) { if (x < minx) minx = x; if (x > maxx) maxx = x; }
      }
      const diameter = maxx - minx + 1;
      // scale:0.5 on a 40px box → ~20px painted circle (not 40px). Allow AA slack.
      expect(diameter).toBeGreaterThan(15);
      expect(diameter).toBeLessThan(28);
    } finally {
      await page.close();
      await raster.close();
    }
  }, 60_000);
});
