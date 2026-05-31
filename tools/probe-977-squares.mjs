import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");

// Render each patterned square in its own div with font-family: sans-serif
const cps = [0x25A3, 0x25A4, 0x25A5, 0x25A6, 0x25A7, 0x25A8, 0x25A9];
const html = `<style>div{font:32px sans-serif;background:white;color:black}</style>` +
  cps.map(cp => `<div id="c${cp.toString(16)}">${String.fromCodePoint(cp)}</div>`).join("\n");
await page.setContent(html);
await page.waitForLoadState("networkidle");

const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
function flat(n,a=[]){a.push(n);for(const c of n.children||[])flat(c,a);return a;}
const divs = flat(root).filter(n => n.nodeName === "DIV");

for (let i = 0; i < cps.length; i++) {
  const cp = cps[i];
  const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: divs[i].nodeId });
  // Also probe painted advance width via Range
  const w = await page.evaluate((id) => {
    const el = document.getElementById(id);
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width;
  }, `c${cp.toString(16)}`);
  console.log(`U+${cp.toString(16).toUpperCase()}  ${String.fromCodePoint(cp)}  Chrome: ${fonts.fonts.map(f=>`${f.familyName}×${f.glyphCount}`).join(", ")}  paint-width: ${w.toFixed(2)}px`);
}
await browser.close();
