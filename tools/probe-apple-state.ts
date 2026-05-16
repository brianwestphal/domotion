/* eslint-disable */
// Mimic real-world.tsx scroll-mode flow exactly, then dump flower state +
// screenshot at the same moment captureElementTree runs (chunk 0).
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

const SETTLE_MS = 800;
const POST_PRESCROLL_MS = 1800;

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
  page.setDefaultTimeout(60_000);
  await page.goto("https://www.apple.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);

  // scroll-mode pre-scroll
  await page.evaluate(async () => {
    const h = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(POST_PRESCROLL_MS);

  // Snapshot A: opacity BEFORE freeze
  const sA = await page.evaluate(() => {
    const fs = Array.from(document.querySelectorAll('.mday-icon')).slice(0, 8);
    return fs.map((f) => {
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      return { cls: (f as HTMLElement).className.slice(0, 35), op: cs.opacity, rect: { x: Math.round(r.left), y: Math.round(r.top) }, t: cs.transform === 'none' ? null : cs.transform.slice(0, 40) };
    });
  });
  console.log("AFTER pre-scroll, no freeze:", JSON.stringify(sA, null, 2));

  await page.screenshot({ path: "/tmp/apple-state-before-freeze.png", clip: { x: 0, y: 0, width: 390, height: 844 } });

  // Freeze (matches real-world.tsx exactly)
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

  // Snapshot B: opacity AFTER freeze, before screenshot
  const sB = await page.evaluate(() => {
    const fs = Array.from(document.querySelectorAll('.mday-icon')).slice(0, 8);
    return fs.map((f) => {
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      return { cls: (f as HTMLElement).className.slice(0, 35), op: cs.opacity, rect: { x: Math.round(r.left), y: Math.round(r.top) }, t: cs.transform === 'none' ? null : cs.transform.slice(0, 40) };
    });
  });
  console.log("AFTER freeze:", JSON.stringify(sB, null, 2));

  // Screenshot (what expected.png is)
  await page.screenshot({ path: "/tmp/apple-state-expected.png", clip: { x: 0, y: 0, width: 390, height: 844 } });

  // Snapshot C: small wait (mimics time until captureElementTree gets to the flowers)
  await page.waitForTimeout(50);
  const sC = await page.evaluate(() => {
    const fs = Array.from(document.querySelectorAll('.mday-icon')).slice(0, 8);
    return fs.map((f) => {
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      return { cls: (f as HTMLElement).className.slice(0, 35), op: cs.opacity, rect: { x: Math.round(r.left), y: Math.round(r.top) }, t: cs.transform === 'none' ? null : cs.transform.slice(0, 40) };
    });
  });
  console.log("After +50ms wait:", JSON.stringify(sC, null, 2));

  await page.waitForTimeout(500);
  const sD = await page.evaluate(() => {
    const fs = Array.from(document.querySelectorAll('.mday-icon')).slice(0, 8);
    return fs.map((f) => {
      const cs = getComputedStyle(f);
      return { cls: (f as HTMLElement).className.slice(0, 35), op: cs.opacity };
    });
  });
  console.log("After +500ms wait:", JSON.stringify(sD, null, 2));

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
