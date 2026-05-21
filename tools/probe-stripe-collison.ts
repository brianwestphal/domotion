// Probe what's captured at the Collison portrait location (111, 4412, 200, 200).
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

function walk(n: CapturedElement, depth: number, pred: (n: CapturedElement, d: number) => boolean) {
  if (pred(n, depth)) {
    const styles: any = n.styles;
    const cls = styles.className || '';
    const src = (n as any).imageSrc?.split('/').pop()?.slice(0, 30);
    console.log(`${'  '.repeat(Math.min(depth, 10))}${n.tag} rect=(${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.width)},${Math.round(n.height)}) op=${styles.opacity} disp=${styles.display} pos=${styles.position} transform=${styles.transform === 'none' ? '-' : 'YES'} src=${src || '-'}`);
  }
  for (const c of n.children ?? []) walk(c, depth + 1, pred);
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

  // Live DOM: find the Collison portrait via elementsFromPoint
  console.log("=== Live DOM at Collison portrait center (212, 4500) ===");
  const live = await page.evaluate(`(function() {
    var sp = document.querySelector('.sessions-keynote-speaker-image img');
    if (!sp) return null;
    var r = sp.getBoundingClientRect();
    var cs = getComputedStyle(sp);
    // Walk ancestors
    var chain = [];
    var cur = sp;
    var depth = 0;
    while (cur && depth < 12) {
      var ccs = getComputedStyle(cur);
      var cr = cur.getBoundingClientRect();
      chain.push({
        d: depth,
        tag: cur.tagName,
        cls: (cur.className||'').toString().slice(0, 60),
        rect: { x: Math.round(cr.left), y: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) },
        display: ccs.display, position: ccs.position, overflow: ccs.overflow,
        transform: ccs.transform === 'none' ? null : ccs.transform.slice(0, 30),
        opacity: ccs.opacity, visibility: ccs.visibility,
        clipPath: ccs.clipPath === 'none' ? null : ccs.clipPath,
      });
      cur = cur.parentElement;
      depth++;
    }
    return { src: sp.src, chain: chain };
  })()`);
  if (live) {
    console.log("img src:", live.src);
    for (const c of live.chain) console.log(`  [${c.d}] ${JSON.stringify(c)}`);
  }

  // Captured tree
  console.log("\n=== Captured tree img/picture in y=4350-4650 ===");
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 6000 });
  walk(tree[0]!, 0, (n) => {
    if (n.tag !== 'img' && n.tag !== 'picture') return false;
    return n.y >= 4300 && n.y <= 4700;
  });

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
