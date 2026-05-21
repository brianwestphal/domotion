// Find what's actually painted at the visible-flower positions in expected.png.
// At y=224 x=33 there's a pink flower visible. What element is that?
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

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
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  // scroll-mode pre-scroll
  await page.evaluate(async () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1800);

  // elementsFromPoint at the positions where flowers are visible in expected.png
  const points = [
    [33, 224],   // top-left pink flower
    [232, 196],  // top-right yellow dot
    [73, 350],   // mid-left pink flower
    [330, 350],  // mid-right yellow flower
    [12, 305],   // top-left orange dot
    [330, 615],  // bottom-right swirl
    [50, 588],   // bottom-left orange flower
    [33, 670],   // bottom-left yellow dot
  ];
  const out = await page.evaluate((pts) => {
    return pts.map(([x, y]) => {
      const els = document.elementsFromPoint(x, y).slice(0, 4);
      return {
        point: [x, y],
        stack: els.map((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const isImg = el.tagName === 'IMG';
          return {
            tag: el.tagName,
            cls: ((el as HTMLElement).className || '').toString().slice(0, 40),
            src: isImg ? ((el as HTMLImageElement).src || '').split('/').pop()?.slice(0, 30) : null,
            op: cs.opacity,
            rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
            bg: cs.backgroundImage.slice(0, 60),
          };
        }),
      };
    });
  }, points);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
