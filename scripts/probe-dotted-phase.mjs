// Probe Chrome's actual dotted/dashed dot/dash positions for the
// border-styles-variants fixture geometry (DM-419/420). Compares to what
// our `adjustedDashAttrs` emits.

import { chromium } from 'playwright';

const html = `<!DOCTYPE html><html><head><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: white; padding: 20px; }
.b1 { width: 80px; height: 50px; border: 3px dotted #3fb950; display: inline-block; margin-right: 20px; }
.b2 { width: 80px; height: 50px; border: 3px dashed #58a6ff; display: inline-block; margin-right: 20px; }
.b3 { width: 80px; height: 50px; border-right: 2px dashed #d29922; display: inline-block; margin-right: 20px; }
.b4 { width: 80px; height: 50px; border-bottom: 6px dotted #8b949e; display: inline-block; margin-right: 20px; }
</style></head><body>
<div class="b1"></div><div class="b2"></div><div class="b3"></div><div class="b4"></div>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 800, height: 200 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html);

const W = 700, H = 100;
const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
const b64 = buf.toString('base64');

const result = await page.evaluate(async ({ b64, W, H }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx2 = c.getContext('2d');
  ctx2.drawImage(img, 0, 0);
  const data = ctx2.getImageData(0, 0, W, H).data;
  // Find horizontal ink runs on the top edge of each box, vertical ink runs on the right edge
  function scanH(yMin, yMax, xMin, xMax, isInk) {
    const runs = [];
    let inRun = false, runStart = 0;
    for (let x = xMin; x < xMax; x++) {
      let ink = false;
      for (let y = yMin; y < yMax; y++) {
        const i = (y*W + x)*4;
        if (isInk(data[i], data[i+1], data[i+2])) { ink = true; break; }
      }
      if (ink && !inRun) { runStart = x; inRun = true; }
      else if (!ink && inRun) { runs.push([runStart, x-1, x-runStart]); inRun = false; }
    }
    if (inRun) runs.push([runStart, xMax-1, xMax-runStart]);
    return runs;
  }
  function scanV(xMin, xMax, yMin, yMax, isInk) {
    const runs = [];
    let inRun = false, runStart = 0;
    for (let y = yMin; y < yMax; y++) {
      let ink = false;
      for (let x = xMin; x < xMax; x++) {
        const i = (y*W + x)*4;
        if (isInk(data[i], data[i+1], data[i+2])) { ink = true; break; }
      }
      if (ink && !inRun) { runStart = y; inRun = true; }
      else if (!ink && inRun) { runs.push([runStart, y-1, y-runStart]); inRun = false; }
    }
    if (inRun) runs.push([runStart, yMax-1, yMax-runStart]);
    return runs;
  }
  const greenDots = scanH(20, 26, 18, 105, (r,g,b) => r < 180 && g > 130 && b < 180);
  const blueDashes = scanH(20, 26, 118, 205, (r,g,b) => r < 150 && g > 130 && b > 200);
  const orangeDashes = scanV(295, 308, 18, 75, (r,g,b) => r > 180 && g > 100 && g < 180 && b < 100);
  // Box 4 gray dotted bottom: scan x from 320 to 405, y around 65-72
  const grayDots = scanH(64, 75, 318, 405, (r,g,b) => r < 200 && g < 200 && b < 200 && Math.abs(r-g) < 20 && Math.abs(g-b) < 20);
  return { greenDots, blueDashes, orangeDashes, grayDots };
}, { b64, W, H });

console.log('Box 1 green dotted (3px, top edge, runs=[startX, endX, width]):');
for (const r of result.greenDots) console.log('  ', r);
console.log('Box 2 blue dashed (3px, top edge):');
for (const r of result.blueDashes) console.log('  ', r);
console.log('Box 3 orange dashed (2px right edge, runs=[startY, endY, length]):');
for (const r of result.orangeDashes) console.log('  ', r);
console.log('Box 4 gray dotted (6px bottom edge, runs=[startX, endX, width]):');
for (const r of result.grayDots) console.log('  ', r);

await browser.close();
