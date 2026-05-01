// Probe Chrome's actual font selection for the U+25A0..26FF symbol-block
// codepoints that DM-415 flagged as rendering with the wrong glyph shape.
// Uses CDP CSS.getPlatformFontsForNode to read which font Chrome painted
// each glyph with, then we'll route accordingly in fallbackFontChain.

import { chromium } from 'playwright';

// Codepoints called out in DM-415 + adjacent ones in the same fixture
const codepoints = [
  // Diamonds row (U+25C6..U+25CF area — focus on U+25C8)
  0x25C6, 0x25C7, 0x25C8,
  // Squares row (U+25A0..U+25A8)
  0x25A0, 0x25A1, 0x25A2, 0x25A3, 0x25A4, 0x25A5, 0x25A6, 0x25A7, 0x25A8,
  // Dots/discs (U+25CB, U+25CF, U+25D0, U+25D1)
  0x25CB, 0x25CF, 0x25D0, 0x25D1,
  // Stars (U+2605..U+2606)
  0x2605, 0x2606, 0x269D, 0x2606, 0x2729,
  // Triangles (U+25B2..U+25C0)
  0x25B2, 0x25B3, 0x25BC, 0x25BD, 0x25B6, 0x25B7, 0x25C0, 0x25C1,
  // Misc symbols block — gender (U+2640..2642 + adj)
  0x2640, 0x2642, 0x26A5,
  // Ballot/check (U+2610..U+2612, U+2713..U+2718)
  0x2610, 0x2611, 0x2612, 0x2713, 0x2717,
  // Card suits (U+2660..U+2667)
  0x2660, 0x2663, 0x2665, 0x2666,
  // Music notes (U+2669..U+266F)
  0x2669, 0x266A, 0x266B, 0x266C,
  // Weather (U+2600..U+2604)
  0x2600, 0x2601, 0x2602, 0x2603, 0x2744,
];

const html = `<!DOCTYPE html><html><head><style>
body { font-family: system-ui, sans-serif; font-size: 18px; margin: 16px; }
.row { font-family: system-ui, sans-serif; }
</style></head><body>${codepoints.map((cp) =>
  `<div class="row" data-cp="${cp.toString(16).toUpperCase()}">U+${cp.toString(16).toUpperCase().padStart(4, '0')} ` +
    `<span id="g${cp.toString(16)}">${String.fromCodePoint(cp)}</span></div>`).join('\n')}</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 600, height: 1200 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.setContent(html);
const cdp = await page.context().newCDPSession(page);
await cdp.send('DOM.enable');
await cdp.send('CSS.enable');
const { root } = await cdp.send('DOM.getDocument');

console.log('cp     | font                        | advance(px) | size');
console.log('-------|-----------------------------|-------------|-----');

for (const cp of codepoints) {
  const id = `g${cp.toString(16)}`;
  const node = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${id}` });
  if (!node.nodeId) continue;
  const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
  const main = (fonts.fonts || []).find((f) => f.glyphCount > 0) || fonts.fonts?.[0];
  // Measure advance via getBoundingClientRect
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    return { w: r.width };
  }, `#${id}`);
  const cpHex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  console.log(`${cpHex} | ${(main?.familyName ?? '???').padEnd(28)} | ${rect.w.toFixed(2).padStart(11)} | ${main?.glyphCount ?? '?'}`);
}

await browser.close();
