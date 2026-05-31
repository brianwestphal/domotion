import { chromium } from "@playwright/test";
import { captureElementTree } from "../dist/index.js";
import { readFileSync } from "node:fs";

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
const page = await ctx.newPage();
await page.setContent(readFileSync("external/html-test/06-forms-textarea.html", "utf-8"));
await page.waitForLoadState("networkidle");

const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1024, height: 768 });
console.log("tree type:", typeof tree, "isArray:", Array.isArray(tree));
function walk(el, fn) {
  if (el == null) return;
  fn(el);
  for (const c of el.children || []) walk(c, fn);
}
const roots = Array.isArray(tree) ? tree : [tree];
for (const root of roots) {
  walk(root, (e) => {
    if (e?.tag === "textarea") {
      console.log("\ntextarea found, text:", JSON.stringify((e.text || "").slice(0, 100)));
      console.log("  textSegments count:", e.textSegments?.length ?? "(none)");
      if (e.textSegments) for (const s of e.textSegments) console.log("    seg text=" + JSON.stringify(s.text) + " x=" + s.x + " y=" + s.y);
      console.log("  elementRaster:", e.elementRaster ? "PRESENT" : "absent");
    }
  });
}
await browser.close();
