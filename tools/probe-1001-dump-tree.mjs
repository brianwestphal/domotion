// Mirror the real-world.tsx flow for nytimes-mobile-entire-page, dump the
// captured tree to /tmp/nyt-tree.json, then summarize elements at y=5000-5600.
import { chromium } from "@playwright/test";
import { captureElementTreeWithWarnings } from "../dist/render/element-tree-to-svg.js";
import { writeFileSync } from "node:fs";

const VIEWPORT = { width: 390, height: 844 };
const CANVAS_H = 6000;
const SETTLE_MS = 5000;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  isMobile: true,
  hasTouch: true,
});
await ctx.routeFromHAR("tests/cache/real-world/nytimes-mobile.har", { update: false, notFound: "abort" });
const page = await ctx.newPage();

await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(SETTLE_MS);
await page.setViewportSize({ width: VIEWPORT.width, height: CANVAS_H });
await page.waitForTimeout(400);
await page.evaluate(async (h) => {
  window.scrollTo(0, h);
  await new Promise((r) => setTimeout(r, 400));
  window.scrollTo(0, 0);
}, CANVAS_H);
await page.waitForTimeout(1800);

// Take expected screenshot first so any layout drift from capture doesn't
// move the reference, mirroring the real-world.tsx ordering.
await page.screenshot({ path: "/tmp/nyt-expected.png", clip: { x: 0, y: 0, width: 390, height: CANVAS_H } });

// Now capture the tree
const cap = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 390, height: CANVAS_H });

writeFileSync("/tmp/nyt-tree.json", JSON.stringify(cap.tree, null, 2));
console.log(`Tree dumped to /tmp/nyt-tree.json (${cap.tree.length} root elements)`);

// Quick stats: count elements at various y bands
function walk(els, cb) {
  for (const el of els) {
    cb(el);
    if (el.children && el.children.length > 0) walk(el.children, cb);
  }
}
let totalEls = 0;
const yBands = new Map();
const elementsInDiffZone = [];
walk(cap.tree, (el) => {
  totalEls++;
  const y = el.rect?.y;
  if (y == null) return;
  const band = Math.floor(y / 500) * 500;
  yBands.set(band, (yBands.get(band) ?? 0) + 1);
  if (y >= 5050 && y <= 5500) {
    elementsInDiffZone.push({ tag: el.tag, y, h: el.rect.height, w: el.rect.width, hasText: !!el.text, childCount: el.children?.length ?? 0 });
  }
});
console.log(`\nTotal captured elements: ${totalEls}`);
console.log("\ny-band distribution (500-px bands):");
const sortedBands = [...yBands.entries()].sort((a, b) => a[0] - b[0]);
for (const [band, count] of sortedBands) {
  if (band < 4000 || band > 6000) continue;
  console.log(`  ${band}-${band + 500}: ${count} elements`);
}
console.log(`\nElements in y=5050-5500 diff zone: ${elementsInDiffZone.length}`);
for (const el of elementsInDiffZone.slice(0, 30)) {
  console.log(`  <${el.tag}> y=${el.y.toFixed(0)} w=${el.w.toFixed(0)} h=${el.h.toFixed(0)} hasText=${el.hasText} children=${el.childCount}`);
}

await browser.close();
