import { chromium } from "@playwright/test";
import * as fontkit from "fontkit";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const cps = [];
for (let cp = 0x1D400; cp <= 0x1D7FF; cp++) cps.push(cp);
await page.setContent(`<!doctype html><meta charset=utf-8><body style="margin:0;font:48px serif"></body>`);
await page.waitForLoadState("networkidle");
const result = await page.evaluate((cps) => {
  const cnv = document.createElement("canvas"); cnv.width = 64; cnv.height = 64;
  const g = cnv.getContext("2d", { willReadFrequently: true });
  const out = [];
  for (const cp of cps) {
    g.clearRect(0, 0, 64, 64); g.fillStyle = "#000"; g.font = "48px serif"; g.textBaseline = "top";
    g.fillText(String.fromCodePoint(cp), 2, 2);
    const d = g.getImageData(0, 0, 64, 64).data;
    let ink = 0, hash = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 32) { ink++; hash = (hash * 31 + ((i >> 2) | d[i + 3])) | 0; }
    out.push({ ink, hash });
  }
  return out;
}, cps);
await browser.close();
const byHash = new Map();
for (const r of result) { const k = `${r.ink}:${r.hash}`; byHash.set(k, (byHash.get(k) || 0) + 1); }
const clusters = [...byHash.values()].sort((a, b) => b - a);
console.log(`Chrome 1D400-1D7FF: ${result.length} cps, ${byHash.size} distinct, largest cluster ${clusters[0]} (${(100*clusters[0]/result.length).toFixed(1)}% — tofu if dominant)`);

// fontkit literal coverage from likely macOS math/symbol faces.
const faces = [];
for (const p of [
  "/System/Library/Fonts/Supplemental/STIXTwoMath.otf",
  "/System/Library/Fonts/Supplemental/STIXGeneral.otf",
  "/System/Library/Fonts/Apple Symbols.ttf",
  "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
]) { try { const f = fontkit.openSync(p); for (const ff of (f.fonts ?? [f])) faces.push({ p, ff }); } catch {} }
let cov = 0; for (const cp of cps) { for (const { ff } of faces) { try { if (ff.glyphForCodePoint(cp).id !== 0) { cov++; break; } } catch {} } }
console.log(`macOS literal coverage (${faces.map(f=>f.p.split("/").pop()).join(",")}): ${cov}/${cps.length}`);
