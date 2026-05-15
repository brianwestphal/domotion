/* eslint-disable */
/**
 * 2-screenshot diagnostic for the stripe-mobile-entire-page batch
 * (DM-587 / DM-590 / DM-591).
 *
 * Prior probes confirmed that the renderer's transform + nested-descendant
 * composition is correct in isolation (`transform-scale-flex-descendants`
 * feature test passes pixel-perfect). The remaining hypothesis is that
 * Stripe's interactive Payment Element widget mutates the DOM between
 * Chrome's screenshot and our captureElementTree pass.
 *
 * This script takes TWO screenshots of the same page using exactly the same
 * setup as `tests/real-world.tsx`'s entire-page mode:
 *   - Screenshot A: immediately after freeze, before any tree capture.
 *   - Screenshot B: after captureElementTree has run.
 *
 * Then it pixel-compares the two screenshots at REGION [1] (260,1077,126,225,
 * the DM-587 region). If A and B differ, JS mutation between snapshot points
 * is confirmed as the root cause for the stripe batch.
 *
 * Usage:
 *   npx tsx tools/probe-stripe-two-screenshots.ts
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { captureElementTree } from "../src/capture/index.js";

interface RawImage { width: number; height: number; data: Buffer }
async function readPngRaw(buf: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");
const OUT_DIR = resolve(TESTS_DIR, "output");
const FULL_PAGE_MAX_H = 6000;

const REGIONS: Array<{ name: string; x: number; y: number; w: number; h: number }> = [
  { name: "DM-587", x: 260, y: 1077, w: 126, h: 225 },
  { name: "DM-590", x: 319, y: 3653, w: 63,  h: 367 },
  { name: "DM-591", x: 56,  y: 3728, w: 229, h: 257 },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "stripe-mobile.har"), {
    url: "**/*",
    update: false,
    notFound: "fallback",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  page.setDefaultNavigationTimeout(90_000);
  await page.goto("https://stripe.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const rawHeight = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  );
  const canvasH = Math.min(FULL_PAGE_MAX_H, Math.max(844, rawHeight));
  await page.setViewportSize({ width: 390, height: canvasH });
  await page.waitForTimeout(400);
  await page.evaluate(async (h) => {
    window.scrollTo(0, h);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  }, canvasH);
  await page.waitForTimeout(1800);

  // Same freeze that real-world.tsx applies (animation + setTimeout/Interval).
  await page.evaluate(() => {
    try {
      if (typeof document.getAnimations === "function") {
        for (const a of document.getAnimations()) {
          try { a.pause(); } catch { /* */ }
        }
      }
    } catch { /* */ }
    try {
      const probe = window.setTimeout(() => {}, 0) as unknown as number;
      window.clearTimeout(probe);
      for (let i = 1; i <= probe; i++) {
        try { window.clearTimeout(i); } catch { /* */ }
        try { window.clearInterval(i); } catch { /* */ }
      }
    } catch { /* */ }
    try {
      const noop = (() => 0) as any;
      window.setTimeout = noop;
      window.setInterval = noop;
    } catch { /* */ }
  });

  console.log(`canvasH=${canvasH}`);

  // Screenshot A — after freeze, before captureElementTree.
  const pngA = await page.screenshot({ fullPage: false, animations: "disabled" });
  writeFileSync(resolve(OUT_DIR, "probe-stripe-two-shots-A.png"), pngA);

  // captureElementTree (matching what real-world.tsx does in entire-page mode).
  const t0 = Date.now();
  const tree = await captureElementTree(page, "body", {
    x: 0, y: 0, width: 390, height: canvasH,
  });
  const captureMs = Date.now() - t0;
  console.log(`captureElementTree completed in ${captureMs}ms (${tree.length} roots)`);

  // Screenshot B — immediately after captureElementTree.
  const pngB = await page.screenshot({ fullPage: false, animations: "disabled" });
  writeFileSync(resolve(OUT_DIR, "probe-stripe-two-shots-B.png"), pngB);

  // Pixel-compare A and B at each region (and overall).
  const a = await readPngRaw(pngA);
  const b = await readPngRaw(pngB);
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`SIZE MISMATCH A=${a.width}x${a.height} vs B=${b.width}x${b.height}`);
  } else {
    console.log(`Both screenshots ${a.width}x${a.height}`);
  }

  const cmpRegion = (name: string, x: number, y: number, w: number, h: number) => {
    if (a.width !== b.width || a.height !== b.height) return;
    const x0 = Math.max(0, Math.min(a.width, Math.floor(x)));
    const y0 = Math.max(0, Math.min(a.height, Math.floor(y)));
    const x1 = Math.max(0, Math.min(a.width, Math.floor(x + w)));
    const y1 = Math.max(0, Math.min(a.height, Math.floor(y + h)));
    let diffPx = 0;
    let total = 0;
    let maxChan = 0;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const idx = (py * a.width + px) * 4;
        const dr = Math.abs(a.data[idx + 0] - b.data[idx + 0]);
        const dg = Math.abs(a.data[idx + 1] - b.data[idx + 1]);
        const db = Math.abs(a.data[idx + 2] - b.data[idx + 2]);
        const m = Math.max(dr, dg, db);
        if (m > maxChan) maxChan = m;
        if (m > 2) diffPx++;
        total++;
      }
    }
    const pct = total === 0 ? 0 : (diffPx / total) * 100;
    console.log(`Region ${name} (${x},${y},${w},${h}) total=${total} diff>2chan=${diffPx} (${pct.toFixed(3)}%) maxChan=${maxChan}`);
  };

  console.log(`\n=== PER-REGION DIFF (A vs B) ===`);
  for (const r of REGIONS) {
    cmpRegion(r.name, r.x, r.y, r.w, r.h);
  }

  // Whole-frame summary.
  if (a.width === b.width && a.height === b.height) {
    let totalDiff = 0;
    let totalPx = a.width * a.height;
    for (let i = 0; i < a.data.length; i += 4) {
      const dr = Math.abs(a.data[i + 0] - b.data[i + 0]);
      const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
      const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (Math.max(dr, dg, db) > 2) totalDiff++;
    }
    const pct = (totalDiff / totalPx) * 100;
    console.log(`\nWhole-frame diff: ${totalDiff}/${totalPx} px (${pct.toFixed(4)}%)`);
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
