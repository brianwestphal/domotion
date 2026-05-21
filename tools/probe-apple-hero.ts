import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/capture/index.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "apple-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Live DOM: find all <img> in the hero region
  const live = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    const out: any[] = [];
    for (const img of imgs.slice(0, 20)) {
      const r = img.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.top > 1200 || r.bottom < 100) continue;
      const cs = getComputedStyle(img);
      out.push({
        src: (img.src || '').slice(-80),
        rect: { x: Math.round(r.left*100)/100, y: Math.round(r.top*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100 },
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        objectFit: cs.objectFit,
        objectPosition: cs.objectPosition,
        transform: cs.transform === 'none' ? null : cs.transform,
        transformOrigin: cs.transformOrigin,
      });
    }
    return out;
  });
  console.log("=== Live DOM hero imgs ===");
  for (const i of live) console.log(JSON.stringify(i));

  // Capture and find same imgs
  await page.evaluate(() => {
    try { if (typeof document.getAnimations === "function") for (const a of document.getAnimations()) { try { a.pause(); } catch {} } } catch {}
  });
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 1500 });

  console.log("\n=== Captured img elements (y<1200) ===");
  const walk = (el: any) => {
    if (el.tag === 'img' && el.y < 1200 && el.width > 0 && el.height > 0) {
      console.log(JSON.stringify({
        rect: { x: el.x, y: el.y, w: el.width, h: el.height },
        imageSrc: (el.imageSrc || '').slice(-80),
        imageIntrinsic: el.imageIntrinsic,
        objectFit: el.styles?.objectFit,
        objectPosition: el.styles?.objectPosition,
        transform: el.styles?.transform === 'none' ? null : el.styles?.transform,
        transformOrigin: el.styles?.transformOrigin,
      }));
    }
    if (Array.isArray(el.children)) for (const c of el.children) walk(c);
  };
  for (const r of tree) walk(r);

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
