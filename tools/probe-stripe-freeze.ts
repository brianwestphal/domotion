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
  await context.routeFromHAR(resolve(CACHE_DIR, "stripe-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto("https://stripe.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const rawHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
  const canvasH = Math.min(6000, Math.max(844, rawHeight));
  await page.setViewportSize({ width: 390, height: canvasH });
  await page.waitForTimeout(400);
  await page.evaluate(async (h) => { window.scrollTo(0, h); await new Promise((r) => setTimeout(r, 400)); window.scrollTo(0, 0); }, canvasH);
  await page.waitForTimeout(1800);

  const out = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.dom-graphic__content'));
    const target = all[1]; // The Stripe Payment Element one with 0.694737 scale
    if (!target) return null;
    const beforeRect = target.getBoundingClientRect();
    const beforeTransform = getComputedStyle(target).transform;
    const beforeInline = (target as HTMLElement).style.transform;

    // Clear transform like freeze pass
    (target as HTMLElement).style.transform = 'translate(0)';
    const afterRect = target.getBoundingClientRect();
    const afterTransform = getComputedStyle(target).transform;

    // Now also clear transforms on ALL ancestors with non-none transform
    let cur: Element | null = target.parentElement;
    const ancestorsCleared = [];
    while (cur) {
      const acs = getComputedStyle(cur);
      if (acs.transform && acs.transform !== 'none') {
        (cur as HTMLElement).style.transform = 'translate(0)';
        ancestorsCleared.push((cur as HTMLElement).className.slice(0, 50) + ' ' + acs.transform.slice(0, 40));
      }
      cur = cur.parentElement;
    }
    const fullClearRect = target.getBoundingClientRect();

    return {
      beforeRect: { x: beforeRect.x, y: beforeRect.y, w: beforeRect.width, h: beforeRect.height },
      beforeTransform, beforeInline,
      afterRect_ownCleared: { x: afterRect.x, y: afterRect.y, w: afterRect.width, h: afterRect.height },
      afterTransform_ownCleared: afterTransform,
      ancestorsCleared,
      fullClearRect: { x: fullClearRect.x, y: fullClearRect.y, w: fullClearRect.width, h: fullClearRect.height },
    };
  });

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
