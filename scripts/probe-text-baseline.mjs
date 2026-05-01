import { chromium } from 'playwright';

// Probe Chrome's actual painted text baseline vs canvas.measureText() ascent.
// Domotion computes the SVG baseline as `textTop + fontAscent` where
// textTop = Range.getBoundingClientRect().top and fontAscent =
// canvas.measureText('Mxgp').fontBoundingBoxAscent. If Chrome's actual
// baseline differs from that sum, every text element is mis-positioned.

const html = `<!DOCTYPE html><html><head><style>
body { font-family: sans-serif; margin: 0; padding: 0; background: white; }
.box { background: #f1f5f9; padding: 10px; max-width: 300px; line-height: normal; color: black; }
.s10 { font-size: 10px; } .s12 { font-size: 12px; } .s14 { font-size: 14px; }
.s16 { font-size: 16px; } .s20 { font-size: 20px; } .s24 { font-size: 24px; }
.s32 { font-size: 32px; } .s48 { font-size: 48px; }
.times { font-family: 'Times New Roman', Times, serif; }
.menlo { font-family: Menlo, monospace; }
</style></head><body>
<p class="box s10" id="t10">M<img id="b10" style="display:inline-block;width:1px;height:1px;vertical-align:baseline"></p>
<p class="box s12" id="t12">M<img id="b12" style="display:inline-block;width:1px;height:1px;vertical-align:baseline"></p>
<p class="box s14" id="t14">M<img id="b14" style="display:inline-block;width:1px;height:1px;vertical-align:baseline"></p>
<p class="box s16" id="t16">M<img id="b16" style="display:inline-block;width:1px;height:1px;vertical-align:baseline"></p>
<p class="box s20" id="t20">M<img id="b20" style="display:inline-block;width:1px;height:1px;vertical-align:baseline"></p>
<p class="box s24" id="t24">M<img id="b24" style="display:inline-block;width:1px;height:1px;vertical-align:baseline"></p>
<p class="box s32" id="t32">M<img id="b32" style="display:inline-block;width:1px;height:1px;vertical-align:baseline"></p>
<p class="box s48" id="t48">M<img id="b48" style="display:inline-block;width:1px;height:1px;vertical-align:baseline"></p>
<p class="box s16 times" id="t16times">M<img id="b16times" style="display:inline-block;width:1px;height:1px;vertical-align:baseline"></p>
<p class="box s16 menlo" id="t16menlo">M<img id="b16menlo" style="display:inline-block;width:1px;height:1px;vertical-align:baseline"></p>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 400, height: 1200 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html);

const ids = ['t10','t12','t14','t16','t20','t24','t32','t48','t16times','t16menlo'];
const W = 400, H = 1200;
const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
const b64 = buf.toString('base64');

const rows = await page.evaluate(async ({ ids, b64, W, H }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx2 = c.getContext('2d');
  ctx2.drawImage(img, 0, 0);
  const data = ctx2.getImageData(0, 0, W, H).data;
  return ids.map((id) => {
    const el = document.getElementById(id);
    const cs = window.getComputedStyle(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const rr = range.getBoundingClientRect();
    const cv = document.createElement('canvas').getContext('2d');
    cv.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const tm = cv.measureText('M');
    const tmHash = cv.measureText('Mxgp');
    const emAsc = tmHash.emHeightAscent;
    const emDesc = tmHash.emHeightDescent;
    const hAsc = tmHash.hangingBaseline;
    const aBL = tmHash.alphabeticBaseline;
    const iBL = tmHash.ideographicBaseline;
    // scan ink within the line box rows of this element
    const yStart = Math.floor(rr.top), yEnd = Math.ceil(rr.bottom);
    let topRow = -1, bottomRow = -1;
    for (let y = yStart; y < yEnd && y < H; y++) {
      for (let x = Math.floor(rr.left); x < Math.ceil(rr.right) && x < W; x++) {
        const i = (y*W + x)*4;
        const lum = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
        if (lum < 100) { if (topRow === -1) topRow = y; bottomRow = y; break; }
      }
    }
    const svgBaseline = rr.top + tm.fontBoundingBoxAscent;
    const chromeBaseline = topRow + tm.actualBoundingBoxAscent;
    // Use inline-block img bottom as a precise baseline marker
    const baselineImg = document.getElementById('b' + id.slice(1));
    const ir = baselineImg ? baselineImg.getBoundingClientRect() : null;
    const imgBaseline = ir ? ir.bottom : null;
    // Try alternative baseline computations using emHeight metrics and the
    // line-box midpoint
    const altEmBL = rr.top + (rr.bottom - rr.top - emAsc - emDesc) / 2 + emAsc;
    return {
      id, sz: cs.fontSize.replace('px',''), font: cs.fontFamily.split(',')[0].slice(0, 6),
      lineH: (rr.bottom - rr.top).toFixed(1),
      cAsc: tm.fontBoundingBoxAscent,
      emAsc: emAsc.toFixed(3), emDesc: emDesc.toFixed(3),
      svgBL: svgBaseline.toFixed(3),
      altEmBL: altEmBL.toFixed(3),
      inkBL: chromeBaseline.toFixed(3),
      svg_err: (svgBaseline - chromeBaseline).toFixed(3),
      em_err: (altEmBL - chromeBaseline).toFixed(3),
    };
  });
}, { ids, b64, W, H });
console.table(rows);

await browser.close();
