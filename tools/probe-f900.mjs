import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

// F900..FAD9 (CJK Compatibility Ideographs, BMP). Skip the FADA..FAFF gap reserveds.
const cps = [];
for (let cp = 0xF900; cp <= 0xFAD9; cp++) cps.push(cp);

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
    const s = sig(String.fromCodePoint(cp));
    out.push({ ink: s.ink, hash: s.hash });
  }
  return out;
}, cps);

await browser.close();

const byHash = new Map();
for (const r of result) {
  const k = `${r.ink}:${r.hash}`;
  byHash.set(k, (byHash.get(k) || 0) + 1);
}
const clusters = [...byHash.entries()].sort((a, b) => b[1] - a[1]);
console.log("F900 block total:", result.length);
console.log("Distinct glyph signatures:", clusters.length);
console.log("Largest cluster:", clusters[0][1], `(${(100 * clusters[0][1] / result.length).toFixed(1)}% — would be tofu if this dominates)`);
console.log("Blank (ink 0):", result.filter((r) => r.ink === 0).length);
