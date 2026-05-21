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
  await context.routeFromHAR(resolve(CACHE_DIR, "framer-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto("https://www.framer.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // REGION [1] (0, 654, 92, 190) — bottom-left tile area
  const out = await page.evaluate(() => {
    const REGIONS = [
      { x: 0, y: 654, w: 92, h: 190 },
      { x: 302, y: 714, w: 88, h: 130 },
    ];
    const results: any[] = [];
    for (const region of REGIONS) {
      const hits: any[] = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const intersects = !(r.right < region.x || r.left > region.x + region.w || r.bottom < region.y || r.top > region.y + region.h);
        if (!intersects) continue;
        const cs = getComputedStyle(el);
        // Only interesting ones: <img>, <video>, <canvas>, <picture>, elements with backgroundImage or backgroundColor
        const tag = el.nodeName.toLowerCase();
        const interesting = tag === 'img' || tag === 'video' || tag === 'canvas' || tag === 'picture' || tag === 'svg' || (cs.backgroundImage && cs.backgroundImage !== 'none');
        if (!interesting && tag !== 'div' && tag !== 'section') continue;
        hits.push({
          tag,
          cls: ((el as HTMLElement).className || '').toString().slice(0, 80),
          rect: { x: Math.round(r.left*100)/100, y: Math.round(r.top*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100 },
          src: tag === 'img' ? ((el as HTMLImageElement).src || '').slice(-80) : (tag === 'video' ? ((el as HTMLVideoElement).src || (el as HTMLVideoElement).currentSrc || '').slice(-80) : null),
          bg: cs.backgroundColor,
          bgImage: cs.backgroundImage === 'none' ? null : cs.backgroundImage.slice(0, 60),
          opacity: cs.opacity,
          overflow: cs.overflow,
          transform: cs.transform === 'none' ? null : cs.transform.slice(0, 60),
        });
      }
      results.push({ region, hits: hits.slice(0, 30) });
    }
    return results;
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
