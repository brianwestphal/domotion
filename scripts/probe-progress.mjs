import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const page = await ctx.newPage({ viewport: { width: 400, height: 200 } });
await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;background:white;font-family:sans-serif;">
<div style="padding:20px;">
<progress value="60" max="100" id="p8" style="display:block;width:80px;height:8px;"></progress>
<br>
<progress value="60" max="100" id="p16" style="display:block;width:160px;height:16px;"></progress>
<br>
<progress value="60" max="100" id="p40" style="display:block;width:300px;height:40px;"></progress>
</div>
</body></html>`);

const buf = await page.screenshot({ omitBackground: false, clip: { x: 0, y: 0, width: 400, height: 200 } });
const b64 = buf.toString("base64");

const samples = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  await new Promise((r) => { img.onload = r; });
  const cvs = document.createElement("canvas");
  cvs.width = img.width; cvs.height = img.height;
  const cx = cvs.getContext("2d");
  cx.drawImage(img, 0, 0);
  const w = img.width, h = img.height;
  const id = cx.getImageData(0, 0, w, h).data;
  function pix(x, y) { const i = (y * w + x) * 4; return [id[i], id[i + 1], id[i + 2]]; }
  function rectOf(id) {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  function vert(x, yStart, yEnd) {
    const out = [];
    for (let y = yStart; y <= yEnd; y++) out.push([y, pix(Math.round(x), y)]);
    return out;
  }
  const out = {};
  for (const id of ["p8", "p16", "p40"]) {
    const r = rectOf(id);
    out[id] = {
      bbox: r,
      // Sample mid-fill (left third) and mid-track (right third) vertical
      midFill: vert(r.x + r.w * 0.3, Math.floor(r.y) - 2, Math.ceil(r.y + r.h) + 2),
      midTrack: vert(r.x + r.w * 0.8, Math.floor(r.y) - 2, Math.ceil(r.y + r.h) + 2),
    };
  }
  return out;
}, b64);

for (const [id, d] of Object.entries(samples)) {
  console.log(`\n=== ${id}  bbox: x=${d.bbox.x.toFixed(1)} y=${d.bbox.y.toFixed(1)} w=${d.bbox.w.toFixed(1)} h=${d.bbox.h.toFixed(1)} ===`);
  console.log("  Mid-FILL vertical:");
  for (const [y, p] of d.midFill) console.log(`    y=${y}: rgb(${p.join(",")})`);
  console.log("  Mid-TRACK vertical:");
  for (const [y, p] of d.midTrack) console.log(`    y=${y}: rgb(${p.join(",")})`);
}

await browser.close();
