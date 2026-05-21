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
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1800);
  await page.evaluate(() => { try { for (const a of document.getAnimations()) { try { a.pause(); } catch {} } } catch {} });

  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 844 });
  const flowers: any[] = [];
  const walk = (el: any) => {
    if (el.tag === 'picture' || el.tag === 'img') {
      if (el.x >= 0 && el.x < 390 && el.y >= 100 && el.y < 700 && el.width > 5 && el.width < 50) {
        flowers.push({
          tag: el.tag, rect: { x: el.x, y: el.y, w: el.width, h: el.height },
          imageSrc: el.imageSrc ? el.imageSrc.split('/').pop()?.slice(0, 40) : null,
          opacity: el.styles?.opacity,
          visibility: el.styles?.visibility,
          display: el.styles?.display,
        });
      }
    }
    if (Array.isArray(el.children)) for (const c of el.children) walk(c);
  };
  for (const r of tree) walk(r);
  for (const f of flowers.slice(0, 15)) console.log(JSON.stringify(f));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
