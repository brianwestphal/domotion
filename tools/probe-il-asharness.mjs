import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
const url = 'file://' + resolve('/Users/westphal/Documents/domotion/external/html-test/24-deep-initial-letter.html');
const browser = await chromium.launch();
// Replicate exactly the html-test-suite viewport (1024 width) and a tall fixtureHeight.
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1496 } })).newPage();
await page.goto(url);
await page.waitForTimeout(150);
const fullShot = await page.screenshot({ clip: { x: 0, y: 0, width: 1024, height: 1496 } });
writeFileSync('/tmp/claude/W-harness-full.png', fullShot);
const wShot = await page.screenshot({ clip: { x: 35, y: 427, width: 210, height: 116 } });
writeFileSync('/tmp/claude/W-harness.png', wShot);
await browser.close();
console.log('done');
