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

  // Apply the same freeze as real-world.tsx does (DM-556 hides ReactModal!)
  await page.evaluate(() => {
    try { if (typeof document.getAnimations === "function") for (const a of document.getAnimations()) { try { a.pause(); } catch {} } } catch {}
    try {
      const noop = (() => 0) as any;
      window.setTimeout = noop;
      window.setInterval = noop;
    } catch {}
    try { window.fetch = (() => new Promise(() => {})) as typeof window.fetch; } catch {}
    try { XMLHttpRequest.prototype.send = function() {}; } catch {}
    // DM-556 modal hiding
    try {
      for (const el of document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) {
        try { (el as HTMLElement).style.display = "none"; } catch {}
      }
    } catch {}
  });

  // After freeze: any ReactModal elements still in the DOM?
  const modalState = await page.evaluate(`(function() {
    var modals = document.querySelectorAll('.ReactModal__Content');
    var overlays = document.querySelectorAll('.ReactModal__Overlay');
    return {
      modalCount: modals.length,
      overlayCount: overlays.length,
      modal0: modals[0] ? {
        attrs: Array.from(modals[0].attributes).map(a => a.name + '=' + a.value).join(', '),
        cs_display: getComputedStyle(modals[0]).display,
        cs_visibility: getComputedStyle(modals[0]).visibility,
        rect: modals[0].getBoundingClientRect ? (function() { var r = modals[0].getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; })() : null,
      } : null,
    };
  })()`);
  console.log("After freeze, ReactModal state:");
  console.log(JSON.stringify(modalState, null, 2));

  // Probe the video element
  const videoLive = await page.evaluate(`(function() {
    var v = document.querySelector('video');
    if (!v) return null;
    var r = v.getBoundingClientRect();
    var cs = getComputedStyle(v);
    // Walk parents
    var chain = [];
    var cur = v;
    var d = 0;
    while (cur && d < 8) {
      var ccs = getComputedStyle(cur);
      var cr = cur.getBoundingClientRect();
      chain.push({
        d: d, tag: cur.tagName, cls: (cur.className||'').toString().slice(0, 60),
        rect: { x: Math.round(cr.left), y: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) },
        display: ccs.display, position: ccs.position, opacity: ccs.opacity,
        transform: ccs.transform === 'none' ? null : ccs.transform.slice(0, 40),
        overflow: ccs.overflow,
      });
      cur = cur.parentElement;
      d++;
    }
    return { count: document.querySelectorAll('video').length, first: { src: v.currentSrc || v.src, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }, chain: chain };
  })()`);
  console.log("\n=== Video element after freeze ===");
  console.log(JSON.stringify(videoLive, null, 2));

  // Capture tree, look for video
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 6000 });
  const videos: CapturedElement[] = [];
  walk(tree[0]!, (n) => n.tag === 'video', videos);
  console.log(`\n=== Captured tree videos: ${videos.length} ===`);
  for (const v of videos) {
    const styles = v.styles as any;
    console.log(`  video rect=(${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.width)},${Math.round(v.height)}) op=${styles.opacity} replacedSnap=${(v as any).replacedSnapshot ? 'YES' : 'NO'}`);
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
