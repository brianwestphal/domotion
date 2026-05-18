/* eslint-disable */
// Probe DM-637's REGIONs on framer-mobile-entire-page. Each region marks a
// patch where the actual.png is solid black but the expected.png shows brand
// logos, avatars, buttons, or imagery. Replays the cached HAR, resizes to
// 6000 high, then dumps every element intersecting each region with tag, src,
// background-image, mask-image (DM-638's fix may already cover some), and the
// outerHTML so we can see what the captured tree is meant to render.
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
  await page.waitForTimeout(2000);
  await page.setViewportSize({ width: 390, height: 6000 });
  await page.waitForTimeout(400);
  await page.evaluate(async (h) => {
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  }, 6000);
  await page.waitForTimeout(800);

  const out = await page.evaluate(() => {
    const REGIONS = [
      { name: "[1] brand logos", x: 3, y: 994, w: 378, h: 68 },
      { name: "[2] avatar circle", x: 32, y: 5178, w: 86, h: 86 },
      { name: "[3] card text", x: 32, y: 5299, w: 260, h: 116 },
      { name: "[4] read more btn", x: 241, y: 5202, w: 120, h: 34 },
      { name: "[5] imagery row", x: 19, y: 5845, w: 356, h: 32 },
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
        // Skip huge wrappers.
        if (r.width > 500 || r.height > 500) continue;
        const cs = getComputedStyle(el);
        const tag = el.nodeName.toLowerCase();
        const interesting = tag === 'img' || tag === 'svg' || tag === 'picture' || tag === 'video' || (cs.backgroundImage && cs.backgroundImage !== 'none') || ((cs as any).maskImage && (cs as any).maskImage !== 'none') || (el.textContent && (el.textContent.trim().length > 0 && (el as HTMLElement).children.length === 0));
        if (!interesting) continue;
        hits.push({
          tag,
          cls: ((el as HTMLElement).className || '').toString().slice(0, 80),
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          src: tag === 'img' ? ((el as HTMLImageElement).src || '').slice(-100) : null,
          currentSrc: tag === 'img' ? ((el as HTMLImageElement).currentSrc || '').slice(-100) : null,
          srcset: tag === 'img' ? ((el as HTMLImageElement).srcset || '').slice(0, 100) : null,
          loading: tag === 'img' ? ((el as HTMLImageElement).loading || '') : null,
          naturalW: tag === 'img' ? (el as HTMLImageElement).naturalWidth : null,
          naturalH: tag === 'img' ? (el as HTMLImageElement).naturalHeight : null,
          alt: tag === 'img' ? ((el as HTMLImageElement).alt || '') : null,
          opacity: cs.opacity,
          visibility: cs.visibility,
          background: cs.backgroundColor,
          bgImage: cs.backgroundImage === 'none' ? null : cs.backgroundImage.slice(0, 80),
          maskImage: ((cs as any).maskImage === 'none' || (cs as any).maskImage == null) ? null : ((cs as any).maskImage || '').slice(0, 80),
          text: el.textContent ? el.textContent.trim().slice(0, 60) : null,
        });
      }
      results.push({ region, hits: hits.slice(0, 15) });
    }
    return results;
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
