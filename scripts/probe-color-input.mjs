import { chromium } from 'playwright';

const html = `<!DOCTYPE html><html><head><style>body{font-family:sans-serif;padding:20px;background:white}</style></head><body>
<input type="color" value="#4f46e5" id="c">
<input type="file" id="f">
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 400, height: 200 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html);

const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 400, height: 100 } });
const b64 = buf.toString('base64');

const data = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 400; c.height = 100;
  const ctx2 = c.getContext('2d');
  ctx2.drawImage(img, 0, 0);
  const d = ctx2.getImageData(0, 0, 400, 100).data;
  const get = (x, y) => { const i = (y*400 + x)*4; return [d[i], d[i+1], d[i+2]]; };
  const r1 = document.getElementById('c').getBoundingClientRect();
  const r2 = document.getElementById('f').getBoundingClientRect();
  // Sample border (just above mid-top edge) and bg-fill (a few px inside)
  return {
    color: {
      rect: r1,
      borderTop: get(Math.floor(r1.left + r1.width/2), Math.floor(r1.top)),
      bgFill: get(Math.floor(r1.left + 3), Math.floor(r1.top + 3)),
      swatchInner: get(Math.floor(r1.left + r1.width/2), Math.floor(r1.top + r1.height/2)),
    },
    file: {
      rect: r2,
      buttonBorderTop: get(Math.floor(r2.left + 30), Math.floor(r2.top + 1)),
      buttonBgFill: get(Math.floor(r2.left + 30), Math.floor(r2.top + 6)),
    }
  };
}, b64);
console.log('Color input:');
console.log('  rect:', data.color.rect.top.toFixed(1), data.color.rect.left.toFixed(1), 'w=' + data.color.rect.width, 'h=' + data.color.rect.height);
console.log('  border @top:', data.color.borderTop.join(','));
console.log('  bg-fill (3px inside):', data.color.bgFill.join(','));
console.log('  swatch inner:', data.color.swatchInner.join(','));
console.log('File input:');
console.log('  rect:', data.file.rect.top.toFixed(1), data.file.rect.left.toFixed(1), 'w=' + data.file.rect.width, 'h=' + data.file.rect.height);
console.log('  button border @top:', data.file.buttonBorderTop.join(','));
console.log('  button bg-fill:', data.file.buttonBgFill.join(','));

await browser.close();
