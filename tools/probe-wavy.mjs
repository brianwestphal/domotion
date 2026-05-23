import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
const url = 'file://' + resolve('/Users/westphal/Documents/domotion/external/html-test/20-deep-wavy-underline-descenders.html');
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1600 } })).newPage();
await page.goto(url);
await page.waitForLoadState('networkidle');
const samples = await page.evaluate(() => {
  const targets = document.querySelectorAll('.wavy, .wavy-thick, .wavy-off-2, .wavy-off-6, .skipink, .noskip');
  const out = [];
  for (const el of targets) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push({
      className: el.className,
      text: (el.textContent || '').slice(0, 40),
      rect: { x: r.x.toFixed(2), y: r.y.toFixed(2), w: r.width.toFixed(2), h: r.height.toFixed(2) },
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      textDecorationLine: cs.textDecorationLine,
      textDecorationStyle: cs.textDecorationStyle,
      textDecorationColor: cs.textDecorationColor,
      textDecorationThickness: cs.textDecorationThickness,
      textUnderlineOffset: cs.textUnderlineOffset,
      textDecorationSkipInk: cs.textDecorationSkipInk,
    });
  }
  return out;
});
console.log(JSON.stringify(samples, null, 2));
await browser.close();
