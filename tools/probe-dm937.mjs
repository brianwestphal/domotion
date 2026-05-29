import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1200 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/06-forms-style-file.html", "utf-8"));
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const lbl = document.querySelector(".drop");
  if (!lbl) return { error: "missing" };
  const cs = getComputedStyle(lbl);
  const r = lbl.getBoundingClientRect();
  // List all "line boxes" via getClientRects (returns rects for each line fragment of an inline)
  const rects = Array.from(lbl.getClientRects()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
  return {
    display: cs.display,
    border: cs.border,
    box: { x: r.x, y: r.y, w: r.width, h: r.height },
    clientRects: rects,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
