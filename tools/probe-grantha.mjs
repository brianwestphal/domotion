import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");
// Just render one Grantha char and ask for the font + its source URL
await page.setContent(`<div style="font:32px system-ui">𑌅</div>`);
await page.waitForLoadState("networkidle");
const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
function flat(n, a=[]){a.push(n);for(const c of n.children||[])flat(c,a);return a;}
const div = flat(root).find(n => n.nodeName === "DIV");
const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: div.nodeId });
console.log(JSON.stringify(fonts, null, 2));
await browser.close();
