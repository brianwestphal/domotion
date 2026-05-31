import { chromium } from "@playwright/test";
import { captureElementTree } from "../dist/index.js";
import { readFileSync } from "node:fs";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/20-deep-first-letter-line.html", "utf-8"));
await page.waitForLoadState("networkidle");

const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1024, height: 4000 });
const roots = Array.isArray(tree) ? tree : [tree];

function walk(el, fn) {
  if (el == null) return;
  fn(el);
  for (const c of el.children || []) walk(c, fn);
}

for (const root of roots) {
  walk(root, (e) => {
    if (e?.tag !== "p") return;
    const segs = e.textSegments ?? [];
    if (segs.length === 0) return;
    const styled = segs[0];
    // Only print paragraphs whose first segment looks like a styled first-letter
    // (text length 1-4 + has color or fontSize override or pseudoBox).
    if (styled.text.length <= 4 && (styled.color || styled.fontSize || styled.pseudoBox)) {
      console.log(`<p>${JSON.stringify(e.text.slice(0, 30))}`);
      console.log(`  styled seg: text=${JSON.stringify(styled.text)} x=${styled.x?.toFixed(1)} y=${styled.y?.toFixed(1)} w=${styled.width?.toFixed(1)} h=${styled.height?.toFixed(1)} fs=${styled.fontSize} fw=${styled.fontWeight} color=${styled.color}`);
      console.log(`    xOffsets=${JSON.stringify(styled.xOffsets?.map(v => v.toFixed(1)))}`);
      if (styled.pseudoBox) console.log(`    pseudoBox: ${JSON.stringify({ x: styled.pseudoBox.x.toFixed(1), y: styled.pseudoBox.y.toFixed(1), w: styled.pseudoBox.width.toFixed(1), h: styled.pseudoBox.height.toFixed(1), bg: styled.pseudoBox.backgroundColor, bgImg: styled.pseudoBox.backgroundImage?.slice(0, 40), br: styled.pseudoBox.borderRadius })}`);
      console.log(`  all segs: count=${segs.length}`);
      segs.forEach((s, i) => {
        const sup = s.rasterGlyphs?.filter((g) => g.suppressGlyph) || [];
        console.log(`    seg[${i}]: text=${JSON.stringify((s.text || "").slice(0, 36))} sup=${sup.length}/${s.rasterGlyphs?.length || 0} fs=${s.fontSize} color=${s.color}`);
      });
    }
  });
}

await browser.close();
