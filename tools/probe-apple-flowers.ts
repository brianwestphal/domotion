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

  const result = await page.evaluate(() => {
    const flower = Array.from(document.querySelectorAll('img'))
      .find(el => /flower01/.test(el.src || ''));
    if (!flower) return { found: false };
    const chain: any[] = [];
    let cur: Element | null = flower;
    let d = 0;
    while (cur && d < 12) {
      const r = cur.getBoundingClientRect();
      const cs = getComputedStyle(cur);
      chain.push({
        depth: d,
        tag: cur.nodeName.toLowerCase(),
        cls: ((cur as HTMLElement).className || '').slice(0, 60),
        rect: { x: Math.round(r.left*100)/100, y: Math.round(r.top*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100 },
        transform: cs.transform === 'none' ? null : cs.transform,
        transformOrigin: cs.transformOrigin,
        position: cs.position,
        overflow: cs.overflow,
      });
      cur = cur.parentElement;
      d++;
    }
    return { found: true, chain };
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
