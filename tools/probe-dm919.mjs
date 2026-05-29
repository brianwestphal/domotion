import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1200 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/20-deep-font-palette.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  // Find smiley emoji
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.textContent.includes("😀")) break;
  }
  if (!node) return { error: "no smiley" };
  // Measure the emoji char rect
  const idx = node.textContent.indexOf("😀");
  const r = document.createRange();
  r.setStart(node, idx);
  r.setEnd(node, idx + 2); // surrogate pair
  const cr = r.getBoundingClientRect();
  const parent = node.parentElement;
  const pcs = getComputedStyle(parent);
  return { rect: { x: cr.x, y: cr.y, w: cr.width, h: cr.height }, fontSize: pcs.fontSize, textContent: parent.textContent.slice(0, 30) };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
