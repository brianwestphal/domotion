// Dump the top-level structure of the captured tree to see what IS captured.
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

function dump(n: CapturedElement, depth: number, maxDepth: number, yMin: number, yMax: number) {
  if (depth > maxDepth) return;
  if (n.y + n.height < yMin || n.y > yMax) return;
  const src = n.imageSrc ? ` src="${(n.imageSrc.split('/').pop() ?? '').slice(0,30)}"` : '';
  const txt = n.text ? ` text="${n.text.slice(0,20)}"` : '';
  const bg = n.styles?.backgroundImage && n.styles.backgroundImage !== 'none' ? ` bg=${n.styles.backgroundImage.slice(0,50)}` : '';
  console.log(`${'  '.repeat(depth)}${n.tag} rect=(${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.width)},${Math.round(n.height)}) op=${(n.styles as any)?.opacity}${src}${txt}${bg}`);
  for (const c of n.children ?? []) dump(c, depth + 1, maxDepth, yMin, yMax);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "apple-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.evaluate(async () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1800);

  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 844 });
  console.log("Captured tree, y in [180, 700] depth<=8:");
  dump(tree[0] as any, 0, 8, 180, 700);

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
