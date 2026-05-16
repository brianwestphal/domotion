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
  await page.evaluate(`(async () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight || 0);
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  })()`);
  await page.waitForTimeout(1800);

  const out = await page.evaluate(`(function() {
    const sf = document.querySelector('.start-frame img');
    const flower01 = document.querySelector('.flower01 img');
    return {
      startFrame: sf ? {
        src: sf.src,
        currentSrc: sf.currentSrc,
        naturalWidth: sf.naturalWidth,
        naturalHeight: sf.naturalHeight,
        complete: sf.complete,
        srcsetSource: sf.parentElement ? sf.parentElement.querySelector('source')?.srcset : null,
      } : null,
      flower01: flower01 ? {
        src: flower01.src,
        currentSrc: flower01.currentSrc,
        naturalWidth: flower01.naturalWidth,
        naturalHeight: flower01.naturalHeight,
        complete: flower01.complete,
      } : null,
    };
  })()`);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
