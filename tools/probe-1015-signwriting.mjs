// Probe Chrome's actual font choice for U+1D80D (Sutton SignWriting) in the
// real fixture's font stack vs minimal stacks. CDP CSS.getPlatformFontsForNode
// reports the font Chrome attempted to use — but for U+1D80D it said SF
// Compact even though no SF Compact variant on disk actually has the glyph
// (verified via fontkit). Find out where the painted glyph really comes from.
import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 800, height: 400 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");

const stacks = [
  // The signwriting fixture's exact stack
  '"Arial Unicode MS","Arial Unicode MS","Apple Symbols","Apple Color Emoji","Noto Sans","Noto Serif",sans-serif',
  // Just sans-serif
  'sans-serif',
  // Just SF Compact
  'SFCompact, "SF Compact"',
  // Apple Symbols
  '"Apple Symbols"',
];

for (const stack of stacks) {
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:${stack};font-size:64px"><span id="t">\u{1D80D}</span></body>`;
  await page.setContent(html);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  function findById(n, id) {
    if (n.attributes) for (let j = 0; j < n.attributes.length - 1; j += 2)
      if (n.attributes[j] === "id" && n.attributes[j+1] === id) return n;
    for (const c of n.children || []) { const f = findById(c, id); if (f) return f; }
    return null;
  }
  const n = findById(root, "t");
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: n.nodeId });
  // Also screenshot a small crop showing the glyph
  const rect = await page.evaluate(() => {
    const r = document.getElementById("t").getBoundingClientRect();
    return { x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.width), h: Math.ceil(r.height) };
  });
  const slug = stack.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  const path = `/tmp/dm1015-${slug}.png`;
  if (rect.w > 0 && rect.h > 0) {
    const buf = await page.screenshot({ clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, buf);
  }
  console.log(`\nstack=${stack}`);
  console.log(`  glyph rect: ${rect.w}x${rect.h} → ${path}`);
  for (const f of fonts) console.log(`  family=${f.familyName} ps=${f.postScriptName ?? "?"} glyphCount=${f.glyphCount}`);
}
await browser.close();
