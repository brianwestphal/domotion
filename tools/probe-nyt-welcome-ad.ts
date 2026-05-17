/* eslint-disable */
import { chromium } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureElementTree } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../tests");
const CACHE_DIR = resolve(TESTS_DIR, "cache/real-world");

function walk(n: CapturedElement, pred: (n: CapturedElement) => boolean, out: CapturedElement[]) {
  if (pred(n)) out.push(n);
  for (const c of n.children ?? []) walk(c, pred, out);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await context.routeFromHAR(resolve(CACHE_DIR, "nytimes-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://www.nytimes.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 390, height: 6000 });
  await page.waitForTimeout(400);
  await page.evaluate(`(async () => {
    window.scrollTo(0, 6000);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  })()`);
  await page.waitForTimeout(1800);

  // Probe LIVE welcome-ad structure (without freeze, to see real positions)
  console.log("=== Live welcome-ad subtree (depth 0-3) ===");
  const out = await page.evaluate(`(function() {
    var ad = document.getElementById('welcome-ad');
    if (!ad) return null;
    var results = [];
    function walk(el, depth) {
      if (depth > 4) return;
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      results.push({
        d: depth,
        tag: el.tagName,
        cls: (el.className||'').toString().slice(0, 50),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        position: cs.position,
        transform: cs.transform === 'none' ? null : cs.transform.slice(0, 50),
        display: cs.display,
        overflow: cs.overflow === 'visible' ? null : cs.overflow,
        opacity: cs.opacity,
        bg: cs.backgroundColor,
      });
      for (var c of el.children) walk(c, depth + 1);
    }
    walk(ad, 0);
    return results;
  })()`);
  if (out) for (const e of out) console.log(`${'  '.repeat(e.d)}${JSON.stringify(e)}`);

  // Now do the same with freeze applied
  await page.evaluate(() => {
    try { if (typeof document.getAnimations === "function") for (const a of document.getAnimations()) { try { a.pause(); } catch {} } } catch {}
    try {
      const noop = (() => 0) as any;
      window.setTimeout = noop;
      window.setInterval = noop;
    } catch {}
    try { window.fetch = (() => new Promise(() => {})) as typeof window.fetch; } catch {}
    try { XMLHttpRequest.prototype.send = function() {}; } catch {}
    try {
      for (const el of document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) {
        try { (el as HTMLElement).style.display = "none"; } catch {}
      }
    } catch {}
  });

  // Check captured tree for the welcome-ad's children
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 6000 });
  // Find elements that look like they're part of the welcome-ad area (y=2700-3250)
  console.log(`\n=== Captured tree elements at y=2700-3250 (depth-by-tag) ===`);
  const matches: CapturedElement[] = [];
  walk(tree[0]!, (n) => n.y >= 2700 && n.y <= 3250 && n.width > 50 && n.height > 50, matches);
  const byTag: Record<string, number> = {};
  for (const m of matches) byTag[m.tag] = (byTag[m.tag] || 0) + 1;
  console.log(`  ${matches.length} elements. By tag:`, byTag);
  // Show nyt-betamax elements (the custom video player) and their replacedSnapshot status
  for (const m of matches) {
    if (m.tag.startsWith('nyt-')) {
      const styles = m.styles as any;
      const rs = (m as any).replacedSnapshot;
      console.log(`  ${m.tag} rect=(${Math.round(m.x)},${Math.round(m.y)},${Math.round(m.width)},${Math.round(m.height)}) replacedSnapshot=${rs ? 'YES dataUri.len=' + (rs.dataUri || '').length : 'NO'}`);
    }
  }
  // Show all img/picture in the welcome-ad area
  console.log(`\n=== img/picture/video at y=2700-3250 ===`);
  const imgs: CapturedElement[] = [];
  walk(tree[0]!, (n) => (n.tag === 'img' || n.tag === 'picture' || n.tag === 'video') && n.y >= 2700 && n.y <= 3250, imgs);
  for (const m of imgs) {
    const src = (m as any).imageSrc?.split('/').pop()?.slice(0, 40) || '-';
    console.log(`  ${m.tag} rect=(${Math.round(m.x)},${Math.round(m.y)},${Math.round(m.width)},${Math.round(m.height)}) src=${src}`);
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
