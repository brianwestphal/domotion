/* eslint-disable */
// Capture the element tree the same way the executor does (chunk 0) and look
// for the .start-frame element + the .mday-icon flowers.
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
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
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

  // Freeze (mirrors real-world.tsx)
  await page.evaluate(() => {
    try { if (typeof document.getAnimations === "function") for (const a of document.getAnimations()) { try { a.pause(); } catch {} } } catch {}
    try {
      const probe = window.setTimeout(() => {}, 0) as unknown as number;
      window.clearTimeout(probe);
      for (let i = 1; i <= probe; i++) {
        try { window.clearTimeout(i); } catch {}
        try { window.clearInterval(i); } catch {}
      }
    } catch {}
    try {
      const noop = (() => 0) as any;
      window.setTimeout = noop;
      window.setInterval = noop;
    } catch {}
    try { window.fetch = (() => new Promise(() => {})) as typeof window.fetch; } catch {}
    try { XMLHttpRequest.prototype.send = function() {}; } catch {}
  });

  // Inspect the start-frame + flowers right now (matches the moment captureElementTree runs)
  const inspect = await page.evaluate(() => {
    const startFrame = document.querySelector('.start-frame') as HTMLElement | null;
    const startFrameImg = startFrame?.querySelector('img') as HTMLImageElement | null;
    const sfRect = startFrame?.getBoundingClientRect();
    const imgRect = startFrameImg?.getBoundingClientRect();
    return {
      sf_class: startFrame?.className,
      sf_cs_opacity: startFrame ? getComputedStyle(startFrame).opacity : null,
      sf_cs_visibility: startFrame ? getComputedStyle(startFrame).visibility : null,
      sf_cs_display: startFrame ? getComputedStyle(startFrame).display : null,
      sf_rect: sfRect ? { x: Math.round(sfRect.left), y: Math.round(sfRect.top), w: Math.round(sfRect.width), h: Math.round(sfRect.height) } : null,
      img_src: startFrameImg ? startFrameImg.src.split('/').pop() : null,
      img_cs_opacity: startFrameImg ? getComputedStyle(startFrameImg).opacity : null,
      img_cs_visibility: startFrameImg ? getComputedStyle(startFrameImg).visibility : null,
      img_rect: imgRect ? { x: Math.round(imgRect.left), y: Math.round(imgRect.top), w: Math.round(imgRect.width), h: Math.round(imgRect.height) } : null,
      img_inline_opacity: startFrameImg ? startFrameImg.style.opacity : null,
    };
  });
  console.log("start-frame state:", JSON.stringify(inspect, null, 2));

  // Now run captureElementTree like the executor does
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 844 });

  // Find start-frame in captured tree
  const sfNodes: ElementTreeNode[] = [];
  walk(tree[0]!, (n) => (n.styles?.className || '').includes('start-frame'), sfNodes);
  console.log(`Captured tree: ${sfNodes.length} .start-frame elements`);
  for (const n of sfNodes) {
    console.log(` SF: tag=${n.tagName} cls=${(n.styles?.className || '').slice(0, 50)} rect=(${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.width)},${Math.round(n.height)}) opacity=${n.styles?.opacity} display=${n.styles?.display} visibility=${n.styles?.visibility}`);
    // Find img child
    const imgNodes: ElementTreeNode[] = [];
    walk(n, (c) => c.tagName === 'IMG' || c.tagName === 'img', imgNodes);
    for (const im of imgNodes) {
      console.log(`   IMG: src=${(im.attributes?.src || '').split('/').pop()?.slice(0,40)} rect=(${Math.round(im.x)},${Math.round(im.y)},${Math.round(im.width)},${Math.round(im.height)}) opacity=${im.styles?.opacity}`);
    }
  }

  // Find mday-icon flowers in captured tree
  const flowerNodes: ElementTreeNode[] = [];
  walk(tree[0]!, (n) => (n.styles?.className || '').includes('mday-icon'), flowerNodes);
  console.log(`Captured tree: ${flowerNodes.length} .mday-icon elements`);
  for (const n of flowerNodes.slice(0, 5)) {
    console.log(` FLOWER: cls=${(n.styles?.className || '').slice(0, 35)} rect=(${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.width)},${Math.round(n.height)}) opacity=${n.styles?.opacity} display=${n.styles?.display}`);
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
