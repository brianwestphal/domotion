import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<div id=a style="background: color-mix(in srgb-linear, red, blue);">x</div><div id=b style="color:#1e293b;background: color-mix(in srgb, currentColor 10%, transparent);">y</div>`);
const result = await page.evaluate(() => {
  const a = getComputedStyle(document.getElementById('a')).backgroundColor;
  const b = getComputedStyle(document.getElementById('b')).backgroundColor;
  // Probe normalize
  const probe = document.createElement('div');
  probe.style.color = 'color-mix(in srgb, ' + a + ' 100%, transparent 0%)';
  document.body.appendChild(probe);
  const aNorm = getComputedStyle(probe).color;
  probe.style.color = 'color-mix(in srgb, ' + b + ' 100%, transparent 0%)';
  const bNorm = getComputedStyle(probe).color;
  return { a, b, aNorm, bNorm };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
