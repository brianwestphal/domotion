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
  await page.waitForTimeout(3000);

  const heroData = await page.evaluate(() => {
    const heroes = Array.from(document.querySelectorAll('img')).filter(i => /hero_md26|hero_iphone_family/.test(i.src || ''));
    return heroes.map(h => ({
      src: h.src,
      currentSrc: h.currentSrc,
      naturalWidth: h.naturalWidth,
      naturalHeight: h.naturalHeight,
      displayedW: Math.round(h.getBoundingClientRect().width),
      displayedH: Math.round(h.getBoundingClientRect().height),
    }));
  });
  console.log(JSON.stringify(heroData, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
