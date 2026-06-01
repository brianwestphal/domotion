// Probe Chrome's per-character font choice for the specific failing codepoints
// in DM-998..1012, using the EXACT font-family stack the html-test fixtures
// declare so the cascade reflects the failing case, not a Helvetica-default
// probe.
import { chromium } from "@playwright/test";

const codepoints = [
  { name: "DM-1010 U+13668 (egypt hierogl ext-A)", cp: 0x13668 },
  { name: "DM-999  U+1D800 (sutton signwriting)",  cp: 0x1D800 },
  { name: "DM-998  U+1D80D (sutton signwriting)",  cp: 0x1D80D },
  { name: "DM-1012 U+3208E (CJK ext-H)",           cp: 0x3208E },
  { name: "DM-1011 U+305D6 (CJK ext-G)",           cp: 0x305D6 },
  { name: "DM-1000 U+2F8F5 (CJK compat suppl)",    cp: 0x2F8F5 },
];

const fontStack = `"Arial Unicode MS","Arial Unicode MS","Apple Symbols","Apple Color Emoji","Noto Sans","Noto Serif",sans-serif`;
const html = `<!doctype html><meta charset="utf-8"><body style="font-family:${fontStack};font-size:32px">
${codepoints.map((c, i) => `<div><span id="c${i}">${String.fromCodePoint(c.cp)}</span> ${c.name}</div>`).join("\n")}
</body>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1024 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");
await page.setContent(html);
await page.waitForLoadState("domcontentloaded");

const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
function findById(n, id) {
  if (n.attributes) {
    for (let j = 0; j < n.attributes.length - 1; j += 2) {
      if (n.attributes[j] === "id" && n.attributes[j+1] === id) return n;
    }
  }
  for (const c of n.children || []) {
    const f = findById(c, id);
    if (f) return f;
  }
  return null;
}

for (let i = 0; i < codepoints.length; i++) {
  const n = findById(root, `c${i}`);
  if (!n) { console.log(`${codepoints[i].name}: node not found`); continue; }
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: n.nodeId });
  console.log(`${codepoints[i].name}:`);
  for (const f of fonts) {
    console.log(`  family=${f.familyName} ps=${f.postScriptName ?? "?"} glyphCount=${f.glyphCount}`);
  }
}

// Also: paint a single hex-tofu and check the measured advance vs LastResort.
const probeHtml = `<!doctype html><meta charset="utf-8"><body style="font-family:'LastResort';font-size:32px">𓙨</body>`;
await page.setContent(probeHtml);
const r = await page.evaluate(() => {
  const range = document.createRange();
  range.selectNodeContents(document.body);
  const rect = range.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
});
console.log(`\nLastResort 𓙨 advance: ${JSON.stringify(r)}`);

await browser.close();
