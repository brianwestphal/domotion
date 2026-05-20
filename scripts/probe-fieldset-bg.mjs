import { chromium } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

// Find the actual top y where each fieldset's background fill begins. For
// card / dark / callout (the ones with a non-transparent background), scan
// rows starting at fs.y - 5 and find the first row where the fieldset's
// bg-color is visible at the fieldset's center column.

const HTML_PATH = path.resolve("external/html-test", "06-forms-style-fieldset.html");
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

  const data = [];
  for (const cls of ["card", "callout", "dark"]) {
    const el = document.querySelector("fieldset." + cls);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const lg = el.querySelector("legend");
    const lr = lg ? lg.getBoundingClientRect() : null;
    const cs = window.getComputedStyle(el);
    const bg = cs.backgroundColor.match(/\d+/g)?.slice(0,3).map(Number) || [255,255,255];
    // sample center-x column, scan from fs.y - 5 to fs.y + 30
    const cxx = Math.round(r.x + r.width / 2);
    const samples = [];
    for (let y = Math.floor(r.y) - 5; y <= Math.floor(r.y) + 30; y++) {
      const p = pix(cxx, y);
      const matchesBg = dist(p, bg) < 12;
      samples.push({ y, p: p.join(","), matchesBg });
    }
    // also bottom edge: fs.y + fs.h - 5 to fs.y + fs.h + 5
    const samplesBot = [];
    for (let y = Math.floor(r.y + r.height) - 5; y <= Math.floor(r.y + r.height) + 5; y++) {
      const p = pix(cxx, y);
      const matchesBg = dist(p, bg) < 12;
      samplesBot.push({ y, p: p.join(","), matchesBg });
    }
    data.push({ cls, fsY: r.y, fsH: r.height, lgY: lr?.y, lgH: lr?.h, lgYC: lr ? lr.y + lr.height/2 : null, bg: bg.join(","), samples, samplesBot });
  }
  return data;
}, b64);

for (const d of result) {
  console.log(`\n=== fieldset.${d.cls} ===`);
  console.log(`  fs.y=${d.fsY?.toFixed(1)} fs.h=${d.fsH?.toFixed(1)} legend.y=${d.lgY?.toFixed(1)} legend.h=${d.lgH?.toFixed(1)} legend.yCenter=${d.lgYC?.toFixed(1)}`);
  console.log(`  bg target: ${d.bg}`);
  console.log(`  top column samples:`);
  for (const s of d.samples) console.log(`    y=${s.y}: ${s.p} ${s.matchesBg ? "  <- matches bg" : ""}`);
  console.log(`  bottom column samples:`);
  for (const s of d.samplesBot) console.log(`    y=${s.y}: ${s.p} ${s.matchesBg ? "  <- matches bg" : ""}`);
}

await browser.close();
