import { chromium } from "@playwright/test";
import fs from "node:fs";

// For each fieldset, scan ALL y rows from fs.y to fs.y + 30 looking for the
// row(s) painted in border-top-color. Identifies the actual top-border y
// position vs fs.y (Chrome may paint the top border AT legend-center, not
// at the box top).

const HTML_PATH = "/Users/westphal/Documents/html-test/06-forms-style-fieldset.html";
const html = fs.readFileSync(HTML_PATH, "utf8");
const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1024, height: 1500 } });
const page = await ctx.newPage();
await page.setContent(html);
const buf = await page.screenshot({ fullPage: false, clip: { x: 0, y: 0, width: 1024, height: 1500 } });
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

  function rowHasBorderColor(y, x0, x1, target) {
    let count = 0;
    let runs = []; let inRun = false; let s = -1;
    for (let x = x0; x <= x1; x++) {
      const p = pix(x, y);
      const isB = dist(p, target) < 12;
      if (isB) count++;
      if (isB && !inRun) { s = x; inRun = true; }
      if (!isB && inRun) { runs.push([s, x-1]); inRun = false; }
    }
    if (inRun) runs.push([s, x1]);
    return { count, runs };
  }

  const data = [];
  for (const cls of ["card", "notch", "offset", "grid", "dark", "badged"]) {
    const el = document.querySelector("fieldset." + cls);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const lg = el.querySelector("legend");
    const lr = lg ? lg.getBoundingClientRect() : null;
    const cs = window.getComputedStyle(el);
    const target = cs.borderTopColor.match(/\d+/g)?.slice(0,3).map(Number) || [0,0,0];
    const btw = parseFloat(cs.borderTopWidth) || 0;
    const x0 = Math.round(r.x + 5), x1 = Math.round(r.x + r.width - 5);
    // scan y
    const scan = [];
    for (let y = Math.floor(r.y) - 2; y <= Math.floor(r.y) + 30; y++) {
      const { count, runs } = rowHasBorderColor(y, x0, x1, target);
      if (count > 30) scan.push({ y, count, runs });
    }
    data.push({ cls, r: { x: r.x, y: r.y, w: r.width, h: r.height }, lr: lr ? { x: lr.x, y: lr.y, w: lr.width, h: lr.height } : null, btw, target, scan });
  }
  return data;
}, b64);

for (const d of result) {
  console.log(`\n=== fieldset.${d.cls} ===`);
  console.log(`  fs y=${d.r.y.toFixed(1)}, h=${d.r.h.toFixed(1)} legend y=${d.lr ? d.lr.y.toFixed(1) : "n/a"} h=${d.lr ? d.lr.h.toFixed(1) : "n/a"} legend-center=${(d.lr ? (d.lr.y + d.lr.h/2).toFixed(1) : "n/a")}`);
  console.log(`  border-top: ${d.btw}px target=${d.target.join(",")}`);
  console.log(`  rows with border-color paint:`);
  for (const s of d.scan) {
    let runStr = s.runs.slice(0, 3).map(([a,b]) => `[${a}..${b}](w=${b-a+1})`).join(" ");
    if (s.runs.length > 3) runStr += ` ... +${s.runs.length-3} more`;
    console.log(`    y=${s.y} (count=${s.count}): runs=${s.runs.length} ${runStr}`);
  }
}

await browser.close();
