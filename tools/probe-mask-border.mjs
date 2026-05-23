// Probe Chrome's mask-border space paint by capturing the painted output
// and inspecting compositor stats. Run via playwright directly.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = 'file://' + resolve('/Users/westphal/Documents/domotion/external/html-test/niche/mask-border.html');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1200 } });
const page = await ctx.newPage();
await page.goto(url);
await page.waitForLoadState('networkidle');

// Get the .mb-3 stage's computed CSS values.
const info = await page.evaluate(() => {
  const el = document.querySelector('.mb-3');
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    maskBorderSource: cs.maskBorderSource,
    maskBorderSlice: cs.maskBorderSlice,
    maskBorderWidth: cs.maskBorderWidth,
    maskBorderOutset: cs.maskBorderOutset,
    maskBorderRepeat: cs.maskBorderRepeat,
    webkitMaskBoxImage: cs.webkitMaskBoxImage,
    webkitMaskBoxImageSource: cs.webkitMaskBoxImageSource,
    webkitMaskBoxImageSlice: cs.webkitMaskBoxImageSlice,
    webkitMaskBoxImageWidth: cs.webkitMaskBoxImageWidth,
    webkitMaskBoxImageOutset: cs.webkitMaskBoxImageOutset,
    webkitMaskBoxImageRepeat: cs.webkitMaskBoxImageRepeat,
  };
});
console.log('mb-3 computed:', JSON.stringify(info, null, 2));

// Screenshot just the .mb-3 stage for clear inspection.
const el = await page.$('.mb-3');
await el.screenshot({ path: '/tmp/claude/mb-3-chrome.png', omitBackground: false });
console.log('Saved screenshot to /tmp/claude/mb-3-chrome.png');

await browser.close();
