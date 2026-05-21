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
  await page.waitForTimeout(800);

  // Replicate real-world.tsx scroll-mode pre-scroll
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1800);

  // Apply the freeze pass (matches real-world.tsx lines 545-592)
  await page.evaluate(() => {
    try { if (typeof document.getAnimations === "function") for (const a of document.getAnimations()) { try { a.pause(); } catch {} } } catch {}
    try {
      const probe = window.setTimeout(() => {}, 0) as unknown as number;
      window.clearTimeout(probe);
      for (let i = 1; i <= probe; i++) {
        try { window.clearTimeout(i); } catch {}
        try { window.clearInterval(i); } catch {}
      }
    } catch {}
    try {
      const noop = (() => 0) as any;
      window.setTimeout = noop;
      window.setInterval = noop;
    } catch {}
    try { window.fetch = (() => new Promise(() => {})) as typeof window.fetch; } catch {}
    try { XMLHttpRequest.prototype.send = function() {}; } catch {}
  });

  // Take expected screenshot (no animations: disabled, matches line 601)
  await page.screenshot({ path: "/tmp/apple-probe-1.png", clip: { x: 0, y: 0, width: 390, height: 844 } });

  // Probe flower state AT THIS MOMENT
  const t1 = await page.evaluate(() => {
    const f = document.querySelector('.mday-icon.flower01') || document.querySelector('img[src*="flower01"]');
    if (!f) return null;
    const cs = getComputedStyle(f);
    const r = f.getBoundingClientRect();
    return { opacity: cs.opacity, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, transform: cs.transform === 'none' ? null : cs.transform, inlineOpacity: (f as HTMLElement).style.opacity, inlineTransform: (f as HTMLElement).style.transform };
  });
  console.log("After expected.png screenshot (t1):", JSON.stringify(t1));

  // Wait similar to what captureElementTree takes (~500ms-2s of internal work)
  for (const ms of [50, 100, 200, 500, 1000, 2000]) {
    await page.waitForTimeout(ms);
    const t = await page.evaluate(() => {
      const f = document.querySelector('.mday-icon.flower01') || document.querySelector('img[src*="flower01"]');
      if (!f) return null;
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      return { opacity: cs.opacity, y: Math.round(r.top), transform: cs.transform === 'none' ? null : cs.transform.slice(0, 50) };
    });
    console.log(`+${ms}ms:`, JSON.stringify(t));
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
