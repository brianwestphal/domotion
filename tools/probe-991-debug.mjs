import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/06-forms-textarea.html", "utf-8"));
await page.waitForLoadState("networkidle");
const info = await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  const v = ta.value;
  const cs = getComputedStyle(ta);
  return {
    value: v,
    valueLen: v.length,
    hasNewline: v.indexOf("\n") >= 0,
    valueRaw: JSON.stringify(v),
    cssWidth: cs.width,
    cssHeight: cs.height,
    padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
    rect: (() => { const r = ta.getBoundingClientRect(); return { w: r.width, h: r.height }; })(),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
