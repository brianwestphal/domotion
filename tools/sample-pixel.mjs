import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
const url = 'file://' + resolve('/Users/westphal/Documents/domotion/external/html-test/24-deep-initial-letter.html');
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1800 } })).newPage();
await page.goto(url);
await page.waitForLoadState('networkidle');
// Screenshot then sample pixel inside the W glyph at .drop-5.
const buf = await page.screenshot({ omitBackground: false });
import('node:fs').then(fs => fs.writeFileSync('/tmp/claude/chrome-paint.png', buf));
// Get the rect of the W glyph.
const wEl = await page.$('.drop-5 p:first-of-type');
const r = await wEl.boundingBox();
console.log('drop-5 p rect:', r);
await browser.close();
