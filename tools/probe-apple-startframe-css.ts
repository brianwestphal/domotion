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

  const sels = ['.start-frame', '.start-frame img', '.inline-media-wrapper', '.tile-image-wrapper', '.tile-wrapper', '.mothers-day-icons', '.section-hero'];
  const code = `(function() {
    function dump(sel) {
      var el = document.querySelector(sel);
      if (!el) return { sel: sel, missing: true };
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      return {
        sel: sel,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        position: cs.position,
        top: cs.top, left: cs.left, right: cs.right, bottom: cs.bottom,
        width: cs.width, height: cs.height,
        transform: cs.transform,
        objectFit: cs.objectFit, objectPosition: cs.objectPosition,
        margin: cs.marginTop + ' ' + cs.marginRight + ' ' + cs.marginBottom + ' ' + cs.marginLeft,
        translate: cs.translate, rotate: cs.rotate, scale: cs.scale,
        overflowX: cs.overflowX, overflowY: cs.overflowY,
      };
    }
    var sels = ${JSON.stringify(sels)};
    return sels.map(dump);
  })()`;
  const out = await page.evaluate(code);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
