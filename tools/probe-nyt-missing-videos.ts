/* eslint-disable */
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
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "nytimes-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 390, height: 6000 });
  await page.waitForTimeout(400);
  await page.evaluate(`(async () => {
    window.scrollTo(0, 6000);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  })()`);
  await page.waitForTimeout(1800);

  // Probe the missing-video areas. The first video appears around y=2900.
  // The second video tiles area around y=4700.
  const points = [[100, 2900], [100, 4700]];
  for (const [x, y] of points) {
    console.log(`\n=== Live DOM at (${x}, ${y}) ===`);
    const els = await page.evaluate(`(function() {
      var els = document.elementsFromPoint(${x}, ${y}).slice(0, 8);
      return els.map(function(e) {
        var cs = getComputedStyle(e);
        var r = e.getBoundingClientRect();
        return {
          tag: e.tagName,
          cls: (e.className || '').toString().slice(0, 60),
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          opacity: cs.opacity, visibility: cs.visibility, display: cs.display,
          position: cs.position,
          transform: cs.transform === 'none' ? null : cs.transform.slice(0, 30),
          overflow: cs.overflow === 'visible' ? null : cs.overflow,
        };
      });
    })()`);
    for (const e of els) console.log(`  ${JSON.stringify(e)}`);
  }

  // Capture tree and find video/picture elements at those y positions
  console.log(`\n=== Captured tree: video/picture/img at y=2800-3100 ===`);
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 6000 });
  const matches: CapturedElement[] = [];
  walk(tree[0]!, (n) => {
    if (n.tag !== 'video' && n.tag !== 'picture' && n.tag !== 'img') return false;
    return n.y >= 2800 && n.y <= 3100;
  }, matches);
  for (const m of matches) {
    const src = (m as any).imageSrc?.split('/').pop()?.slice(0, 30) || '-';
    const styles = m.styles as any;
    console.log(`  ${m.tag} rect=(${Math.round(m.x)},${Math.round(m.y)},${Math.round(m.width)},${Math.round(m.height)}) src=${src} op=${styles.opacity} display=${styles.display}`);
  }

  console.log(`\n=== Captured tree: video/picture/img at y=4500-5000 ===`);
  const matches2: CapturedElement[] = [];
  walk(tree[0]!, (n) => {
    if (n.tag !== 'video' && n.tag !== 'picture' && n.tag !== 'img') return false;
    return n.y >= 4500 && n.y <= 5000;
  }, matches2);
  for (const m of matches2) {
    const src = (m as any).imageSrc?.split('/').pop()?.slice(0, 30) || '-';
    const styles = m.styles as any;
    console.log(`  ${m.tag} rect=(${Math.round(m.x)},${Math.round(m.y)},${Math.round(m.width)},${Math.round(m.height)}) src=${src} op=${styles.opacity} display=${styles.display}`);
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
