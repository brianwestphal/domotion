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

  // Look at the flower's full computed style + animations
  const initial = await page.evaluate(() => {
    const flower = document.querySelector('.mday-icon.flower01') || document.querySelector('img[src*="flower01"]');
    if (!flower) return { found: false };
    const cs = getComputedStyle(flower);
    const animations = (flower as HTMLElement).getAnimations ? (flower as HTMLElement).getAnimations().map((a: any) => ({
      type: a.constructor.name,
      animationName: a.animationName,
      playState: a.playState,
      currentTime: a.currentTime,
      effectTiming: a.effect ? a.effect.getTiming() : null,
    })) : [];
    // Also check parent (mothers-day-icons)
    const parent = document.querySelector('.mothers-day-icons');
    const parentAnims = parent && (parent as HTMLElement).getAnimations ? (parent as HTMLElement).getAnimations().map((a: any) => ({
      type: a.constructor.name,
      animationName: a.animationName,
      playState: a.playState,
      currentTime: a.currentTime,
    })) : [];
    return {
      found: true,
      flower: {
        opacity: cs.opacity,
        visibility: cs.visibility,
        display: cs.display,
        animationName: cs.animationName,
        animationDuration: cs.animationDuration,
        animationDelay: cs.animationDelay,
        animationPlayState: cs.animationPlayState,
        animationFillMode: cs.animationFillMode,
        transform: cs.transform === 'none' ? null : cs.transform,
        transition: cs.transition,
      },
      animations,
      parentAnims,
    };
  });
  console.log("=== Initial state ===");
  console.log(JSON.stringify(initial, null, 2));

  // Now scroll progressively and observe how opacity changes
  for (const scrollY of [0, 100, 200, 300, 400, 500, 700]) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
      const flower = document.querySelector('.mday-icon.flower01') || document.querySelector('img[src*="flower01"]');
      if (!flower) return null;
      const cs = getComputedStyle(flower);
      const r = flower.getBoundingClientRect();
      const anims = (flower as HTMLElement).getAnimations ? (flower as HTMLElement).getAnimations().map((a: any) => ({
        name: a.animationName,
        state: a.playState,
        time: a.currentTime,
      })) : [];
      return { opacity: cs.opacity, rect: { x: Math.round(r.left), y: Math.round(r.top) }, transform: cs.transform === 'none' ? null : cs.transform, anims };
    });
    console.log(`scrollY=${scrollY}: ${JSON.stringify(state)}`);
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
