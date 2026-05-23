import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
const url = 'file://' + resolve('/Users/westphal/Documents/domotion/external/html-test/24-deep-initial-letter.html');
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1600 } })).newPage();
await page.goto(url);
await page.waitForLoadState('networkidle');
// Screenshot the W rect with omitBackground:true vs false.
const clip = { x: 35, y: 427, width: 210, height: 116 };
const withBg = await page.screenshot({ clip });
writeFileSync('/tmp/claude/W-with-bg.png', withBg);
const noBg = await page.screenshot({ clip, omitBackground: true });
writeFileSync('/tmp/claude/W-no-bg.png', noBg);
await browser.close();
console.log('Saved /tmp/claude/W-with-bg.png and /tmp/claude/W-no-bg.png');
