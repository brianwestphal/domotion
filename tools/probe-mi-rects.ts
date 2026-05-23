import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`file://${ROOT}/external/html-test/34-mathml-layout.html`);
await page.waitForTimeout(500);

const result = await page.evaluate(() => {
  const out: any[] = [];
  // Find first matrix row's mi a, mi b
  const mis = document.querySelectorAll('mi');
  for (let i = 0; i < Math.min(mis.length, 6); i++) {
    const mi = mis[i];
    const r = (mi as Element).getBoundingClientRect();
    // Get text node Range
    const t = mi.firstChild;
    let tr: any = null;
    if (t && t.nodeType === 3) {
      const range = document.createRange();
      range.selectNodeContents(t);
      const rb = range.getBoundingClientRect();
      tr = { x: rb.left, y: rb.top, w: rb.width, h: rb.height };
    }
    out.push({
      text: mi.textContent,
      miRect: { x: r.left, y: r.top, w: r.width, h: r.height },
      textRect: tr,
    });
  }
  return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
