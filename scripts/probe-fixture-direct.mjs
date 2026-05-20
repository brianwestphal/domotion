import { chromium } from "@playwright/test";
import path from "node:path";

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
await page.goto("file://" + path.resolve("external/html-test") + "/06-forms-style-progress-meter.html");

const buf = await page.screenshot({ omitBackground: false, fullPage: false });
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
  function pix(x, y) {
    const i = (y * w + x) * 4;
    return [id[i], id[i + 1], id[i + 2]];
  }
  // Locate the first base progress bar via DOM bbox.
  const allProgress = Array.from(document.querySelectorAll("progress"));
  const out = [];
  for (let idx = 0; idx < Math.min(2, allProgress.length); idx++) {
    const el = allProgress[idx];
    const r = el.getBoundingClientRect();
    out.push({ idx, bbox: { x: r.x, y: r.y, w: r.width, h: r.height } });
    // Sample column x=mid-of-value (~25% in for first bar)
    const xSample = Math.round(r.x + r.width * 0.1);
    const xWide = Math.round(r.x + r.width * 0.5);
    const yTop = Math.floor(r.y) - 2, yBot = Math.ceil(r.y + r.height) + 2;
    out[idx].sampleX = xSample;
    out[idx].sampleWideX = xWide;
    out[idx].col = [];
    for (let y = yTop; y <= yBot; y++) {
      out[idx].col.push({ y, p: pix(xSample, y), q: pix(xWide, y) });
    }
  }
  return out;
}, b64);

for (const r of result) {
  console.log(`\n=== progress[${r.idx}] bbox: x=${r.bbox.x} y=${r.bbox.y} w=${r.bbox.w} h=${r.bbox.h} ===`);
  console.log(`  sampleX (mid-value)=${r.sampleX}  sampleWideX (mid-bar)=${r.sampleWideX}  col rows: ${(r.col || []).length}`);
  for (const c of (r.col || [])) {
    console.log(`  y=${c.y}  midValueX ${c.p.join(",").padEnd(13)}  midBarX ${c.q.join(",")}`);
  }
}

await browser.close();
