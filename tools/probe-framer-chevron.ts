// Probe the framer-mobile-entire-page chevron arrows at REGION [1] (253, 1063, 36, 30)
// and REGION [2] (94, 1741, 37, 33). Replays the cached HAR at 390×844 mobile viewport,
// then resizes to 6000 high to match the entire-page mode that recorded the test. Dumps
// every element intersecting each region with tag, classes, outerHTML, computed-style
// fill/stroke/color/font-family, and any inline <svg> markup.
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
  // Match the real-world.tsx entire-page setup: resize to capped 6000 height.
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
      { name: "[1]", x: 253, y: 1063, w: 36, h: 30 },
      { name: "[2]", x: 94, y: 1741, w: 37, h: 33 },
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
        const tag = el.nodeName.toLowerCase();
        // Skip elements bigger than 200×200 (likely backdrop containers, not the icon itself).
        if (r.width > 200 || r.height > 200) continue;
        hits.push({
          tag,
          cls: ((el as HTMLElement).className || '').toString().slice(0, 100),
          rect: { x: Math.round(r.left*100)/100, y: Math.round(r.top*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100 },
          fontFamily: cs.fontFamily,
          color: cs.color,
          fill: cs.fill,
          stroke: cs.stroke,
          background: cs.backgroundColor,
          bgImage: cs.backgroundImage === 'none' ? null : cs.backgroundImage.slice(0, 100),
          textContent: (el.textContent || '').slice(0, 40),
          // For <svg> and <path>, dump the outerHTML so we can see exactly what's emitted.
          outerHTML: (tag === 'svg' || tag === 'path' || tag === 'use' || tag === 'symbol')
            ? (el.outerHTML || '').slice(0, 400)
            : null,
          // For <img>, dump src + alt.
          src: tag === 'img' ? ((el as HTMLImageElement).src || '').slice(-80) : null,
          alt: tag === 'img' ? ((el as HTMLImageElement).alt || '') : null,
        });
      }
      results.push({ region, hits });
    }
    return results;
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
