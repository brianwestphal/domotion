import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { CURSOR_CATEGORIES, cursorGlyphSvg } from "../src/animation/cursor-glyphs.js";

const SIZE = 40;        // glyph render size (px in the 24-box)
const TILE = 92;        // tile size
function tile(value: string, bg: string): string {
  // glyph centered; hotspot lands at tile center
  const cx = TILE/2, cy = TILE/2 - 6;
  const glyph = cursorGlyphSvg(value, cx, cy, SIZE);
  const empty = value === "none";
  return `<div class="tile" style="background:${bg}">
    <svg width="${TILE}" height="${TILE-22}" viewBox="0 0 ${TILE} ${TILE-22}">
      ${empty ? `<text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="11" fill="${bg==='#1f2430'?'#9aa':'#999'}">(hidden)</text>` : glyph}
      <circle cx="${cx}" cy="${cy}" r="1.5" fill="#e0218a"/>
    </svg>
    <div class="lbl" style="color:${bg==='#1f2430'?'#cdd3df':'#222'}">${value}</div>
  </div>`;
}
const cats = CURSOR_CATEGORIES.map(c => `
  <h2>${c.title}</h2>
  <div class="row">${c.values.map(v=>tile(v,"#fbfbfd")).join("")}</div>
  <div class="row">${c.values.map(v=>tile(v,"#1f2430")).join("")}</div>
`).join("");
const html = `<!doctype html><meta charset="utf8"><body style="margin:0;font-family:-apple-system,system-ui,sans-serif;background:#fff;padding:18px 22px">
<h1 style="margin:0 0 2px">Domotion cursor glyphs — DM-1106 review</h1>
<div style="color:#666;font-size:13px;margin-bottom:10px">Lucide-composed glyphs, one per CSS <code>cursor</code> value. Each shown on light + dark to check the white halo. The <span style="color:#e0218a">pink dot</span> marks the hotspot (the point that lands on the actual cursor position).</div>
<style>
  h2{font-size:13px;color:#444;margin:16px 0 4px;text-transform:uppercase;letter-spacing:.04em}
  .row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
  .tile{width:${TILE}px;border:1px solid #e6e6ea;border-radius:8px;padding:0 0 4px;display:flex;flex-direction:column;align-items:center;overflow:hidden}
  .lbl{font-size:10.5px;font-family:ui-monospace,Menlo,monospace;margin-top:-2px}
</style>
${cats}
</body>`;
const browser = await chromium.launch();
const page = await browser.newContext({ deviceScaleFactor: 2 }).then(c=>c.newPage());
await page.setViewportSize({ width: 980, height: 1400 });
await page.setContent(html);
const h = await page.evaluate(()=>document.body.scrollHeight);
await page.setViewportSize({ width: 980, height: h+20 });
const out = "tests/output/cursor-glyphs-catalog.png";
writeFileSync(out, await page.screenshot({ fullPage: true }));
console.log("wrote", out, h);
await browser.close();
