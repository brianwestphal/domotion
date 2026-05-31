// Check what capHeightRatio my formula derives and compare to what
// effective fontSize would produce the actual painted W width.
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
const page = await ctx.newPage();
await page.setContent(`<!doctype html><html><body>
<script>
function probe() {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const out = [];
  for (const w of ['400', '700', '800']) {
    ctx.font = w + ' 100px Georgia, serif';
    const h = ctx.measureText('H');
    const w_ = ctx.measureText('W');
    out.push({
      weight: w,
      H_actualBoundingBoxAscent: h.actualBoundingBoxAscent,
      H_fontBoundingBoxAscent: h.fontBoundingBoxAscent,
      W_width: w_.width,
      W_actualBoundingBoxAscent: w_.actualBoundingBoxAscent,
    });
  }
  document.body.textContent = JSON.stringify(out);
}
probe();
</script>
</body></html>`);
await page.waitForLoadState("networkidle");
const txt = await page.evaluate(() => document.body.textContent);
console.log("canvas H probe:", txt);

// Now empirically check what fontSize produces a W of width 193.15
const realProbe = await page.evaluate(() => {
  const tests = [];
  for (let fs = 160; fs <= 220; fs += 5) {
    const span = document.createElement('span');
    span.style.font = `800 ${fs}px Georgia, serif`;
    span.style.position = 'absolute'; span.style.left = '0'; span.style.top = '-1000px';
    span.style.lineHeight = 'normal';
    span.textContent = 'W';
    document.body.appendChild(span);
    const r = document.createRange();
    r.selectNodeContents(span);
    const cr = r.getBoundingClientRect();
    tests.push({ fs, w: +cr.width.toFixed(2), h: +cr.height.toFixed(2) });
    document.body.removeChild(span);
  }
  return tests;
});
console.log("W widths by fontSize:");
realProbe.forEach((t) => console.log(`  fs=${t.fs} → w=${t.w} h=${t.h}`));

await browser.close();
