import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 760, height: 800 } });
const page = await ctx.newPage();

// Replicate the embed-rtl span from 02-deep-bidi-isolate.html
await page.setContent(`<!doctype html><html><body style="font-family:system-ui,sans-serif">
<p>English: <span style="unicode-bidi:embed;direction:rtl;background:#fef9c3">שלום (one) עולם</span> tail.</p>
</body></html>`);

const info = await page.evaluate(() => {
  const span = document.querySelector("span");
  const text = span.textContent;
  const range = document.createRange();
  const tn = span.firstChild;
  const out = [];
  for (let i = 0; i < text.length; i++) {
    range.setStart(tn, i);
    range.setEnd(tn, i + 1);
    const r = range.getBoundingClientRect();
    out.push({ i, ch: text[i], code: text.charCodeAt(i).toString(16).toUpperCase(), x: +r.x.toFixed(2), w: +r.width.toFixed(2) });
  }
  return out;
});
for (const r of info) console.log(`logical ${r.i.toString().padStart(2)} "${r.ch}" U+${r.code.padStart(4, '0')} → x=${r.x} w=${r.w}`);
await browser.close();
