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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1800);

  // Get the flower's full computed style, all 200+ props
  const out = await page.evaluate(() => {
    const f4 = document.querySelector('.mday-icon.flower04');
    if (!f4) return null;
    const cs = getComputedStyle(f4);
    const interesting: any = {};
    for (let i = 0; i < cs.length; i++) {
      const k = cs.item(i);
      if (!k.startsWith('--')) {
        const v = cs.getPropertyValue(k);
        // Only include 'interesting' values (not defaults)
        if (v && v !== 'none' && v !== '0px' && v !== '0' && v !== 'normal' && v !== 'auto' && v !== 'inherit' && v !== 'initial' && k !== 'opacity' && k !== 'visibility' && k !== 'display') {
          // Skip too-long values
          if (v.length < 200) interesting[k] = v;
        }
      }
    }
    return {
      opacity: cs.opacity,
      visibility: cs.visibility,
      display: cs.display,
      backgroundImage: cs.backgroundImage,
      backgroundColor: cs.backgroundColor,
      width: cs.width,
      height: cs.height,
      position: cs.position,
      top: cs.top,
      left: cs.left,
      // Parent opacity chain
      parentOpacity: f4.parentElement ? getComputedStyle(f4.parentElement).opacity : null,
      grandparentOpacity: f4.parentElement?.parentElement ? getComputedStyle(f4.parentElement.parentElement).opacity : null,
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
