// For which (lang, text) does Chromium paint `font-family: initial` (the
// generic standard family) with a different face than the concrete family
// whose name `initial` computes to?
// usage: node tools/scratch/probe-standard-vs-concrete.mjs
import { chromium } from "@playwright/test";

const langs = ["ja", "zh-CN", "zh-TW", "zh-HK", "ko", "ar", "he", "th", "hi", "ru", "el", "en", ""];
const texts = ["A漢", "漢字かな", "한국어", "مرحبا", "שלום", "ภาษาไทย", "हिन्दी", "Ωμέγα", "Жж", "Ag"];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.setContent("<p>x</p>");
const initial = await page.locator("p").evaluate((el) => getComputedStyle(el).fontFamily);
const cells = [];
let html = `<!doctype html><meta charset="utf-8"><style>p{font-size:32px;margin:0}.s{font-family:initial}.c{font-family:${initial}}</style>`;
let n = 0;
for (const lang of langs) {
  for (const text of texts) {
    cells.push({ lang, text, s: `s${n}`, c: `c${n}` });
    const l = lang ? ` lang="${lang}"` : "";
    html += `<p id="s${n}" class="s"${l}>${text}</p><p id="c${n}" class="c"${l}>${text}</p>`;
    n++;
  }
}
await page.setContent(html);
const cdp = await page.context().newCDPSession(page);
await cdp.send("DOM.enable");
await cdp.send("CSS.enable");
const { root } = await cdp.send("DOM.getDocument");
async function fonts(id) {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts.map((f) => `${f.postScriptName}:${f.glyphCount}`).join(",");
}
const diffs = [];
for (const cell of cells) {
  const s = await fonts(cell.s);
  const c = await fonts(cell.c);
  if (s !== c) diffs.push({ lang: cell.lang, text: cell.text, standard: s, concrete: c });
}
console.log(JSON.stringify({ platform: process.platform, initial, diffCount: diffs.length, of: cells.length }));
for (const d of diffs) console.log(JSON.stringify(d));
await browser.close();
