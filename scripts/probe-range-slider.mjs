import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

// Probe Chromium's painted UA-default + author-styled range sliders from
// 06-forms-style-range.html. Measure the painted track's vertical extent
// (top/bottom y) and the painted thumb bbox so renderRange's `trackThickness`
// and `thumbW`/`thumbH` constants in src/form-controls.ts can be calibrated.
// DM-338.

const HTML_PATH = path.resolve("external/html-test", "06-forms-style-range.html");
const html = fs.readFileSync(HTML_PATH, "utf8");

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1024, height: 1400 } });
const page = await ctx.newPage();
await page.setContent(html);
const buf = await page.screenshot({ fullPage: false, clip: { x: 0, y: 0, width: 1024, height: 1400 } });
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
  const dist = (a,b) => Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1]), Math.abs(a[2]-b[2]));
  const isWhite = (p) => p[0] >= 250 && p[1] >= 250 && p[2] >= 250;

  // For each input[type=range], find the painted vertical extent at the
  // track's horizontal center column (avoiding the thumb), and the painted
  // bbox at the thumb's horizontal column.
  const out = [];
  const inputs = Array.from(document.querySelectorAll('input[type="range"]'));
  for (const el of inputs) {
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    if (r.width < 50 || r.height < 5) continue; // skip near-empty
    // Probe column: 5% of width (well left of thumb for value=0; for value > 0
    // we use 80% which should be in the unfilled region for value~30-65).
    const x = Math.round(r.x + r.width * 0.05);
    const cy = Math.round(r.y + r.height / 2);
    // Sample 30px around cy
    const trackPainted = [];
    for (let y = cy - 15; y <= cy + 15; y++) {
      const p = pix(x, y);
      if (!isWhite(p)) trackPainted.push({ y, p: p.join(",") });
    }
    // Find thumb bbox by scanning horizontally near the value-position
    const value = +el.value, min = +el.min || 0, max = +el.max || 100;
    const ratio = (value - min) / (max - min);
    const thumbCx = Math.round(r.x + r.width * ratio);
    let thumbTop = -1, thumbBot = -1, thumbLeft = -1, thumbRight = -1;
    for (let y = Math.floor(r.y) - 4; y <= Math.ceil(r.y + r.height) + 4; y++) {
      const p = pix(thumbCx, y);
      if (!isWhite(p)) { if (thumbTop < 0) thumbTop = y; thumbBot = y; }
    }
    for (let xx = Math.floor(r.x) - 4; xx <= Math.ceil(r.x + r.width) + 4; xx++) {
      const p = pix(xx, cy);
      if (!isWhite(p)) {
        if (thumbLeft < 0) thumbLeft = xx;
        thumbRight = xx;
      }
    }
    out.push({
      idx: out.length, name: el.id || el.name || el.outerHTML.slice(0, 80),
      cls: el.className, value, min, max,
      r: { x: r.x, y: r.y, w: r.width, h: r.height },
      cy, trackPainted: trackPainted.slice(0, 10),
      thumbTop, thumbBot, thumbHeight: thumbTop >= 0 ? thumbBot - thumbTop + 1 : 0,
      thumbLeftAtCY: thumbLeft, thumbRightAtCY: thumbRight, thumbWidthAtCY: thumbLeft >= 0 ? thumbRight - thumbLeft + 1 : 0,
      accentColor: cs.accentColor,
      writingMode: cs.writingMode,
    });
  }
  return out;
}, b64);

for (const d of result) {
  console.log(`\n=== range #${d.idx} ${d.cls} ===`);
  console.log(`  value=${d.value} min=${d.min} max=${d.max}, accent=${d.accentColor}, wm=${d.writingMode}`);
  console.log(`  bbox: x=${d.r.x.toFixed(1)} y=${d.r.y.toFixed(1)} w=${d.r.w.toFixed(1)} h=${d.r.h.toFixed(1)}, cy=${d.cy}`);
  console.log(`  track row painted:`);
  if (d.trackPainted.length === 0) console.log(`    (none — outside track area or fully white)`);
  for (const r of d.trackPainted) console.log(`    y=${r.y}: ${r.p}`);
  console.log(`  thumb bbox: y=[${d.thumbTop}..${d.thumbBot}] (h=${d.thumbHeight})  x@cy=[${d.thumbLeftAtCY}..${d.thumbRightAtCY}] (w=${d.thumbWidthAtCY})`);
}

await browser.close();
