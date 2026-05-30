import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");

await page.setContent(readFileSync("/Users/westphal/Documents/html-test/unicode/12480-1254F-early-dynastic-cuneiform.html", "utf-8"));
await page.waitForLoadState("networkidle");

const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
function flat(node, arr = []) { arr.push(node); for (const c of node.children || []) flat(c, arr); return arr; }
const all = flat(root);
const gNodes = all.filter(n => n.nodeName === "G").slice(0, 8);

for (const g of gNodes) {
  const fonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: g.nodeId });
  const text = (g.children || []).find(c => c.nodeName === "#text")?.nodeValue ?? "?";
  const cp = [...text].map(c => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(",");
  console.log(`char: ${JSON.stringify(text)} (${cp})  →  ${fonts.fonts.map(f => `${f.familyName}×${f.glyphCount}`).join(", ")}`);
}
await browser.close();
