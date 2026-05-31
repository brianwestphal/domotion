// Snug probe — for each drop cap, set region tightly to the float's painted
// area to avoid section headers above and body text wrapping to the right.
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
    const probe = cc.measureText(ch);
    out.push({
      cls, ch,
      pRectX: +pRect.x.toFixed(2),
      pRectY: +pRect.y.toFixed(2),
      pseudoIL: fl.initialLetter || fl.webkitInitialLetter,
      cRecX: +cr.x.toFixed(2),
      cRecY: +cr.y.toFixed(2),
      cRecW: +cr.width.toFixed(2),
      cRecH: +cr.height.toFixed(2),
      effectiveFs: +(100 * parseFloat(fl.width) / probe.width).toFixed(2),
      pseudoComputedW: parseFloat(fl.width),
      pseudoComputedH: parseFloat(fl.height),
      capHeightRatio: +(m.actualBoundingBoxAscent / 100).toFixed(4),
      ascentRatio: +(m.fontBoundingBoxAscent / 100).toFixed(4),
      descentRatio: +(m.fontBoundingBoxDescent / 100).toFixed(4),
      parentLH: parseFloat(cs.lineHeight),
      bodyFs: parseFloat(cs.fontSize),
    });
  });
  return out;
});
await browser.close();

async function inkRows(path, region) {
  const img = await sharp(path).extract(region).raw().greyscale().toBuffer({ resolveWithObject: true });
  const { data: buf, info } = img;
  const rows = [];
  for (let y = 0; y < info.height; y++) {
    let dark = 0;
    for (let x = 0; x < info.width; x++) {
      if (buf[y * info.width + x] < 200) dark++;
    }
    rows.push({ y, dark });
  }
  return rows;
}

console.log("--- snug shift probe ---");
for (const d of data) {
  // Region: x from paragraph-left to paragraph-left + computed pseudo width + 5 (avoid body wrap).
  // y from Range.top - 5 (catch any cap above Range.top) to Range.top + Range.height + 50.
  // Per fixture x and y bounds are derived from cRec.
  const left = Math.max(0, Math.floor(d.cRecX) - 2);
  const width = Math.min(280, Math.ceil(d.cRecW) + 4);
  const top = Math.max(0, Math.floor(d.cRecY) - 5);
  const height = Math.min(280, Math.ceil(d.cRecH) + 50);
  const region = { left, top, width, height };
  const rows = await inkRows("tests/output/html-test/24-deep-initial-letter-expected.png", region);
  // Heavy-ink rows = those with > 8 dark pixels (drop cap is thick).
  const heavyRows = rows.filter((r) => r.dark > 8);
  if (heavyRows.length === 0) { console.log(`${d.cls} ${d.ch}: NO HEAVY INK in region`); continue; }
  const inkTop = top + heavyRows[0].y;
  const inkBot = top + heavyRows[heavyRows.length - 1].y;
  // Apply Blink's formula
  // block_offset = line_height * size - ascent_init_box - descent_body_leaded
  const sizeStr = d.pseudoIL.split(/\s+/)[0];
  const size = parseInt(sizeStr, 10);
  const ascentInit = d.effectiveFs * d.ascentRatio;
  const bodyAscent = d.bodyFs * d.ascentRatio;
  const bodyDescent = d.bodyFs * d.descentRatio;
  const halfLeading = (d.parentLH - bodyAscent - bodyDescent) / 2;
  const bodyDescentLeaded = bodyDescent + halfLeading;
  const blinkBlockOffset = d.parentLH * size - ascentInit - bodyDescentLeaded;
  const blinkBoxTop = d.pRectY + blinkBlockOffset;
  // Within the box, the W's text origin is at -ascent_init (per AdjustInitialLetterInTextPosition).
  // The text baseline is at box_top + ascent_init. cap-top = baseline - cap-height.
  const baseline = blinkBoxTop + ascentInit;
  const capHeightInit = d.effectiveFs * d.capHeightRatio;
  const blinkCapTop = baseline - capHeightInit;
  console.log(`${d.cls} ${d.ch} IL=${d.pseudoIL} effectiveFs=${d.effectiveFs}`);
  console.log(`  Range.top=${d.cRecY} Range.h=${d.cRecH} pRectY=${d.pRectY}`);
  console.log(`  empirical ink-top=${inkTop} ink-bot=${inkBot} ink-h=${inkBot - inkTop}`);
  console.log(`  blink box-top=${blinkBoxTop.toFixed(2)} baseline=${baseline.toFixed(2)} cap-top=${blinkCapTop.toFixed(2)}`);
  console.log(`  shift(empirical ink-top - Range.top) = ${(inkTop - d.cRecY).toFixed(2)}`);
  console.log(`  shift(blink cap-top - Range.top)     = ${(blinkCapTop - d.cRecY).toFixed(2)}`);
}
