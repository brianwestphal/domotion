import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`file://${ROOT}/external/html-test/34-mathml-layout.html`);
await page.waitForTimeout(300);

const result = await page.evaluate(() => {
  const out = [];
  const mos = document.querySelectorAll('mo');
  for (let i = 0; i < Math.min(mos.length, 4); i++) {
    const mo = mos[i];
    const cs = getComputedStyle(mo);
    out.push({
      text: mo.textContent,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      mathDepth: cs.mathDepth,
      mathStyle: cs.mathStyle,
    });
  }
  return out;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
