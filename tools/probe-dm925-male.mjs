import { chromium } from "@playwright/test";
import * as fontkit from "fontkit";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/02-text-symbols.html", "utf-8"));
await page.waitForLoadState("networkidle");
const w = await page.evaluate(() => {
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = tw.nextNode())) if (node.textContent.includes("♂")) break;
  if (!node) return null;
  const idx = node.textContent.indexOf("♂");
  const r = document.createRange();
  r.setStart(node, idx); r.setEnd(node, idx + 1);
  return r.getBoundingClientRect().width;
});
console.log("Chrome ♂ width:", w);
const fonts = [
  ["Hiragino Sans GB W3", "/System/Library/Fonts/Hiragino Sans GB.ttc", "HiraginoSansGB-W3"],
  ["Hiragino W3", "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", "HiraKakuProN-W3"],
  ["Apple Symbols", "/System/Library/Fonts/Apple Symbols.ttf", null],
  ["AppleSDGothicNeo", "/System/Library/Fonts/AppleSDGothicNeo.ttc", "AppleSDGothicNeo-Regular"],
  ["STIX Math", "/System/Library/Fonts/Supplemental/STIXTwoMath.otf", null],
];
for (const [name, path, ps] of fonts) {
  try {
    const file = fontkit.openSync(path);
    const font = ps && file.fonts ? file.getFont(ps) : (file.fonts ? file.fonts[0] : file);
    if (!font) continue;
    const g = font.glyphForCodePoint(0x2642);
    if (!g || g.id === 0) { console.log(`  ${name}: NO GLYPH`); continue; }
    const adv = g.advanceWidth * 18 / font.unitsPerEm;
    console.log(`  ${name}: ${adv.toFixed(2)}px`);
  } catch {}
}
await browser.close();
