import { chromium } from "@playwright/test";

// Isolate the BLUE value pseudo of UA-default <progress> at the fixture's
// h=14. The track is light gray (#e2e8f0-ish) so we filter for blue-dominant
// pixels only — that gives the painted shape of just the value pseudo.

const HTML = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:white;font-family:sans-serif;">
<style>.r { padding: 8px; }</style>
<div class="r"><progress id="p14_25" value="25" max="100" style="display:block;width:528px;height:14px;"></progress></div>
<div class="r"><progress id="p14_75" value="75" max="100" style="display:block;width:528px;height:14px;"></progress></div>
<div class="r"><progress id="p8_25" value="25" max="100" style="display:block;width:300px;height:8px;"></progress></div>
<div class="r"><progress id="p16_25" value="25" max="100" style="display:block;width:300px;height:16px;"></progress></div>
<div class="r"><progress id="p40_25" value="25" max="100" style="display:block;width:300px;height:40px;"></progress></div>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
await page.setContent(HTML);

const buf = await page.screenshot({ omitBackground: false, clip: { x: 0, y: 0, width: 800, height: 600 } });
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
  const isBlueish = (x, y) => {
    const i = (y * w + x) * 4;
    const R = id[i], G = id[i + 1], B = id[i + 2];
    // Chrome paints the value as accent-blue (~#0075FF). Blue-dominant.
    return B > R + 30 && B > 100;
  };
  function rectOf(elId) {
    const el = document.getElementById(elId);
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  function paintedRows(bbox) {
    const out = [];
    for (let y = Math.floor(bbox.y) - 2; y <= Math.ceil(bbox.y + bbox.h) + 2; y++) {
      let left = -1, right = -1;
      for (let x = Math.floor(bbox.x) - 2; x <= Math.ceil(bbox.x + bbox.w) + 2; x++) {
        if (isBlueish(x, y)) { left = x; break; }
      }
      for (let x = Math.ceil(bbox.x + bbox.w) + 2; x >= Math.floor(bbox.x) - 2; x--) {
        if (isBlueish(x, y)) { right = x; break; }
      }
      // Sample a column well inside the value (x=bbox.x + bbox.w * 0.1) so we
      // see the bar fill, not the corner.
      const xMid = Math.round(bbox.x + bbox.w * 0.1);
      const i = (y * w + xMid) * 4;
      const px = [id[i], id[i + 1], id[i + 2]];
      if (left >= 0) out.push({ y, left, right, midPix: px });
    }
    return out;
  }
  const out = {};
  for (const elId of ["p14_25", "p14_75", "p8_25", "p16_25", "p40_25"]) {
    const r = rectOf(elId);
    out[elId] = { bbox: r, rows: paintedRows(r) };
  }
  return out;
}, b64);

for (const [name, data] of Object.entries(result)) {
  const { bbox, rows } = data;
  if (rows.length === 0) { console.log(`${name}: no blue paint`); continue; }
  const yTop = rows[0].y, yBot = rows[rows.length - 1].y;
  const xLeft = Math.min(...rows.map((r) => r.left));
  const xRight = Math.max(...rows.map((r) => r.right));
  console.log(`\n=== ${name} (bbox h=${bbox.h}) ===`);
  console.log(`  blue bbox: y=[${yTop}..${yBot}] (h=${yBot - yTop + 1}) x=[${xLeft}..${xRight}] (w=${xRight - xLeft + 1})`);
  console.log(`  inset top=${yTop - bbox.y} bottom=${(bbox.y + bbox.h) - yBot - 1} left=${xLeft - bbox.x} right=${(bbox.x + bbox.w) - xRight - 1}`);
  console.log(`  per-row:`);
  for (const r of rows) {
    console.log(`    y=${r.y}: left=${r.left} right=${r.right} (inset L=${r.left - bbox.x}) mid_px=[${r.midPix.join(",")}]`);
  }
}

await browser.close();
