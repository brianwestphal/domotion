import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const SIZES = [12, 16, 24, 36];
const THICKS = [1, 2, 4];
const DPR = 2;
const TEXT = 'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmm';
let html = '<!doctype html><meta charset="utf-8"><style>body{margin:24px;font-family:sans-serif;background:white;color:black;}.row{margin:18px 0;}.label{font-size:11px;color:#888;}.sample{text-decoration:underline wavy red;line-height:2em;}</style>';
for (const s of SIZES) for (const t of THICKS) {
  html += `<div class="row"><div class="label">fs=${s} thick=${t}</div><div class="sample" style="font-size:${s}px;text-decoration-thickness:${t}px;">${TEXT}</div></div>`;
}
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: DPR });
const page = await ctx.newPage();
await page.setContent(html);
await page.waitForLoadState('networkidle');
const samples = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('.sample')).map(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { fontSize: parseFloat(cs.fontSize), thickness: parseFloat(cs.textDecorationThickness) || 1, rect: { x: r.x, y: r.y, w: r.width, h: r.height + parseFloat(cs.fontSize) * 0.6 } };
  });
});
for (const s of samples) {
  const buf = await page.screenshot({ clip: { x: Math.floor(s.rect.x), y: Math.floor(s.rect.y), width: Math.ceil(s.rect.w), height: Math.ceil(s.rect.h) }, omitBackground: false });
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  // Find red wave-center as the AVERAGE y of red pixels at each x.
  const centerY = new Array(W).fill(null);
  const redCounts = new Array(W).fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 200 && g < 50 && b < 50) {
        centerY[x] = (centerY[x] == null ? 0 : centerY[x]) + y;
        redCounts[x]++;
      }
    }
  }
  // Average y per x (= the stroke's vertical center at that x)
  const vals = [];
  const xs = [];
  for (let x = 0; x < W; x++) {
    if (centerY[x] != null && redCounts[x] > 0) {
      vals.push(centerY[x] / redCounts[x]);
      xs.push(x);
    }
  }
  if (vals.length < 50) { console.log(JSON.stringify({ fontSize: s.fontSize, thickness: s.thickness, error: "too-few-red-pixels" })); continue; }
  // Smooth amplitude/center estimates by trimming the ends.
  const trim = Math.floor(vals.length * 0.05);
  const core = vals.slice(trim, vals.length - trim);
  const meanY = core.reduce((a, b) => a + b, 0) / core.length;
  // Amplitude: half (max - min) of the smoothed centerline.
  const maxY = Math.max(...core), minY = Math.min(...core);
  const ampPx = (maxY - minY) / 2 / DPR;
  // Wavelength via zero-crossing detection: count how many times the signal
  // crosses meanY going UPWARD; period = total_x / (upward_crossings).
  let upCrosses = 0;
  let firstUp = -1, lastUp = -1;
  for (let i = 1; i < core.length; i++) {
    if (core[i - 1] >= meanY && core[i] < meanY) {
      upCrosses++;
      if (firstUp < 0) firstUp = i;
      lastUp = i;
    }
  }
  const wavelengthPx = (upCrosses >= 2 && lastUp > firstUp) ? (lastUp - firstUp) / (upCrosses - 1) / DPR : 0;
  // meanY relative to element top
  const meanYRel = meanY / DPR - (s.rect.y - Math.floor(s.rect.y));
  // We need centerY position relative to baseline. Baseline ≈ 0.8 * fontSize.
  const baselineY = 0.8 * s.fontSize;
  const yCenterBelowBaseline = meanYRel - baselineY;
  console.log(JSON.stringify({
    fontSize: s.fontSize,
    thickness: s.thickness,
    yCenterBelowBaseline: yCenterBelowBaseline.toFixed(3),
    amplitude: ampPx.toFixed(3),
    wavelength: wavelengthPx.toFixed(3),
    crosses: upCrosses,
  }));
  writeFileSync(`/tmp/claude/wavy2-fs${s.fontSize}-t${s.thickness}.png`, buf);
}
await browser.close();
