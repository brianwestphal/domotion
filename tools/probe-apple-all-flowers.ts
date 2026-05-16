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
  await context.routeFromHAR(resolve(CACHE_DIR, "apple-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);

  // Mirror the real-world.tsx scroll-mode pre-scroll
  await page.evaluate(async () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1800);

  // Apply freeze
  await page.evaluate(() => {
    try { for (const a of document.getAnimations()) { try { a.pause(); } catch {} } } catch {}
    try {
      const noop = (() => 0) as any;
      window.setTimeout = noop;
      window.setInterval = noop;
    } catch {}
    try { window.fetch = (() => new Promise(() => {})) as typeof window.fetch; } catch {}
    try { XMLHttpRequest.prototype.send = function() {}; } catch {}
  });

  // Probe all flowers + scattered .mday-icon elements
  const out = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.mday-icon, [class*="mday-icon"], img[src*="flower"], img[src*="squiggle"], img[src*="dot"]'));
    return all.slice(0, 30).map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        cls: ((el as HTMLElement).className || '').slice(0, 40),
        src: (el as HTMLImageElement).src ? (el as HTMLImageElement).src.split('/').pop()?.slice(0, 30) : null,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        opacity: cs.opacity,
        transform: cs.transform === 'none' ? null : cs.transform.slice(0, 50),
        display: cs.display,
      };
    });
  });
  for (const f of out) console.log(JSON.stringify(f));
  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
