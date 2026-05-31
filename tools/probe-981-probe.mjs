import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
// Probe all the suspect codepoints
const cps = [
  // r4/r5 arrows
  0x2194, 0x2195, 0x2196, 0x2197, 0x2198, 0x2199,
  // r8: maybe ℚ ℵ × ÷ etc
  0x211A, 0x2135,
  // r10/r11 geom/symbols
  0x2605, 0x2606, 0x2665, 0x2666, 0x2660, 0x2663,
  // r11 has → and sigma — but those are probably fine. Σ = U+03A3 (Greek)
  0x2192,
];
const html = `<style>div{font:32px sans-serif;background:white;color:black;height:48px}</style>` +
  cps.map(cp => `<div id="c${cp.toString(16)}">${String.fromCodePoint(cp)}</div>`).join("\n");
await page.setContent(html);
await page.waitForLoadState("networkidle");
const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
function flat(n,a=[]){a.push(n);for(const c of n.children||[])flat(c,a);return a;}
const divs = flat(root).filter(n => n.nodeName === "DIV");
for (let i = 0; i < cps.length; i++) {
  const cp = cps[i];
  const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: divs[i].nodeId });
  const w = await page.evaluate((id) => {
    const r = document.createRange(); r.selectNodeContents(document.getElementById(id));
    return r.getBoundingClientRect().width;
  }, `c${cp.toString(16)}`);
  console.log(`U+${cp.toString(16).toUpperCase().padStart(4,"0")}  ${String.fromCodePoint(cp)}  Chrome: ${fonts.fonts.map(f=>`${f.familyName}×${f.glyphCount}`).join(", ")}  paint-width: ${w.toFixed(2)}px`);
}
await browser.close();
