// Correct validation: render the ACTUAL fixture (with its real font-family
// stack) through Chrome (expected) and our pipeline (actual), then classify
// each glyph cell tofu-vs-real at the exact <g> rects and measure agreement.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { captureElementTree, elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { setRenderTextMode } from "../src/render/text-to-path.js";

const FIXTURE = process.argv[2] ?? "../html-test/unicode/2F800-2FA1F-cjk-compatibility-ideographs-supplement.0.html";
const W = 1024, H = 1400;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(readFileSync(FIXTURE, "utf-8"), { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);

// Exact glyph-cell rects (the <g> inside each <x>).
const rects = await page.evaluate(() => {
  const out = [];
  for (const g of document.querySelectorAll("x > g")) {
    const r = g.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
});

const expected = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });

// Our pipeline (paths mode, like the suite).
const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
setRenderTextMode("paths");
const inner = elementTreeToSvgInner(tree, W, H);
const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${inner}</svg>`;
writeFileSync("/tmp/claude/fx.svg", svg);
await page.setContent(`<!doctype html><body style="margin:0"><img src="file:///tmp/claude/fx.svg" width="${W}" height="${H}"></body>`, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
const actual = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
await browser.close();

async function gray(buf) {
  const r = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { d: r.data, w: r.info.width };
}
// Per-cell signature: ink + 4x4 density grid hash. Tofu cells share one sig.
function cellSig(g, rc) {
  let ink = 0; const grid = new Array(16).fill(0);
  for (let y = 2; y < rc.h - 2; y++) for (let x = 2; x < rc.w - 2; x++) {
    const px = rc.x + x, py = rc.y + y;
    if (px < 0 || py < 0 || px >= g.w) continue;
    if (g.d[py * g.w + px] < 128) {
      ink++;
      grid[Math.min(3, (y / rc.h * 4) | 0) * 4 + Math.min(3, (x / rc.w * 4) | 0)]++;
    }
  }
  return { ink, hash: grid.map((n) => Math.min(9, (n / 18) | 0)).join("") };
}

const eg = await gray(expected), ag = await gray(actual);
const eSigs = rects.map((r) => cellSig(eg, r));
const aSigs = rects.map((r) => cellSig(ag, r));

// Tofu = membership in the dominant repeated signature (separately per image).
function tofuSet(sigs) {
  const m = new Map();
  for (let i = 0; i < sigs.length; i++) { const k = `${Math.round(sigs[i].ink / 20)}:${sigs[i].hash}`; (m.get(k) ?? m.set(k, []).get(k)).push(i); }
  let best = []; for (const v of m.values()) if (v.length > best.length) best = v;
  return new Set(best);
}
const eTofu = tofuSet(eSigs), aTofu = tofuSet(aSigs);

let bothReal = 0, bothTofu = 0, over = 0, under = 0;
for (let i = 0; i < rects.length; i++) {
  const e = eTofu.has(i), a = aTofu.has(i);
  if (!e && !a) bothReal++;
  else if (e && a) bothTofu++;
  else if (e && !a) over++;   // Chrome tofu, ours real => OVER-render
  else under++;               // Chrome real, ours tofu => UNDER-render
}
console.log(`${FIXTURE.split("/").pop()}`);
console.log(`  cells=${rects.length}  Chrome-tofu=${eTofu.size}  ours-tofu=${aTofu.size}`);
console.log(`  bothReal=${bothReal} bothTofu=${bothTofu} OVER(ours-real/chrome-tofu)=${over} UNDER(ours-tofu/chrome-real)=${under}`);
console.log(`  agreement=${((100 * (bothReal + bothTofu)) / rects.length).toFixed(1)}%`);
