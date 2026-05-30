// Sweep every unicode block fixture, probe Chrome's font choice per character,
// build a (block → font-family) histogram so we can prioritise font additions.
import { chromium } from "@playwright/test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UNICODE_DIR = "/Users/westphal/Documents/html-test/unicode";
const files = readdirSync(UNICODE_DIR)
  .filter(f => f.endsWith(".html") && f !== "index.html")
  .sort();

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");

const familyCount = new Map(); // family → count
const blockToFamilies = new Map(); // block → Set of families

for (const file of files) {
  const block = file.replace(/\.html$/, "");
  await page.setContent(readFileSync(join(UNICODE_DIR, file), "utf-8"));
  await page.waitForLoadState("domcontentloaded");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const gNodes = [];
  function flat(n) { if (n.nodeName === "G") gNodes.push(n); for (const c of n.children || []) flat(c); }
  flat(root);

  const sampled = gNodes.slice(0, 3); // sample first 3 cells of each block
  const familiesHere = new Set();
  for (const g of sampled) {
    try {
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: g.nodeId });
      for (const f of fonts) {
        if (f.glyphCount > 0) {
          familyCount.set(f.familyName, (familyCount.get(f.familyName) ?? 0) + f.glyphCount);
          familiesHere.add(f.familyName);
        }
      }
    } catch (e) { /* nodeId may have stalised, ignore */ }
  }
  blockToFamilies.set(block, [...familiesHere]);
}

await browser.close();

console.log("=== Font families used by Chrome across all unicode blocks ===");
const sorted = [...familyCount.entries()].sort((a, b) => b[1] - a[1]);
for (const [f, c] of sorted) console.log(`  ${c.toString().padStart(8)}  ${f}`);

writeFileSync("/tmp/unicode-fonts.json", JSON.stringify({
  familyCount: Object.fromEntries(sorted),
  blockToFamilies: Object.fromEntries(blockToFamilies),
}, null, 2));
console.log("\nSaved /tmp/unicode-fonts.json");
