// Probe Chrome's per-cell font choice for a unicode-block fixture, and
// (optionally) which on-disk macOS font has the glyph via fontkit.
// Usage: node tools/probe-uni-font.mjs <fixture-basename> [cp1,cp2,...]
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import * as fontkit from "fontkit";

const fixture = process.argv[2];
const HTML_DIR = process.env.HTML_TEST_DIR ?? "../html-test/unicode";
const html = readFileSync(`${HTML_DIR}/${fixture}.html`, "utf-8");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");
await page.setContent(html);
await page.waitForLoadState("domcontentloaded");

const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
const cells = [];
(function walk(n) {
  // cells are <x><g>CHAR</g><n>U+XXXX</n></x>
  if (n.nodeName === "G") cells.push(n);
  for (const c of n.children || []) walk(c);
})(root);

console.log(`fixture=${fixture}  cells=${cells.length}`);
const N = Math.min(parseInt(process.env.N ?? "16"), cells.length);
for (let i = 0; i < N; i++) {
  try {
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: cells[i].nodeId });
    // get the codepoint label from sibling <n>
    const fams = fonts.filter((f) => f.glyphCount > 0).map((f) => `${f.familyName}/${f.postScriptName ?? "?"}(${f.glyphCount})`);
    console.log(`  cell[${i}]: ${fams.join("  ") || "(none)"}`);
  } catch { console.log(`  cell[${i}]: <err>`); }
}
await browser.close();
