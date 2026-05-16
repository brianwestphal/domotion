/* eslint-disable */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

  // Look at all 18 animations on the page
  const anims = await page.evaluate(() => {
    return document.getAnimations({ subtree: true }).map((a: any) => ({
      type: a.constructor.name,
      animationName: a.animationName,
      transitionProperty: a.transitionProperty,
      playState: a.playState,
      currentTime: a.currentTime,
      duration: a.effect ? a.effect.getTiming().duration : null,
      target: a.effect && a.effect.target ? ((a.effect.target as Element).className || '').toString().slice(0, 60) : null,
    }));
  });
  console.log("ALL ANIMATIONS (18 expected):");
  for (const a of anims) console.log(JSON.stringify(a));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
