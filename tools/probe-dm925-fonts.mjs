import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 600 } });
const page = await ctx.newPage();
const tests = [
  // problematic from the fixture
  0x21D0, 0x21D2, 0x21D1, 0x21D3, // arrows ⇐⇒⇑⇓
  0x2713, 0x2714, // checks ✓✔
  0x2716, 0x2717, // crosses ✖✗
  0x2660, 0x2661, 0x2662, 0x2663, // suits ♠♡♢♣
  0x2605, 0x2606, // stars ★☆
  0x2190, 0x2191, 0x2192, 0x2193, // simple arrows ←↑→↓
  0x221A, 0x222B, 0x2200, // math √∫∀
  0x2122, 0x00A9, // trademark + copyright ™©
];
await page.setContent(`<html><body><span id='c' style='font-family:system-ui,sans-serif;font-size:48px'></span></body></html>`);
const out = await page.evaluate(async (cps) => {
  const span = document.getElementById('c');
  // Use Canvas measureText with the right font cascade
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = '48px system-ui, sans-serif';
  return cps.map(cp => {
    const ch = String.fromCodePoint(cp);
    span.textContent = ch;
    const r = span.getBoundingClientRect();
    const tm = ctx.measureText(ch);
    return { cp: cp.toString(16), char: ch, w: tm.width, rectW: r.width };
  });
}, tests);
console.log(JSON.stringify(out, null, 2));
await browser.close();
