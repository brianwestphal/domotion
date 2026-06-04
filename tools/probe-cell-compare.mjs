// Precise over/under-render count: compare the harness's TRUSTED expected.png
// (Chrome) and actual.png (our SVG, rasterized by the harness) at the exact
// glyph-cell rects. Classifies each cell tofu-vs-real per image.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const FIXTURE = process.argv[2];
const EXP = process.argv[3];
const ACT = process.argv[4];
const W = 1024, H = 1400;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
await page.setContent(readFileSync(FIXTURE, "utf-8"), { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const cells = await page.evaluate(() =>
  [...document.querySelectorAll("x > g")].map((g) => {
    const r = g.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter((r) => r.w > 0 && r.h > 0)
);
await browser.close();

async function gray(p) {
  const r = await sharp(readFileSync(p)).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { d: r.data, w: r.info.width, h: r.info.height };
}
function sig(g, rc) {
  let ink = 0; const grid = new Array(16).fill(0);
  for (let y = 2; y < rc.h - 2; y++) for (let x = 2; x < rc.w - 2; x++) {
    const px = rc.x + x, py = rc.y + y;
    if (px < 0 || py < 0 || px >= g.w || py >= g.h) continue;
    if (g.d[py * g.w + px] < 128) { ink++; grid[Math.min(3, (y / rc.h * 4) | 0) * 4 + Math.min(3, (x / rc.w * 4) | 0)]++; }
  }
  return { ink, hash: grid.map((n) => Math.min(9, (n / 18) | 0)).join("") };
}
function tofuSet(sigs) {
  const m = new Map();
  for (let i = 0; i < sigs.length; i++) { const k = `${Math.round(sigs[i].ink / 20)}:${sigs[i].hash}`; if (!m.has(k)) m.set(k, []); m.get(k).push(i); }
  let best = [];
  for (const v of m.values()) if (v.length > best.length) best = v;
  // Only treat as a tofu cluster if it's a meaningful repeat (>=8 identical cells).
  return best.length >= 8 ? new Set(best) : new Set();
}

const eg = await gray(EXP), ag = await gray(ACT);
const eS = cells.map((c) => sig(eg, c)), aS = cells.map((c) => sig(ag, c));
const eT = tofuSet(eS), aT = tofuSet(aS);

let bothReal = 0, bothTofu = 0, over = 0, under = 0;
const overCells = [];
for (let i = 0; i < cells.length; i++) {
  const e = eT.has(i), a = aT.has(i);
  if (!e && !a) bothReal++;
  else if (e && a) bothTofu++;
  else if (e && !a) { over++; overCells.push(i); }   // Chrome tofu, ours real => OVER
  else under++;                                       // Chrome real, ours tofu => UNDER
}
console.log(`${FIXTURE.split("/").pop()}: cells=${cells.length} Chrome-tofu=${eT.size} ours-tofu=${aT.size}`);
console.log(`  bothReal=${bothReal} bothTofu=${bothTofu} OVER(ours-real/chrome-tofu)=${over} UNDER(ours-tofu/chrome-real)=${under}`);
if (overCells.length) console.log(`  over-cells idx: ${overCells.slice(0, 20).join(",")}`);
