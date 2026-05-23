// Probe Chrome's actual wavy-underline geometry at multiple font sizes by
// rendering a known string with `text-decoration: underline wavy`, taking a
// high-DPR screenshot of the underline region, and analysing the dark
// pixels to back out wave centre-y, amplitude, and wavelength.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const SIZES = [12, 16, 24, 36];
const DPR = 2; // higher resolution → tighter wave-position estimates
const TEXT = 'wwwwwwwwwwwwwwwwwwww'; // ascender-only for clean baseline
const HTML = `<!doctype html><meta charset="utf-8"><style>
body { margin: 24px; font-family: sans-serif; background: white; color: black; }
.row { margin: 24px 0; }
.label { font-size: 12px; color: #888; }
.sample { text-decoration: underline wavy red; text-decoration-thickness: 2px; }
</style>
${SIZES.map((s) => `<div class="row"><div class="label">${s}px / 2px thickness</div><div class="sample" style="font-size:${s}px;line-height:${s * 2}px;">${TEXT}</div></div>`).join('\n')}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 800, height: 1000 }, deviceScaleFactor: DPR });
const page = await ctx.newPage();
await page.setContent(HTML);
await page.waitForLoadState('networkidle');

const samples = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.sample')) {
    const r = el.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(el).fontSize);
    // The wavy paint sits below the baseline. Capture a band from element top
    // down to ~1.5em — covers the wave's max extent.
    out.push({
      fontSize: fs,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      probeBand: { x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.width), h: Math.ceil(r.height + fs * 0.5) },
    });
  }
  return out;
});

for (const s of samples) {
  const buf = await page.screenshot({ clip: { x: s.probeBand.x, y: s.probeBand.y, width: s.probeBand.w, height: s.probeBand.h }, omitBackground: false });
  const png = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width: pxW, height: pxH, channels } = png.info;
  const data = png.data;
  // Find RED pixels (the wavy underline colour is rgb(255, 0, 0)).
  // Map: for each x column, find the topmost and bottommost red-ish y.
  const tops = new Array(pxW).fill(-1);
  const bots = new Array(pxW).fill(-1);
  for (let y = 0; y < pxH; y++) {
    for (let x = 0; x < pxW; x++) {
      const i = (y * pxW + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 180 && g < 80 && b < 80) {
        if (tops[x] < 0) tops[x] = y;
        bots[x] = y;
      }
    }
  }
  // Wave centre at each x = midpoint of top+bot. Amplitude in px = (bot-top)/2.
  let yCenterSum = 0, ampSum = 0, n = 0;
  for (let x = 0; x < pxW; x++) {
    if (tops[x] < 0) continue;
    yCenterSum += (tops[x] + bots[x]) / 2;
    ampSum += (bots[x] - tops[x]) / 2;
    n++;
  }
  const yCenterAvg = n ? yCenterSum / n / DPR : 0;
  const ampAvg = n ? ampSum / n / DPR : 0;
  // Wavelength: detect peaks (local minima in tops[]) and measure spacing.
  const peakXs = [];
  for (let x = 2; x < pxW - 2; x++) {
    if (tops[x] < 0 || tops[x - 1] < 0 || tops[x + 1] < 0) continue;
    if (tops[x] <= tops[x - 1] && tops[x] <= tops[x + 1] && tops[x] < tops[x - 2] + 1 && tops[x] < tops[x + 2] + 1) {
      peakXs.push(x);
    }
  }
  const wavelengthPx = peakXs.length > 1 ? (peakXs[peakXs.length - 1] - peakXs[0]) / (peakXs.length - 1) / DPR : 0;
  // Wave center y RELATIVE to element top.
  const yCenterRel = yCenterAvg - (s.rect.y - s.probeBand.y);
  // Underline auto position is at baseline + underline-offset; baseline ≈ ascent ≈ 0.8 * fontSize.
  const ascentApprox = 0.8 * s.fontSize;
  const yCenterBelowBaseline = yCenterRel - ascentApprox;
  console.log(JSON.stringify({
    fontSize: s.fontSize,
    yCenterRel: yCenterRel.toFixed(3),
    yCenterBelowBaseline: yCenterBelowBaseline.toFixed(3),
    amplitude: ampAvg.toFixed(3),
    wavelength: wavelengthPx.toFixed(3),
    peakCount: peakXs.length,
  }));
  writeFileSync(`/tmp/claude/wavy-${s.fontSize}.png`, buf);
}

await browser.close();
