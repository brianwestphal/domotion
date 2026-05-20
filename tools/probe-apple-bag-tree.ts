// Dump the captured element tree to see what gets stored for the bag-badge
import { chromium } from "@playwright/test";
import { captureElementTreeWithWarnings } from "../src/render/element-tree-to-svg.js";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const HAR = resolve(process.cwd(), "tests/cache/real-world/apple-desktop.har");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  });
  await ctx.routeFromHAR(HAR, { update: false });
  const page = await ctx.newPage();
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const { tree } = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 1280, height: 800 });
  // Find badge: x=1136, y=96.5
  const isBag = (el: any) => Math.abs(el.x - 1136) < 10 && Math.abs(el.y - 96) < 10;
  function walk(els: any[], parentClass = "", depth = 0) {
    for (const el of els) {
      const cls = (el.styles && el.styles.className) || "";
      // Find any element near 1136 / 1100-1170 with black bg
      const bg = el.styles?.backgroundColor;
      const nearBag = el.x > 1100 && el.x < 1170 && el.y > 70 && el.y < 130;
      if (nearBag) {
        console.log(`[d${depth}]`, { tag: el.tag, x: el.x, y: el.y, w: el.width, h: el.height, bg, fill: el.styles?.color, kids: el.children?.length });
      }
      if (el.children) walk(el.children, cls, depth + 1);
    }
  }
  walk(tree);
  writeFileSync("/tmp/claude/apple-tree-snippet.json", JSON.stringify(tree).slice(0, 100000));
  await browser.close();
})();
