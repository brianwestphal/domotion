import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 400 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const cps = [];
for (let cp = 0x2F800; cp <= 0x2FA1D; cp++) cps.push(cp);

await page.setContent(`<!doctype html><meta charset=utf-8><body style="margin:0;font:64px serif"></body>`);
await page.waitForLoadState("networkidle");

const result = await page.evaluate((cps) => {
  const out = [];
  const cnv = document.createElement("canvas");
  cnv.width = 80; cnv.height = 80;
  const g = cnv.getContext("2d", { willReadFrequently: true });
  function sig(str) {
    g.clearRect(0, 0, 80, 80);
    g.fillStyle = "#000";
    g.font = "64px serif";
    g.textBaseline = "top";
    g.fillText(str, 4, 4);
    const d = g.getImageData(0, 0, 80, 80).data;
    let ink = 0, hash = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a > 32) { ink++; hash = (hash * 31 + ((i >> 2) | a)) | 0; }
    }
    return { ink, hash };
  }
  for (const cp of cps) {
    const comp = String.fromCodePoint(cp);
    const sC = sig(comp);
    out.push({ cp: cp.toString(16), compInk: sC.ink, compHash: sC.hash });
  }
  return out;
}, cps);

const byHash = new Map();
for (const r of result) {
  const k = `${r.compInk}:${r.compHash}`;
  byHash.set(k, (byHash.get(k) || 0) + 1);
}
const clusters = [...byHash.entries()].sort((a, b) => b[1] - a[1]);
console.log("Total comp codepoints:", result.length);
console.log("Distinct comp glyph signatures:", clusters.length);
console.log("Top clusters (signature -> count):");
for (const [k, n] of clusters.slice(0, 8)) console.log(`  ${k}  ->  ${n}`);
const top = clusters[0];
console.log(`\nLargest cluster covers ${top[1]} / ${result.length} = ${(100 * top[1] / result.length).toFixed(1)}% of codepoints (one identical glyph = placeholder).`);

const sample = cps.slice(0, 16).map((cp) => String.fromCodePoint(cp));
const compRow = sample.join("");
const nfcRow = sample.map((c) => c.normalize("NFC")).join("");
await page.setContent(
  `<!doctype html><meta charset=utf-8><body style="margin:0;background:#fff">
   <div style="font:64px serif;white-space:nowrap;padding:8px">${compRow}</div>
   <div style="font:64px serif;white-space:nowrap;padding:8px">${nfcRow}</div>
   </body>`
);
await page.waitForLoadState("networkidle");
const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 180 } });
writeFileSync("/tmp/claude/cmp-2f800.png", buf);
console.log("\nWrote /tmp/claude/cmp-2f800.png  (top row = compatibility codepoints as Chrome paints them; bottom row = their NFC decompositions)");

await browser.close();
