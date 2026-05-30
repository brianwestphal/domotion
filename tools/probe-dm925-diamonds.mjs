import { chromium } from "@playwright/test";
import * as fontkit from "fontkit";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();
await page.setContent("<html><body><span id='c' style='font-family:system-ui,sans-serif;font-size:18px'></span></body></html>");
const cps = [0x25C6, 0x25C7, 0x25C8, 0x25C9, 0x25CE];
for (const cp of cps) {
  const ch = String.fromCodePoint(cp);
  const w = await page.evaluate((ch) => {
    const span = document.getElementById("c");
    span.textContent = ch;
    return span.getBoundingClientRect().width;
  }, ch);
  console.log(`\nU+${cp.toString(16).toUpperCase()} ${ch}: Chrome=${w.toFixed(2)}px`);
  const fonts = [
    ["Hiragino Sans GB", "/System/Library/Fonts/Hiragino Sans GB.ttc", "HiraginoSansGB-W3"],
    ["Hiragino W3", "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", "HiraKakuProN-W3"],
    ["Apple Symbols", "/System/Library/Fonts/Apple Symbols.ttf", null],
    ["LucidaGrande", "/System/Library/Fonts/LucidaGrande.ttc", "LucidaGrande"],
  ];
  for (const [name, path, ps] of fonts) {
    try {
      const file = fontkit.openSync(path);
      const font = ps && file.fonts ? file.getFont(ps) : (file.fonts ? file.fonts[0] : file);
      if (!font) continue;
      const glyph = font.glyphForCodePoint(cp);
      if (!glyph || glyph.id === 0) continue;
      const adv = glyph.advanceWidth * 18 / font.unitsPerEm;
      console.log(`    ${name}: ${adv.toFixed(2)}px${Math.abs(adv - w) < 0.1 ? " ← MATCH" : ""}`);
    } catch {}
  }
}
await browser.close();
