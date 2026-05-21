/**
 * Probe stripe-mobile-entire-page at REGION coords (DM-587 / 588 / 589 / 590 / 591).
 *
 * Replicates the entire-page capture path from tests/real-world.tsx:
 *   - Mobile viewport (390x844), iPhone UA, isMobile=true.
 *   - Replay HAR.
 *   - Resize viewport to min(scrollHeight, 6000) so the entire-page capture
 *     sees the same DOM as the failing test.
 *   - Run the same animation/timer freeze.
 *   - captureElementTree at the resized viewport.
 *   - Dump elements intersecting a target rect with their styles / children
 *     summary so we can see exactly what got captured at the failure region.
 *
 * Usage:
 *   npx tsx tools/probe-stripe-checkout.ts            # default REGION [1] from DM-587
 *   npx tsx tools/probe-stripe-checkout.ts 260 1077 126 225
 */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { captureElementTree } from "../src/capture/index.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");
const OUT_DIR = resolve(TESTS_DIR, "output");

const TARGET_X = parseFloat(process.argv[2] || "260");
const TARGET_Y = parseFloat(process.argv[3] || "1077");
const TARGET_W = parseFloat(process.argv[4] || "126");
const TARGET_H = parseFloat(process.argv[5] || "225");
const FULL_PAGE_MAX_H = 6000;

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

  // Resize to full document height (matches entire-page mode).
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

  // Same freeze that real-world.tsx applies.
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

  console.log(`canvasH=${canvasH} target=(${TARGET_X},${TARGET_Y},${TARGET_W},${TARGET_H})`);

  // Live-DOM probe FIRST (before captureElementTree, so DOM is unmodified).
  // All helpers are inline arrow funcs to avoid esbuild injecting __name.
  const liveProbe = await page.evaluate((rect) => {
    const all = document.querySelectorAll("*");
    const hits: any[] = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const intersects = !(
        r.right < rect.x ||
        r.left > rect.x + rect.w ||
        r.bottom < rect.y ||
        r.top > rect.y + rect.h
      );
      if (!intersects) continue;
      // Build path inline.
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.nodeName !== "BODY" && cur.nodeName !== "HTML") {
        let seg = cur.nodeName.toLowerCase();
        const cls = (cur as HTMLElement).className;
        if (typeof cls === "string" && cls.length > 0) {
          seg += "." + cls.split(/\s+/).slice(0, 2).join(".");
        }
        const id = (cur as HTMLElement).id;
        if (id) seg += "#" + id;
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      const cs = getComputedStyle(el);
      hits.push({
        path: parts.join(" > ").slice(-200),
        tag: el.nodeName.toLowerCase(),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        text: (el.textContent ?? "").trim().slice(0, 60),
        position: cs.position,
        display: cs.display,
        transform: cs.transform === "none" ? null : cs.transform,
        transformOrigin: cs.transform === "none" ? null : cs.transformOrigin,
        zIndex: cs.zIndex,
        overflow: cs.overflow,
        flexDirection: cs.display.includes("flex") ? cs.flexDirection : null,
        order: cs.display.includes("flex") || cs.display.includes("grid") ? cs.order : null,
      });
    }
    return hits.slice(0, 60);
  }, { x: TARGET_X, y: TARGET_Y, w: TARGET_W, h: TARGET_H });

  console.log(`\n=== LIVE DOM (${liveProbe.length} elements intersecting region) ===`);
  for (const h of liveProbe) {
    console.log(JSON.stringify(h));
  }

  // Now run captureElementTree on the same region.
  const tree = await captureElementTree(page, "body", {
    x: 0, y: 0, width: 390, height: canvasH,
  });

  function intersects(el: any): boolean {
    if (!el || typeof el.x !== "number") return false;
    const left = el.x;
    const top = el.y;
    const right = left + (el.width || 0);
    const bot = top + (el.height || 0);
    return !(right < TARGET_X || left > TARGET_X + TARGET_W || bot < TARGET_Y || top > TARGET_Y + TARGET_H);
  }

  const hits: any[] = [];
  function walk(el: any, depth: number, parentPath: string): void {
    const pathSeg = `${el.tag}${el.className ? "." + el.className.split(/\s+/).slice(0, 2).join(".") : ""}`;
    const path = parentPath ? `${parentPath} > ${pathSeg}` : pathSeg;
    if (intersects(el)) {
      hits.push({
        depth,
        path: path.slice(-200),
        tag: el.tag,
        rect: { x: el.x, y: el.y, w: el.width, h: el.height },
        text: el.text ? el.text.slice(0, 40) : undefined,
        textSegmentCount: Array.isArray(el.textSegments) ? el.textSegments.length : 0,
        textSegmentsPreview: Array.isArray(el.textSegments) ? el.textSegments.slice(0, 3).map((s: any) => ({
          text: typeof s.text === "string" ? s.text.slice(0, 30) : "",
          x: s.x, y: s.y, w: s.width, h: s.height,
        })) : undefined,
        bg: el.styles?.backgroundColor,
        position: el.styles?.position,
        display: el.styles?.display,
        transform: el.styles?.transform === "none" ? null : el.styles?.transform,
        zIndex: el.styles?.zIndex,
        elementRaster: el.elementRaster ? {
          x: el.elementRaster.x, y: el.elementRaster.y, w: el.elementRaster.width, h: el.elementRaster.height,
        } : null,
        replacedSnapshot: el.replacedSnapshot ? "yes" : null,
        childCount: Array.isArray(el.children) ? el.children.length : 0,
      });
    }
    if (Array.isArray(el.children)) {
      for (const c of el.children) walk(c, depth + 1, path);
    }
  }
  for (const root of tree) walk(root, 0, "");

  console.log(`\n=== CAPTURED TREE (${hits.length} elements intersecting region) ===`);
  for (const h of hits) {
    console.log(JSON.stringify(h));
  }

  // Side-by-side counts.
  console.log(`\n=== SUMMARY ===`);
  console.log(`Live DOM elements at region:    ${liveProbe.length}`);
  console.log(`Captured tree elements at region: ${hits.length}`);

  // Persist the full captured tree at the region for offline inspection.
  writeFileSync(
    resolve(OUT_DIR, "probe-stripe-checkout.json"),
    JSON.stringify({ canvasH, target: { x: TARGET_X, y: TARGET_Y, w: TARGET_W, h: TARGET_H }, liveProbe, captured: hits }, null, 2),
  );
  console.log(`\nFull dump → tests/output/probe-stripe-checkout.json`);

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
