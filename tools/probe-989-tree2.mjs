import { chromium } from "@playwright/test";
import { captureElementTree } from "../dist/index.js";
import { readFileSync } from "node:fs";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 1184 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/24-deep-initial-letter.html", "utf-8"));
await page.waitForLoadState("networkidle");

const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1024, height: 1496 });
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
    if (styled.text.length <= 4 && (styled.fontSize !== undefined || styled.color || styled.pseudoBox)) {
      console.log(`<p>${JSON.stringify(e.text.slice(0, 20))}`);
      console.log(`  styled: text=${JSON.stringify(styled.text)} x=${styled.x?.toFixed(1)} y=${styled.y?.toFixed(1)} fs=${styled.fontSize?.toFixed(1)} asc=${styled.fontAscent?.toFixed(1)}`);
      if (styled.pseudoBox) console.log(`  pBox: x=${styled.pseudoBox.x.toFixed(1)} y=${styled.pseudoBox.y.toFixed(1)} w=${styled.pseudoBox.width.toFixed(1)} h=${styled.pseudoBox.height.toFixed(1)}`);
    }
  });
}

await browser.close();
