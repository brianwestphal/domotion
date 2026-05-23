import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
const SIZES = [12, 16, 24, 36];
const TEXT = 'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmm';
let html = '<!doctype html><meta charset="utf-8"><style>body{margin:24px;font-family:system-ui,sans-serif;background:white;color:black;line-height:1.8;}.sample{text-decoration:underline wavy red;text-decoration-thickness:2px;}</style>';
for (const s of SIZES) html += `<div><span class="sample" style="font-size:${s}px;">${TEXT}</span></div>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.setContent(html);
await page.waitForLoadState('networkidle');
const samples = await page.evaluate(() => Array.from(document.querySelectorAll('.sample')).map(el => {
  const r = el.getBoundingClientRect();
  return { fontSize: parseFloat(getComputedStyle(el).fontSize), rect: { x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.width), h: Math.ceil(r.height + parseFloat(getComputedStyle(el).fontSize)) } };
}));
const DPR = 2;
for (const s of samples) {
  const buf = await page.screenshot({ clip: { x: s.rect.x, y: s.rect.y, width: s.rect.w, height: s.rect.h } });
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  // Find bottom of black ink (= baseline for descender-less text 'm').
  // Scan from bottom up — first row with black pixels is the baseline.
  let blackBottomY = -1;
  for (let y = H - 1; y >= 0; y--) {
    let blackCount = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) blackCount++;
    }
    if (blackCount > W / 4) { blackBottomY = y; break; }
  }
  // Find red wave centerline.
  const centers = [];
  for (let x = 0; x < W; x++) {
    let topY = -1, botY = -1;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * ch;
      if (data[i] > 200 && data[i + 1] < 50 && data[i + 2] < 50) {
        if (topY < 0) topY = y;
        botY = y;
      }
    }
    if (topY >= 0) centers.push((topY + botY) / 2);
  }
  if (centers.length < 50 || blackBottomY < 0) { console.log(JSON.stringify({ fontSize: s.fontSize, error: "skip" })); continue; }
  const inner = centers.slice(10, centers.length - 10);
  const meanY = inner.reduce((a, b) => a + b, 0) / inner.length;
  const ampPx = (Math.max(...inner) - Math.min(...inner)) / 2 / DPR;
  // yCenter relative to baseline (= blackBottomY).
  const yCenterBelowBaseline = (meanY - blackBottomY) / DPR;
  console.log(JSON.stringify({
    fontSize: s.fontSize,
    baselineY: blackBottomY,
    meanY: meanY.toFixed(2),
    yCenterBelowBaseline: yCenterBelowBaseline.toFixed(2),
    amplitude: ampPx.toFixed(3),
  }));
  writeFileSync(`/tmp/claude/wavy4-${s.fontSize}.png`, buf);
}
await browser.close();
