import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
const cps = [0x2605, 0x2665, 0x2660, 0x2663];
const html = `<style>div{font:18px monospace;background:white;color:black}</style>` +
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
  console.log(`U+${cp.toString(16).toUpperCase()}  mono  Chrome: ${fonts.fonts.map(f=>`${f.familyName}×${f.glyphCount}`).join(", ")}  width=${w.toFixed(2)}`);
}
await browser.close();
