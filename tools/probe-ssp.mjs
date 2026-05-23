import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
const url = 'file://' + resolve('/Users/westphal/Documents/domotion/external/html-test/20-deep-font-feature-values.html');
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1600 } })).newPage();
await page.goto(url);
await page.waitForLoadState('networkidle');
// Get the resolved font for the "The quick brown fox" line — first <p> in the panel.
const info = await page.evaluate(() => {
  const p = document.querySelector('.panel p');
  if (!p) return null;
  const cs = getComputedStyle(p);
  const r = p.getBoundingClientRect();
  // Use the deprecated but useful CSS Font Loading API to ask Chrome which face it'd resolve to.
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;font-family:' + cs.fontFamily + ';font-size:18px';
  probe.textContent = 'The quick brown fox';
  document.body.appendChild(probe);
  const probeWidth = probe.getBoundingClientRect().width;
  // Compare to a known Times width.
  const timesProbe = document.createElement('span');
  timesProbe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;font-family:Times,"Times New Roman",serif;font-size:18px';
  timesProbe.textContent = 'The quick brown fox';
  document.body.appendChild(timesProbe);
  const timesWidth = timesProbe.getBoundingClientRect().width;
  const georgiaProbe = document.createElement('span');
  georgiaProbe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;font-family:Georgia,serif;font-size:18px';
  georgiaProbe.textContent = 'The quick brown fox';
  document.body.appendChild(georgiaProbe);
  const georgiaWidth = georgiaProbe.getBoundingClientRect().width;
  // Source Serif Pro — if installed
  const sspProbe = document.createElement('span');
  sspProbe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;font-family:"Source Serif Pro";font-size:18px';
  sspProbe.textContent = 'The quick brown fox';
  document.body.appendChild(sspProbe);
  const sspWidth = sspProbe.getBoundingClientRect().width;
  return {
    fontFamily: cs.fontFamily,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    probeWidth, timesWidth, georgiaWidth, sspWidth,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
