import { captureElementTree } from "../dist/capture/index.js";
import { withPage, launchBrowser } from "../dist/capture/index.js";
import { readFileSync } from "node:fs";
const browser = await launchBrowser();
const tree = await withPage(browser, async (page) => {
  await page.setContent(readFileSync("external/html-test/20-deep-text-underline-position.html", "utf-8"));
  await page.waitForLoadState("networkidle");
  const { tree } = await captureElementTree(page, "body", { x: 0, y: 0, width: 1024, height: 1500 });
  return tree;
});
// Walk for .vert with .pos-left class
function walk(el, depth = 0) {
  if (el.className && el.className.includes("vert pos-left")) {
    console.log("Found .vert.pos-left:");
    console.log("  rect:", el.x, el.y, el.width, el.height);
    console.log("  elementRaster:", JSON.stringify(el.elementRaster));
    // Walk children for .ul
    for (const c of el.children ?? []) {
      if (c.className?.includes("ul")) {
        console.log("  .ul child:");
        console.log("    rect:", c.x, c.y, c.width, c.height);
        console.log("    elementRaster:", JSON.stringify(c.elementRaster));
      }
    }
    return true;
  }
  for (const c of el.children ?? []) if (walk(c, depth + 1)) return true;
  return false;
}
for (const root of tree) walk(root);
await browser.close();
