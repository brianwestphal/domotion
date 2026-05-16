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
  page.setDefaultTimeout(90_000);
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const showFlowers = async (label: string) => {
    const out = await page.evaluate(() => {
      const flowers = Array.from(document.querySelectorAll('.mday-icon, [class*="mday-icon"], img[src*="flower"]'));
      return flowers.slice(0, 5).map((f) => {
        const cs = getComputedStyle(f);
        const r = f.getBoundingClientRect();
        return { cls: ((f as HTMLElement).className || '').slice(0, 30), opacity: cs.opacity, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) }, transform: cs.transform === 'none' ? null : cs.transform.slice(0, 50) };
      });
    });
    console.log(label, JSON.stringify(out));
  };

  await showFlowers("initial");

  // Pre-scroll like real-world.tsx does (scroll to bottom + back to top)
  const rawHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
  console.log("scrollHeight:", rawHeight);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(800);
  await showFlowers("after scroll bottom");

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  await showFlowers("after back to top");

  // Now also trigger scroll events  
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(300);
  await showFlowers("after scroll event dispatch");

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
