import { chromium } from '@playwright/test';
import sharp from 'sharp';

// Probe Chrome's wavy-underline wavelength at the fixture font sizes / thicknesses.
const SAMPLES = [
  { fontSize: 16, thickness: 2 },   // fixture .wavy
  { fontSize: 16, thickness: 4 },   // fixture .wavy-thick (uses default thickness override -> 4)
  { fontSize: 18, thickness: 2 },
  { fontSize: 22, thickness: 2 },
  { fontSize: 32, thickness: 2 },
];
let html = '<!doctype html><meta charset="utf-8"><style>body{margin:24px;font-family:system-ui,sans-serif;background:white;color:black;line-height:2;}.s{text-decoration:underline wavy red;}</style>';
for (const s of SAMPLES) html += `<div><span class="s" style="font-size:${s.fontSize}px;text-decoration-thickness:${s.thickness}px;">mmmmmmmmmmmmmmmmmmmmmmmmmmmmmm</span></div>`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.setContent(html);
await page.waitForLoadState('networkidle');
const samples = await page.evaluate(() => Array.from(document.querySelectorAll('.s')).map(el => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { fontSize: parseFloat(cs.fontSize), thickness: parseFloat(cs.textDecorationThickness), rect: { x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.width), h: Math.ceil(r.height + parseFloat(cs.fontSize)) } };
}));
const DPR = 2;
for (const s of samples) {
  const buf = await page.screenshot({ clip: { x: s.rect.x, y: s.rect.y, width: s.rect.w, height: s.rect.h } });
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  // Find the wavy underline by detecting red pixels
  const centersByX = new Map();
  for (let x = 0; x < W; x++) {
    let topY = -1, botY = -1;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * ch;
      if (data[i] > 200 && data[i + 1] < 50 && data[i + 2] < 50) { if (topY < 0) topY = y; botY = y; }
    }
    if (topY >= 0) centersByX.set(x, (topY + botY) / 2);
  }
  // Find peaks and troughs to estimate wavelength
  const xs = [...centersByX.keys()].sort((a, b) => a - b);
  const ys = xs.map(x => centersByX.get(x));
  if (ys.length < 20) continue;
  // Find local minima (peaks - lowest y) over a window of 3
  const peaks = [];
  for (let i = 2; i < ys.length - 2; i++) {
    if (ys[i] < ys[i-1] && ys[i] < ys[i-2] && ys[i] <= ys[i+1] && ys[i] <= ys[i+2]) peaks.push(xs[i]);
  }
  const periods = [];
  for (let i = 1; i < peaks.length; i++) periods.push(peaks[i] - peaks[i-1]);
  const avgPeriod = periods.reduce((a, b) => a + b, 0) / periods.length;
  const wavelengthCssPx = avgPeriod / DPR;
  // Amplitude
  const ampPx = (Math.max(...ys) - Math.min(...ys)) / 2 / DPR;
  console.log(`fs=${s.fontSize} t=${s.thickness} → wavelength=${wavelengthCssPx.toFixed(2)} amp=${ampPx.toFixed(2)}`);
}
await browser.close();
