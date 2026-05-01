import { chromium } from "@playwright/test";
import fs from "node:fs";

// Probe Chromium's painted fieldset+legend interaction. For each fieldset in
// the 06-forms-style-fieldset.html fixture, capture:
//   - fieldset.getBoundingClientRect()
//   - legend.getBoundingClientRect()
//   - whether the top border is "notched" (broken) behind the legend by
//     scanning a single pixel row at the top-border centerline for the
//     border-color signature.
// Drives DM-342 (notched label position) / DM-343 (callout label / background).

const HTML_PATH = "/Users/westphal/Documents/html-test/06-forms-style-fieldset.html";
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
  const pix = (x, y) => {
    const i = (y * w + x) * 4;
    return [id[i], id[i + 1], id[i + 2], id[i + 3]];
  };
  const dist = (a, b) => Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1]), Math.abs(a[2]-b[2]));

  function classRow(elClass) {
    const el = document.querySelector("fieldset." + elClass);
    if (!el) return null;
    const fs = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const lg = el.querySelector("legend");
    const ls = lg ? lg.getBoundingClientRect() : null;
    return {
      cls: elClass,
      fs: { x: fs.x, y: fs.y, w: fs.width, h: fs.height },
      legend: ls ? { x: ls.x, y: ls.y, w: ls.width, h: ls.height, text: lg.textContent } : null,
      borderTopColor: cs.borderTopColor,
      borderTopWidth: cs.borderTopWidth,
      backgroundColor: cs.backgroundColor,
      paddingTop: cs.paddingTop,
    };
  }
  const data = ["card", "notch", "offset", "callout", "grid", "dark", "badged"].map(classRow).filter(Boolean);

  for (const d of data) {
    // Sample the row at the top border centerline (i.e., fs.y + borderTopWidth/2).
    const btw = parseFloat(d.borderTopWidth) || 0;
    const yLine = Math.round(d.fs.y + btw / 2);
    if (btw === 0) { d.topBorderRow = "(no top border)"; continue; }
    // Sample colors across the top of the fieldset
    const borderRgb = d.borderTopColor.match(/\d+/g)?.slice(0,3).map(Number) || [0,0,0];
    const samples = [];
    const x0 = Math.round(d.fs.x);
    const x1 = Math.round(d.fs.x + d.fs.w);
    let inBorder = false;
    let runs = [];
    let runStart = -1;
    for (let x = x0; x <= x1; x++) {
      const p = pix(x, yLine);
      const isBorder = dist(p, borderRgb) < 30;
      if (isBorder && !inBorder) { runStart = x; inBorder = true; }
      if (!isBorder && inBorder) { runs.push([runStart, x - 1]); inBorder = false; }
    }
    if (inBorder) runs.push([runStart, x1]);
    d.topBorderRow = { yLine, runs, borderRgb };
    // For the legend, also sample what's actually painted at legend-y center
    if (d.legend) {
      const yLg = Math.round(d.legend.y + d.legend.h / 2);
      d.legendCenterPaint = {
        atFsLeft: pix(Math.round(d.fs.x + 1), yLg),
        atLegendLeft: pix(Math.round(d.legend.x), yLg),
        atLegendCenter: pix(Math.round(d.legend.x + d.legend.w / 2), yLg),
        atLegendRight: pix(Math.round(d.legend.x + d.legend.w - 1), yLg),
        atFsRight: pix(Math.round(d.fs.x + d.fs.w - 2), yLg),
      };
    }
  }
  return data;
}, b64);

for (const d of result) {
  console.log(`\n=== fieldset.${d.cls} ===`);
  console.log(`  fs bbox: x=${d.fs.x.toFixed(1)} y=${d.fs.y.toFixed(1)} w=${d.fs.w.toFixed(1)} h=${d.fs.h.toFixed(1)}`);
  if (d.legend) console.log(`  legend bbox: x=${d.legend.x.toFixed(1)} y=${d.legend.y.toFixed(1)} w=${d.legend.w.toFixed(1)} h=${d.legend.h.toFixed(1)} text=${JSON.stringify(d.legend.text)}`);
  console.log(`  border-top: ${d.borderTopWidth} ${d.borderTopColor}`);
  console.log(`  background: ${d.backgroundColor}`);
  console.log(`  padding-top: ${d.paddingTop}`);
  if (typeof d.topBorderRow === "string") {
    console.log(`  ${d.topBorderRow}`);
  } else {
    console.log(`  top-border row y=${d.topBorderRow.yLine} (color ${d.topBorderRow.borderRgb.join(",")}):`);
    for (const [a,b] of d.topBorderRow.runs) console.log(`    border run x=[${a}..${b}]  width=${b-a+1}`);
    if (d.topBorderRow.runs.length === 1) console.log(`    (single continuous run — no notch)`);
    else if (d.topBorderRow.runs.length === 2) console.log(`    NOTCH: gap x=[${d.topBorderRow.runs[0][1]+1}..${d.topBorderRow.runs[1][0]-1}] width=${d.topBorderRow.runs[1][0] - d.topBorderRow.runs[0][1] - 1}`);
  }
  if (d.legendCenterPaint) {
    console.log(`  legend-row paint: fs.left=${d.legendCenterPaint.atFsLeft.slice(0,3).join(",")} lg.left=${d.legendCenterPaint.atLegendLeft.slice(0,3).join(",")} lg.center=${d.legendCenterPaint.atLegendCenter.slice(0,3).join(",")} lg.right=${d.legendCenterPaint.atLegendRight.slice(0,3).join(",")} fs.right=${d.legendCenterPaint.atFsRight.slice(0,3).join(",")}`);
  }
}

await browser.close();
