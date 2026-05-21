// For each of DM-588/589/590/591's REGIONS, probe what's at that location
// in the live DOM (post-pre-scroll + freeze), and what's at the same location
// in our captured tree.
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

const REGIONS = [
  { id: "DM-588", title: "Pro Plan card", x: 41, y: 1423, w: 310, h: 400 },
  { id: "DM-589", title: "Collison portrait", x: 106, y: 4399, w: 213, h: 231 },
  { id: "DM-590", title: "Accounts list", x: 319, y: 3653, w: 63, h: 367 },
  { id: "DM-591", title: "Daybreak Yoga checkout", x: 56, y: 3728, w: 229, h: 257 },
];

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
  await context.routeFromHAR(resolve(CACHE_DIR, "stripe-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://stripe.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 390, height: 6000 });
  await page.waitForTimeout(400);
  await page.evaluate(`(async () => {
    window.scrollTo(0, 6000);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  })()`);
  await page.waitForTimeout(1800);

  for (const region of REGIONS) {
    console.log(`\n=== ${region.id}: ${region.title} ===`);
    console.log(`region: (${region.x}, ${region.y}, ${region.w}, ${region.h})`);

    // Live DOM: pick center of region, walk elements there
    const cx = region.x + region.w / 2;
    const cy = region.y + region.h / 2;
    const live = await page.evaluate(`(function() {
      var els = document.elementsFromPoint(${cx}, ${cy}).slice(0, 8);
      return els.map(function(e) {
        var cs = getComputedStyle(e);
        var r = e.getBoundingClientRect();
        return {
          tag: e.tagName,
          cls: (e.className || '').toString().slice(0, 60),
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          opacity: cs.opacity, visibility: cs.visibility, display: cs.display,
          transform: cs.transform === 'none' ? null : cs.transform.slice(0, 40),
          position: cs.position,
          overflow: cs.overflow === 'visible' ? null : cs.overflow,
        };
      });
    })()`);
    console.log("Live stack at center:");
    for (const e of live) console.log(`  ${JSON.stringify(e)}`);
  }

  // Capture full tree (one capture for all regions)
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 6000 });

  for (const region of REGIONS) {
    console.log(`\n=== ${region.id} captured tree count at region ===`);
    const cx = region.x + region.w / 2;
    const cy = region.y + region.h / 2;
    const matches: CapturedElement[] = [];
    walk(tree[0]!, (n) => {
      // Element whose rect intersects the region
      return n.x < region.x + region.w && n.x + n.width > region.x
          && n.y < region.y + region.h && n.y + n.height > region.y;
    }, matches);
    // Tag-only stats
    const byTag: Record<string, number> = {};
    for (const m of matches) byTag[m.tag] = (byTag[m.tag] || 0) + 1;
    console.log(`  ${matches.length} captured elements intersect region. By tag:`, byTag);
    // Show a few with rects
    for (const m of matches.slice(0, 8)) {
      console.log(`    ${m.tag} rect=(${Math.round(m.x)},${Math.round(m.y)},${Math.round(m.width)},${Math.round(m.height)}) bg=${(m.styles as any).backgroundImage?.slice(0, 30) || ''}`);
    }
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
