// Render a small fixture with border-radius + per-side borders to verify the DM-686 fix.
import { chromium } from "@playwright/test";
import { captureElementTreeWithWarnings, elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { writeFileSync } from "node:fs";

const HTML = `
<!doctype html><html><head><style>
body { margin:0; padding:20px; background:#fff; font-family:sans-serif; }
.box {
  width: 200px; height: 100px;
  border-top: 3px solid rgb(80,80,80);
  border-left: 3px solid rgb(80,80,80);
  border-right: 3px solid rgb(80,80,80);
  border-radius: 8px 8px 0 0;
  margin-bottom: 12px;
}
.dashed {
  border-style: dashed;
  border-color: rgb(0,128,0);
  border-radius: 16px;
}
.uniform {
  border: 4px solid rgb(80,80,80);
  border-radius: 12px;
}
</style></head><body>
<div class="box"></div>
<div class="box dashed"></div>
<div class="box uniform"></div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 500 } });
  const page = await ctx.newPage();
  await page.setContent(HTML);
  await page.waitForTimeout(500);
  const { tree, warnings } = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 400, height: 500 });
  console.log("warnings:", warnings.length);
  const svg = elementTreeToSvg(tree, 400, 500);
  writeFileSync("/tmp/claude/border-radius-test.svg", svg);
  await page.screenshot({ path: "/tmp/claude/border-radius-chrome.png", clip: { x: 0, y: 0, width: 400, height: 500 } });

  // Render the SVG using Playwright too for an apples-to-apples comparison.
  const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500" width="400" height="500">${svg}</svg>`;
  const svgPage = await ctx.newPage();
  await svgPage.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${fullSvg}</body></html>`);
  await svgPage.screenshot({ path: "/tmp/claude/border-radius-svg.png", clip: { x: 0, y: 0, width: 400, height: 500 } });
  await browser.close();
  console.log("wrote /tmp/claude/border-radius-test.svg and chrome.png");
})();
