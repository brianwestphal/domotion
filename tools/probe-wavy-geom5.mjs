import { chromium } from '@playwright/test';
import sharp from 'sharp';
const SIZES = [12, 16, 24, 36];
const THICKS = [1, 2, 3, 4, 6];
const TEXT = 'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm';
let html = '<!doctype html><meta charset="utf-8"><style>body{margin:24px;font-family:system-ui,sans-serif;background:white;color:black;line-height:2;}.sample{text-decoration:underline wavy red;}</style>';
for (const fs of SIZES) for (const tc of THICKS) html += `<div><span class="sample" style="font-size:${fs}px;text-decoration-thickness:${tc}px;">${TEXT}</span></div>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1800, height: 1400 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.setContent(html);
await page.waitForLoadState('networkidle');
const samples = await page.evaluate(() => Array.from(document.querySelectorAll('.sample')).map(el => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { fontSize: parseFloat(cs.fontSize), thickness: parseFloat(cs.textDecorationThickness), rect: { x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.width), h: Math.ceil(r.height + parseFloat(cs.fontSize)) } };
}));
const DPR = 2;
const results = [];
for (const s of samples) {
  const buf = await page.screenshot({ clip: { x: s.rect.x, y: s.rect.y, width: s.rect.w, height: s.rect.h } });
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  let blackBottomY = -1;
  for (let y = H - 1; y >= 0; y--) {
    let bc = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) bc++;
    }
    if (bc > W / 4) { blackBottomY = y; break; }
  }
  const centers = [];
  for (let x = 0; x < W; x++) {
    let topY = -1, botY = -1;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * ch;
      if (data[i] > 200 && data[i + 1] < 50 && data[i + 2] < 50) { if (topY < 0) topY = y; botY = y; }
    }
    if (topY >= 0) centers.push((topY + botY) / 2);
  }
  if (centers.length < 50 || blackBottomY < 0) continue;
  const inner = centers.slice(10, centers.length - 10);
  const meanY = inner.reduce((a, b) => a + b, 0) / inner.length;
  const ampPx = (Math.max(...inner) - Math.min(...inner)) / 2 / DPR;
  const yCenterBelowBaseline = (meanY - blackBottomY) / DPR;
  results.push({ fs: s.fontSize, t: s.thickness, yC: +yCenterBelowBaseline.toFixed(2), amp: +ampPx.toFixed(2) });
}
for (const r of results) console.log(`fs=${String(r.fs).padStart(2)} t=${r.t} → yCenter=${r.yC.toFixed(2)}  amp=${r.amp.toFixed(2)}`);
await browser.close();
