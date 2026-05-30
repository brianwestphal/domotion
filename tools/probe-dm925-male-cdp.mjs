import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 2000 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/02-text-symbols.html", "utf-8"));
await page.waitForLoadState("networkidle");
const client = await ctx.newCDPSession(page);
await client.send("DOM.enable");
await client.send("CSS.enable");
const { root } = await client.send("DOM.getDocument", { depth: -1 });
// Walk to find the ♂ text node's parent
function walk(node) {
  if (node.nodeValue && node.nodeValue.includes("♂")) return node;
  for (const c of node.children ?? []) {
    const r = walk(c); if (r) return r;
  }
  return null;
}
const node = walk(root);
if (node) {
  const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
  console.log("Fonts used:");
  for (const f of fonts) console.log(`  ${f.familyName} (${f.glyphCount} glyphs, postScript=${f.postScriptName})`);
}
await browser.close();
