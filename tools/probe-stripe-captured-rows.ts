// Capture the tree and find each payment-method-item to see what opacity / clipPath
// the capture preserved.
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
  await context.routeFromHAR(resolve(CACHE_DIR, "stripe-mobile.har"), { url: "**/*", update: false, notFound: "fallback" });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("https://stripe.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.setViewportSize({ width: 390, height: 6000 });
  await page.waitForTimeout(400);
  await page.evaluate(`(async () => {
    window.scrollTo(0, 6000);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  })()`);
  await page.waitForTimeout(1800);

  // Mark each row's element via JS so we can find them in the captured tree
  await page.evaluate(`(function() {
    var rows = document.querySelectorAll('.payments-graphic__checkout-payment-methods-item');
    for (var j = 0; j < rows.length; j++) {
      rows[j].setAttribute('data-probe-row', String(j));
      var txt = (rows[j].textContent || '').trim().slice(0, 25).replace(/\\s+/g, ' ');
      rows[j].setAttribute('data-probe-text', txt);
    }
  })()`);

  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 390, height: 6000 });

  // Walk tree looking for elements that match our marker. Capture doesn't preserve attrs
  // generally, but it might preserve data-* — let me check by walking and matching position
  // around y=1100-1250.
  const rows: CapturedElement[] = [];
  walk(tree[0]!, (n) => {
    // Match elements in the y range that look like rows: ~167 wide, position-y in 1100-1250
    return n.tag === 'div' && Math.abs(n.width - 167) < 10 && n.y >= 1090 && n.y <= 1300 && n.height < 80;
  }, rows);

  console.log("Captured row-like elements:");
  for (const r of rows) {
    const styles: any = r.styles;
    console.log(JSON.stringify({
      tag: r.tag,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      opacity: styles.opacity,
      visibility: styles.visibility,
      display: styles.display,
      clipPath: styles.clipPath,
      zIndex: styles.zIndex,
      position: styles.position,
      transform: styles.transform,
      transformCreatesSc: styles.transformCreatesSc,
    }));
  }

  await browser.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
