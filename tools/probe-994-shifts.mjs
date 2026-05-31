// For each drop-cap in 24-deep, characterise: Range.top, expected ink top
// (from pixel walk of expected.png), and derive the consistent shift formula.

import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");

const data = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll("p:first-of-type").forEach((p) => {
    const parent = p.closest("[class*='drop-'], [class*='raise'], [class*='multi'], [class*='sans-']");
    if (!parent) return;
    const cls = Array.from(parent.classList).join(" ");
    const fl = getComputedStyle(p, "::first-letter");
    const cs = getComputedStyle(p);
    const pRect = p.getBoundingClientRect();
    const firstNode = Array.from(p.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    if (!firstNode) return;
    const raw = firstNode.textContent ?? "";
    const offset = raw.length - raw.replace(/^\s+/, "").length;
    const ch = raw[offset];
    const r = document.createRange();
    r.setStart(firstNode, offset);
    r.setEnd(firstNode, offset + 1);
    const cr = r.getBoundingClientRect();
    const c = document.createElement('canvas');
    const cc = c.getContext('2d');
    cc.font = `${fl.fontStyle} ${fl.fontWeight} 100px ${fl.fontFamily}`;
    const m = cc.measureText('H');
    const capHeightRatio = m.actualBoundingBoxAscent / 100;
    const ascentRatio = m.fontBoundingBoxAscent / 100;
    const pseudoCw = parseFloat(fl.width);
    const probe = cc.measureText(ch);
    const naturalW100 = probe.width;
    const effectiveFs = 100 * pseudoCw / naturalW100;
    const effectiveAscent = effectiveFs * ascentRatio;
    const effectiveCap = effectiveFs * capHeightRatio;
    out.push({
      cls, ch,
      pRectY: +pRect.y.toFixed(2),
      pseudoIL: fl.initialLetter || fl.webkitInitialLetter,
      cRecY: +cr.y.toFixed(2),
      cRecH: +cr.height.toFixed(2),
      effectiveFs: +effectiveFs.toFixed(2),
      effectiveAscent: +effectiveAscent.toFixed(2),
      effectiveCap: +effectiveCap.toFixed(2),
      capHeightRatio: +capHeightRatio.toFixed(4),
      ascentRatio: +ascentRatio.toFixed(4),
      parentLH: parseFloat(cs.lineHeight),
      bodyFs: parseFloat(cs.fontSize),
    });
  });
  return out;
});

await browser.close();

// Walk expected.png for each W region to find painted ink top.
async function inkTopBottom(path, region) {
  const img = await sharp(path)
    .extract(region)
    .raw()
    .greyscale()
    .toBuffer({ resolveWithObject: true });
  const { data: buf, info } = img;
  const rows = [];
  for (let y = 0; y < info.height; y++) {
    let dark = 0;
    for (let x = 0; x < info.width; x++) {
      if (buf[y * info.width + x] < 200) dark++;
    }
    rows.push(dark);
  }
  // Threshold > 50 selects rows with heavy ink (drop cap), excluding thin
  // header text or body text wrapping around the drop cap.
  const inkRows = rows.map((d, i) => ({ d, y: i })).filter((r) => r.d > 50);
  return {
    top: inkRows[0]?.y,
    bottom: inkRows[inkRows.length - 1]?.y,
  };
}

console.log("--- shift derivation ---");
for (const d of data) {
  // Crop x to just the drop-cap area (paragraph left + ~glyph-width buffer),
  // and y wide enough to capture the full glyph including any cap that
  // overflows above pRectY. Don't include the body text that wraps around.
  const glyphX = d.cRecY != null ? 30 : 30;
  const glyphW = Math.min(280, d.effectiveFs * 1.5); // glyph is ~1.13× fontSize wide for most letters
  const region = {
    left: glyphX,
    top: Math.max(0, Math.floor(d.cRecY - 50)),
    width: Math.floor(glyphW),
    height: 250,
  };
  void glyphX;
  const exp = await inkTopBottom("tests/output/html-test/24-deep-initial-letter-expected.png", region);
  const absExpTop = region.top + (exp.top ?? 0);
  const absExpBot = region.top + (exp.bottom ?? 0);
  const shift = absExpTop - d.cRecY;
  console.log(`${d.cls} ${d.ch} IL=${d.pseudoIL} pRectY=${d.pRectY}`);
  console.log(`  cRecY=${d.cRecY} cRecH=${d.cRecH} effectiveFs=${d.effectiveFs} effectiveCap=${d.effectiveCap.toFixed(1)} effectiveAscent=${d.effectiveAscent.toFixed(1)}`);
  console.log(`  expected ink top=${absExpTop} bot=${absExpBot} ink-height=${absExpBot - absExpTop}`);
  console.log(`  region: left=${region.left} top=${region.top} w=${region.width} h=${region.height}`);
  console.log(`  SHIFT(painted ink-top − Range.top) = ${shift.toFixed(2)}`);
  console.log(`  bodyLine1 baseline ≈ ${(d.pRectY + (d.parentLH - d.bodyFs * (1 - d.capHeightRatio)) / 2 + d.bodyFs * d.capHeightRatio).toFixed(2)} cap-top ≈ ${(d.pRectY + (d.parentLH - d.bodyFs * (1 - d.capHeightRatio)) / 2).toFixed(2)}`);
}
