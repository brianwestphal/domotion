import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const SIZES = [12, 16, 24, 36];
const TEXT = 'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmm';
// Match the 20-deep-wavy-underline-descenders fixture exactly: body line-height: 1.8.
let html = '<!doctype html><meta charset="utf-8"><style>body{margin:24px;font-family:system-ui,sans-serif;background:white;color:black;line-height:1.8;}.sample{text-decoration:underline wavy red;text-decoration-thickness:2px;}</style>';
for (const s of SIZES) html += `<div><span class="sample" style="font-size:${s}px;">${TEXT}</span></div>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.setContent(html);
await page.waitForLoadState('networkidle');
const samples = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('.sample')).map(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // Use a Range on the text node to get the precise INK bounding box (incl. baseline approximation).
    const range = document.createRange();
    range.selectNodeContents(el);
    const rr = range.getBoundingClientRect();
    return { fontSize: parseFloat(cs.fontSize), rect: { x: r.x, y: r.y, w: r.width, h: r.height + parseFloat(cs.fontSize) * 0.7 }, inkRect: { x: rr.x, y: rr.y, w: rr.width, h: rr.height } };
  });
});
const DPR = 2;
for (const s of samples) {
  const buf = await page.screenshot({ clip: { x: Math.floor(s.rect.x), y: Math.floor(s.rect.y), width: Math.ceil(s.rect.w), height: Math.ceil(s.rect.h) }, omitBackground: false });
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  const redYs = [];
  for (let x = 0; x < W; x++) {
    const ys = [];
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * ch;
      if (data[i] > 200 && data[i + 1] < 50 && data[i + 2] < 50) ys.push(y);
    }
    if (ys.length > 0) {
      const top = ys[0], bot = ys[ys.length - 1];
      redYs.push({ x, top, bot, center: (top + bot) / 2 });
    }
  }
  if (redYs.length < 50) { console.log(JSON.stringify({ fontSize: s.fontSize, error: "too-few-red-pixels" })); continue; }
  const centers = redYs.slice(10, redYs.length - 10).map(r => r.center);
  const meanY = centers.reduce((a, b) => a + b, 0) / centers.length;
  const maxY = Math.max(...centers), minY = Math.min(...centers);
  const ampPx = (maxY - minY) / 2 / DPR;
  const meanYAbs = meanY / DPR + Math.floor(s.rect.y); // page-absolute
  const inkBaselineApprox = s.inkRect.y + s.inkRect.h; // bottom of ink ≈ descender bottom
  // For text with no descenders ('mmm...'), inkRect.h ≈ x-height + ascent.
  // Chrome baseline ≈ ink_top + ascent. For most fonts ascent ≈ 0.8 * fontSize.
  const baselineApprox = s.inkRect.y + 0.8 * s.fontSize;
  const yCenterBelowBaseline = meanYAbs - baselineApprox;
  console.log(JSON.stringify({
    fontSize: s.fontSize,
    inkRect: s.inkRect,
    meanYAbs: meanYAbs.toFixed(2),
    baselineApprox: baselineApprox.toFixed(2),
    yCenterBelowBaseline: yCenterBelowBaseline.toFixed(2),
    yCenterBelowBaselinePerFs: (yCenterBelowBaseline / s.fontSize).toFixed(3),
    amplitude: ampPx.toFixed(3),
  }));
  writeFileSync(`/tmp/claude/wavy3-${s.fontSize}.png`, buf);
}
await browser.close();
