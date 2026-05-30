import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/02-text-symbols.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = tw.nextNode())) if (node.textContent.includes("◆")) break;
  if (!node) return { error: "no diamonds" };
  const text = node.textContent;
  const results = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ') continue;
    const r = document.createRange();
    r.setStart(node, i); r.setEnd(node, i + 1);
    const cr = r.getBoundingClientRect();
    results.push({ ch, w: cr.width });
  }
  return { text, results };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
