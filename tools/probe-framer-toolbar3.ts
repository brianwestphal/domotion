import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

function walk(n: CapturedElement, pred: (n: CapturedElement) => boolean, out: CapturedElement[]) {
  if (pred(n)) out.push(n);
  for (const c of n.children ?? []) walk(c, pred, out);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "framer-desktop.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://www.framer.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.setViewportSize({ width: 1280, height: 6000 });
  await page.waitForTimeout(400);

  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 1280, height: 6000 });
  const svgs: CapturedElement[] = [];
  walk(tree[0]!, (n) => n.tag === 'svg', svgs);
  const svgsNearToolbar = svgs.filter((s) => s.x >= 800 && s.x <= 1280 && s.y >= 3800 && s.y <= 3950);
  for (const s of svgsNearToolbar) {
    console.log(`\n=== svg at (${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.width)},${Math.round(s.height)}) ===`);
    console.log((s as any).svgContent);
  }
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
