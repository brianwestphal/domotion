import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/13-deep-sticky-condensing-header.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  // Find the text "A sticky translucent header..."
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = tw.nextNode())) if (node.textContent.includes("A sticky")) break;
  if (!node) return { error: "not found" };
  const text = node.textContent;
  const positions = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ') continue;
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + 1);
    const cr = r.getBoundingClientRect();
    positions.push({ i, ch, x: cr.x, w: cr.width });
  }
  return { text: text.slice(0, 50), positions };
});
console.log(JSON.stringify(out, null, 2).slice(0, 4000));
await browser.close();
