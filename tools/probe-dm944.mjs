import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const browser = await chromium.launch();
// Use the SAME viewport the html-test runner uses (1024 wide, with the
// FIXTURE_HEIGHT_OVERRIDES tall height of 1184 for 28-deep-container-types).
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
const page = await ctx.newPage();
const html = readFileSync('external/html-test/28-deep-container-types.html', 'utf-8');
await page.setContent(html);
await page.waitForLoadState('networkidle');

const info = await page.evaluate(() => {
  const el = document.querySelector('.nested-target');
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  // Probe pseudo content's painted rect by inspecting characters using Range
  const range = document.createRange();
  range.selectNodeContents(el);
  const r = range.getBoundingClientRect();
  // Compute line heights from each character
  const textNode = el.firstChild;
  const text = textNode?.nodeValue ?? '';
  const ys = new Set();
  for (let i = 0; i < text.length - 1; i++) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i + 1);
    const cr = range.getBoundingClientRect();
    if (cr.width > 0) ys.add(Math.round(cr.top));
  }
  // The pseudo's painted area is rect.bottom - last-text-line-bottom
  const lastY = Math.max(...ys);
  return {
    elRect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    rangeRect: { x: r.x, y: r.y, w: r.width, h: r.height },
    textLineCount: ys.size,
    textLineYs: Array.from(ys).sort((a,b) => a - b),
    elBottom: rect.bottom,
    lastTextY: lastY,
    pseudoLikelyOnNewLine: rect.bottom - lastY > 24,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
