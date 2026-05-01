import { chromium } from 'playwright';
const html = `<!DOCTYPE html><html><head><style>
body { background: #0d1117; color: #e6edf3; font-family: -apple-system, sans-serif; margin: 20px; line-height: 1.7; }
.s14 { font-size: 14px; }
.s22 { font-size: 22px; }
</style></head><body>
<div style="font-size: 12px"><span style="text-decoration: underline" id="u12">underlined twelve</span></div>
<div style="font-size: 14px"><span style="text-decoration: underline" id="u14">underlined fourteen</span></div>
<div style="font-size: 16px"><span style="text-decoration: underline" id="u16">underlined sixteen</span></div>
<div style="font-size: 22px"><span style="text-decoration: underline" id="u22">underlined twenty-two</span></div>
<div style="font-size: 24px"><span style="text-decoration: underline" id="u24">underlined twenty-four</span></div>
<div style="font-size: 18px"><span style="text-decoration: underline" id="u18">underlined eighteen</span></div>
<div style="font-size: 32px"><span style="text-decoration: underline" id="u32">underlined thirty-two</span></div>
<div style="font-size: 14px"><span style="text-decoration: line-through" id="s14">struck fourteen</span></div>
<div style="font-size: 22px"><span style="text-decoration: line-through" id="s22">struck twenty-two</span></div>
<div style="font-size: 14px"><span style="text-decoration: overline" id="o14">over fourteen</span></div>
<div style="font-size: 22px"><span style="text-decoration: overline" id="o22">over twenty-two</span></div>
</body></html>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 600, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html);
const W = 600, H = 800;
const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
const b64 = buf.toString('base64');
const result = await page.evaluate(async ({ ids, b64, W, H }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx2 = c.getContext('2d');
  ctx2.drawImage(img, 0, 0);
  const data = ctx2.getImageData(0, 0, W, H).data;
  // background is dark; ink is light. Use luminance > 100 as ink.
  const isInk = (i) => (0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]) > 80;
  return ids.map((id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const cv = document.createElement('canvas').getContext('2d');
    cv.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const tm = cv.measureText(el.textContent);
    // Find line-rect: scan only the span's bbox columns, find horizontal-strip pixels with 80%+ ink coverage = the deco line
    const xs = Math.floor(r.left), xe = Math.ceil(r.right);
    const ys = Math.floor(r.top - 5), ye = Math.ceil(r.bottom + 5);
    let decoTop = -1, decoBottom = -1;
    for (let y = ys; y <= ye && y < H; y++) {
      let inkCount = 0;
      for (let x = xs; x < xe && x < W; x++) {
        const i = (y*W + x)*4;
        if (isInk(i)) inkCount++;
      }
      const cov = inkCount / (xe - xs);
      if (cov > 0.85) { if (decoTop === -1) decoTop = y; decoBottom = y; }
    }
    return {
      id, fontSize: cs.fontSize, top: r.top, bottom: r.bottom,
      ascent: tm.fontBoundingBoxAscent, descent: tm.fontBoundingBoxDescent,
      decoTop, decoBottom,
      // Compute SVG baseline = top + ascent. Chrome painted deco offset from baseline:
      ourBaseline: r.top + tm.fontBoundingBoxAscent,
      decoOffsetFromBaseline: decoTop !== -1 ? (decoTop - (r.top + tm.fontBoundingBoxAscent)) : null,
    };
  });
}, { ids: ['u12','u14','u16','u18','u22','u24','u32','s14','s22','o14','o22'], b64, W, H });
console.table(result);
await browser.close();
