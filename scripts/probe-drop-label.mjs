import { chromium } from 'playwright';
const html = `<!DOCTYPE html><html><head><style>
.drop {
  position: relative;
  border: 2px dashed #94a3b8; border-radius: 10px;
  padding: 28px; text-align: center; background: #f8fafc;
}
.drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
</style></head><body>
<label class="drop" id="d">
  <span>icon</span>
  <strong>Drop files</strong>
  <small>PNG, JPG, up to 10 MB</small>
  <input type="file">
</label>
</body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 400 }, deviceScaleFactor: 1 });
await page.setContent(html);
const data = await page.evaluate(() => {
  const el = document.getElementById('d');
  const cs = window.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const rects = Array.from(el.getClientRects()).map(r => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
  return {
    display: cs.display, position: cs.position, padding: cs.padding,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    rects,
    offsetWidth: el.offsetWidth, offsetHeight: el.offsetHeight,
    clientWidth: el.clientWidth, clientHeight: el.clientHeight,
    scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight,
  };
});
console.log(data);
await browser.close();
