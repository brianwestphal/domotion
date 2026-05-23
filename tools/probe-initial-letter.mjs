import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
const url = 'file://' + resolve('/Users/westphal/Documents/domotion/external/html-test/24-deep-initial-letter.html');
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1800 } })).newPage();
await page.goto(url);
await page.waitForLoadState('networkidle');
// Get computed styles on the ::first-letter pseudo for .drop-5 p:first-of-type.
const info = await page.evaluate(() => {
  const out = [];
  const targets = [
    { sel: '.drop-3 p:first-of-type', name: 'drop-3' },
    { sel: '.drop-5 p:first-of-type', name: 'drop-5' },
    { sel: '.drop-fancy p:first-of-type', name: 'drop-fancy' },
    { sel: '.raise p:first-of-type', name: 'raise' },
    { sel: '.multi p:first-of-type', name: 'multi' },
    { sel: '.sans-body p:first-of-type', name: 'sans-body' },
  ];
  for (const t of targets) {
    const el = document.querySelector(t.sel);
    if (!el) continue;
    const cs = getComputedStyle(el, '::first-letter');
    const r = el.getBoundingClientRect();
    out.push({
      name: t.name,
      rect: { x: r.x.toFixed(1), y: r.y.toFixed(1) },
      pseudoColor: cs.color,
      pseudoBgImage: cs.backgroundImage,
      pseudoFontSize: cs.fontSize,
      pseudoFontWeight: cs.fontWeight,
      pseudoInitialLetter: cs.initialLetter || cs.webkitInitialLetter,
    });
  }
  // Test 1: directly sample the painted pixel of the W center.
  const wEl = document.querySelector('.drop-5 p:first-of-type');
  if (wEl) {
    const wRect = wEl.getBoundingClientRect();
    out.push({ wPaintRect: { x: wRect.x, y: wRect.y, w: wRect.width, h: wRect.height } });
  }
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
