import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
await page.setContent("<html><body><span id='c' style='font-family:system-ui,sans-serif;font-size:24px'>⎘</span></body></html>");
await page.waitForLoadState("networkidle");
const out = await page.evaluate(() => {
  const span = document.getElementById("c");
  const r = span.getBoundingClientRect();
  return { w: r.width, h: r.height };
});
console.log("U+2398 NEXT PAGE width @ 24px:", JSON.stringify(out));
// Also test other common candidates
import * as fontkit from "fontkit";
const candidates = [
  ["/System/Library/Fonts/Apple Symbols.ttf", null],
  ["/System/Library/Fonts/LucidaGrande.ttc", "LucidaGrande"],
  ["/System/Library/Fonts/Helvetica.ttc", "Helvetica"],
  ["/System/Library/Fonts/Supplemental/Arial Unicode.ttf", null],
  ["/System/Library/Fonts/SFNSDisplay.ttf", null],
  ["/System/Library/Fonts/Menlo.ttc", "Menlo-Regular"],
  ["/System/Library/Fonts/Symbol.ttf", null],
  ["/System/Library/Fonts/Supplemental/STIXTwoMath.otf", null],
];
for (const [path, ps] of candidates) {
  try {
    const file = fontkit.openSync(path);
    const font = ps && file.fonts ? file.getFont(ps) : (file.fonts ? file.fonts[0] : file);
    if (!font) { console.log(`  ${path}: no font`); continue; }
    const glyph = font.glyphForCodePoint(0x2398);
    if (!glyph || glyph.id === 0) { console.log(`  ${path}: NO GLYPH`); continue; }
    const adv = glyph.advanceWidth * 24 / font.unitsPerEm;
    console.log(`  ${path} (${font.fullName || ps}): glyph ${glyph.id}, advance ${adv.toFixed(2)}px`);
  } catch (e) {
    console.log(`  ${path}: ${e.message}`);
  }
}
await browser.close();
