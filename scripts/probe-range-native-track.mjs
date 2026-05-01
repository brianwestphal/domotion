import { chromium } from "@playwright/test";

// Probe Chromium's UA-default range slider track + thumb dimensions on a
// minimal fixture (no author CSS). Measures the painted track thickness and
// the painted thumb diameter against bbox.height. DM-338.

const HTML = `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:white;">
<input type="range" id="r1" value="50" style="width:300px;">
<br><br>
<input type="range" id="r2" value="50" style="width:300px;height:20px;">
<br><br>
<input type="range" id="r3" value="0" style="width:300px;">
<br><br>
<input type="range" id="r4" value="100" style="width:300px;">
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
await page.setContent(HTML);
const buf = await page.screenshot({ fullPage: false, clip: { x: 0, y: 0, width: 800, height: 600 } });
const b64 = buf.toString("base64");

const result = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  await new Promise((r) => { img.onload = r; });
  const cvs = document.createElement("canvas");
  cvs.width = img.width; cvs.height = img.height;
  const cx = cvs.getContext("2d");
  cx.drawImage(img, 0, 0);
  const w = img.width, h = img.height;
  const id = cx.getImageData(0, 0, w, h).data;
  const pix = (x, y) => { const i = (y*w+x)*4; return [id[i], id[i+1], id[i+2]]; };
  const isWhite = (p) => p[0] >= 250 && p[1] >= 250 && p[2] >= 250;

  const out = [];
  for (const id of ["r1", "r2", "r3", "r4"]) {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    // Scan the column at LEFT of bbox + 4 (definitely in track-unfilled or
    // filled region depending on value, but always in the track NOT in the thumb).
    const colLeft = Math.round(r.x + 4);
    const colRight = Math.round(r.x + r.width - 4);
    const colMid = Math.round(r.x + r.width / 2);
    const cy = Math.round(r.y + r.height / 2);
    function sampleCol(x) {
      const samples = [];
      for (let y = Math.floor(r.y) - 2; y <= Math.ceil(r.y + r.height) + 2; y++) {
        const p = pix(x, y);
        samples.push({ y, p: p.join(","), white: isWhite(p) });
      }
      return samples;
    }
    out.push({ id, r: { x: r.x, y: r.y, w: r.width, h: r.height }, cy,
      colLeft, colRight, colMid,
      atLeft: sampleCol(colLeft), atRight: sampleCol(colRight), atMid: sampleCol(colMid) });
  }
  return out;
}, b64);

for (const d of result) {
  console.log(`\n=== ${d.id} ===`);
  console.log(`  bbox: x=${d.r.x.toFixed(1)} y=${d.r.y.toFixed(1)} w=${d.r.w.toFixed(1)} h=${d.r.h.toFixed(1)}, cy=${d.cy}`);
  console.log(`  At left col (${d.colLeft}) — track unfilled (or filled if val>0):`);
  for (const s of d.atLeft) if (!s.white) console.log(`    y=${s.y}: ${s.p}`);
  console.log(`  At right col (${d.colRight}) — track unfilled (or filled if val=100):`);
  for (const s of d.atRight) if (!s.white) console.log(`    y=${s.y}: ${s.p}`);
  console.log(`  At mid col (${d.colMid}) — thumb if value=50:`);
  for (const s of d.atMid) if (!s.white) console.log(`    y=${s.y}: ${s.p}`);
}

await browser.close();
