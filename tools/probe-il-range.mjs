import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
const url = 'file://' + resolve('/Users/westphal/Documents/domotion/external/html-test/24-deep-initial-letter.html');
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1800 } })).newPage();
await page.goto(url);
await page.waitForLoadState('networkidle');
const info = await page.evaluate(() => {
  const out = [];
  for (const sel of ['.drop-5 p:first-of-type', '.drop-fancy p:first-of-type', '.multi p:first-of-type']) {
    const el = document.querySelector(sel);
    if (!el || !el.firstChild) continue;
    const textNode = el.firstChild;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 1); // first char
    const r = range.getBoundingClientRect();
    const cs = getComputedStyle(el, '::first-letter');
    const csPara = getComputedStyle(el);
    out.push({
      sel,
      firstCharText: textNode.textContent[0],
      rangeRect: { x: r.x.toFixed(2), y: r.y.toFixed(2), w: r.width.toFixed(2), h: r.height.toFixed(2) },
      pseudoFontSize: cs.fontSize,
      pseudoInitialLetter: cs.initialLetter || cs.webkitInitialLetter,
      paraLineHeight: csPara.lineHeight,
      paraFontSize: csPara.fontSize,
    });
  }
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
