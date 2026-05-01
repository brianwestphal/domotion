import { chromium } from "@playwright/test";
import * as fontkit from "fontkit";

// Probe Chrome's painted ♔ (U+2654) and ♚ (U+265A) at 22px sans-serif:
//   1. Which font does Chrome actually use? (via CDP CSS.getPlatformFontsForNode)
//   2. What's the rendered ADVANCE (glyph origin to next glyph origin)?
//   3. What's the INKED bbox left edge vs glyph origin (left-side bearing)?
// And for each candidate font (Apple Symbols, Hiragino, LucidaGrande):
//   - glyphForCodePoint, advanceWidth, leftSideBearing for both glyphs
// To resolve DM-380.

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:20px;font:22px sans-serif;background:white;">
<span id="t">♔♚</span><br>
<span id="t1">♔</span><br>
<span id="t2">♚</span></body></html>`);

const client = await page.context().newCDPSession(page);
await client.send("DOM.enable");
await client.send("CSS.enable");
const docResp = await client.send("DOM.getDocument", { depth: -1 });
function findId(node, id) {
  if (node.attributes) {
    for (let i = 0; i < node.attributes.length; i += 2) {
      if (node.attributes[i] === "id" && node.attributes[i + 1] === id) return node.nodeId;
    }
  }
  if (node.children) for (const ch of node.children) { const r = findId(ch, id); if (r) return r; }
  return null;
}
const measureNodes = ["t", "t1", "t2"];
for (const id of measureNodes) {
  const nodeId = findId(docResp.root, id);
  const fonts = await client.send("CSS.getPlatformFontsForNode", { nodeId });
  console.log(`#${id} fonts:`, fonts.fonts.map(f => `${f.familyName} (${f.glyphCount}gly ${(f.fontVariationAxes ?? []).length}axes)`));
}

// 2/3: bounding rects per character via Range API.
const rects = await page.evaluate(() => {
  function rectsOf(elId) {
    const el = document.getElementById(elId);
    const t = el.firstChild;
    const out = [];
    for (let i = 0; i < t.length; i++) {
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i+1);
      const rr = r.getBoundingClientRect();
      out.push({ char: t.data[i], cp: t.data.charCodeAt(i).toString(16), x: rr.x, y: rr.y, w: rr.width, h: rr.height });
    }
    return out;
  }
  return { t: rectsOf("t"), t1: rectsOf("t1"), t2: rectsOf("t2") };
});
console.log("\nRange.getBoundingClientRect per char:");
for (const k of Object.keys(rects)) {
  console.log(`  #${k}:`);
  for (const r of rects[k]) console.log(`    ${r.char} U+${r.cp}: x=${r.x.toFixed(3)} w=${r.w.toFixed(3)} h=${r.h.toFixed(3)}`);
}
// distance between the two char x's in #t to determine actual advance:
if (rects.t.length === 2) {
  console.log(`  distance #t[0].x → #t[1].x = ${(rects.t[1].x - rects.t[0].x).toFixed(3)}`);
}

// fontkit: per-font advance + LSB at 22px
const fontPaths = {
  "Apple Symbols": "/System/Library/Fonts/Apple Symbols.ttf",
  "Menlo": "/System/Library/Fonts/Menlo.ttc",
  "HiraginoSansGB": "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "Lucida Grande": "/System/Library/Fonts/LucidaGrande.ttc",
};
const SIZE = 22;
console.log("\nfontkit per-font (at 22px):");
for (const [name, p] of Object.entries(fontPaths)) {
  try {
    let f = fontkit.openSync(p);
    if (f.fonts) {
      // pick first that has glyphForCodePoint(0x2654) returning non-zero
      for (const sub of f.fonts) {
        const g = sub.glyphForCodePoint(0x2654);
        if (g && g.id !== 0) { f = sub; break; }
      }
    }
    const scale = SIZE / f.unitsPerEm;
    for (const cp of [0x2654, 0x265A]) {
      const g = f.glyphForCodePoint(cp);
      if (!g || g.id === 0) { console.log(`  ${name} U+${cp.toString(16)}: no glyph`); continue; }
      const adv = (g.advanceWidth ?? 0) * scale;
      const bbox = g.bbox;
      const lsb = (bbox?.minX ?? 0) * scale;
      const inked = ((bbox?.maxX ?? 0) - (bbox?.minX ?? 0)) * scale;
      console.log(`  ${name} U+${cp.toString(16)}: advance=${adv.toFixed(3)} lsb=${lsb.toFixed(3)} inkedW=${inked.toFixed(3)}`);
    }
  } catch (e) { console.log(`  ${name}: ${e.message}`); }
}

await browser.close();
