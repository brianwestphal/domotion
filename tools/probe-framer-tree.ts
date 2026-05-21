// Dump the captured tree at REGION [1] (3, 994, 378, 68) of framer-mobile-
// entire-page. Replays the HAR, resizes to 6000 high, runs captureElementTree,
// then walks the captured tree filtering elements whose rect intersects the
// region. Prints tag, captured styles (background, mask, transform, position),
// and the children-count so we can see whether the brand logo divs are
// captured at all.
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/capture/index.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

function intersects(rect: { x: number; y: number; w: number; h: number }, region: { x: number; y: number; w: number; h: number }): boolean {
  return !(rect.x + rect.w < region.x || rect.x > region.x + region.w || rect.y + rect.h < region.y || rect.y > region.y + region.h);
}

function walk(node: any, region: any, depth: number, out: any[]) {
  if (node == null) return;
  if (node.x != null && node.width != null) {
    const r = { x: node.x, y: node.y, w: node.width, h: node.height };
    if (intersects(r, region) && r.w > 0 && r.h > 0 && r.w < 500 && r.h < 500) {
      const s = node.styles || {};
      out.push({
        depth,
        tag: node.tag,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) },
        background: s.backgroundColor,
        bgImage: s.backgroundImage != null && s.backgroundImage !== 'none' ? (s.backgroundImage || '').slice(0, 100) : null,
        maskImage: s.maskImage != null && s.maskImage !== 'none' ? (s.maskImage || '').slice(0, 100) : null,
        transform: s.transform,
        opacity: s.opacity,
        children: node.children?.length ?? 0,
        imageSrc: node.imageSrc != null ? node.imageSrc.slice(-80) : null,
      });
    }
  }
  if (node.children) {
    for (const c of node.children) walk(c, region, depth + 1, out);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "framer-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto("https://www.framer.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.setViewportSize({ width: 390, height: 6000 });
  await page.waitForTimeout(400);
  await page.evaluate(async (h) => {
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  }, 6000);
  await page.waitForTimeout(800);

  // Replicate the test's DM-510/DM-556 freeze pass.
  await page.evaluate(() => {
    try {
      if (typeof document.getAnimations === "function") {
        for (const a of document.getAnimations()) {
          try { a.pause(); } catch {}
        }
      }
    } catch {}
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

  // Replicate the test's screenshot-before-capture step.
  await page.screenshot({ path: "/tmp/probe-framer-expected.png", clip: { x: 0, y: 0, width: 390, height: 6000 } });

  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 6000 });
  // Walk WITHOUT region filter — find every li at y≈1013 to see how many of the
  // 8 marquee items the capture actually recorded.
  const REGION = { x: -10000, y: 1010, w: 20000, h: 50 };
  const out: any[] = [];
  for (const root of tree) {
    walk(root, REGION, 0, out);
  }
  // Filter to li tags so the output stays small.
  const lis = out.filter((d) => d.tag === 'li');
  console.log('LIs found:', lis.length);
  for (const li of lis) {
    console.log(JSON.stringify(li));
  }
  // Also dump every element with a bgImage at any y between 1000-1100.
  console.log('\\nElements with bgImage in y range:');
  for (const d of out) {
    if (d.bgImage && d.rect.y >= 1000 && d.rect.y <= 1100) {
      console.log(JSON.stringify(d).slice(0, 200));
    }
  }
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
