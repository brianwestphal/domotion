// End-to-end validation: render the F900 + 2F800 blocks through OUR pipeline
// (paths mode, same as the unicode suite) and Chrome directly, then classify
// each glyph cell tofu-vs-real and report cell-by-cell agreement with Chrome.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { captureElementTree, elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { setRenderTextMode } from "../src/render/text-to-path.js";

const COLS = 16, CELL = 56, FONT = 36;

function blockHtml(cps) {
  const rows = Math.ceil(cps.length / COLS);
  const cells = cps
    .map((cp) => `<div style="width:${CELL}px;height:${CELL}px;display:flex;align-items:center;justify-content:center;font:${FONT}px serif;color:#000">${`&#x${cp.toString(16)};`}</div>`)
    .join("");
  const W = COLS * CELL, H = rows * CELL;
  return {
    W, H, rows,
    html: `<!doctype html><meta charset=utf-8><body style="margin:0;background:#fff"><div style="display:flex;flex-wrap:wrap;width:${W}px">${cells}</div></body>`,
  };
}

// Classify each cell crop: ink count + coarse 4x4 hash. Tofu cells collapse to
// one identical (ink,hash); real glyphs are mostly distinct.
async function classifyCells(pngBuf, rows) {
  const img = sharp(pngBuf);
  const { width } = await img.metadata();
  const raw = await img.greyscale().raw().toBuffer({ resolveWithObject: true });
  const data = raw.data, w = raw.info.width;
  const sigs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      const x0 = c * CELL, y0 = r * CELL;
      let ink = 0;
      const grid = new Array(16).fill(0);
      for (let y = 2; y < CELL - 2; y++) {
        for (let x = 2; x < CELL - 2; x++) {
          const v = data[(y0 + y) * w + (x0 + x)];
          if (v < 128) {
            ink++;
            const gx = Math.min(3, Math.floor((x / CELL) * 4));
            const gy = Math.min(3, Math.floor((y / CELL) * 4));
            grid[gy * 4 + gx]++;
          }
        }
      }
      // Quantize the 16-cell density grid into a stable hash.
      const hash = grid.map((n) => Math.min(9, Math.floor(n / 30))).join("");
      sigs.push({ ink, hash, blank: ink < 8 });
    }
  }
  return sigs;
}

function report(label, sigs, total) {
  const byKey = new Map();
  for (const s of sigs.slice(0, total)) {
    const k = `${Math.round(s.ink / 25)}:${s.hash}`;
    byKey.set(k, (byKey.get(k) || 0) + 1);
  }
  const clusters = [...byKey.values()].sort((a, b) => b - a);
  const blank = sigs.slice(0, total).filter((s) => s.blank).length;
  return { distinct: byKey.size, largest: clusters[0] ?? 0, blank, total };
}

const browser = await chromium.launch();

async function runBlock(name, cps) {
  const { W, H, rows, html } = blockHtml(cps);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  // --- Chrome expected ---
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const expected = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });

  // --- Our pipeline (paths mode) ---
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
  setRenderTextMode("paths");
  const inner = elementTreeToSvgInner(tree, W, H);
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${inner}</svg>`;
  writeFileSync(`/tmp/claude/our-${name}.svg`, svg);
  await page.setContent(`<!doctype html><body style="margin:0"><img src="file:///tmp/claude/our-${name}.svg" width="${W}" height="${H}"></body>`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const actual = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });

  const eSig = await classifyCells(expected, rows);
  const aSig = await classifyCells(actual, rows);

  const eRep = report(`${name} chrome`, eSig, cps.length);
  const aRep = report(`${name} ours`, aSig, cps.length);

  // Cell-by-cell agreement: is OUR cell blank exactly where Chrome's is blank?
  let agreeBlank = 0, ourReal_chromeTofu = 0, ourTofu_chromeReal = 0, bothReal = 0, bothTofu = 0;
  for (let i = 0; i < cps.length; i++) {
    const eT = eSig[i].blank, aT = aSig[i].blank;
    if (eT && aT) { bothTofu++; agreeBlank++; }
    else if (!eT && !aT) { bothReal++; agreeBlank++; }
    else if (!aT && eT) ourReal_chromeTofu++;   // OVER-render
    else ourTofu_chromeReal++;                    // under-render
  }

  console.log(`\n=== ${name} (${cps.length} codepoints) ===`);
  console.log(`Chrome : distinct=${eRep.distinct}  largestCluster=${eRep.largest}  blankCells=${eRep.blank}`);
  console.log(`Ours   : distinct=${aRep.distinct}  largestCluster=${aRep.largest}  blankCells=${aRep.blank}`);
  console.log(`Agreement: bothReal=${bothReal}  bothTofu=${bothTofu}  agree=${agreeBlank}/${cps.length}`);
  console.log(`  OVER-render (ours real, Chrome tofu): ${ourReal_chromeTofu}`);
  console.log(`  under-render (ours tofu, Chrome real): ${ourTofu_chromeReal}`);

  await ctx.close();
  return { name, ourReal_chromeTofu, ourTofu_chromeReal, total: cps.length };
}

const f900 = []; for (let cp = 0xF900; cp <= 0xFAD9; cp++) f900.push(cp);
const astral = []; for (let cp = 0x2F800; cp <= 0x2FA1D; cp++) astral.push(cp);

const r1 = await runBlock("f900", f900);
const r2 = await runBlock("2f800", astral);

await browser.close();

console.log("\n=== SUMMARY ===");
for (const r of [r1, r2]) {
  console.log(`${r.name}: over-render=${r.ourReal_chromeTofu}/${r.total}, under-render=${r.ourTofu_chromeReal}/${r.total}`);
}
