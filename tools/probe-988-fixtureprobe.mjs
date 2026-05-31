import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2048 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
await page.setContent(readFileSync("external/html-test/02-text-symbols.html","utf-8"));
await page.waitForLoadState("networkidle");
// Find one of the ★ chars and measure
const info = await page.evaluate(() => {
  const out = [];
  const text = document.body.innerText;
  for (const ch of ["★", "♥", "♠", "♣", "●", "✓", "→", "Σ", "™"]) {
    const idx = text.indexOf(ch);
    if (idx < 0) continue;
    // walk text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const ci = n.textContent.indexOf(ch);
      if (ci < 0) continue;
      const range = document.createRange();
      range.setStart(n, ci);
      range.setEnd(n, ci+1);
      const r = range.getBoundingClientRect();
      const parent = n.parentElement;
      const cs = window.getComputedStyle(parent);
      out.push({ ch, x: r.x, y: r.y, w: r.width, h: r.height, fontSize: cs.fontSize, parent: parent.className });
      break;
    }
  }
  return out;
});
for (const i of info) console.log(`${i.ch}  parent=${i.parent}  fontSize=${i.fontSize}  rect=${JSON.stringify({x:i.x,y:i.y,w:i.w,h:i.h})}`);
await browser.close();
