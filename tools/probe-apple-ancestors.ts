/* eslint-disable */
// Walk the live ancestor chain of .start-frame, then compare to captured tree.
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import type { ElementTreeNode } from "../src/types/element-tree.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

function walk(node: ElementTreeNode, pred: (n: ElementTreeNode) => boolean, out: ElementTreeNode[]) {
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) walk(c, pred, out);
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

  // Live ancestor chain of .start-frame
  const chain = await page.evaluate(() => {
    const el = document.querySelector('.start-frame') as HTMLElement | null;
    if (!el) return null;
    const chain: any[] = [];
    let cur: HTMLElement | null = el;
    while (cur && cur !== document.documentElement) {
      const cs = getComputedStyle(cur);
      const r = cur.getBoundingClientRect();
      chain.push({
        tag: cur.tagName,
        id: cur.id || null,
        cls: cur.className.toString().slice(0, 60),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        op: cs.opacity,
        vis: cs.visibility,
        disp: cs.display,
        pos: cs.position,
        overflow: cs.overflow,
        transform: cs.transform === 'none' ? null : cs.transform.slice(0, 50),
        zindex: cs.zIndex,
      });
      cur = cur.parentElement;
    }
    return chain;
  });
  console.log("Live ancestor chain of .start-frame (from element up to html):");
  for (let i = 0; i < (chain?.length ?? 0); i++) {
    console.log(`  [${i}] ${JSON.stringify(chain![i])}`);
  }

  // Captured tree
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 844 });

  // Search captured tree for any of the ancestor classes
  const interesting = ['mothers-day-icons', 'section-hero', 'unit-image-wrapper', 'start-frame', 'mday-icon', 'tile-link'];
  for (const cls of interesting) {
    const matches: ElementTreeNode[] = [];
    walk(tree[0]!, (n) => (n.styles?.className || '').includes(cls), matches);
    console.log(`Captured tree match for ".${cls}": ${matches.length}`);
    for (const n of matches.slice(0, 3)) {
      console.log(`  cls="${(n.styles?.className||'').slice(0,55)}" tag=${n.tagName} rect=(${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.width)},${Math.round(n.height)}) opacity=${n.styles?.opacity} display=${n.styles?.display}`);
    }
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
