import { chromium } from "@playwright/test";

// Probe each styled <progress> variant from
// tests/output/html-test/06-forms-style-progress-meter.html: bbox, painted fill
// extents (top/bottom/left edges), and corner rounding (rx empirically derived
// by walking the corner pixels). Helps pin renderProgress() metrics for
// DM-354.

const HTML = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:white;font-family:sans-serif;">
<style>
  .row { padding: 8px; }
  /* mirror fixture, fixed widths so probe coordinates are deterministic */
  progress.base { width: 528px; height: 14px; display:block; }
  progress.grad { -webkit-appearance: none; appearance: none; width: 528px; height: 14px; display:block; border:0; border-radius:7px; overflow:hidden; }
  progress.grad::-webkit-progress-bar { background:#e2e8f0; border-radius:7px; }
  progress.grad::-webkit-progress-value { background:linear-gradient(90deg,#22d3ee,#4f46e5); border-radius:7px; }
  progress.thin { -webkit-appearance:none; appearance:none; width:528px; height:4px; display:block; border:0; background:#e2e8f0; }
  progress.thin::-webkit-progress-bar { background:#e2e8f0; }
  progress.thin::-webkit-progress-value { background:#0f172a; }
  progress.chunky { -webkit-appearance:none; appearance:none; width:528px; height:28px; display:block; border:0; border-radius:14px; overflow:hidden; background:#0f172a; }
  progress.chunky::-webkit-progress-bar { background:#1e293b; border-radius:14px; box-shadow:inset 0 1px 3px rgb(0 0 0 / .6); }
  progress.chunky::-webkit-progress-value { background:linear-gradient(180deg,#fbbf24,#d97706); border-radius:14px; }
  progress.stripe { -webkit-appearance:none; appearance:none; width:528px; height:18px; display:block; border:0; border-radius:4px; overflow:hidden; }
  progress.stripe::-webkit-progress-bar { background:#e2e8f0; }
  progress.stripe::-webkit-progress-value { background:repeating-linear-gradient(45deg,#16a34a 0 10px,#15803d 10px 20px); }
</style>
<div class="row"><progress id="base25" class="base" value="25" max="100"></progress></div>
<div class="row"><progress id="base75" class="base" value="75" max="100"></progress></div>
<div class="row"><progress id="grad60" class="grad" value="60" max="100"></progress></div>
<div class="row"><progress id="thin40" class="thin" value="40" max="100"></progress></div>
<div class="row"><progress id="chunky70" class="chunky" value="70" max="100"></progress></div>
<div class="row"><progress id="stripe50" class="stripe" value="50" max="100"></progress></div>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 800, height: 800 } });
const page = await ctx.newPage();
await page.setContent(HTML);

const buf = await page.screenshot({ omitBackground: false, clip: { x: 0, y: 0, width: 800, height: 800 } });
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
  const isWhite = (x, y) => {
    const i = (y * w + x) * 4;
    return id[i] >= 250 && id[i + 1] >= 250 && id[i + 2] >= 250;
  };
  const pix = (x, y) => {
    const i = (y * w + x) * 4;
    return [id[i], id[i + 1], id[i + 2]];
  };
  function paintedRows(bbox) {
    // For each y in [bbox.y - 2, bbox.y + bbox.h + 2], find leftmost and rightmost non-white x within [bbox.x - 2, bbox.x + bbox.w + 2]
    const out = [];
    for (let y = Math.floor(bbox.y) - 2; y <= Math.ceil(bbox.y + bbox.h) + 2; y++) {
      let left = -1, right = -1;
      for (let x = Math.floor(bbox.x) - 2; x <= Math.ceil(bbox.x + bbox.w) + 2; x++) {
        if (!isWhite(x, y)) { left = x; break; }
      }
      for (let x = Math.ceil(bbox.x + bbox.w) + 2; x >= Math.floor(bbox.x) - 2; x--) {
        if (!isWhite(x, y)) { right = x; break; }
      }
      out.push({ y, left, right });
    }
    return out;
  }
  function rectOf(elId) {
    const el = document.getElementById(elId);
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  const out = {};
  for (const elId of ["base25", "base75", "grad60", "thin40", "chunky70", "stripe50"]) {
    const r = rectOf(elId);
    out[elId] = { bbox: r, rows: paintedRows(r), centerCol: pix(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2)) };
  }
  return out;
}, b64);

for (const [name, data] of Object.entries(result)) {
  const { bbox, rows } = data;
  const painted = rows.filter((r) => r.left >= 0);
  if (painted.length === 0) { console.log(`${name}: no paint`); continue; }
  const yTop = painted[0].y, yBot = painted[painted.length - 1].y;
  const xLeft = Math.min(...painted.map((r) => r.left));
  const xRight = Math.max(...painted.map((r) => r.right));
  console.log(`\n=== ${name} ===`);
  console.log(`  bbox: x=${bbox.x.toFixed(1)} y=${bbox.y.toFixed(1)} w=${bbox.w.toFixed(1)} h=${bbox.h.toFixed(1)}`);
  console.log(`  painted bbox: y=[${yTop}..${yBot}] (h=${yBot - yTop + 1}) x=[${xLeft}..${xRight}] (w=${xRight - xLeft + 1})`);
  console.log(`  inset top=${yTop - bbox.y} bottom=${(bbox.y + bbox.h) - yBot - 1} left=${xLeft - bbox.x} right=${(bbox.x + bbox.w) - xRight - 1}`);
  console.log(`  per-row left/right (showing ends and center):`);
  for (let i = 0; i < painted.length; i++) {
    const r = painted[i];
    if (i < 3 || i > painted.length - 4 || i === Math.floor(painted.length / 2)) {
      console.log(`    y=${r.y}: left=${r.left} right=${r.right} (inset L=${r.left - bbox.x}, R=${(bbox.x + bbox.w) - r.right - 1})`);
    }
  }
}

await browser.close();
