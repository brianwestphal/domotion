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
    // Find ALL elements with class containing payment-button INSIDE the Stripe Payment Element widget
    const stripeContent = Array.from(document.querySelectorAll('.dom-graphic__content'))[1];
    if (!stripeContent) return null;
    const allInside = Array.from(stripeContent.querySelectorAll('*'));
    const matches: any[] = [];
    for (const el of allInside) {
      const cls = (el as HTMLElement).className || '';
      if (typeof cls !== 'string') continue;
      if (cls.includes('checkout-payment-button') || cls.includes('payments-graphic__checkout-button')) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        matches.push({
          cls: cls.slice(0, 80),
          rect: { x: Math.round(r.left*100)/100, y: Math.round(r.top*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100 },
          transform: cs.transform === 'none' ? null : cs.transform,
          position: cs.position,
          text: (el.textContent||'').trim().slice(0, 40),
        });
      }
    }
    // Also get all payment-methods-item rect/transform pairs
    const items = Array.from(stripeContent.querySelectorAll('.payments-graphic__checkout-payment-methods-item, .payments-graphic__checkout-payment-button'));
    const itemList: any[] = [];
    for (const el of items) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      itemList.push({
        cls: ((el as HTMLElement).className || '').slice(0, 80),
        rect: { x: Math.round(r.left*100)/100, y: Math.round(r.top*100)/100, w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100 },
        transform: cs.transform === 'none' ? null : cs.transform,
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
    return { stripeButtons: matches, itemList };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
