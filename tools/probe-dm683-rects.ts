import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { captureElementTreeWithWarnings } from "../src/render/element-tree-to-svg.js";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto("file://" + resolve("external/html-test/15-deep-flex-aspect-ratio.html"));
  await page.waitForTimeout(200);

  const live = await page.evaluate(() => {
    const out: any[] = [];
    // Capture every h2, .frame, .row, .item with text content for the
    // sections after the column-direction one.
    const all = document.querySelectorAll("h2, .frame, .row, .item");
    for (const el of Array.from(all)) {
      const r = el.getBoundingClientRect();
      if (r.top < 600 || r.top > 1000) continue;
      const text = (el as HTMLElement).innerText?.slice(0, 40) ?? "";
      out.push({ tag: el.tagName, cls: el.className, text, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  });
  console.log("LIVE CHROME RECTS:");
  for (const e of live) console.log(" ", JSON.stringify(e));

  const cap = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 1024, height: 768 });
  console.log("\nCAPTURED RECTS (any element in y=300..1050):");
  function walk(n: any, depth = 0): void {
    if (depth > 25) return;
    if (n.y != null && n.y > 300 && n.y < 1050 && n.x != null && n.x >= 42 && n.x < 250) {
      const cls = JSON.stringify(n.classList);
      console.log(`  d=${depth} <${n.tag}> cls=${cls} rect=${JSON.stringify({ x: n.x, y: n.y, w: n.width, h: n.height })}`);
    }
    for (const c of (n.children ?? [])) walk(c, depth + 1);
  }
  for (const root of cap.tree) walk(root);
  await browser.close();
}
void main();
